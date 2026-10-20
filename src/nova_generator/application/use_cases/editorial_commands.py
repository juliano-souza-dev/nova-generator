from __future__ import annotations

import re
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.domain.projects.entities import Cue, EditorialRevision, WordTiming


class EditorialCommandError(ValueError):
    """A command would violate a published editorial invariant."""


def _estimated_speech_word_ms(surface: str, words: list[WordTiming]) -> int:
    """Estimate provisional speech duration from the current cue's rhythm."""
    def syllables(value: str) -> int:
        return max(1, len(re.findall(r"[aeiouy]+", value.casefold())))

    samples = sorted(
        (word.end_ms - word.start_ms) / syllables(word.surface)
        for word in words
        if word.end_ms > word.start_ms
    )
    pace = samples[len(samples) // 2] if samples else 220
    pace = max(135, min(360, pace))
    return max(130, min(950, round(pace * syllables(surface))))


def _reconcile_approved_words(
    text: str, words: list[WordTiming], cue_start_ms: int
) -> tuple[list[WordTiming], str, list[str]]:
    """Preserve ASR anchors; estimate new words for later manual alignment."""
    tokens = re.findall(r"\s*\S+", text)
    trailing = text[len("".join(tokens)) :]
    if not tokens or trailing.strip():
        raise EditorialCommandError("approved English has invalid word boundaries")
    if not words:
        raise EditorialCommandError("cannot assign edited English without existing word timings")

    def lexical(value: str) -> str:
        return re.sub(r"[^\w]+", "", value).casefold()

    old = [lexical(word.surface) for word in words]
    new = [lexical(token) for token in tokens]
    # LCS anchors keep the same word ID even when earlier words are deleted.
    n, m = len(old), len(new)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = (
                1 + dp[i + 1][j + 1]
                if old[i] == new[j]
                else max(dp[i + 1][j], dp[i][j + 1])
            )
    anchors: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        if old[i] == new[j]:
            anchors.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1

    matches: dict[int, WordTiming | None] = {}
    old_pos = new_pos = 0
    for old_end, new_end in [*anchors, (n, m)]:
        old_count, new_count = old_end - old_pos, new_end - new_pos
        for offset in range(new_count):
            matches[new_pos + offset] = (
                words[old_pos + offset] if offset < old_count else None
            )
        if old_end < n:
            matches[new_end] = words[old_end]
        old_pos, new_pos = old_end + 1, new_end + 1

    if len(matches) != m:
        raise EditorialCommandError("could not reconcile the edited words")
    updated: list[WordTiming] = []
    cursor = cue_start_ms
    for k, token in enumerate(tokens):
        previous = matches[k]
        if previous is None:
            start = cursor + (15 if updated else 0)
            end = start + _estimated_speech_word_ms(token, words)
            updated.append(
                WordTiming(
                    uuid4(), words[0].cue_id, k + 1, token, start, end, start, end,
                    {
                        "pt": "",
                        "editorial_word_inserted": True,
                        "editorial_timing_estimated": True,
                        "translation_review_required": True,
                    },
                )
            )
        else:
            start = max(previous.start_ms, cursor)
            end = start + previous.end_ms - previous.start_ms
            provenance = _changed_word_provenance(previous, token)
            if start != previous.start_ms:
                provenance.pop("word_timing_reviewed", None)
                provenance.pop("word_timing_reviewed_by", None)
                provenance["editorial_timing_estimated"] = True
            updated.append(
                replace(previous, order=k + 1, surface=token, start_ms=start,
                        end_ms=end, provenance=provenance)
            )
        cursor = updated[-1].end_ms
    kept_ids = {word.id for word in updated}
    removed = [word for word in words if word.id not in kept_ids]
    affected_groups = {
        word.provenance.get("semantic_group_id")
        for word in removed
        if word.provenance.get("semantic_group_id")
    }
    if affected_groups:
        for group_id in affected_groups:
            original_group = [
                word for word in words
                if word.provenance.get("semantic_group_id") == group_id
            ]
            remaining = [
                index for index, word in enumerate(updated)
                if word.provenance.get("semantic_group_id") == group_id
            ]
            if not remaining:
                continue
            group_translation = next(
                (
                    word.provenance.get("pt")
                    for word in original_group
                    if isinstance(word.provenance.get("pt"), str)
                    and str(word.provenance["pt"]).strip()
                ),
                "",
            )
            for rank, index in enumerate(remaining):
                current = updated[index]
                provenance = dict(current.provenance)
                provenance["translation_review_required"] = True
                if len(remaining) == 1:
                    provenance.pop("semantic_group_id", None)
                    provenance.pop("semantic_group_role", None)
                else:
                    provenance["semantic_group_role"] = "lead" if rank == 0 else "member"
                if rank == 0:
                    provenance["pt"] = (
                        provenance.get("pt_original")
                        or provenance.get("pt")
                        or group_translation
                    )
                else:
                    provenance["pt"] = None
                updated[index] = replace(current, provenance=provenance)

    # Inserting a token inside a semantic unit breaks its contiguity. Keep the
    # original translations as review drafts, but never publish a split group.
    group_ids = {
        word.provenance.get("semantic_group_id")
        for word in updated
        if word.provenance.get("semantic_group_id")
    }
    for group_id in group_ids:
        positions = [
            index for index, word in enumerate(updated)
            if word.provenance.get("semantic_group_id") == group_id
        ]
        if positions == list(range(positions[0], positions[-1] + 1)):
            continue
        for index in positions:
            word = updated[index]
            provenance = dict(word.provenance)
            provenance["pt"] = provenance.get("pt_original") or provenance.get("pt") or ""
            provenance.pop("semantic_group_id", None)
            provenance.pop("semantic_group_role", None)
            provenance["translation_review_required"] = True
            updated[index] = replace(word, provenance=provenance)
    return updated, trailing, [str(word.id) for word in removed]


def _changed_word_provenance(word: WordTiming, surface: str) -> dict[str, Any]:
    provenance = dict(word.provenance)
    if surface == word.surface:
        return provenance
    provenance.setdefault("editorial_original_surface", word.surface)
    provenance["editorial_word_edited"] = True
    old_lexeme = re.sub(r"[^\w]+", "", word.surface).casefold()
    new_lexeme = re.sub(r"[^\w]+", "", surface).casefold()
    if old_lexeme != new_lexeme:
        provenance["translation_review_required"] = True
    return provenance


class EditApprovedText:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        approved_en: str,
        approved_pt: str,
        author: str,
        approve: bool = True,
        proposed_speech_timing: dict[str, int] | None = None,
        proposed_word_timings: list[dict[str, int]] | None = None,
        proposed_word_translations: list[str | None] | None = None,
    ) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        _literal(approved_en, "approved_en")
        _literal(approved_pt, "approved_pt")
        if not approved_en.strip() or not approved_pt.strip():
            raise EditorialCommandError("editorial text requires non-empty EN and PT text")
        before = _scene_snapshot(self._repository, cue.scene_id)
        current_text = (
            "".join(word.surface for word in words)
            + str(cue.provenance.get("editorial_preparation_trailing", ""))
        )
        updated_words = words
        provenance = dict(cue.provenance)
        if (
            approved_en != current_text
            or len(re.findall(r"\s*\S+", approved_en)) != len(words)
        ):
            updated_words, trailing, removed_ids = _reconcile_approved_words(
                approved_en, words, cue.speech_start_ms
            )
            provenance["editorial_preparation_trailing"] = trailing
            if removed_ids:
                provenance["editorial_deleted_word_ids"] = removed_ids
            provenance["editorial_text_manually_corrected"] = True
            provenance["editorial_text_ai_reference"] = cue.provenance.get(
                "editorial_text_ai_reference", cue.approved_en
            )
        new_start = cue.speech_start_ms
        new_end = max(cue.speech_end_ms, updated_words[-1].end_ms)
        if proposed_speech_timing is not None:
            new_start, new_end = _range(
                proposed_speech_timing.get("start_ms"),
                proposed_speech_timing.get("end_ms"),
                "proposed_speech_timing",
            )
        if proposed_word_timings is not None:
            if len(proposed_word_timings) != len(updated_words):
                raise EditorialCommandError(
                    "proposed_word_timings must match the edited word count"
                )
            revised: list[WordTiming] = []
            for word, timing in zip(updated_words, proposed_word_timings, strict=True):
                start, end = _range(
                    timing.get("start_ms"), timing.get("end_ms"), "proposed_word_timing"
                )
                provenance_word = dict(word.provenance)
                if (start, end) != (word.start_ms, word.end_ms):
                    provenance_word.pop("word_timing_reviewed", None)
                    provenance_word.pop("word_timing_reviewed_by", None)
                    provenance_word["editorial_timing_estimated"] = True
                revised.append(
                    replace(word, start_ms=start, end_ms=end, provenance=provenance_word)
                )
            updated_words = revised
        if proposed_word_translations is not None:
            if len(proposed_word_translations) != len(updated_words):
                raise EditorialCommandError(
                    "proposed_word_translations must match the edited word count"
                )
            revised_translations: list[WordTiming] = []
            for word, pt in zip(updated_words, proposed_word_translations, strict=True):
                if pt is not None and not isinstance(pt, str):
                    raise EditorialCommandError("proposed translation must be a string")
                provenance_word = dict(word.provenance)
                if (
                    pt is not None
                    and pt.strip()
                    and provenance_word.get("semantic_group_role") != "member"
                    and pt != provenance_word.get("pt")
                ):
                    provenance_word["pt"] = pt
                    provenance_word.pop("translation_review_required", None)
                revised_translations.append(replace(word, provenance=provenance_word))
            updated_words = revised_translations
        previous_end = new_start
        for word in updated_words:
            if (
                word.start_ms < previous_end
                or word.end_ms > new_end
                or word.start_ms >= word.end_ms
            ):
                raise EditorialCommandError(
                    "word timing outside edited cue or overlapping; adjust IN/OUT"
                )
            previous_end = word.end_ms
        project_id = self._repository.get_scene_project_id(cue.scene_id)
        scenes = self._repository.get_project_scenes(project_id) if project_id else []
        scene = next((scene for scene in scenes if scene.id == cue.scene_id), None)
        if scene is None or new_start < 0 or new_end > scene.duration_ms:
            raise EditorialCommandError(
                "expanded cue exceeds scene duration; shorten it before saving"
            )
        if approve and any(
            word.provenance.get("editorial_timing_estimated")
            and not word.provenance.get("word_timing_reviewed")
            for word in updated_words
        ):
            raise EditorialCommandError(
                "review estimated IN/OUT for each new or shifted word before approval"
            )
        if approve and any(
            word.provenance.get("translation_review_required") for word in updated_words
        ):
            raise EditorialCommandError(
                "review translations for the corrected words before approving the cue"
            )
        if approve:
            for neighbor in self._repository.get_scene_cues(cue.scene_id):
                if neighbor.id == cue.id:
                    continue
                if (
                    neighbor.order < cue.order and neighbor.speech_end_ms > new_start
                ) or (
                    neighbor.order > cue.order and neighbor.speech_start_ms < new_end
                ):
                    raise EditorialCommandError(
                        "cue overlaps another cue; adjust the boundaries before approval"
                    )
        updated = replace(
            cue,
            approved_en=approved_en,
            approved_pt=approved_pt,
            speech_start_ms=new_start,
            speech_end_ms=new_end,
            subtitle_start_ms=min(cue.subtitle_start_ms, new_start),
            subtitle_end_ms=max(cue.subtitle_end_ms, new_end),
            revision=cue.revision + 1,
            provenance={**provenance, "approval": "approved" if approve else "draft"},
        )
        if len(updated_words) != len(words):
            # Remove words and record the scene revision in one transaction.
            entries = [
                (
                    updated if current.id == cue.id else current,
                    updated_words
                    if current.id == cue.id
                    else self._repository.get_cue_words(current.id),
                )
                for current in self._repository.get_scene_cues(cue.scene_id)
            ]
            _replace_structure(
                self._repository,
                cue.scene_id,
                before,
                entries,
                command="edit_approved_text" if approve else "edit_draft_text",
                author=author,
            )
        else:
            self._repository.save_cue(updated, updated_words)
            _record(
                self._repository,
                updated,
                "edit_approved_text" if approve else "edit_draft_text",
                author,
                before,
            )
        return updated


class EditWordSurface:
    """Correct a word everywhere without changing its ID, order or recorded times."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        word_id: UUID,
        surface: str,
        author: str,
    ) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == word_id), None)
        if index is None:
            raise EditorialCommandError("word not found in cue")
        _literal(surface, "surface")
        if not surface.strip() or len(surface.split()) != 1:
            raise EditorialCommandError(
                "word correction must contain exactly one word; use cue reconciliation "
                "or manual segmentation to change word count"
            )
        target = words[index]
        leading = re.match(r"\s*", target.surface)
        preserved_space = leading.group(0) if leading else ""
        updated_surface = preserved_space + surface.strip()
        if updated_surface == target.surface:
            return cue
        updated_words = list(words)
        corrected_provenance = _changed_word_provenance(target, updated_surface)
        corrected_provenance.pop("word_timing_reviewed", None)
        corrected_provenance.pop("word_timing_reviewed_by", None)
        updated_words[index] = replace(
            target,
            surface=updated_surface,
            provenance=corrected_provenance,
        )
        before = _scene_snapshot(self._repository, cue.scene_id)
        new_text = (
            "".join(word.surface for word in updated_words)
            + str(cue.provenance.get("editorial_preparation_trailing", ""))
        )
        new_cue = replace(
            cue,
            approved_en=new_text,
            revision=cue.revision + 1,
            provenance={
                **cue.provenance,
                "approval": "draft",
                "editorial_text_manually_corrected": True,
                "editorial_text_ai_reference": cue.provenance.get(
                    "editorial_text_ai_reference", cue.approved_en
                ),
            },
        )
        self._repository.save_cue(new_cue, updated_words)
        _record(self._repository, new_cue, "edit_word_surface", author, before)
        return new_cue


def _remap_words_for_cue(
    words: list[WordTiming],
    *,
    original_start_ms: int,
    original_end_ms: int,
    target_start_ms: int,
    target_end_ms: int,
) -> list[WordTiming]:
    """Reposition child words proportionally when their parent speech interval changes.

    The transformation preserves ordering and proportional pauses, with a 1 ms
    minimum per word. It never changes the original ASR timestamps or word IDs.
    """
    if (
        original_start_ms == target_start_ms
        and original_end_ms == target_end_ms
    ):
        return words
    original_span = original_end_ms - original_start_ms
    target_span = target_end_ms - target_start_ms
    if original_span <= 0 or target_span < len(words):
        raise EditorialCommandError(
            "cue duration is too short to fit its words; increase the cue interval"
        )

    def project(time_ms: int) -> int:
        relative = max(0, min(original_span, time_ms - original_start_ms))
        # Integer half-up rounding; stable with the equivalent UI calculation.
        return target_start_ms + (
            2 * relative * target_span + original_span
        ) // (2 * original_span)

    updated: list[WordTiming] = []
    previous_end = target_start_ms
    for index, word in enumerate(words):
        remaining = len(words) - index - 1
        start = max(previous_end, min(project(word.start_ms), target_end_ms - remaining - 1))
        end = max(start + 1, min(project(word.end_ms), target_end_ms - remaining))
        provenance = dict(word.provenance)
        if start != word.start_ms or end != word.end_ms:
            provenance.pop("word_timing_reviewed", None)
            provenance.pop("word_timing_reviewed_by", None)
            provenance["timing_remapped_with_cue"] = True
        updated.append(
            replace(word, start_ms=start, end_ms=end, provenance=provenance)
        )
        previous_end = end
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
        updated_words = _remap_words_for_cue(
            words,
            original_start_ms=cue.speech_start_ms,
            original_end_ms=cue.speech_end_ms,
            target_start_ms=speech_start_ms,
            target_end_ms=speech_end_ms,
        )
        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = replace(
            cue,
            speech_start_ms=speech_start_ms,
            speech_end_ms=speech_end_ms,
            subtitle_start_ms=subtitle_start_ms,
            subtitle_end_ms=subtitle_end_ms,
            revision=cue.revision + 1,
            provenance={**cue.provenance, "approval": "draft"},
        )
        self._repository.save_cue(updated, updated_words)
        _record(self._repository, updated, "adjust_cue_timing", author, before)
        return updated


class FitCueToWords:
    """Expand a cue to contain every word, without changing a single word timestamp."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, author: str) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        if not words:
            raise EditorialCommandError("cue has no words to align")
        first = min(word.start_ms for word in words)
        last = max(word.end_ms for word in words)
        new_start = min(cue.speech_start_ms, first)
        new_end = max(cue.speech_end_ms, last)
        if new_start == cue.speech_start_ms and new_end == cue.speech_end_ms:
            return cue
        ordered = sorted(self._repository.get_scene_cues(cue.scene_id), key=lambda item: item.order)
        index = next(i for i, item in enumerate(ordered) if item.id == cue.id)
        if (index > 0 and ordered[index - 1].speech_end_ms > new_start) or (
            index + 1 < len(ordered) and ordered[index + 1].speech_start_ms < new_end
        ):
            raise EditorialCommandError(
                "word timestamps cross an adjacent cue. Review the boundary or merge/split "
                "the affected cues first; automatic adjustment would overlap speakers."
            )
        project_id = self._repository.get_scene_project_id(cue.scene_id)
        scenes = self._repository.get_project_scenes(project_id) if project_id else []
        scene = next((item for item in scenes if item.id == cue.scene_id), None)
        if scene is None or new_end > scene.duration_ms:
            raise EditorialCommandError("word timings exceed scene duration")
        updated = replace(
            cue,
            speech_start_ms=new_start,
            speech_end_ms=new_end,
            subtitle_start_ms=min(cue.subtitle_start_ms, new_start),
            subtitle_end_ms=max(cue.subtitle_end_ms, new_end),
            revision=cue.revision + 1,
            provenance={**cue.provenance, "approval": "draft"},
        )
        before = _scene_snapshot(self._repository, cue.scene_id)
        entries = [
            (
                updated if item.id == cue.id else item,
                words if item.id == cue.id else self._repository.get_cue_words(item.id),
            )
            for item in ordered
        ]
        _replace_structure(
            self._repository, cue.scene_id, before, entries,
            command="fit_cue_to_words", author=author,
        )
        return updated


class CompleteWordTimingReview:
    """Persist a word's manual timing review without approving the entire cue."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, word_id: UUID, author: str) -> WordTiming:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == word_id), None)
        if index is None:
            raise EditorialCommandError("word not found in cue")
        word = words[index]
        if (
            word.start_ms >= word.end_ms
            or word.start_ms < cue.speech_start_ms
            or word.end_ms > cue.speech_end_ms
        ):
            raise EditorialCommandError(
                "cannot finish a word with invalid timing or timing outside the cue"
            )
        if word.provenance.get("word_timing_reviewed") is True:
            return word
        before = _scene_snapshot(self._repository, cue.scene_id)
        provenance = {
            **word.provenance,
            "word_timing_reviewed": True,
            "word_timing_reviewed_by": author,
        }
        updated_word = replace(word, provenance=provenance)
        updated_words = list(words)
        updated_words[index] = updated_word
        self._repository.save_cue(cue, updated_words)
        _record(self._repository, cue, "complete_word_timing_review", author, before)
        return updated_word


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
            provenance = dict(word.provenance)
            if start != word.start_ms or end != word.end_ms:
                provenance.pop("word_timing_reviewed", None)
                provenance.pop("word_timing_reviewed_by", None)
            updated.append(replace(word, start_ms=start, end_ms=end, provenance=provenance))
            previous_end = end
        before = _scene_snapshot(self._repository, cue.scene_id)
        self._repository.save_cue(cue, updated)
        _record(self._repository, cue, "adjust_word_timing", author, before)
        return updated


class RealignCue:
    """Move a complete cue while preserving every internal duration and offset."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, target_start_ms: int, author: str) -> Cue:
        cue, words = _cue_with_words(self._repository, cue_id)
        if target_start_ms < 0:
            raise EditorialCommandError("target_start_ms must be non-negative")
        project_id = self._repository.get_scene_project_id(cue.scene_id)
        scenes = self._repository.get_project_scenes(project_id) if project_id else []
        scene = next((item for item in scenes if item.id == cue.scene_id), None)
        delta = target_start_ms - cue.speech_start_ms
        shifted = replace(
            cue,
            speech_start_ms=cue.speech_start_ms + delta,
            speech_end_ms=cue.speech_end_ms + delta,
            subtitle_start_ms=cue.subtitle_start_ms + delta,
            subtitle_end_ms=cue.subtitle_end_ms + delta,
            revision=cue.revision + 1,
        )
        shifted_words = [
            replace(word, start_ms=word.start_ms + delta, end_ms=word.end_ms + delta)
            for word in words
        ]
        if scene is None or shifted.speech_end_ms > scene.duration_ms:
            raise EditorialCommandError("realigned cue exceeds the scene duration")
        before = _scene_snapshot(self._repository, cue.scene_id)
        self._repository.save_cue(shifted, shifted_words)
        _record(self._repository, shifted, "realign_cue", author, before)
        return shifted


class EditWordTranslation:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, word_id: UUID, pt: str, author: str) -> list[WordTiming]:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == word_id), None)
        if index is None:
            raise EditorialCommandError("word not found in cue")
        group_id = _semantic_group_id(words[index])
        members = [i for i, word in enumerate(words) if _semantic_group_id(word) == group_id]
        if not group_id:
            members = [index]
        if not pt:
            raise EditorialCommandError("word or group translation is required")
        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = list(words)
        lead = min(members)
        for position in members:
            provenance = dict(updated[position].provenance)
            provenance["pt"] = pt if position == lead else None
            provenance.pop("translation_review_required", None)
            updated[position] = replace(updated[position], provenance=provenance)
        changed_cue = _word_edit_draft(cue)
        self._repository.save_cue(changed_cue, updated)
        _record(self._repository, changed_cue, "edit_word_translation", author, before)
        return updated


class GroupWordTranslation:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        word_id: UUID,
        direction: str,
        pt: str,
        author: str,
    ) -> list[WordTiming]:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == word_id), None)
        if index is None:
            raise EditorialCommandError("word not found in cue")
        current = _semantic_members(words, index)
        neighbor_index = min(current) - 1 if direction == "previous" else max(current) + 1
        if direction not in {"previous", "next"} or not 0 <= neighbor_index < len(words):
            raise EditorialCommandError("there is no adjacent unit to group")
        members = sorted(set(current + _semantic_members(words, neighbor_index)))
        if members != list(range(min(members), max(members) + 1)):
            raise EditorialCommandError("only contiguous words can be grouped")
        if not pt:
            raise EditorialCommandError("group translation is required")
        before = _scene_snapshot(self._repository, cue.scene_id)
        group_id = f"semantic-{uuid4()}"
        updated = list(words)
        lead = members[0]
        for position in members:
            provenance = dict(updated[position].provenance)
            if "pt_original" not in provenance:
                provenance["pt_original"] = provenance.get("pt") or ""
            provenance.update(
                {
                    "semantic_group_id": group_id,
                    "semantic_group_role": "lead" if position == lead else "member",
                    "pt": pt if position == lead else None,
                }
            )
            updated[position] = replace(updated[position], provenance=provenance)
        changed_cue = _word_edit_draft(cue)
        self._repository.save_cue(changed_cue, updated)
        _record(self._repository, changed_cue, "group_word_translation", author, before)
        return updated


class UngroupWordTranslation:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(self, cue_id: UUID, *, word_id: UUID, author: str) -> list[WordTiming]:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == word_id), None)
        if index is None:
            raise EditorialCommandError("word not found in cue")
        members = _semantic_members(words, index)
        if len(members) < 2:
            raise EditorialCommandError("word does not belong to a semantic group")
        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = list(words)
        for position in members:
            provenance = dict(updated[position].provenance)
            provenance["pt"] = provenance.pop("pt_original", "")
            provenance.pop("semantic_group_id", None)
            provenance.pop("semantic_group_role", None)
            updated[position] = replace(updated[position], provenance=provenance)
        changed_cue = _word_edit_draft(cue)
        self._repository.save_cue(changed_cue, updated)
        _record(self._repository, changed_cue, "ungroup_word_translation", author, before)
        return updated


class ReplaceSemanticWordUnits:
    """Atomically replace every semantic unit of a cue without changing word timings."""

    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self,
        cue_id: UUID,
        *,
        expected_revision: int,
        units: list[dict[str, object]],
        author: str,
    ) -> list[WordTiming]:
        cue, words = _cue_with_words(self._repository, cue_id)
        if cue.revision != expected_revision:
            raise EditorialCommandError("cue changed after the semantic suggestion was created")
        positions_by_id = {str(word.id): index for index, word in enumerate(words)}
        normalized: list[tuple[list[int], str]] = []
        used: set[int] = set()
        for unit in units:
            raw_ids = unit.get("word_ids")
            pt = unit.get("pt")
            if not isinstance(raw_ids, list) or len(raw_ids) < 2:
                raise EditorialCommandError("semantic units must contain at least two words")
            if not isinstance(pt, str) or not pt.strip():
                raise EditorialCommandError("semantic unit translation is required")
            try:
                positions = [positions_by_id[str(word_id)] for word_id in raw_ids]
            except KeyError as error:
                raise EditorialCommandError(
                    "semantic unit references a word outside its cue"
                ) from error
            if len(set(positions)) != len(positions):
                raise EditorialCommandError("semantic unit contains duplicate words")
            if positions != list(range(positions[0], positions[0] + len(positions))):
                raise EditorialCommandError("semantic units must use contiguous words in cue order")
            if used.intersection(positions):
                raise EditorialCommandError("semantic units cannot overlap")
            used.update(positions)
            normalized.append((positions, pt))

        before = _scene_snapshot(self._repository, cue.scene_id)
        updated = [_without_semantic_group(word) for word in words]
        for positions, pt in normalized:
            group_id = f"semantic-{uuid4()}"
            for offset, position in enumerate(positions):
                provenance = dict(updated[position].provenance)
                provenance["pt_original"] = provenance.get("pt") or ""
                provenance.update(
                    {
                        "semantic_group_id": group_id,
                        "semantic_group_role": "lead" if offset == 0 else "member",
                        "pt": pt if offset == 0 else None,
                    }
                )
                updated[position] = replace(updated[position], provenance=provenance)
        changed_cue = _word_edit_draft(cue)
        self._repository.save_cue(changed_cue, updated)
        _record(self._repository, changed_cue, "replace_semantic_word_units", author, before)
        return updated


def _without_semantic_group(word: WordTiming) -> WordTiming:
    provenance = dict(word.provenance)
    if "semantic_group_id" in provenance:
        provenance["pt"] = provenance.pop("pt_original", provenance.get("pt") or "")
    provenance.pop("semantic_group_id", None)
    provenance.pop("semantic_group_role", None)
    return replace(word, provenance=provenance)


def _word_edit_draft(cue: Cue) -> Cue:
    return replace(
        cue,
        revision=cue.revision + 1,
        provenance={**cue.provenance, "approval": "draft"},
    )


def _semantic_group_id(word: WordTiming) -> str:
    value = word.provenance.get("semantic_group_id")
    return value if isinstance(value, str) else ""


def _semantic_members(words: list[WordTiming], index: int) -> list[int]:
    group_id = _semantic_group_id(words[index])
    if not group_id:
        return [index]
    return [i for i, word in enumerate(words) if _semantic_group_id(word) == group_id]


def _replace_structure(
    repository: EditorialProjectRepository,
    scene_id: UUID,
    before: dict[str, Any],
    replacement: list[tuple[Cue, list[WordTiming]]],
    *,
    command: str,
    author: str,
) -> None:
    project_id = repository.get_scene_project_id(scene_id)
    if project_id is None:
        raise EditorialCommandError("scene not found")
    revision = EditorialRevision(
        uuid4(),
        project_id,
        scene_id,
        None,
        max((item.sequence for item in repository.list_revisions(scene_id)), default=0) + 1,
        command,
        author,
        "editorial-api",
        before,
        {
            "cues": [
                {"cue": _cue_data(cue), "words": [_word_data(word) for word in words]}
                for cue, words in replacement
            ]
        },
        datetime.now(UTC),
    )
    if not repository.replace_scene_cues_with_revision(scene_id, before, replacement, revision):
        raise EditorialCommandError("scene changed during structural edit; reload and retry")


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
        first_speaker: str | None = None,
        second_speaker: str | None = None,
    ) -> list[Cue]:
        cue, words = _cue_with_words(self._repository, cue_id)
        index = next((i for i, word in enumerate(words) if word.id == after_word_id), None)
        if index is None or index == len(words) - 1:
            raise EditorialCommandError("after_word_id must identify a non-final word in the cue")
        _split_text(first, "first")
        _split_text(second, "second")
        if any(not value.strip() for value in (*first.values(), *second.values())):
            raise EditorialCommandError("split requires English and Portuguese for both parts")
        left_words, right_words = words[: index + 1], words[index + 1 :]
        left_groups = {
            word.provenance.get("semantic_group_id")
            for word in left_words if word.provenance.get("semantic_group_id")
        }
        right_groups = {
            word.provenance.get("semantic_group_id")
            for word in right_words if word.provenance.get("semantic_group_id")
        }
        if left_groups.intersection(right_groups):
            raise EditorialCommandError(
                "split boundary crosses a semantic group; ungroup it before splitting"
            )
        if left_words[-1].end_ms > right_words[0].start_ms:
            raise EditorialCommandError("word timings overlap at the selected split boundary")
        before = _scene_snapshot(self._repository, cue.scene_id)
        left_id, right_id = uuid4(), uuid4()
        left_end = left_words[-1].end_ms
        right_start = right_words[0].start_ms
        provenance = {
            **cue.provenance,
            "approval": "draft",
            "structural_edit": "manual_split",
            "split_from": str(cue.id),
        }
        left = Cue(
            left_id, cue.scene_id, cue.order,
            cue.speech_start_ms, left_end,
            cue.subtitle_start_ms, left_end,
            first_speaker if first_speaker is not None else cue.speaker,
            first["original_en"], first["approved_en"], first["approved_pt"],
            cue.revision + 1,
            {**provenance, "split_side": "first"},
        )
        right = Cue(
            right_id, cue.scene_id, cue.order + 1,
            right_start, cue.speech_end_ms,
            right_start, cue.subtitle_end_ms,
            second_speaker if second_speaker is not None else cue.speaker,
            second["original_en"], second["approved_en"], second["approved_pt"],
            cue.revision + 1,
            {**provenance, "split_side": "second"},
        )
        all_cues = self._repository.get_scene_cues(cue.scene_id)
        replacement: list[tuple[Cue, list[WordTiming]]] = []
        for current in all_cues:
            if current.id == cue.id:
                replacement.extend([
                    (left, _move_words(left_words, left_id)),
                    (right, _move_words(right_words, right_id)),
                ])
            else:
                shift = 1 if current.order > cue.order else 0
                replacement.append(
                    (
                        replace(current, order=current.order + shift),
                        self._repository.get_cue_words(current.id),
                    )
                )
        _replace_structure(
            self._repository, cue.scene_id, before, replacement,
            command="split_cue", author=author,
        )
        return [left, right]


class MergeCues:
    def __init__(self, repository: EditorialProjectRepository) -> None:
        self._repository = repository

    def execute(
        self, first_cue_id: UUID, second_cue_id: UUID, *, text: dict[str, str], author: str
    ) -> Cue:
        return self.execute_many([first_cue_id, second_cue_id], text=text, author=author)

    def execute_many(
        self,
        cue_ids: list[UUID],
        *,
        text: dict[str, str],
        author: str,
        speaker_override: str | None = None,
        confirm_same_speaker: bool = False,
    ) -> Cue:
        if not 2 <= len(cue_ids) <= 12 or len(set(cue_ids)) != len(cue_ids):
            raise EditorialCommandError("merge requires between 2 and 12 distinct consecutive cues")
        _split_text(text, "text")
        if any(not value.strip() for value in text.values()):
            raise EditorialCommandError("merged English and Portuguese cannot be empty")
        selected = [_cue_with_words(self._repository, cue_id) for cue_id in cue_ids]
        first = selected[0][0]
        if any(
            cue.scene_id != first.scene_id or cue.order != first.order + index
            for index, (cue, _) in enumerate(selected)
        ):
            raise EditorialCommandError("cues must be consecutive and in scene order")
        known_speakers = {
            cue.speaker.strip().casefold() for cue, _ in selected if cue.speaker.strip()
        }
        if len(known_speakers) > 1 and not (
            confirm_same_speaker and speaker_override and speaker_override.strip()
        ):
            raise EditorialCommandError(
                "different speakers detected; confirm the same voice and choose its label"
            )
        all_words = [word for _, words in selected for word in words]
        if any(
            current.end_ms > next_word.start_ms
            for current, next_word in zip(all_words, all_words[1:], strict=False)
        ):
            raise EditorialCommandError("words must be chronological and non-overlapping")
        before = _scene_snapshot(self._repository, first.scene_id)
        last = selected[-1][0]
        new_id = uuid4()
        merged = Cue(
            new_id, first.scene_id, first.order,
            first.speech_start_ms, last.speech_end_ms,
            first.subtitle_start_ms, last.subtitle_end_ms,
            speaker_override.strip()
            if speaker_override is not None and speaker_override.strip()
            else next((cue.speaker for cue, _ in selected if cue.speaker.strip()), ""),
            text["original_en"], text["approved_en"], text["approved_pt"],
            max(cue.revision for cue, _ in selected) + 1,
            {
                **first.provenance,
                "approval": "draft",
                "structural_edit": "manual_merge",
                "speaker_verified_by_editor": confirm_same_speaker,
                "merged_from": [str(cue.id) for cue, _ in selected],
            },
        )
        removed_ids = set(cue_ids)
        decrease = len(selected) - 1
        replacement: list[tuple[Cue, list[WordTiming]]] = []
        for cue in self._repository.get_scene_cues(first.scene_id):
            if cue.id == first.id:
                replacement.append((merged, _move_words(all_words, new_id)))
            elif cue.id in removed_ids:
                continue
            else:
                replacement.append(
                    (
                        replace(
                            cue,
                            order=cue.order - decrease if cue.order > last.order else cue.order,
                        ),
                        self._repository.get_cue_words(cue.id),
                    )
                )
        _replace_structure(
            self._repository, first.scene_id, before, replacement,
            command="merge_cues", author=author,
        )
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
