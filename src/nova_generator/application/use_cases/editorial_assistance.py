from __future__ import annotations

import json
import re
from dataclasses import asdict, replace
from datetime import UTC, datetime
from hashlib import sha256
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from nova_generator.application.ports.editorial_assistant import (
    EditorialAssistanceResult,
    EditorialAssistant,
    EditorialCuePrompt,
    EditorialSemanticUnit,
    EditorialSuggestion,
    EditorialWordPrompt,
    EditorialWordTranslation,
)
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue, EditorialRevision, WordTiming


class EditorialAssistanceError(ValueError):
    pass


def build_editorial_prompt(
    repository: EditorialProjectRepository, scene_id: UUID
) -> tuple[str, tuple[EditorialCuePrompt, ...]]:
    if repository.get_scene_project_id(scene_id) is None:
        raise EditorialAssistanceError("scene not found")
    prompts: list[EditorialCuePrompt] = []
    for cue in repository.get_scene_cues(scene_id):
        words, trailing = _word_prompts(
            repository.get_cue_words(cue.id), cue.approved_en or cue.original_en
        )
        word_by_word_en = "".join(f"{word.leading}{word.surface}" for word in words) + trailing
        current_literal = cue.approved_en or cue.original_en
        prompts.append(
            EditorialCuePrompt(
                id=str(cue.id),
                order=cue.order,
                original_en=cue.original_en,
                current_en=cue.approved_en,
                current_pt=cue.approved_pt,
                words=words,
                speech_start_ms=cue.speech_start_ms,
                speech_end_ms=cue.speech_end_ms,
                subtitle_start_ms=cue.subtitle_start_ms,
                subtitle_end_ms=cue.subtitle_end_ms,
                trailing=trailing,
                word_by_word_en=word_by_word_en,
                requires_reconciliation=word_by_word_en != current_literal,
            )
        )
    cues = tuple(prompts)
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
    require_word_translations: bool = False,
    require_word_revisions: bool = False,
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
    if any(
        not item.approved_en.strip() or not item.approved_pt.strip() for item in result.suggestions
    ):
        raise EditorialAssistanceError("assistant returned an empty English or Portuguese text")
    for cue, suggestion in zip(cues, result.suggestions, strict=True):
        _validate_word_translations(
            cue,
            suggestion,
            required=require_word_translations,
            require_revisions=require_word_revisions,
        )
        _validate_semantic_units(cue, suggestion.semantic_units)
    return result


def _validate_word_translations(
    cue: EditorialCuePrompt,
    suggestion: EditorialSuggestion,
    *,
    required: bool,
    require_revisions: bool,
) -> None:
    if not suggestion.word_translations and not required:
        return
    expected = [word.id for word in cue.words]
    returned = [item.word_id for item in suggestion.word_translations]
    if returned != expected:
        raise EditorialAssistanceError(
            "assistant must translate every word once, in the original order"
        )
    if any(not item.pt.strip() for item in suggestion.word_translations):
        raise EditorialAssistanceError("assistant returned an empty word translation")
    if not require_revisions:
        return
    for expected_word, returned_word in zip(cue.words, suggestion.word_translations, strict=True):
        if returned_word.order != expected_word.order:
            raise EditorialAssistanceError("assistant changed a word order")
        if returned_word.leading is None or returned_word.surface is None:
            raise EditorialAssistanceError("assistant must return every word surface and separator")
        if not returned_word.surface:
            raise EditorialAssistanceError("assistant returned an empty word surface")
        if returned_word.start_ms is None or returned_word.end_ms is None:
            raise EditorialAssistanceError("assistant must return every word timing")
    _validate_revised_word_timings(cue, suggestion.word_translations)
    reconstructed = (
        "".join(f"{word.leading}{word.surface}" for word in suggestion.word_translations)
        + suggestion.trailing
    )
    if reconstructed != suggestion.approved_en:
        raise EditorialAssistanceError(
            "approved English must exactly match the reconstructed word surfaces"
        )


def _validate_revised_word_timings(
    cue: EditorialCuePrompt, words: tuple[EditorialWordTranslation, ...]
) -> None:
    previous_end = cue.speech_start_ms
    for word in words:
        start, end = word.start_ms, word.end_ms
        if (
            not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start < previous_end
            or end <= start
            or start < cue.speech_start_ms
            or end > cue.speech_end_ms
        ):
            raise EditorialAssistanceError("assistant returned invalid or overlapping word timing")
        previous_end = end


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

    def execute(
        self, scene_id: UUID, *, expected_input_sha256: str | None = None
    ) -> EditorialAssistanceResult:
        input_sha256, cues = build_editorial_prompt(self._repository, scene_id)
        if expected_input_sha256 is not None and input_sha256 != expected_input_sha256:
            raise EditorialAssistanceError(
                "scene changed before editorial preparation started; process it again"
            )
        result = self._assistant.suggest(
            scene_id=str(scene_id), input_sha256=input_sha256, cues=cues
        )
        return validate_editorial_result(
            result,
            scene_id=scene_id,
            input_sha256=input_sha256,
            cues=cues,
            require_word_translations=True,
            require_word_revisions=True,
        )


def persist_editorial_preparation(
    repository: EditorialProjectRepository,
    result: EditorialAssistanceResult,
    *,
    author: str,
) -> bool:
    """Persist one complete AI preparation as a scene-level atomic draft."""
    if result.contract_version != "nova-generator-editorial-suggestions/1.3":
        raise EditorialAssistanceError(
            "editorial contract 1.3 is required to reconcile every word and timing"
        )
    scene_id = UUID(result.scene_id)
    already_applied = load_persisted_editorial_preparation(
        repository, scene_id, result.input_sha256
    )
    if already_applied is not None:
        return False
    before = _scene_snapshot(repository, scene_id)
    input_sha256, prompts = build_editorial_prompt(repository, scene_id)
    validated = validate_editorial_result(
        result,
        scene_id=scene_id,
        input_sha256=input_sha256,
        cues=prompts,
        require_word_translations=True,
        require_word_revisions=True,
    )
    project_id = repository.get_scene_project_id(scene_id)
    if project_id is None:
        raise EditorialAssistanceError("scene not found")
    entries = []
    for cue, suggestion in zip(
        repository.get_scene_cues(scene_id), validated.suggestions, strict=True
    ):
        words = repository.get_cue_words(cue.id)
        translated = _prepared_words(words, suggestion, result.input_sha256)
        changed = replace(
            cue,
            approved_en=suggestion.approved_en,
            approved_pt=suggestion.approved_pt,
            revision=cue.revision + 1,
            provenance={
                **cue.provenance,
                "approval": "draft",
                "editorial_preparation": "complete",
                "editorial_preparation_provider": result.provider,
                "editorial_preparation_model": result.model,
                "editorial_preparation_sha256": result.input_sha256,
                "editorial_preparation_notes": suggestion.notes,
                "editorial_preparation_trailing": suggestion.trailing,
                "editorial_preparation_contract": result.contract_version,
            },
        )
        entries.append((changed, translated))
    after = _entries_snapshot(entries)
    revision = EditorialRevision(
        uuid4(),
        project_id,
        scene_id,
        None,
        max((item.sequence for item in repository.list_revisions(scene_id)), default=0) + 1,
        "prepare_editorial_draft",
        author,
        result.provider,
        before,
        after,
        datetime.now(UTC),
    )
    if not repository.replace_scene_cues_with_revision(scene_id, before, entries, revision):
        raise EditorialAssistanceError(
            "scene changed while editorial preparation was running; process it again"
        )
    return True


def scene_is_editorially_prepared(repository: EditorialProjectRepository, scene_id: UUID) -> bool:
    cues = repository.get_scene_cues(scene_id)
    return bool(cues) and all(
        cue.approved_en.strip()
        and cue.approved_pt.strip()
        and cue.provenance.get("editorial_preparation") == "complete"
        and cue.provenance.get("editorial_preparation_contract")
        == "nova-generator-editorial-suggestions/1.3"
        and all(
            (
                isinstance(word.provenance.get("pt"), str)
                and bool(str(word.provenance["pt"]).strip())
            )
            or word.provenance.get("semantic_group_role") == "member"
            for word in repository.get_cue_words(cue.id)
        )
        for cue in cues
    )


def load_persisted_editorial_preparation(
    repository: EditorialProjectRepository, scene_id: UUID, input_sha256: str
) -> EditorialAssistanceResult | None:
    cues = repository.get_scene_cues(scene_id)
    if not cues or any(
        cue.provenance.get("editorial_preparation") != "complete"
        or cue.provenance.get("editorial_preparation_sha256") != input_sha256
        or cue.provenance.get("editorial_preparation_contract")
        != "nova-generator-editorial-suggestions/1.3"
        for cue in cues
    ):
        return None
    suggestions: list[EditorialSuggestion] = []
    for cue in cues:
        words = repository.get_cue_words(cue.id)
        translations: list[EditorialWordTranslation] = []
        groups: dict[str, list[WordTiming]] = {}
        for word in words:
            pt = word.provenance.get("pt_original", word.provenance.get("pt"))
            if not isinstance(pt, str) or not pt.strip():
                return None
            leading, surface = _split_word_surface(word.surface)
            translations.append(
                EditorialWordTranslation(
                    str(word.id),
                    pt,
                    word.order,
                    leading,
                    surface,
                    word.start_ms,
                    word.end_ms,
                )
            )
            group_id = word.provenance.get("semantic_group_id")
            if isinstance(group_id, str):
                groups.setdefault(group_id, []).append(word)
        units = []
        for group_words in groups.values():
            lead = next(
                (
                    word
                    for word in group_words
                    if word.provenance.get("semantic_group_role") == "lead"
                ),
                None,
            )
            pt = lead.provenance.get("pt") if lead else None
            if lead is None or not isinstance(pt, str) or not pt.strip():
                return None
            units.append(EditorialSemanticUnit(tuple(str(word.id) for word in group_words), pt))
        suggestions.append(
            EditorialSuggestion(
                cue_id=str(cue.id),
                order=cue.order,
                approved_en=cue.approved_en,
                approved_pt=cue.approved_pt,
                notes=str(cue.provenance.get("editorial_preparation_notes", "")),
                word_translations=tuple(translations),
                semantic_units=tuple(units),
                trailing=str(cue.provenance.get("editorial_preparation_trailing", "")),
            )
        )
    first = cues[0].provenance
    return EditorialAssistanceResult(
        scene_id=str(scene_id),
        input_sha256=input_sha256,
        provider=str(first.get("editorial_preparation_provider", "persisted")),
        model=str(first.get("editorial_preparation_model", "persisted")),
        suggestions=tuple(suggestions),
        rate_limits={},
        contract_version="nova-generator-editorial-suggestions/1.3",
    )


def _prepared_words(
    words: list[WordTiming], suggestion: EditorialSuggestion, input_sha256: str
) -> list[WordTiming]:
    translations = {item.word_id: item for item in suggestion.word_translations}
    updated = [
        replace(
            word,
            surface=(translations[str(word.id)].leading or "")
            + (translations[str(word.id)].surface or word.surface),
            start_ms=(
                translations[str(word.id)].start_ms
                if translations[str(word.id)].start_ms is not None
                else word.start_ms
            ),
            end_ms=(
                translations[str(word.id)].end_ms
                if translations[str(word.id)].end_ms is not None
                else word.end_ms
            ),
            provenance={
                **{
                    key: value
                    for key, value in word.provenance.items()
                    if key
                    not in {
                        "semantic_group_id",
                        "semantic_group_role",
                        "pt_original",
                    }
                },
                "pt": translations[str(word.id)].pt,
            },
        )
        for word in words
    ]
    positions = {str(word.id): index for index, word in enumerate(updated)}
    for unit_index, unit in enumerate(suggestion.semantic_units):
        indexes = [positions[word_id] for word_id in unit.word_ids]
        group_id = str(
            uuid5(
                NAMESPACE_URL,
                f"nova-generator/editorial-preparation/{input_sha256}/{suggestion.cue_id}/{unit_index}",
            )
        )
        for offset, index in enumerate(indexes):
            provenance = dict(updated[index].provenance)
            provenance["pt_original"] = provenance["pt"]
            provenance.update(
                {
                    "semantic_group_id": group_id,
                    "semantic_group_role": "lead" if offset == 0 else "member",
                    "pt": unit.pt if offset == 0 else None,
                }
            )
            updated[index] = replace(updated[index], provenance=provenance)
    return updated


def _word_prompt(word: WordTiming, *, leading: str, surface: str) -> EditorialWordPrompt:
    confidence = word.provenance.get("asr_confidence")
    if (
        not isinstance(confidence, (int, float))
        or isinstance(confidence, bool)
        or not 0 <= confidence <= 1
    ):
        confidence = None
    return EditorialWordPrompt(
        id=str(word.id),
        order=word.order,
        surface=surface,
        current_pt=_optional_string(word.provenance.get("pt")),
        semantic_group_id=_optional_string(word.provenance.get("semantic_group_id")),
        semantic_group_role=_optional_string(word.provenance.get("semantic_group_role")),
        leading=leading,
        start_ms=word.start_ms,
        end_ms=word.end_ms,
        original_start_ms=word.original_start_ms,
        original_end_ms=word.original_end_ms,
        confidence=float(confidence) if confidence is not None else None,
    )


def _word_prompts(
    words: list[WordTiming], literal: str
) -> tuple[tuple[EditorialWordPrompt, ...], str]:
    split = [_split_word_surface(word.surface) for word in words]
    leading_values: list[str] = []
    cursor = 0
    aligned = True
    for _, surface in split:
        position = literal.find(surface, cursor)
        if position < cursor or any(character.isalnum() for character in literal[cursor:position]):
            aligned = False
            break
        leading_values.append(literal[cursor:position])
        cursor = position + len(surface)
    trailing = literal[cursor:] if aligned else ""
    if aligned and any(character.isalnum() for character in trailing):
        aligned = False
        trailing = ""
    if not aligned:
        leading_values = [
            raw_leading or ("" if index == 0 else " ")
            for index, (raw_leading, _) in enumerate(split)
        ]
    prompts = tuple(
        _word_prompt(word, leading=leading_values[index], surface=split[index][1])
        for index, word in enumerate(words)
    )
    return prompts, trailing


def _split_word_surface(value: str) -> tuple[str, str]:
    match = re.match(r"\s*", value)
    leading = match.group(0) if match else ""
    surface = value[len(leading) :]
    return leading, surface


def _scene_snapshot(repository: EditorialProjectRepository, scene_id: UUID) -> dict[str, object]:
    return {
        "cues": [
            {
                "cue": {
                    **asdict(cue),
                    "id": str(cue.id),
                    "scene_id": str(cue.scene_id),
                },
                "words": [
                    {
                        **asdict(word),
                        "id": str(word.id),
                        "cue_id": str(word.cue_id),
                    }
                    for word in repository.get_cue_words(cue.id)
                ],
            }
            for cue in repository.get_scene_cues(scene_id)
        ]
    }


def _entries_snapshot(entries: list[tuple[Cue, list[WordTiming]]]) -> dict[str, object]:
    return {
        "cues": [
            {
                "cue": {
                    **asdict(cue),
                    "id": str(cue.id),
                    "scene_id": str(cue.scene_id),
                },
                "words": [
                    {
                        **asdict(word),
                        "id": str(word.id),
                        "cue_id": str(word.cue_id),
                    }
                    for word in words
                ],
            }
            for cue, words in entries
        ]
    }
