"""Import one combined editorial + pedagogy answer before human review."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.application.use_cases.editorial_assistance import (
    build_editorial_prompt,
    persist_editorial_preparation,
    validate_editorial_result,
)
from nova_generator.application.use_cases.external_editorial_exchange import (
    _as_result,
    _ExternalResult,
)
from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialOutput,
    MaterialsAiExchange,
)
from nova_generator.application.use_cases.pre_editorial_package import (
    OUTPUT_CONTRACT,
    PreEditorialPackage,
    PreparationPackageError,
)
from nova_generator.application.use_cases.review_asr_candidate import ReviewAsrCandidate


class _UnifiedResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract: str
    project_id: UUID
    scene_id: UUID
    input_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    editorial: dict[str, Any]
    materials: dict[str, Any]


class UnifiedPreparationExchange:
    def __init__(
        self,
        repository: EditorialProjectRepository,
        jobs: JobRepository,
        project_root: Path,
    ) -> None:
        self.repository = repository
        self.jobs = jobs
        self.project_root = project_root
        self.preparation = PreEditorialPackage(project_root)

    def import_result(self, project_id: UUID, ingest_job_id: UUID, raw: Any) -> dict[str, Any]:
        try:
            payload = _UnifiedResult.model_validate(raw)
        except ValidationError as error:
            raise PreparationPackageError(f"Resposta unificada inválida: {error}") from error
        original = self.preparation.load(project_id, payload.scene_id)
        if not original:
            raise PreparationPackageError("Pacote inicial não encontrado; finalize a transcrição")
        if (
            payload.contract != OUTPUT_CONTRACT
            or payload.project_id != project_id
            or payload.scene_id != UUID(original["scene_id"])
            or payload.input_sha256 != original["input_sha256"]
            or str(ingest_job_id) != original["ingest_job_id"]
        ):
            raise PreparationPackageError(
                "O retorno pertence a outro projeto ou a uma transcrição antiga"
            )

        result_file = (
            self.project_root / str(project_id) / "preparation" / f"{payload.scene_id}-result.json"
        )
        if result_file.is_file():
            previous = json.loads(result_file.read_text(encoding="utf-8"))
            if previous == raw:
                return {"status": "draft", "scene_id": str(payload.scene_id), "reused": True}
            raise PreparationPackageError("Já existe um retorno importado; revise o material salvo")

        # Only the existing ASR candidate materializer creates editorial records.
        ReviewAsrCandidate(self.repository, self.jobs).execute(
            project_id, ingest_job_id, author="unified-ai-preparation"
        )
        current_hash, prompts = build_editorial_prompt(self.repository, payload.scene_id)
        if current_hash != payload.input_sha256:
            raise PreparationPackageError("O Editorial foi modificado; o retorno está obsoleto")
        try:
            editorial_payload = _ExternalResult.model_validate(payload.editorial)
        except ValidationError as error:
            raise PreparationPackageError(f"Editorial inválido: {error}") from error
        if editorial_payload.schema_version != "nova-generator-editorial-suggestions/1.3":
            raise PreparationPackageError("O retorno unificado exige contrato editorial 1.3")
        editorial = validate_editorial_result(
            _as_result(editorial_payload),
            scene_id=payload.scene_id,
            input_sha256=current_hash,
            cues=prompts,
            require_word_translations=True,
            require_word_revisions=True,
        )
        project = self.repository.get_project(project_id)
        assert project is not None
        proposed = {
            "contract": "nova-generator-materials-output/1.0",
            "project_id": str(project_id),
            "source_sha256": "0" * 64,
            "title": project.title,
            **payload.materials,
        }
        try:
            material = MaterialOutput.model_validate(proposed)
        except ValidationError as error:
            raise PreparationPackageError(f"Materiais ou Anki inválidos: {error}") from error
        expected_sections = (
            "learning_path", "vocabulary", "structures", "guided_practice",
            "activities", "challenge", "review",
        )
        if tuple(section.id for section in material.sections) != expected_sections:
            raise PreparationPackageError("As sete seções estão incompletas ou fora de ordem")
        if any(
            not section.exercises
            for section in material.sections
            if section.id in {"guided_practice", "activities", "challenge"}
        ):
            raise PreparationPackageError("Prática, atividades e desafio exigem respostas")
        expected = {suggestion.cue_id: suggestion for suggestion in editorial.suggestions}
        seen = set()
        for card in material.anki_cards:
            cue_id = str(card.cue_id)
            cue = expected.get(cue_id)
            if cue is None or cue_id in seen:
                raise PreparationPackageError("Anki contém cue desconhecida ou repetida")
            seen.add(cue_id)
            if card.front_en != cue.approved_en or card.back_pt != cue.approved_pt:
                raise PreparationPackageError(f"Anki {cue_id} difere do texto editorial proposto")
            if card.marked_en and card.marked_en.casefold() not in card.front_en.casefold():
                raise PreparationPackageError(f"Destaque inglês inválido no Anki {cue_id}")
            if card.marked_pt and card.marked_pt.casefold() not in card.back_pt.casefold():
                raise PreparationPackageError(f"Destaque português inválido no Anki {cue_id}")
            if bool(card.example_en.strip()) != bool(card.example_pt.strip()):
                raise PreparationPackageError(f"Exemplos EN/PT incompletos no Anki {cue_id}")

        persist_editorial_preparation(
            self.repository, editorial, author="unified-ai-preparation"
        )
        # Apply the AI's pedagogical selection once. The operator may later
        # include/exclude individual Anki cards in Materials as usual.
        included_ids = {str(card.cue_id) for card in material.anki_cards}
        for cue in self.repository.get_scene_cues(payload.scene_id):
            if "anki_included" in cue.provenance:
                continue
            updated = replace(
                cue,
                provenance={
                    **cue.provenance,
                    "anki_included": str(cue.id) in included_ids,
                },
            )
            self.repository.save_cue(updated, self.repository.get_cue_words(cue.id))
        materials_exchange = MaterialsAiExchange(self.repository, self.project_root)
        proposed["source_sha256"] = materials_exchange.package(project_id)["source_sha256"]
        materials_exchange.import_result(project_id, proposed)
        result_file.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return {
            "status": "draft",
            "scene_id": str(payload.scene_id),
            "materials_status": "draft",
            "anki_cards": len(material.anki_cards),
            "reused": False,
        }

    def generate_groq(
        self, project_id: UUID, ingest_job_id: UUID, *,
        api_key: str | None, model: str, client: Any | None = None,
    ) -> dict[str, Any]:
        scene_id = uuid5(NAMESPACE_URL, f"nova-generator/asr-scene/{ingest_job_id}")
        package = self.preparation.load(project_id, scene_id)
        if not package:
            raise PreparationPackageError("Conclua a transcrição antes de chamar a IA")
        if client is None:
            if not api_key:
                raise PreparationPackageError("Groq não configurada. Use o pacote de IA externa")
            from groq import Groq
            client = Groq(api_key=api_key, timeout=120, max_retries=0)
        try:
            response = client.chat.completions.create(
                model=model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a bilingual editorial and English learning curriculum editor. "
                            "Return only one JSON object matching instructions.output_shape. "
                            "Correct and translate all cues with word-level alignment "
                            "and contextual semantic units. Produce seven sections "
                            "with answers and selected Anki mini-lessons in the same "
                            "response. Never modify Shadowing. Preserve every "
                            "ID, timestamp and literal spacing rule."
                        ),
                    },
                    {"role": "user", "content": json.dumps(package, ensure_ascii=False)},
                ],
            )
            content = response.choices[0].message.content
            if not isinstance(content, str):
                raise ValueError("A Groq não retornou texto")
            result = json.loads(content)
        except (ValueError, TypeError, KeyError, IndexError) as error:
            raise PreparationPackageError(f"Groq retornou JSON inválido: {error}") from error
        return self.import_result(project_id, ingest_job_id, result)
