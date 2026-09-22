from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue, EditorialRevision, WordTiming


class EditorialCommandError(ValueError):
    """A command would violate a published editorial invariant."""


class EditApprovedText:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, approved_en: str, approved_pt: str, author: str) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        _literal(approved_en, "approved_en")
        _literal(approved_pt, "approved_pt")
        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = replace(
            cue, approved_en=approved_en, approved_pt=approved_pt, revision=cue.revision + 1
        )
        self._repository.save_cue(updated, words)
        _record(self._repository, updated, "edit_approved_text", author, before)
        return updated


class AdjustCueTiming:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        speech_start_ms: int,
        speech_end_ms: int,
        subtitle_start_ms: int,
        subtitle_end_ms: int,
        author: str,
    ) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        _range(speech_start_ms, speech_end_ms, "speech_timing")
        _range(subtitle_start_ms, subtitle_end_ms, "subtitle_timing")
        if any(
            not speech_start_ms <= word.start_ms < word.end_ms <= speech_end_ms for word in words
        ):
            raise EditorialCommandError("speech_timing must contain every word timing")
        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = replace(
            cue,
            speech_start_ms=speech_start_ms,
            speech_end_ms=speech_end_ms,
            subtitle_start_ms=subtitle_start_ms,
            subtitle_end_ms=subtitle_end_ms,
            revision=cue.revision + 1,
        )
        self._repository.save_cue(updated, words)
        _record(self._repository, updated, "adjust_cue_timing", author, before)
        return updated


class AdjustWordTiming:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self, cue_id: UUID, *, timings: list[dict[str, Any]], author: str
    ) -> list[WordTiming]:
        cue, words = _cue_with_words(self._repository, cue_id)
        supplied = {item.get("id"): item for item in timings if isinstance(item, dict)}
        if len(supplied) != len(words) or {str(word.id) for word in words} != set(supplied):
            raise EditorialCommandError("timings must include every word exactly once")
        updated: list[WordTiming] = []
        previous_end = cue.speech_start_ms
        for word in words:
            item = supplied[str(word.id)]
            start, end = item.get("start_ms"), item.get("end_ms")
            start, end = _range(start, end, f"word[{word.id}]")
            if start < previous_end or start < cue.speech_start_ms or end > cue.speech_end_ms:
                raise EditorialCommandError(
                    f"word[{word.id}] timing must be ordered and inside speech_timing"
                )
            updated.append(replace(word, start_ms=start, end_ms=end))
            previous_end = end
        before = _scene_snapshot(self._repository, cue.scene_id)
        self._repository.save_cue(cue, updated)
        _record(self._repository, cue, "adjust_word_timing", author, before)
        return updated


class SplitCue:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        after_word_id: UUID,
        first: dict[str, str],
        second: dict[str, str],
        author: str,
    ) -> list[Cue]:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == after_word_id), None)
        if index is None or index == len(words) - 1:
            raise EditorialCommandError("after_word_id must identify a non-final word in the cue")
        _split_text(first, "first")
        _split_text(second, "second")
        before = _scene_snapshot(self._repository, cue.scene_id)
        left_words, right_words = words[: index + 1], words[index + 1 :]
        boundary = left_words[-1].end_ms
        left_id, right_id = uuid4(), uuid4()
        left = Cue(
            left_id,
            cue.scene_id,
            cue.order,
            cue.speech_start_ms,
            boundary,
            cue.subtitle_start_ms,
            boundary,
            cue.speaker,
            first["original_en"],
            first["approved_en"],
            first["approved_pt"],
            cue.revision + 1,
            {**cue.provenance, "split_from": str(cue.id), "split_side": "first"},
        )
        right = Cue(
            right_id,
            cue.scene_id,
            cue.order + 1,
            boundary,
            cue.speech_end_ms,
            boundary,
            cue.subtitle_end_ms,
            cue.speaker,
            second["original_en"],
            second["approved_en"],
            second["approved_pt"],
            cue.revision + 1,
            {**cue.provenance, "split_from": str(cue.id), "split_side": "second"},
        )
        all_cues = self._repository.get_scene_cues(cue.scene_id)
        replacement: list[tuple[Cue, list[WordTiming]]] = []
        for current in all_cues:
            if current.id == cue.id:
                replacement.extend(
                    [
                        (left, _move_words(left_words, left_id)),
                        (right, _move_words(right_words, right_id)),
                    ]
                )
            else:
                current_words = self._repository.get_cue_words(current.id)
                shift = 1 if current.order > cue.order else 0
                replacement.append((replace(current, order=current.order + shift), current_words))
        self._repository.replace_scene_cues(cue.scene_id, replacement)
        _record(self._repository, left, "split_cue", author, before)
        return [left, right]


class MergeCues:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self, first_cue_id: UUID, second_cue_id: UUID, *, text: dict[str, str], author: str
    ) -> Cue:
        first, first_words = _cue_with_words(self._repository, first_cue_id)
        second, second_words = _cue_with_words(self._repository, second_cue_id)
        if first.scene_id != second.scene_id or second.order != first.order + 1:
            raise EditorialCommandError("cues must be consecutive cues in the same scene")
        _split_text(text, "text")
        before = _scene_snapshot(self._repository, first.scene_id)
        merged_id = uuid4()
        merged = Cue(
            merged_id,
            first.scene_id,
            first.order,
            first.speech_start_ms,
            second.speech_end_ms,
            first.subtitle_start_ms,
            second.subtitle_end_ms,
            first.speaker,
            text["original_en"],
            text["approved_en"],
            text["approved_pt"],
            max(first.revision, second.revision) + 1,
            {"merged_from": [str(first.id), str(second.id)]},
        )
        all_cues = self._repository.get_scene_cues(first.scene_id)
        replacement: list[tuple[Cue, list[WordTiming]]] = []
        for current in all_cues:
            if current.id == first.id:
                replacement.append((merged, _move_words(first_words + second_words, merged_id)))
            elif current.id == second.id:
                continue
            else:
                shift = -1 if current.order > second.order else 0
                replacement.append(
                    (
                        replace(current, order=current.order + shift),
                        self._repository.get_cue_words(current.id),
                    )
                )
        self._repository.replace_scene_cues(first.scene_id, replacement)
        _record(self._repository, merged, "merge_cues", author, before)
        return merged


class UndoEditorialRevision:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self, scene_id: UUID, *, revision_id: UUID, author: str
    ) -> list[tuple[Cue, list[WordTiming]]]:
        target = next(
            (item for item in self._repository.list_revisions(scene_id) if item.id == revision_id),
            None,
        )
        if target is None or target.command == "undo_editorial_revision":
            raise EditorialCommandError("revision not found or cannot be undone")
        before = _scene_snapshot(self._repository, scene_id)
        replacement = _snapshot_entries(target.before_snapshot)
        self._repository.replace_scene_cues(scene_id, replacement)
        project_id = target.project_id
        sequence = len(self._repository.list_revisions(scene_id)) + 1
        self._repository.save_revision(
            EditorialRevision(
                uuid4(),
                project_id,
                scene_id,
                None,
                sequence,
                "undo_editorial_revision",
                author,
                "editorial-api",
                before,
                _scene_snapshot(self._repository, scene_id),
                datetime.now(UTC),
            )
        )
        return replacement


def _cue_with_words(
    repository: EditorialProjectRepository, cue_id: UUID
) -> tuple[Cue, list[WordTiming]]:
    cue = repository.get_cue(cue_id)
    if cue is None:
        raise EditorialCommandError("cue not found")
    return cue, repository.get_cue_words(cue.id)


def _record(
    repository: EditorialProjectRepository,
    cue: Cue,
    command: str,
    author: str,
    before: dict[str, Any],
) -> None:
    project_id = repository.get_scene_project_id(cue.scene_id)
    if project_id is None:
        raise EditorialCommandError("scene not found")
    repository.save_revision(
        EditorialRevision(
            uuid4(),
            project_id,
            cue.scene_id,
            cue.id,
            len(repository.list_revisions(cue.scene_id)) + 1,
            command,
            author,
            "editorial-api",
            before,
            _scene_snapshot(repository, cue.scene_id),
            datetime.now(UTC),
        )
    )


def _scene_snapshot(repository: EditorialProjectRepository, scene_id: UUID) -> dict[str, Any]:
    entries = []
    for cue in repository.get_scene_cues(scene_id):
        entries.append(
            {
                "cue": _cue_data(cue),
                "words": [_word_data(w) for w in repository.get_cue_words(cue.id)],
            }
        )
    return {"cues": entries}


def _snapshot_entries(snapshot: dict[str, Any]) -> list[tuple[Cue, list[WordTiming]]]:
    entries = snapshot.get("cues")
    if not isinstance(entries, list) or not entries:
        raise EditorialCommandError("revision has no restorable scene snapshot")
    result = []
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("cue"), dict)
            or not isinstance(entry.get("words"), list)
        ):
            raise EditorialCommandError("revision snapshot is malformed")
        cue_data = entry["cue"]
        cue = Cue(
            **{**cue_data, "id": UUID(cue_data["id"]), "scene_id": UUID(cue_data["scene_id"])}
        )
        words = [
            WordTiming(**{**w, "id": UUID(w["id"]), "cue_id": UUID(w["cue_id"])})
            for w in entry["words"]
        ]
        result.append((cue, words))
    return result


def _cue_data(cue: Cue) -> dict[str, Any]:
    return {
        "id": str(cue.id),
        "scene_id": str(cue.scene_id),
        "order": cue.order,
        "speech_start_ms": cue.speech_start_ms,
        "speech_end_ms": cue.speech_end_ms,
        "subtitle_start_ms": cue.subtitle_start_ms,
        "subtitle_end_ms": cue.subtitle_end_ms,
        "speaker": cue.speaker,
        "original_en": cue.original_en,
        "approved_en": cue.approved_en,
        "approved_pt": cue.approved_pt,
        "revision": cue.revision,
        "provenance": cue.provenance,
    }


def _word_data(word: WordTiming) -> dict[str, Any]:
    return {
        "id": str(word.id),
        "cue_id": str(word.cue_id),
        "order": word.order,
        "surface": word.surface,
        "start_ms": word.start_ms,
        "end_ms": word.end_ms,
        "original_start_ms": word.original_start_ms,
        "original_end_ms": word.original_end_ms,
        "provenance": word.provenance,
    }


def _move_words(words: list[WordTiming], cue_id: UUID) -> list[WordTiming]:
    return [
        replace(
            word,
            cue_id=cue_id,
            order=index,
            provenance={**word.provenance, "moved_from_cue": str(word.cue_id)},
        )
        for index, word in enumerate(words, 1)
    ]


def _literal(value: object, field: str) -> None:
    if not isinstance(value, str):
        raise EditorialCommandError(f"{field} must be a literal string")


def _range(start: object, end: object, field: str) -> tuple[int, int]:
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or start < 0
        or end <= start
    ):
        raise EditorialCommandError(f"{field} must be a positive millisecond range")
    return start, end


def _split_text(value: dict[str, str], field: str) -> None:
    if not isinstance(value, dict):
        raise EditorialCommandError(f"{field} must provide literal text")
    for key in ("original_en", "approved_en", "approved_pt"):
        _literal(value.get(key), f"{field}.{key}")
