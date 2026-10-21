"""Shared Anki proposal contract and deterministic editorial cue reconciliation."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nova_generator.domain.projects.entities import Cue


class AnkiCard(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    cue_id: UUID
    front_en: str = Field(min_length=1)
    back_pt: str = Field(min_length=1)
    card_type: str = Field(min_length=1, max_length=80)
    focus_text: str = Field(min_length=1, max_length=255)
    meaning: str = Field(min_length=1, max_length=500)
    marked_en: str = Field(min_length=1, max_length=255)
    marked_pt: str = Field(min_length=1, max_length=255)
    explanation_pt: str = Field(min_length=1, max_length=3000)
    example_en: str = Field(min_length=1, max_length=1500)
    example_pt: str = Field(min_length=1, max_length=1500)
    tags: list[str] = Field(max_length=12)


class AnkiProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contract: Literal["nova-generator-anki-proposal/1.0"]
    scene_id: UUID
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    anki_cards: list[AnkiCard] = Field(min_length=1, max_length=50)


def validate_anki_cards(
    proposal: AnkiProposal,
    approved_cues: Mapping[str, tuple[str, str]],
) -> None:
    """Require literal current text; allow distinct lessons on one merged cue."""
    seen: set[tuple[str, str]] = set()
    for card in proposal.anki_cards:
        cue_id = str(card.cue_id)
        if cue_id not in approved_cues:
            raise ValueError(f"Anki cue_id not found in this scene: {cue_id}")
        lesson_key = (cue_id, card.focus_text.strip().casefold())
        if lesson_key in seen:
            raise ValueError(
                f"Anki cue and focus repeated: {cue_id}, {card.focus_text}"
            )
        seen.add(lesson_key)
        english, portuguese = approved_cues[cue_id]
        if card.front_en != english or card.back_pt != portuguese:
            raise ValueError(
                f"Anki card {cue_id} has text different from the approved editorial cue; "
                "review the cue and update the Anki draft before importing"
            )
        if card.marked_en.casefold() not in english.casefold():
            raise ValueError(f"Anki card {cue_id} has marked_en outside the approved cue")
        if card.marked_pt.casefold() not in portuguese.casefold():
            raise ValueError(f"Anki card {cue_id} has marked_pt outside the approved cue")


def _canonical_phrase(value: str) -> str:
    """Ignore surrounding/duplicate whitespace, not letters or punctuation."""
    return " ".join(value.split()).casefold()


def _can_reanchor(card: AnkiCard, cue: Cue) -> bool:
    english = _canonical_phrase(card.front_en)
    portuguese = _canonical_phrase(card.back_pt)
    current_en = _canonical_phrase(cue.approved_en)
    current_pt = _canonical_phrase(cue.approved_pt)
    return (
        len(english) >= 10
        and len(portuguese) >= 7
        and english in current_en
        and portuguese in current_pt
        and card.marked_en.casefold() in cue.approved_en.casefold()
        and card.marked_pt.casefold() in cue.approved_pt.casefold()
    )


def reconcile_anki_proposal(proposal: AnkiProposal, cues: Sequence[Cue]) -> AnkiProposal:
    """Reanchor cards after cue merges using exact bilingual content and unique lineage.

    No fuzzy matching, invented cue IDs, or silent deletion of lessons. If a source
    cue was split or edited and the target cannot be uniquely proved, fail with
    a concrete error so the operator can review the editorial change.
    """
    by_id = {str(cue.id): cue for cue in cues}
    repaired: list[AnkiCard] = []
    for card in proposal.anki_cards:
        old_id = str(card.cue_id)
        direct = by_id.get(old_id)
        if direct is not None:
            # A surviving ID with changed text is not safe to rewrite automatically.
            repaired.append(card)
            continue

        candidates: list[Cue] = []
        for cue in cues:
            lineage = cue.provenance or {}
            merged_from = lineage.get("ai_merged_from", [])
            if not isinstance(merged_from, list):
                merged_from = []
            explicitly_related = (
                old_id in [str(value) for value in merged_from]
                or str(lineage.get("split_from", "")) == old_id
            )
            # Content-only fallback handles older merges without provenance, but
            # requires a unique EN/PT literal match, never English alone.
            if _can_reanchor(card, cue) and (
                explicitly_related or _canonical_phrase(card.front_en)
                in _canonical_phrase(cue.approved_en)
            ):
                candidates.append(cue)

        if len(candidates) != 1:
            detail = (
                "no unique successor cue matches its English and Portuguese"
                if not candidates else
                f"{len(candidates)} possible successor cues"
            )
            raise ValueError(
                f"Anki cue_id {old_id} was replaced by the Editorial, but {detail}. "
                "Review the merged/split cue rather than assigning a guessed ID."
            )

        selected = candidates[0]
        repaired.append(card.model_copy(update={
            "cue_id": selected.id,
            "front_en": selected.approved_en,
            "back_pt": selected.approved_pt,
        }))

    resolved = proposal.model_copy(update={"anki_cards": repaired})
    validate_anki_cards(
        resolved,
        {str(cue.id): (cue.approved_en, cue.approved_pt) for cue in cues},
    )
    return resolved
