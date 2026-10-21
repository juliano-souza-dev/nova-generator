"""Map approved Anki lessons to the iHub Structures in Context transport.

This does not generate new pedagogy, alter Anki cards, or estimate word timings.
Only verified focus spans from the original editorial audio are published.
"""

from __future__ import annotations

import unicodedata
from typing import Any


class StructuresInContextError(ValueError):
    """A prepared lesson cannot be published as a playable source expression."""


def _normalized_token(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    for mark in ("’", "‘", "`", "´"):
        text = text.replace(mark, "'")
    text = text.casefold()
    start, end = 0, len(text)
    while start < end and not (text[start].isalnum() or text[start] == "'"):
        start += 1
    while end > start and not (text[end - 1].isalnum() or text[end - 1] == "'"):
        end -= 1
    return text[start:end]


def _matching_word_indexes(words: list[dict[str, Any]], expression: str) -> list[int]:
    # Match the same contiguous, normalized tokens as iHub's word-study player.
    target = [_normalized_token(token) for token in expression.split()]
    target = [token for token in target if token]
    source = [_normalized_token(word.get("text", "")) for word in words]
    if not target or len(target) > len(source):
        return []
    for start in range(len(source) - len(target) + 1):
        if source[start:start + len(target)] == target:
            return list(range(start, start + len(target)))
    return []


def build_structures_in_context(
    cards: list[dict[str, Any]],
    rows_by_cue: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Create iHub's wbw_practices from frozen, approved didactic cards.

    Cue references and word ranges use the same published source timeline.
    On an unplayable or incomplete item, fail instead of silently dropping a
    curated lesson or manufacturing fake word-level intervals.
    """
    allowed = {
        "vocabulary", "phrasal_verb", "structure",
        "collocation", "idiom", "expression",
    }
    practices: list[dict[str, Any]] = []
    for number, card in enumerate(cards, start=1):
        cue_id = str(card.get("cue_id", ""))
        source = rows_by_cue.get(cue_id)
        if source is None:
            raise StructuresInContextError(
                f"English in Context card {number} has no published source cue"
            )
        expression = str(card.get("focus_text", "")).strip()
        meaning = str(card.get("meaning", "")).strip()
        explanation = str(card.get("explanation_pt", "")).strip()
        example_en = str(card.get("example_en", "")).strip()
        example_pt = str(card.get("example_pt", "")).strip()
        if not all((expression, meaning, explanation, example_en, example_pt)):
            raise StructuresInContextError(
                f"English in Context card {number} is missing its mini-lesson fields"
            )
        words = source.get("words", [])
        indexes = _matching_word_indexes(words, expression)
        if not indexes:
            raise StructuresInContextError(
                f"English in Context card {number}: focus_text {expression!r} "
                "does not match contiguous source words; review its word timings"
            )
        start_ms = int(words[indexes[0]]["start_ms"])
        end_ms = int(words[indexes[-1]]["end_ms"])
        if start_ms < 0 or end_ms <= start_ms:
            raise StructuresInContextError(
                f"English in Context card {number} has invalid original audio timing"
            )
        kind = str(card.get("card_type", "structure")).strip().lower()
        kind = kind.replace(" ", "_").replace("-", "_")
        if kind == "phrasal":
            kind = "phrasal_verb"
        if kind not in allowed:
            kind = "structure"
        practices.append({
            "cue_order": int(source["order"]),
            "type": kind,
            "expression_en": expression,
            "word_indexes": indexes,
            "meaning_pt": meaning,
            "explanation_pt": explanation,
            "example_en": example_en,
            "example_pt": example_pt,
            "start_ms": start_ms,
            "end_ms": end_ms,
        })
    return practices
