from __future__ import annotations

import json
from dataclasses import asdict
from hashlib import sha256
from uuid import UUID

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialAssistant,
    EditorialCuePrompt,
    EditorialSemanticUnit,
    EditorialWordPrompt,
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
            words=tuple(
                EditorialWordPrompt(
                    str(word.id),
                    word.order,
                    word.surface,
                    _optional_string(word.provenance.get("pt")),
                    _optional_string(word.provenance.get("semantic_group_id")),
                    _optional_string(word.provenance.get("semantic_group_role")),
                )
                for word in repository.get_cue_words(cue.id)
            ),
        )
        for cue in repository.get_scene_cues(scene_id)
    )
    if not cues:
        raise EditorialAssistanceError("scene has no cues")
    canonical = json.dumps(
        [asdict(cue) for cue in cues],
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
    for cue, suggestion in zip(cues, result.suggestions, strict=True):
        _validate_semantic_units(cue, suggestion.semantic_units)
    return result


def _validate_semantic_units(
    cue: EditorialCuePrompt, units: tuple[EditorialSemanticUnit, ...]
) -> None:
    word_index = {word.id: index for index, word in enumerate(cue.words)}
    used: set[str] = set()
    for unit in units:
        if len(unit.word_ids) < 2:
            raise EditorialAssistanceError("semantic units must contain at least two words")
        if not unit.pt.strip():
            raise EditorialAssistanceError("semantic unit translation cannot be empty")
        if len(set(unit.word_ids)) != len(unit.word_ids):
            raise EditorialAssistanceError("semantic unit contains duplicate word ids")
        try:
            positions = [word_index[word_id] for word_id in unit.word_ids]
        except KeyError as error:
            raise EditorialAssistanceError(
                "semantic unit references a word outside its cue"
            ) from error
        if positions != list(range(positions[0], positions[0] + len(positions))):
            raise EditorialAssistanceError("semantic units must use contiguous words in cue order")
        if used.intersection(unit.word_ids):
            raise EditorialAssistanceError("semantic units cannot overlap")
        used.update(unit.word_ids)


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


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
