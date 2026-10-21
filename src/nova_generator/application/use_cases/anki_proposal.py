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


class DidacticAnkiCard(BaseModel):
    """Editable Anki lesson. Front/back are new pedagogical sentences, not subtitles."""

    model_config = ConfigDict(extra="forbid", strict=True)

    card_id: UUID
    cue_id: UUID
    source_context_en: str = Field(min_length=1, max_length=4000)
    source_context_pt: str = Field(min_length=1, max_length=4000)
    front_en: str = Field(min_length=1, max_length=2000)
    back_pt: str = Field(min_length=1, max_length=2000)
    uses_literal_scene_line: bool = False
    card_type: str = Field(min_length=1, max_length=80)
    focus_text: str = Field(min_length=1, max_length=255)
    meaning: str = Field(min_length=1, max_length=500)
    marked_en: str = Field(min_length=1, max_length=255)
    marked_pt: str = Field(min_length=1, max_length=255)
    explanation_pt: str = Field(min_length=1, max_length=3000)
    example_en: str = Field(min_length=1, max_length=1500)
    example_pt: str = Field(min_length=1, max_length=1500)
    tags: list[str] = Field(max_length=12)


class DidacticAnkiProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contract: Literal["nova-generator-anki-proposal/2.0"]
    scene_id: UUID
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    anki_cards: list[DidacticAnkiCard] = Field(min_length=1, max_length=50)


def validate_didactic_cards(
    proposal: DidacticAnkiProposal,
    approved_cues: Mapping[str, tuple[str, str]],
) -> None:
    """Keep original context literal but permit pedagogically rewritten examples."""
    seen: set[UUID] = set()
    focus_seen: set[tuple[UUID, str]] = set()
    for card in proposal.anki_cards:
        key = str(card.cue_id)
        if key not in approved_cues:
            raise ValueError(f"Anki cue_id not found in this scene: {key}")
        if card.card_id in seen:
            raise ValueError(f"Anki card_id repeated: {card.card_id}")
        seen.add(card.card_id)
        original_en, original_pt = approved_cues[key]
        if (card.source_context_en, card.source_context_pt) != (original_en, original_pt):
            raise ValueError(
                f"Anki card {card.card_id} context differs from its approved editorial cue"
            )
        if card.focus_text.casefold() not in original_en.casefold():
            raise ValueError(
                f"Anki card {card.card_id} focus_text must occur in the source cue"
            )
        if card.marked_en.casefold() not in card.front_en.casefold():
            raise ValueError(f"Anki card {card.card_id} marked_en must occur in front_en")
        if card.marked_pt.casefold() not in card.back_pt.casefold():
            raise ValueError(f"Anki card {card.card_id} marked_pt must occur in back_pt")
        if card.uses_literal_scene_line != (
            card.front_en == original_en and card.back_pt == original_pt
        ):
            raise ValueError(
                f"Anki card {card.card_id} uses_literal_scene_line contradicts its front/back"
            )
        focus_key = (card.cue_id, card.focus_text.casefold().strip())
        if focus_key in focus_seen:
            raise ValueError(f"Anki focus repeated for source cue: {card.focus_text}")
        focus_seen.add(focus_key)


def reconcile_didactic_proposal(
    proposal: DidacticAnkiProposal, cues: Sequence[Cue]
) -> DidacticAnkiProposal:
    """Re-anchor merged cues by unique bilingual source context, not the generated face."""
    by_id = {str(cue.id): cue for cue in cues}
    repaired: list[DidacticAnkiCard] = []
    for card in proposal.anki_cards:
        cue = by_id.get(str(card.cue_id))
        if cue is None:
            matches = [
                item for item in cues
                if _canonical_phrase(card.source_context_en)
                in _canonical_phrase(item.approved_en)
                and _canonical_phrase(card.source_context_pt)
                in _canonical_phrase(item.approved_pt)
                and card.focus_text.casefold() in item.approved_en.casefold()
            ]
            if len(matches) != 1:
                raise ValueError(
                    f"Anki cue_id {card.cue_id} has no unique successor after the Editorial"
                )
            cue = matches[0]
        updated = card.model_copy(update={
            "cue_id": cue.id,
            "source_context_en": cue.approved_en,
            "source_context_pt": cue.approved_pt,
        })
        if updated.uses_literal_scene_line:
            updated = updated.model_copy(update={
                "front_en": cue.approved_en, "back_pt": cue.approved_pt
            })
        repaired.append(updated)
    result = proposal.model_copy(update={"anki_cards": repaired})
    validate_didactic_cards(
        result, {str(cue.id): (cue.approved_en, cue.approved_pt) for cue in cues}
    )
    return result


def legacy_to_didactic(
    proposal: AnkiProposal,
    approved_cues: Mapping[str, tuple[str, str]],
) -> DidacticAnkiProposal:
    """Non-destructive display/edit migration for existing imported v1 cards."""
    from uuid import uuid5

    upgraded = []
    for card in proposal.anki_cards:
        # Preserve stale source text so the Materials review can flag it.
        # Never silently drop an imported legacy lesson after editorial edits.
        updated = DidacticAnkiCard(
            card_id=uuid5(proposal.scene_id, f"{card.cue_id}:{card.focus_text}"),
            cue_id=card.cue_id,
            source_context_en=card.front_en,
            source_context_pt=card.back_pt,
            front_en=card.front_en,
            back_pt=card.back_pt,
            uses_literal_scene_line=True,
            card_type=card.card_type,
            focus_text=card.focus_text,
            meaning=card.meaning,
            marked_en=card.marked_en,
            marked_pt=card.marked_pt,
            explanation_pt=card.explanation_pt,
            example_en=card.example_en,
            example_pt=card.example_pt,
            tags=card.tags,
        )
        upgraded.append(updated)
    return DidacticAnkiProposal(
        contract="nova-generator-anki-proposal/2.0",
        scene_id=proposal.scene_id,
        input_sha256=proposal.input_sha256,
        anki_cards=upgraded,
    )
