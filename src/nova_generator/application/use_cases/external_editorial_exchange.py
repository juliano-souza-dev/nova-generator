from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialSuggestion,
)
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.editorial_assistance import (
    EditorialAssistanceError,
    build_editorial_prompt,
    validate_editorial_result,
)


class _ExternalSuggestion(BaseModel):
    cue_id: str
    order: int
    approved_en: str = Field(min_length=1)
    approved_pt: str = Field(min_length=1)
    notes: str = ""


class _ExternalResult(BaseModel):
    schema_version: Literal["nova-generator-editorial-suggestions/1.0"]
    scene_id: UUID
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    suggestions: list[_ExternalSuggestion] = Field(min_length=1)


class ExternalEditorialExchange:
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
            "schema_version": "nova-generator-editorial-input/1.0",
            "scene_id": str(scene_id),
            "input_sha256": input_sha256,
            "cues": [cue.__dict__ for cue in cues],
        }
        template = {
            "schema_version": "nova-generator-editorial-suggestions/1.0",
            "scene_id": str(scene_id),
            "input_sha256": input_sha256,
            "suggestions": [
                {
                    "cue_id": cue.id,
                    "order": cue.order,
                    "approved_en": cue.current_en or cue.original_en,
                    "approved_pt": cue.current_pt,
                    "notes": "",
                }
                for cue in cues
            ],
        }
        ingest_job_id = scene.provenance.get("ingest_job_id")
        cut = (
            self._project_root / str(project_id) / "cuts" / f"{ingest_job_id}.mp4"
            if isinstance(ingest_job_id, str)
            else None
        )
        with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "editorial_input.json",
                json.dumps(source, ensure_ascii=False, indent=2) + "\n",
            )
            archive.writestr(
                "editorial_result_template.json",
                json.dumps(template, ensure_ascii=False, indent=2) + "\n",
            )
            archive.writestr("INSTRUCOES.md", _instructions())
            if cut is not None and cut.is_file() and cut.stat().st_size:
                archive.write(cut, arcname="scene.mp4", compress_type=zipfile.ZIP_STORED)
        return package

    def import_result(self, scene_id: UUID, content: bytes) -> EditorialAssistanceResult:
        if not content or len(content) > self._maximum_result_bytes:
            raise EditorialAssistanceError("external result is empty or too large")
        try:
            document = _ExternalResult.model_validate_json(content)
        except ValidationError as error:
            raise EditorialAssistanceError("external result does not match the contract") from error
        input_sha256, cues = build_editorial_prompt(self._repository, scene_id)
        result = EditorialAssistanceResult(
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
                )
                for item in document.suggestions
            ),
            rate_limits={},
        )
        validated = validate_editorial_result(
            result, scene_id=scene_id, input_sha256=input_sha256, cues=cues
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


def _instructions() -> str:
    return """# Assistência editorial externa

Analise `scene.mp4` quando estiver presente e use `editorial_input.json` como fonte canônica.
Preencha somente `approved_en`, `approved_pt` e `notes` no arquivo de modelo.
Mantenha `scene_id`, `input_sha256`, `cue_id`, `order`, a quantidade e a ordem sem alterações.
Corrija o inglês somente quando necessário e traduza para português brasileiro natural.
Preserve nomes, acentos, apóstrofos, aspas, vírgulas, pontos, perguntas e reticências.
Não una, divida, omita ou invente cues.
Devolva somente o JSON preenchido. O Generator o importará como sugestão de rascunho.
"""
