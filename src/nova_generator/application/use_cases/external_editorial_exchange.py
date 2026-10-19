from __future__ import annotations

import json
import zipfile
from dataclasses import asdict, replace
from io import BytesIO
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialCuePrompt,
    EditorialSemanticUnit,
    EditorialSuggestion,
    EditorialWordTranslation,
)
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.editorial_assistance import (
    EditorialAssistanceError,
    build_editorial_prompt,
    persist_editorial_chunk_preparation,
    persist_editorial_chunk_with_speaker_turns,
    validate_editorial_result,
)


class _ExternalSemanticUnit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    word_ids: list[str] = Field(min_length=2)
    pt: str = Field(min_length=1)


class _ExternalWordTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    word_id: str
    pt: str = Field(min_length=1)
    order: int | None = Field(default=None, ge=1)
    leading: str | None = None
    surface: str | None = Field(default=None, min_length=1)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, gt=0)


class _ExternalSpeakerTurn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    word_ids: list[str] = Field(min_length=1)
    speaker: str = Field(min_length=1)
    approved_pt: str = Field(min_length=1)
    confidence: Literal["high", "medium", "uncertain"] = "uncertain"


class _ExternalSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    cue_id: str
    order: int
    approved_en: str = Field(min_length=1)
    approved_pt: str = Field(min_length=1)
    notes: str = ""
    word_translations: list[_ExternalWordTranslation] = Field(default_factory=list)
    semantic_units: list[_ExternalSemanticUnit] = Field(default_factory=list)
    trailing: str = ""
    speaker_turns: list[_ExternalSpeakerTurn] = Field(default_factory=list)
    merge_with_previous: bool = False


class _ExternalResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[
        "nova-generator-editorial-suggestions/1.0",
        "nova-generator-editorial-suggestions/1.1",
        "nova-generator-editorial-suggestions/1.2",
        "nova-generator-editorial-suggestions/1.3",
        "nova-generator-editorial-suggestions/1.4",
        "nova-generator-editorial-suggestions/1.5",
    ]
    scene_id: UUID
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    chunk_id: str | None = None
    suggestions: list[_ExternalSuggestion] = Field(min_length=1)


class ExternalEditorialExchange:
    _CUES_PER_CHUNK = 8

    def __init__(
        self,
        repository: EditorialProjectRepository,
        project_root: Path,
        *,
        maximum_result_bytes: int = 2_000_000,
    ) -> None:
        self._repository = repository
        self._project_root = project_root
        self._maximum_result_bytes = maximum_result_bytes

    def build_package(self, scene_id: UUID) -> Path:
        input_sha256, cues = build_editorial_prompt(self._repository, scene_id)
        project_id = self._repository.get_scene_project_id(scene_id)
        if project_id is None:
            raise EditorialAssistanceError("scene not found")
        scene = next(
            (
                item
                for item in self._repository.get_project_scenes(project_id)
                if item.id == scene_id
            ),
            None,
        )
        if scene is None:
            raise EditorialAssistanceError("scene not found")
        directory = self._project_root / str(project_id) / "editorial-ai"
        directory.mkdir(parents=True, exist_ok=True)
        package = directory / f"scene-{scene_id}-external-ai.zip"
        source = {
            "schema_version": "nova-generator-editorial-input/1.5",
            "scene_id": str(scene_id),
            "input_sha256": input_sha256,
            "cues": [asdict(cue) for cue in cues],
        }
        chunks = [
            cues[index : index + self._CUES_PER_CHUNK]
            for index in range(0, len(cues), self._CUES_PER_CHUNK)
        ]
        manifest = {
            "schema_version": "nova-generator-editorial-exchange/1.5",
            "scene_id": str(scene_id),
            "input_sha256": input_sha256,
            "chunks": [
                {
                    "id": f"chunk-{index:03d}",
                    "index": index,
                    "cue_ids": [cue.id for cue in chunk],
                    "cue_orders": [cue.order for cue in chunk],
                }
                for index, chunk in enumerate(chunks, start=1)
            ],
        }
        (directory / f"scene-{scene_id}-external-ai-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
            )
            archive.writestr("INSTRUCOES.md", _instructions())
            legacy_source = {**source, "schema_version": "nova-generator-editorial-input/1.3"}
            legacy_template = _template(scene_id, input_sha256, "", cues) | {
                "schema_version": "nova-generator-editorial-suggestions/1.3"
            }
            archive.writestr(
                "editorial_input.json",
                json.dumps(legacy_source, ensure_ascii=False, indent=2) + "\n",
            )
            archive.writestr(
                "editorial_result_template.json",
                json.dumps(legacy_template, ensure_ascii=False, indent=2) + "\n",
            )
            for item, chunk in zip(manifest["chunks"], chunks, strict=True):
                chunk_source = {**source, "chunk": item, "cues": [asdict(cue) for cue in chunk]}
                template = _template(scene_id, input_sha256, item["id"], chunk)
                prefix = f"chunks/{item['index']:03d}-{item['id']}"
                archive.writestr(
                    f"{prefix}-input.json",
                    json.dumps(chunk_source, ensure_ascii=False, indent=2) + "\n",
                )
                archive.writestr(
                    f"{prefix}-result.json",
                    json.dumps(template, ensure_ascii=False, indent=2) + "\n",
                )
                archive.writestr(f"{prefix}-prompt.md", _chunk_prompt(chunk_source, template))
        return package

    def import_result(self, scene_id: UUID, content: bytes) -> EditorialAssistanceResult:
        if not content or len(content) > self._maximum_result_bytes:
            raise EditorialAssistanceError("external result is empty or too large")
        try:
            document = _ExternalResult.model_validate_json(content)
        except ValidationError as error:
            raise EditorialAssistanceError("external result does not match the contract") from error
        if document.schema_version in {
            "nova-generator-editorial-suggestions/1.4",
            "nova-generator-editorial-suggestions/1.5",
        }:
            return self._import_chunk(scene_id, document, content)
        input_sha256, cues = build_editorial_prompt(self._repository, scene_id)
        result = _as_result(document)
        validated = validate_editorial_result(
            result,
            scene_id=scene_id,
            input_sha256=input_sha256,
            cues=cues,
            require_word_translations=document.schema_version.endswith(("/1.2", "/1.3")),
            require_word_revisions=document.schema_version.endswith("/1.3"),
        )
        project_id = self._repository.get_scene_project_id(scene_id)
        assert project_id is not None
        destination = (
            self._project_root
            / str(project_id)
            / "editorial-ai"
            / f"scene-{scene_id}-external-result.json"
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        return validated

    def import_batch(
        self, scene_id: UUID, uploads: list[tuple[str, bytes]]
    ) -> EditorialAssistanceResult:
        """Preflight every external chunk, then persist one atomic scene revision."""
        if not uploads or len(uploads) > 24:
            raise EditorialAssistanceError("select between 1 and 24 JSON files, or one ZIP")
        expanded: list[tuple[str, bytes]] = []
        for name, payload in uploads:
            if not payload:
                raise EditorialAssistanceError(f"{name}: empty file")
            if name.lower().endswith(".zip"):
                try:
                    with zipfile.ZipFile(BytesIO(payload)) as archive:
                        candidates = [
                            item for item in archive.infolist()
                            if not item.is_dir()
                            and item.filename.lower().endswith("-result.json")
                            and not item.filename.startswith("__MACOSX/")
                        ]
                        if not candidates or len(candidates) > 24:
                            raise EditorialAssistanceError(
                                f"{name}: ZIP must contain 1 to 24 *-result.json files"
                            )
                        if sum(item.file_size for item in candidates) > 8_000_000:
                            raise EditorialAssistanceError("ZIP exceeds the allowed JSON size")
                        expanded.extend(
                            (item.filename, archive.read(item)) for item in candidates
                        )
                except (zipfile.BadZipFile, OSError, RuntimeError) as error:
                    raise EditorialAssistanceError(f"{name}: invalid ZIP archive") from error
            elif name.lower().endswith(".json"):
                expanded.append((name, payload))
            else:
                raise EditorialAssistanceError(f"{name}: only JSON or ZIP is supported")
        if not expanded or len(expanded) > 24:
            raise EditorialAssistanceError("too many result files")
        project_id = self._repository.get_scene_project_id(scene_id)
        if project_id is None:
            raise EditorialAssistanceError("scene not found")
        manifest_path = (
            self._project_root / str(project_id) / "editorial-ai"
            / f"scene-{scene_id}-external-ai-manifest.json"
        )
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise EditorialAssistanceError(
                "export the current external package before importing results"
            ) from error
        manifest_chunks = manifest.get("chunks")
        if not isinstance(manifest_chunks, list) or not manifest_chunks:
            raise EditorialAssistanceError("external package has no valid chunk manifest")
        source_hash, source_cues = build_editorial_prompt(self._repository, scene_id)
        if source_hash != manifest.get("input_sha256"):
            raise EditorialAssistanceError(
                "the scene changed; export a fresh external package before importing"
            )
        originals = {cue.id: cue for cue in source_cues}
        expected_ids = [
            cue_id for chunk in manifest_chunks for cue_id in chunk.get("cue_ids", [])
        ]
        if len(expected_ids) != len(set(expected_ids)) or set(expected_ids) != set(originals):
            raise EditorialAssistanceError("exported chunks do not match the current scene")
        documents: dict[str, tuple[_ExternalResult, bytes]] = {}
        for name, content in expanded:
            if len(content) > self._maximum_result_bytes:
                raise EditorialAssistanceError(f"{name}: result is too large")
            try:
                document = _ExternalResult.model_validate_json(content)
            except (ValidationError, ValueError) as error:
                raise EditorialAssistanceError(
                    f"{name}: {_validation_detail(error)}"
                ) from error
            if document.schema_version not in {
                "nova-generator-editorial-suggestions/1.4",
                "nova-generator-editorial-suggestions/1.5",
            }:
                raise EditorialAssistanceError(f"{name}: use chunked contract 1.4 or 1.5")
            if document.scene_id != scene_id or document.input_sha256 != source_hash:
                raise EditorialAssistanceError(f"{name}: result is for another or stale scene")
            if not document.chunk_id or document.chunk_id in documents:
                raise EditorialAssistanceError(f"{name}: missing or duplicate chunk_id")
            documents[document.chunk_id] = (document, content)
        manifest_ids = [chunk.get("id") for chunk in manifest_chunks]
        if len(set(manifest_ids)) != len(manifest_ids) or set(documents) != set(manifest_ids):
            missing = sorted(set(manifest_ids) - set(documents))
            extra = sorted(set(documents) - set(manifest_ids))
            raise EditorialAssistanceError(
                f"all chunks are required; missing: {missing}; unexpected: {extra}"
            )
        versions = {document.schema_version for document, _ in documents.values()}
        if len(versions) != 1:
            raise EditorialAssistanceError("all results must use the same contract version")
        validated_chunks: list[EditorialAssistanceResult] = []
        turns: dict[str, list[dict[str, object]]] = {}
        for chunk in manifest_chunks:
            document, _ = documents[chunk["id"]]
            expected = tuple(
                replace(originals[cue_id], order=order)
                for cue_id, order in zip(
                    chunk["cue_ids"], chunk["cue_orders"], strict=True
                )
            )
            validated = validate_editorial_result(
                _as_result(document),
                scene_id=scene_id,
                input_sha256=source_hash,
                cues=expected,
                require_word_translations=True,
                require_word_revisions=True,
            )
            validated_chunks.append(validated)
            turns.update({
                item.cue_id: [turn.model_dump() for turn in item.speaker_turns]
                for item in document.suggestions
            })
        first = validated_chunks[0]
        combined = EditorialAssistanceResult(
            scene_id=str(scene_id),
            input_sha256=source_hash,
            provider="external",
            model="external-ai",
            suggestions=tuple(
                suggestion
                for chunk in validated_chunks for suggestion in chunk.suggestions
            ),
            rate_limits={},
            contract_version=first.contract_version,
        )
        if combined.contract_version == "nova-generator-editorial-suggestions/1.5":
            persist_editorial_chunk_with_speaker_turns(
                self._repository,
                combined,
                turns,
                author="external-editorial-assistant",
                merge_with_previous={
                    item.cue_id
                    for chunk in manifest_chunks
                    for item in documents[chunk["id"]][0].suggestions
                    if item.merge_with_previous
                },
            )
        else:
            persist_editorial_chunk_preparation(
                self._repository, combined, author="external-editorial-assistant"
            )
        for chunk in manifest_chunks:
            _document, content = documents[chunk["id"]]
            (manifest_path.parent / f"scene-{scene_id}-{chunk['id']}-external-result.json"
            ).write_bytes(content)
        return combined

    def _import_chunk(
        self, scene_id: UUID, document: _ExternalResult, content: bytes
    ) -> EditorialAssistanceResult:
        if not document.chunk_id:
            raise EditorialAssistanceError("external chunk result is missing chunk_id")
        project_id = self._repository.get_scene_project_id(scene_id)
        if project_id is None:
            raise EditorialAssistanceError("scene not found")
        manifest_path = (
            self._project_root
            / str(project_id)
            / "editorial-ai"
            / f"scene-{scene_id}-external-ai-manifest.json"
        )
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise EditorialAssistanceError(
                "export a current external text package before importing chunks"
            ) from error
        if document.scene_id != scene_id or document.input_sha256 != manifest.get("input_sha256"):
            raise EditorialAssistanceError(
                "external chunk is stale for the current exported package"
            )
        chunk = next(
            (item for item in manifest.get("chunks", []) if item.get("id") == document.chunk_id),
            None,
        )
        if not isinstance(chunk, dict):
            raise EditorialAssistanceError("external chunk is not part of this package")
        _current_hash, all_cues = build_editorial_prompt(self._repository, scene_id)
        expected_ids = chunk.get("cue_ids", [])
        expected_orders = chunk.get("cue_orders", [])
        current_by_id = {cue.id: cue for cue in all_cues}
        if (
            not isinstance(expected_ids, list)
            or not isinstance(expected_orders, list)
            or len(expected_ids) != len(expected_orders)
            or any(cue_id not in current_by_id for cue_id in expected_ids)
        ):
            raise EditorialAssistanceError("scene changed; export a new external text package")
        # Earlier 1.5 chunks can expand cues, shifting downstream scene orders.
        # Validate against the immutable exported order, not the live scene order.
        expected = tuple(
            replace(current_by_id[cue_id], order=order)
            for cue_id, order in zip(expected_ids, expected_orders, strict=True)
        )
        result = _as_result(document)
        validated = validate_editorial_result(
            result,
            scene_id=scene_id,
            input_sha256=document.input_sha256,
            cues=expected,
            require_word_translations=True,
            require_word_revisions=True,
        )
        destination = (
            manifest_path.parent / f"scene-{scene_id}-{document.chunk_id}-external-result.json"
        )
        destination.write_bytes(content)
        if document.schema_version.endswith("/1.5"):
            persist_editorial_chunk_with_speaker_turns(
                self._repository,
                validated,
                {
                    item.cue_id: [turn.model_dump() for turn in item.speaker_turns]
                    for item in document.suggestions
                },
                author="external-editorial-assistant",
                merge_with_previous={
                    item.cue_id for item in document.suggestions if item.merge_with_previous
                },
            )
        else:
            persist_editorial_chunk_preparation(
                self._repository, validated, author="external-editorial-assistant"
            )
        return validated


def _validation_detail(error: ValidationError | ValueError) -> str:
    if isinstance(error, ValidationError):
        item = error.errors()[0]
        location = ".".join(str(part) for part in item["loc"])
        return f"invalid contract at {location}: {item['msg']}"
    return str(error)


def _instructions() -> str:
    return """# Assistência editorial externa em blocos

Este pacote contém somente texto: não há vídeo nem áudio. Por isso, inferências de
interlocutores e tempos devem ser conservadoras e baseadas nos word_ids e
timestamps disponíveis. Abra cada arquivo
`chunks/*-prompt.md`, cole-o em uma conversa nova da Groq e salve a resposta como JSON no
arquivo `chunks/*-result.json` correspondente. Envie os retornos um a um ao Generator; cada
bloco é validado e aplicado imediatamente. Nunca misture cues de blocos diferentes.

Use o `*-input.json` como fonte canônica.
Preencha `approved_en`, `approved_pt`, `notes`, `word_translations` e `semantic_units` no arquivo
de modelo. `word_translations` é a revisão completa do word-by-word. Deve conter todas as palavras
na ordem recebida, com `word_id` e `order` inalterados; preserve ou corrija `leading`, `surface`,
`start_ms` e `end_ms`, mantenha o `trailing` literal da cue e escreva a tradução contextual natural
em `pt`. Nenhum campo textual
obrigatório pode ficar vazio. Não sobreponha tempos nem mova uma palavra para fora do intervalo
de fala do cue. Os tempos e a confiança no arquivo de entrada ajudam a conferir o áudio.
Quando `requires_reconciliation` for verdadeiro, `current_en` e `word_by_word_en` já divergiam na
entrada. Ouça o trecho e devolva uma única versão reconciliada nos campos de palavra e em
`approved_en`; nunca esconda letras ou pontuação dentro de `leading`.
O Generator reconstruirá `approved_en` concatenando exatamente `leading + surface` de cada
palavra e acrescentando `trailing`. Essa reconstrução deve ser idêntica, byte a byte, ao
`approved_en`, inclusive espaços,
acentos, apóstrofos, aspas, vírgulas, pontos, perguntas e reticências.
Cada unidade semântica deve ter `word_ids` contíguos, na ordem recebida, e uma única tradução
brasileira natural em `pt`. Agrupe phrasal verbs, expressões, collocations, auxiliares/negações e
sequências cuja tradução palavra por palavra soe mecânica. Exemplo: agrupe `Can I help?` e use
`Posso ajudar?`, nunca `Posso eu ajudar?`. Não crie grupos de uma palavra nem grupos sobrepostos.
Mantenha `scene_id`, `input_sha256`, `cue_id`, `order`, a quantidade e a ordem sem alterações.
Corrija o inglês somente quando necessário e traduza para português brasileiro natural.
Preserve nomes, acentos, apóstrofos, aspas, vírgulas, pontos, perguntas e reticências.
Não invente, apague ou troque a ordem das falas. Organize os turnos com coerência:
UMA cue pode conter várias frases, vocativos e interjeições da MESMA pessoa.
Não divida apenas por ponto final, exclamação, respiração ou mudança de assunto.
"Nunca volto! Lizzie!" deve permanecer na MESMA cue se ambos vierem da mesma voz.
Só forneça speaker_turns quando houver real mudança de interlocutor; nunca crie
dois turnos consecutivos com o mesmo speaker. Mantenha rótulos consistentes em toda cena.
No contrato 1.5, quando houver certeza suficiente, forneça speaker_turns com pelo menos
dois turnos, cada um contendo speaker, approved_pt, confidence e word_ids contíguos.
A concatenação dos word_ids de todos os turnos deve corresponder exatamente à sequência
original de palavras da cue, sem repetir, perder nem reordenar palavras.
Use nomes de interlocutor somente quando sustentados pelo contexto; quando não for possível
identificar a pessoa, utilize um identificador neutro, como "speaker_2".
Não infira tempos por proporção do texto: os novos limites são obtidos dos timestamps
das palavras na fronteira de cada turno. Preserve gaps e nunca permita sobreposição.
Se não houver evidência suficiente de alternância ou de limites temporais confiáveis,
deixe speaker_turns vazio e indique a dúvida em notes.
Evite grupos semânticos que cruzem as fronteiras de speaker_turns.
Se duas cues ORIGINAIS consecutivas representam a continuação imediata da fala
da mesma pessoa (por exemplo uma cue só com "Lizzie!"), marque merge_with_previous=true
na segunda suggestion, preservando seu cue_id e suas palavras. A união será realizada
pelo Generator após validar o pacote inteiro. Nunca una falas de pessoas distintas
e nunca una somente porque são frases curtas; leve em conta speaker, vocativo,
pontuação, contexto e tempo entre as falas. Em caso de dúvida, deixe false em
merge_with_previous e explique em notes. Não invente tempos, não apague palavras.
Devolva somente o JSON preenchido. O Generator o importará como sugestão de rascunho.
"""


def _template(
    scene_id: UUID, input_sha256: str, chunk_id: str, cues: tuple[EditorialCuePrompt, ...]
) -> dict[str, object]:
    return {
        "schema_version": "nova-generator-editorial-suggestions/1.5",
        "scene_id": str(scene_id),
        "input_sha256": input_sha256,
        "chunk_id": chunk_id,
        "suggestions": [
            {
                "cue_id": cue.id,
                "order": cue.order,
                "approved_en": cue.word_by_word_en,
                "approved_pt": cue.current_pt,
                "notes": "",
                "word_translations": [
                    {
                        "word_id": word.id,
                        "order": word.order,
                        "leading": word.leading,
                        "surface": word.surface,
                        "start_ms": word.start_ms,
                        "end_ms": word.end_ms,
                        "pt": "",
                    }
                    for word in cue.words
                ],
                "semantic_units": [],
                "speaker_turns": [],
                "merge_with_previous": False,
                "trailing": cue.trailing,
            }
            for cue in cues
        ],
    }


def _chunk_prompt(source: dict[str, object], template: dict[str, object]) -> str:
    return (
        """Você é o revisor editorial bilíngue do Nova Generator. Devolva SOMENTE um JSON válido,
sem markdown e sem explicações. Complete o JSON de resposta abaixo sem alterar schema_version,
scene_id, input_sha256, chunk_id, cue_id, ordem ou ids. Preserve literalmente pontuação e espaços.
Use português brasileiro natural e crie unidades semânticas para expressões como phrasal verbs;
por exemplo, “Can I help?” deve ser “Posso ajudar?”, nunca uma tradução mecânica palavra a palavra.
Cada palavra precisa manter seu tempo dentro do cue e ter uma tradução contextual.
Procure ativamente trocas de interlocutor dentro das cues. Não presuma que o áudio
contém uma só pessoa por cue. Se houver alternância, documente em notes uma proposta
SPEAKER_SPLIT_PROPOSAL: fronteiras por word_id, trechos, speakers inferidos e grau de
certeza. Preserve sempre os IDs de origem no JSON de resposta 1.5.
Para dividir, preencha speaker_turns com word_ids contíguos na ordem, speaker, approved_pt
e confidence (high, medium ou uncertain). A soma dos turnos deve incluir TODAS as palavras
da cue, sem repetições. Deixe [] quando não houver mudança confiável.
NÃO isole vocativos ("Lizzie!") ou interjeições se pertencem à mesma fala.
Não gere speaker_turns consecutivos com o mesmo interlocutor.
Para continuar a fala entre duas cues originais, use merge_with_previous=true na
suggestion da segunda cue; faça isso apenas se for a mesma pessoa e não existir
pausa significativa. Caso incerto, deixe false e registre o motivo em notes.
Preserve os tempos originais das palavras; só corrija valores quando houver evidência
no áudio ou nos timestamps fornecidos. A sequência final deve ser cronológica e sem
sobreposições; NÃO invente tempos para fazer a divisão parecer precisa.

ENTRADA CANÔNICA:
```json
"""
        + json.dumps(source, ensure_ascii=False, separators=(",", ":"))
        + """
```

JSON A PREENCHER:
```json
"""
        + json.dumps(template, ensure_ascii=False, separators=(",", ":"))
        + """
```
"""
    )


def _as_result(document: _ExternalResult) -> EditorialAssistanceResult:
    return EditorialAssistanceResult(
        scene_id=str(document.scene_id),
        input_sha256=document.input_sha256,
        provider="external",
        model="external-ai",
        suggestions=tuple(
            EditorialSuggestion(
                cue_id=item.cue_id,
                order=item.order,
                approved_en=item.approved_en,
                approved_pt=item.approved_pt,
                notes=item.notes,
                word_translations=tuple(
                    EditorialWordTranslation(
                        word.word_id,
                        word.pt,
                        word.order,
                        word.leading,
                        word.surface,
                        word.start_ms,
                        word.end_ms,
                    )
                    for word in item.word_translations
                ),
                semantic_units=tuple(
                    EditorialSemanticUnit(tuple(unit.word_ids), unit.pt)
                    for unit in item.semantic_units
                ),
                trailing=item.trailing,
            )
            for item in document.suggestions
        ),
        rate_limits={},
        contract_version=document.schema_version,
    )
