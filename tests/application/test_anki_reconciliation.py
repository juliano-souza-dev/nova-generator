"""Regression for editorial merges replacing cue IDs after initial Anki preparation."""

from __future__ import annotations

import json
from uuid import UUID

import pytest

from nova_generator.application.use_cases.anki_proposal import (
    AnkiProposal,
    reconcile_anki_proposal,
)
from nova_generator.domain.projects.entities import Cue

SCENE = UUID("ea2fa8f1-537b-51c8-b5cf-3254c6ededb6")
ORIGINAL_SUPERVISION = "6535d80c-574a-5812-9957-1291cf6dbe2e"
ORIGINAL_ANSWER = "71baf5a0-ceda-515f-9c84-4a1d682bfa41"
MERGED = "daa5a78d-b9ea-5e43-a0ee-cfc3d066da7f"
EN = "However, Louis Litt, he oversees all associates, so you'll also answer to him."
PT = (
    "No entanto, Louis Litt supervisiona todos os advogados associados, "
    "então você também terá de prestar contas a ele."
)


def _cue(cue_id=MERGED, *, english=EN, portuguese=PT):
    return Cue(
        UUID(cue_id), SCENE, 8, 22670, 25750, 22670, 25750,
        "Donna", english, english, portuguese, 2,
        {"approval": "approved", "ai_merged_from": [ORIGINAL_SUPERVISION, ORIGINAL_ANSWER]},
    )


def _proposal():
    return AnkiProposal.model_validate_json(
        json.dumps({
            "contract": "nova-generator-anki-proposal/1.0",
            "scene_id": str(SCENE),
            "input_sha256": "a" * 64,
            "anki_cards": [
                {
                    "cue_id": ORIGINAL_SUPERVISION,
                    "front_en": " However, Louis Litt, he oversees all associates,",
                    "back_pt": (
                        "No entanto, Louis Litt supervisiona todos os advogados associados,"
                    ),
                    "focus_text": "oversees",
                    "meaning": "supervisiona",
                    "marked_en": "oversees",
                    "marked_pt": "supervisiona",
                    "card_type": "VERB",
                    "explanation_pt": "Supervisionar o trabalho.",
                    "example_en": "She oversees the team.",
                    "example_pt": "Ela supervisiona a equipe.",
                    "tags": ["workplace"],
                },
                {
                    "cue_id": ORIGINAL_ANSWER,
                    "front_en": " so you'll also answer to him.",
                    "back_pt": "então você também terá de prestar contas a ele.",
                    "focus_text": "answer to",
                    "meaning": "prestar contas a",
                    "marked_en": "answer to",
                    "marked_pt": "prestar contas a",
                    "card_type": "EXPRESSION",
                    "explanation_pt": "Responder ao superior.",
                    "example_en": "I answer to the manager.",
                    "example_pt": "Presto contas ao gerente.",
                    "tags": ["workplace"],
                },
            ],
        }, ensure_ascii=False)
    )


def test_reanchors_both_original_parts_to_same_merged_cue():
    prepared = reconcile_anki_proposal(_proposal(), [_cue()])
    assert len(prepared.anki_cards) == 2
    assert {str(card.cue_id) for card in prepared.anki_cards} == {MERGED}
    assert all(card.front_en == EN and card.back_pt == PT for card in prepared.anki_cards)
    assert {card.focus_text for card in prepared.anki_cards} == {"oversees", "answer to"}


def test_rejects_unverifiable_translation_changes():
    with pytest.raises(ValueError, match="no unique successor cue"):
        reconcile_anki_proposal(_proposal(), [_cue(portuguese="Uma tradução diferente.")])


def test_rejects_ambiguous_successors():
    another = _cue("a00a94d3-a908-4234-8d70-1f546b7199a8")
    with pytest.raises(ValueError, match="2 possible successor cues"):
        reconcile_anki_proposal(_proposal(), [_cue(), another])


def test_rejects_duplicate_pedagogical_focus_on_one_cue():
    original = _proposal()
    duplicate = original.anki_cards[0].model_copy(
        update={"cue_id": UUID(MERGED), "front_en": EN, "back_pt": PT}
    )
    with pytest.raises(ValueError, match="cue and focus repeated"):
        reconcile_anki_proposal(
            original.model_copy(update={"anki_cards": [duplicate, duplicate]}),
            [_cue()],
        )
