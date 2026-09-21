"""Semantic validation for the versioned editorial cue contract.

Kept dependency-free so it can run in CI before the FastAPI domain exists.
"""
from __future__ import annotations

from hashlib import sha256
from typing import Any
from uuid import UUID


class ContractViolation(ValueError):
    """The supplied document breaks a published editorial invariant."""


def _fail(path: str, message: str) -> None:
    raise ContractViolation(f"{path}: {message}")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_uuid(value: Any, path: str) -> None:
    if not isinstance(value, str):
        _fail(path, "must be a UUID string")
    try:
        UUID(value)
    except ValueError:
        _fail(path, "must be a UUID string")


def _validate_literal(value: Any, path: str) -> str:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    text = value.get("value")
    digest = value.get("utf8_sha256")
    if not isinstance(text, str) or not text:
        _fail(f"{path}.value", "must be a non-empty literal string")
    expected = sha256(text.encode("utf-8")).hexdigest()
    if digest != expected:
        _fail(f"{path}.utf8_sha256", "does not match the literal UTF-8 value")
    return text


def _validate_range(value: Any, path: str, upper_bound: int) -> tuple[int, int]:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    start, end = value.get("start_ms"), value.get("end_ms")
    if not _is_int(start) or not _is_int(end):
        _fail(path, "timestamps must be integer milliseconds")
    if not 0 <= start < end <= upper_bound:
        _fail(path, f"must be within 0..{upper_bound} ms with positive duration")
    return start, end


def validate_document(document: dict[str, Any]) -> None:
    """Validate the semantic invariants of an editorial-cues 1.0 document."""
    if not isinstance(document, dict):
        _fail("$", "must be an object")
    if document.get("schema") != "nova-generator/editorial-cues":
        _fail("$.schema", "must be nova-generator/editorial-cues")
    if document.get("schema_version") != "1.0":
        _fail("$.schema_version", "must be 1.0")
    _require_uuid(document.get("project_id"), "$.project_id")
    timeline = document.get("timeline")
    if not isinstance(timeline, dict) or timeline.get("origin") != "scene_local_ms":
        _fail("$.timeline", "must use the scene_local_ms timeline")
    duration = timeline.get("duration_ms")
    if not _is_int(duration) or duration < 1:
        _fail("$.timeline.duration_ms", "must be a positive integer")
    cues = document.get("cues")
    if not isinstance(cues, list) or not cues:
        _fail("$.cues", "must be a non-empty list")

    seen_cue_ids: set[str] = set()
    for cue_index, cue in enumerate(cues):
        path = f"$.cues[{cue_index}]"
        if not isinstance(cue, dict):
            _fail(path, "must be an object")
        if cue.get("order") != cue_index + 1:
            _fail(f"{path}.order", "must be sequential and start at 1")
        cue_id = cue.get("id")
        _require_uuid(cue_id, f"{path}.id")
        if cue_id in seen_cue_ids:
            _fail(f"{path}.id", "must be unique")
        seen_cue_ids.add(cue_id)
        speech_start, speech_end = _validate_range(cue.get("speech_timing"), f"{path}.speech_timing", duration)
        _validate_range(cue.get("subtitle_timing"), f"{path}.subtitle_timing", duration)
        _validate_literal(cue.get("original_en"), f"{path}.original_en")
        approved_en = _validate_literal(cue.get("approved_en"), f"{path}.approved_en")
        _validate_literal(cue.get("approved_pt"), f"{path}.approved_pt")
        if not _is_int(cue.get("revision")) or cue["revision"] < 1:
            _fail(f"{path}.revision", "must be a positive integer")

        tokens = cue.get("tokens")
        if not isinstance(tokens, list) or not tokens:
            _fail(f"{path}.tokens", "must be a non-empty list")
        assembled: list[str] = []
        cursor = 0
        previous_word_end = speech_start
        seen_token_ids: set[str] = set()
        word_count = 0
        for token_index, token in enumerate(tokens):
            token_path = f"{path}.tokens[{token_index}]"
            if not isinstance(token, dict):
                _fail(token_path, "must be an object")
            if token.get("order") != token_index + 1:
                _fail(f"{token_path}.order", "must be sequential and start at 1")
            token_id = token.get("id")
            _require_uuid(token_id, f"{token_path}.id")
            if token_id in seen_token_ids:
                _fail(f"{token_path}.id", "must be unique within its cue")
            seen_token_ids.add(token_id)
            surface = token.get("surface")
            if not isinstance(surface, str) or not surface:
                _fail(f"{token_path}.surface", "must be a non-empty literal string")
            start, end = token.get("char_start"), token.get("char_end")
            if not _is_int(start) or not _is_int(end) or start != cursor or end != start + len(surface):
                _fail(token_path, "must have contiguous character offsets matching surface")
            kind = token.get("kind")
            timing = token.get("timing")
            if kind == "word":
                word_count += 1
                if timing is None:
                    _fail(f"{token_path}.timing", "is required for a word")
                word_start, word_end = _validate_range(timing, f"{token_path}.timing", duration)
                if word_start < speech_start or word_end > speech_end:
                    _fail(f"{token_path}.timing", "must stay inside parent speech timing")
                if word_start < previous_word_end:
                    _fail(f"{token_path}.timing", "must not overlap or move before the previous word")
                previous_word_end = word_end
            elif kind in {"punctuation", "whitespace"}:
                if timing is not None:
                    _fail(f"{token_path}.timing", "must be null for punctuation and whitespace")
            else:
                _fail(f"{token_path}.kind", "must be word, punctuation, or whitespace")
            assembled.append(surface)
            cursor = end
        if word_count == 0:
            _fail(f"{path}.tokens", "must include at least one word")
        if "".join(assembled) != approved_en:
            _fail(f"{path}.tokens", "must concatenate exactly to approved_en; do not normalize or rebuild text")
