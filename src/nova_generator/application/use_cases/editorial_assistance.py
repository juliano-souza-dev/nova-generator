from __future__ import annotations

import json
from hashlib import sha256
from uuid import UUID

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialAssistant,
    EditorialCuePrompt,
)
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository


class EditorialAssistanceError(ValueError):
    pass


def build_editorial_prompt(
    repository: EditorialProjectRepository, scene_id: UUID
) -> tuple[str, tuple[EditorialCuePrompt, ...]]:
    if repository.get_scene_project_id(scene_id) is None:
        raise EditorialAssistanceError("scene not found")
    cues = tuple(
        EditorialCuePrompt(
            id=str(cue.id),
            order=cue.order,
            original_en=cue.original_en,
            current_en=cue.approved_en,
            current_pt=cue.approved_pt,
        )
        for cue in repository.get_scene_cues(scene_id)
    )
    if not cues:
        raise EditorialAssistanceError("scene has no cues")
    canonical = json.dumps(
        [cue.__dict__ for cue in cues],
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return sha256(canonical.encode("utf-8")).hexdigest(), cues


def validate_editorial_result(
    result: EditorialAssistanceResult,
    *,
    scene_id: UUID,
    input_sha256: str,
    cues: tuple[EditorialCuePrompt, ...],
) -> EditorialAssistanceResult:
    if result.scene_id != str(scene_id):
        raise EditorialAssistanceError("assistant returned a different scene_id")
    if result.input_sha256 != input_sha256:
        raise EditorialAssistanceError("assistant response is stale for the current cues")
    expected = [(cue.id, cue.order) for cue in cues]
    returned = [(item.cue_id, item.order) for item in result.suggestions]
    if returned != expected:
        raise EditorialAssistanceError(
            "assistant must return every cue once, in the original order"
        )
    if any(not item.approved_en or not item.approved_pt for item in result.suggestions):
        raise EditorialAssistanceError("assistant returned an empty English or Portuguese text")
    return result


class RunEditorialAssistance:
    def __init__(
        self, repository: EditorialProjectRepository, assistant: EditorialAssistant
    ) -> None:
        self._repository = repository
        self._assistant = assistant

    def execute(self, scene_id: UUID) -> EditorialAssistanceResult:
        input_sha256, cues = build_editorial_prompt(self._repository, scene_id)
        result = self._assistant.suggest(
            scene_id=str(scene_id), input_sha256=input_sha256, cues=cues
        )
        return validate_editorial_result(
            result, scene_id=scene_id, input_sha256=input_sha256, cues=cues
        )
