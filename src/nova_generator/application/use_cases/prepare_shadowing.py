"""Editable, source-checked shadowing plan built from approved cues only."""

from __future__ import annotations

import json
import os
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue, Scene


class ShadowingError(ValueError):
    pass


CONTRACT = "nova-generator-shadowing/2.0"
PROPOSAL_CONTRACT = "nova-generator-shadowing-proposal/1.0"
MAX_BLOCK_MS = 6_500
MAX_BLOCK_WORDS = 14
MAX_CUE_GAP_MS = 1_000
MIN_PAUSE_MS = 2_000
MAX_PAUSE_MS = 9_000
PAUSE_MARGIN_MS = 1_600


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Group(_StrictModel):
    cue_ids: list[UUID] = Field(min_length=1, max_length=20)


class _Proposal(_StrictModel):
    contract: str
    scene_id: UUID
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    groups: list[_Group] = Field(max_length=250)


class PrepareShadowing:
    """Separate editorial identity, AI suggestions, editable selection and human approval."""

    def __init__(self, repository: EditorialProjectRepository, project_root: Path):
        self.repository = repository
        self.project_root = project_root

    def scenes(self, project_id: UUID) -> list[dict[str, Any]]:
        if self.repository.get_project(project_id) is None:
            raise ShadowingError("project not found")
        return [
            self.scene(project_id, scene.id)
            for scene in self.repository.get_project_scenes(project_id)
        ]

    def scene(self, project_id: UUID, scene_id: UUID) -> dict[str, Any]:
        scene, cues, fingerprint = self._source(project_id, scene_id)
        stored = self._read(project_id, scene_id)
        if (
            stored is not None
            and stored.get("contract") == CONTRACT
            and stored.get("source_sha256") == fingerprint
        ):
            try:
                groups = _group_ids(stored["blocks"])
                blocks = _validated_blocks(cues, groups)
                plan_hash = _plan_hash(fingerprint, blocks)
                if stored["plan_sha256"] == plan_hash:
                    return self._public(
                        project_id,
                        scene,
                        cues,
                        fingerprint,
                        blocks,
                        status="approved" if stored.get("status") == "approved" else "draft",
                        origin=str(stored.get("origin", "manual")),
                    )
            except (KeyError, TypeError, ValueError, ShadowingError):
                pass
        return self._public(
            project_id,
            scene,
            cues,
            fingerprint,
            _validated_blocks(cues, _automatic_groups(cues)),
            status="draft",
            origin="automatic",
        )

    def package(self, project_id: UUID, scene_id: UUID) -> dict[str, Any]:
        plan = self.scene(project_id, scene_id)
        return {
            "contract": "nova-generator-shadowing-input/1.0",
            "project_id": str(project_id),
            "scene_id": str(scene_id),
            "source_sha256": plan["source_sha256"],
            "constraints": {
                "max_duration_ms": MAX_BLOCK_MS,
                "max_words": MAX_BLOCK_WORDS,
                "max_gap_ms": MAX_CUE_GAP_MS,
                "same_speaker": True,
                "contiguous_cues_per_group": True,
                "optional_cues": True,
            },
            "cues": plan["source_cues"],
            "instructions": (
                "Selecione falas curtas e naturais para praticar inglês. "
                "Cada grupo deve usar apenas cues consecutivos do MESMO personagem, sem misturar "
                "interlocutores ou ultrapassar 6,5 segundos e 14 palavras. "
                "Pode omitir qualquer cue inadequado. Não altere, traduza, reescreva, fragmente "
                "ou invente cues, IDs, timestamps ou texto. Devolva somente JSON com os campos "
                "contract, scene_id, source_sha256 e groups; cada grupo contém somente cue_ids. "
                f"Use contract={PROPOSAL_CONTRACT} e os mesmos hashes e IDs deste pacote."
            ),
            "output_example": {
                "contract": PROPOSAL_CONTRACT,
                "scene_id": str(scene_id),
                "source_sha256": plan["source_sha256"],
                "groups": [{"cue_ids": [plan["source_cues"][0]["id"]]}],
            },
        }

    def import_result(
        self, project_id: UUID, scene_id: UUID, document: Any, *, origin: str = "external"
    ) -> dict[str, Any]:
        try:
            proposal = _Proposal.model_validate(document)
        except ValidationError as error:
            raise ShadowingError(f"JSON de Shadowing inválido: {error}") from error
        if proposal.contract != PROPOSAL_CONTRACT or proposal.scene_id != scene_id:
            raise ShadowingError("A proposta não corresponde a esta cena ou contrato")
        return self._change(
            project_id,
            scene_id,
            proposal.source_sha256,
            [[str(cue_id) for cue_id in group.cue_ids] for group in proposal.groups],
            origin=origin,
        )

    def edit(
        self,
        project_id: UUID,
        scene_id: UUID,
        source_sha256: str,
        plan_sha256: str,
        groups: list[list[str]],
    ) -> dict[str, Any]:
        current = self.scene(project_id, scene_id)
        if plan_sha256 != current["plan_sha256"]:
            raise ShadowingError("O plano mudou. Atualize a cena antes de editar.")
        return self._change(
            project_id, scene_id, source_sha256, groups, origin="manual"
        )

    def approve(
        self,
        project_id: UUID,
        scene_id: UUID,
        source_sha256: str,
        plan_sha256: str | None = None,
    ) -> dict[str, Any]:
        plan = self.scene(project_id, scene_id)
        if plan["source_sha256"] != source_sha256:
            raise ShadowingError("editorial content changed; reload shadowing")
        if plan_sha256 is not None and plan_sha256 != plan["plan_sha256"]:
            raise ShadowingError("O plano mudou desde a prévia. Reproduza e aprove a versão atual.")
        if not plan["blocks"]:
            raise ShadowingError("Selecione ao menos um trecho curto para aprovar o Shadowing")
        result = {**plan, "status": "approved"}
        self._write(project_id, scene_id, result)
        return result

    def generate_groq(
        self,
        project_id: UUID,
        scene_id: UUID,
        *,
        api_key: str | None,
        model: str,
        client: Any | None = None,
    ) -> dict[str, Any]:
        if client is None:
            if not api_key:
                raise ShadowingError(
                    "Groq não configurada. Baixe o pacote e importe a proposta de IA externa."
                )
            try:
                from groq import Groq  # pyright: ignore[reportMissingImports]
            except ImportError as error:
                raise ShadowingError(
                    "O SDK Groq não está instalado. Use a opção de IA externa."
                ) from error
            client = Groq(api_key=api_key, timeout=60, max_retries=0)

        package = self.package(project_id, scene_id)
        try:
            response = client.chat.completions.create(
                model=model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You design short Brazilian Portuguese learner shadowing exercises. "
                            "Return JSON only. Never edit source or invent cue IDs. "
                            "Select pedagogically useful, easy-to-repeat fragments. "
                            "One speaker per group. Strictly comply with max duration, word count, "
                            "contiguous cue order and source hash. Omit long or mixed-speaker cues."
                        ),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(package, ensure_ascii=False, separators=(",", ":")),
                    },
                ],
            )
            content = response.choices[0].message.content
            if not isinstance(content, str):
                raise ValueError("A Groq não retornou um JSON")
            document = json.loads(content)
        except (ValueError, TypeError, IndexError, KeyError) as error:
            raise ShadowingError(f"Resposta inválida da Groq: {error}") from error
        except Exception as error:
            status = getattr(error, "status_code", None)
            if status == 429:
                raise ShadowingError(
                    "Limite da Groq atingido. Aguarde ou use a IA externa."
                ) from error
            raise ShadowingError(
                "Falha ao gerar Shadowing na Groq. Tente novamente ou use a IA externa."
            ) from error
        return self.import_result(project_id, scene_id, document, origin="groq")

    def _change(
        self,
        project_id: UUID,
        scene_id: UUID,
        source_sha256: str,
        groups: list[list[str]],
        *,
        origin: str,
    ) -> dict[str, Any]:
        scene, cues, fingerprint = self._source(project_id, scene_id)
        if source_sha256 != fingerprint:
            raise ShadowingError("O Editorial mudou. Recarregue a cena e gere outra proposta.")
        blocks = _validated_blocks(cues, groups)
        result = self._public(
            project_id, scene, cues, fingerprint, blocks, status="draft", origin=origin
        )
        self._write(project_id, scene_id, result)
        return result

    def _source(self, project_id: UUID, scene_id: UUID) -> tuple[Scene, list[Cue], str]:
        project = self.repository.get_project(project_id)
        scene = next(
            (
                item
                for item in self.repository.get_project_scenes(project_id)
                if item.id == scene_id
            ),
            None,
        ) if project is not None else None
        if scene is None:
            raise ShadowingError("scene not found in project")
        cues = sorted(self.repository.get_scene_cues(scene_id), key=lambda item: item.order)
        if not cues:
            raise ShadowingError("scene has no reviewed cues")
        for cue in cues:
            if (
                cue.provenance.get("approval") == "draft"
                or not cue.approved_en.strip()
                or not cue.approved_pt.strip()
            ):
                raise ShadowingError("approve all cues before preparing shadowing")
            if (
                cue.speech_start_ms < 0
                or cue.speech_end_ms <= cue.speech_start_ms
                or cue.speech_end_ms > scene.duration_ms
            ):
                raise ShadowingError(f"cue {cue.order} has invalid timing")
        snapshot = _snapshot(scene, cues)
        fingerprint = _digest(snapshot)
        return scene, cues, fingerprint

    def _public(
        self,
        project_id: UUID,
        scene: Scene,
        cues: list[Cue],
        fingerprint: str,
        blocks: list[dict[str, Any]],
        *,
        status: str,
        origin: str,
    ) -> dict[str, Any]:
        selected = {cue_id for block in blocks for cue_id in block["cue_ids"]}
        source_cues = [
            {
                "id": str(cue.id),
                "order": cue.order,
                "speaker": cue.speaker.strip() or "Não identificado",
                "start_ms": cue.speech_start_ms,
                "end_ms": cue.speech_end_ms,
                "en": cue.approved_en,
                "pt": cue.approved_pt,
                "eligible": _cue_is_short(cue),
            }
            for cue in cues
        ]
        excluded = [
            {
                **item,
                "reason": (
                    "Fala longa demais. Divida o cue no Editorial para incluí-lo."
                    if not item["eligible"]
                    else "Não selecionado para esta prática"
                ),
            }
            for item in source_cues
            if item["id"] not in selected
        ]
        return {
            "contract": CONTRACT,
            "project_id": str(project_id),
            "scene_id": str(scene.id),
            "source_sha256": fingerprint,
            "plan_sha256": _plan_hash(fingerprint, blocks),
            "duration_ms": scene.duration_ms,
            "status": status,
            "origin": origin,
            "blocks": blocks,
            "source_cues": source_cues,
            "excluded_cues": excluded,
        }

    def _path(self, project_id: UUID, scene_id: UUID) -> Path:
        return self.project_root / str(project_id) / "shadowing" / f"{scene_id}.json"

    def _read(self, project_id: UUID, scene_id: UUID) -> dict[str, Any] | None:
        try:
            data = json.loads(self._path(project_id, scene_id).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def _write(self, project_id: UUID, scene_id: UUID, data: dict[str, Any]) -> None:
        path = self._path(project_id, scene_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def _digest(value: object) -> str:
    return sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()


def _snapshot(scene: Scene, cues: list[Cue]) -> dict[str, Any]:
    return {
        "scene_id": str(scene.id),
        "duration_ms": scene.duration_ms,
        "cues": [
            {
                "id": str(cue.id),
                "order": cue.order,
                "revision": cue.revision,
                "speaker": cue.speaker,
                "start_ms": cue.speech_start_ms,
                "end_ms": cue.speech_end_ms,
                "en": cue.approved_en,
                "pt": cue.approved_pt,
            }
            for cue in cues
        ],
    }


def _cue_is_short(cue: Cue) -> bool:
    return (
        cue.speech_end_ms - cue.speech_start_ms <= MAX_BLOCK_MS
        and len(cue.approved_en.split()) <= MAX_BLOCK_WORDS
    )


def _automatic_groups(cues: list[Cue]) -> list[list[str]]:
    groups: list[list[str]] = []
    for cue in cues:
        if not _cue_is_short(cue):
            continue
        if groups:
            previous = next(item for item in reversed(cues) if str(item.id) == groups[-1][-1])
            last_group_cues = [item for item in cues if str(item.id) in groups[-1]]
            same_speaker = bool(cue.speaker.strip()) and cue.speaker == previous.speaker
            contiguous = cues.index(cue) == cues.index(previous) + 1
            duration = cue.speech_end_ms - last_group_cues[0].speech_start_ms
            words = sum(len(item.approved_en.split()) for item in last_group_cues)
            if (
                same_speaker
                and contiguous
                and 0 <= cue.speech_start_ms - previous.speech_end_ms <= MAX_CUE_GAP_MS
                and duration <= MAX_BLOCK_MS
                and words + len(cue.approved_en.split()) <= MAX_BLOCK_WORDS
            ):
                groups[-1].append(str(cue.id))
                continue
        groups.append([str(cue.id)])
    return groups


def _group_ids(blocks: Any) -> list[list[str]]:
    if not isinstance(blocks, list):
        raise ShadowingError("invalid stored blocks")
    return [list(block["cue_ids"]) for block in blocks]


def _validated_blocks(cues: list[Cue], groups: list[list[str]]) -> list[dict[str, Any]]:
    if not isinstance(groups, list) or len(groups) > len(cues):
        raise ShadowingError("Quantidade inválida de grupos de shadowing")
    index = {str(cue.id): (position, cue) for position, cue in enumerate(cues)}
    used: set[str] = set()
    previous_position = -1
    blocks: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, list) or not 1 <= len(group) <= 20:
            raise ShadowingError("Cada grupo deve conter de 1 a 20 cues")
        if any(not isinstance(cue_id, str) or cue_id not in index for cue_id in group):
            raise ShadowingError("A proposta contém cue inexistente nesta cena")
        positions = [index[cue_id][0] for cue_id in group]
        if positions != list(range(positions[0], positions[0] + len(group))):
            raise ShadowingError("Junte somente cues consecutivos, sem pular falas")
        if positions[0] <= previous_position or used.intersection(group):
            raise ShadowingError("Os cues devem estar em ordem e aparecer apenas uma vez")
        selected = [index[cue_id][1] for cue_id in group]
        speaker = selected[0].speaker.strip()
        if len(selected) > 1 and (
            not speaker or any(item.speaker.strip() != speaker for item in selected[1:])
        ):
            raise ShadowingError("Um grupo de Shadowing não pode misturar personagens")
        if any(
            right.speech_start_ms < left.speech_end_ms
            or right.speech_start_ms - left.speech_end_ms > MAX_CUE_GAP_MS
            for left, right in zip(selected, selected[1:], strict=False)
        ):
            raise ShadowingError("A pausa entre cues é longa demais para uma única prática")
        start_ms = selected[0].speech_start_ms
        end_ms = selected[-1].speech_end_ms
        word_count = sum(len(item.approved_en.split()) for item in selected)
        if end_ms - start_ms > MAX_BLOCK_MS or word_count > MAX_BLOCK_WORDS:
            raise ShadowingError(
                f"Prática longa demais: limite de {MAX_BLOCK_MS / 1000:g} s e "
                f"{MAX_BLOCK_WORDS} palavras por grupo"
            )
        previous_position = positions[-1]
        used.update(group)
        pause_ms = max(
            MIN_PAUSE_MS,
            min(MAX_PAUSE_MS, end_ms - start_ms + PAUSE_MARGIN_MS),
        )
        blocks.append(
            {
                "id": f"block-{len(blocks) + 1}",
                "start_ms": start_ms,
                "end_ms": end_ms,
                "pause_duration_ms": pause_ms,
                "speaker": speaker or "Não identificado",
                "word_count": word_count,
                "cue_ids": group,
                "en": " ".join(item.approved_en for item in selected),
                "pt": " ".join(item.approved_pt for item in selected),
            }
        )
    return blocks


def _plan_hash(source_sha256: str, blocks: list[dict[str, Any]]) -> str:
    return _digest({"source_sha256": source_sha256, "blocks": blocks})
