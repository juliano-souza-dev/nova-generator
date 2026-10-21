"""Shared, strict Anki proposal contract used by initial and Materials imports."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


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
    """Verify scene-local identities and exact EN/PT without changing the content."""
    seen: set[str] = set()
    for card in proposal.anki_cards:
        cue_id = str(card.cue_id)
        if cue_id not in approved_cues:
            raise ValueError(f"Anki cue_id not found in this scene: {cue_id}")
        if cue_id in seen:
            raise ValueError(f"Anki cue_id repeated: {cue_id}")
        seen.add(cue_id)
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
