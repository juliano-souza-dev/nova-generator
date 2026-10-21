"""Regression tests for the iHub English in Context transport adapter."""

import pytest

from nova_generator.application.use_cases.structures_in_context import (
    StructuresInContextError,
    build_structures_in_context,
)


def _card(**changes):
    return {
        "cue_id": "cue-1",
        "card_type": "phrasal verb",
        "focus_text": "What's the point?",
        "meaning": "Qual é o sentido?",
        "explanation_pt": "Pergunta pelo propósito de uma ação.",
        "example_en": "What's the point of arguing?",
        "example_pt": "Qual é o sentido de discutir?",
        **changes,
    }


def _rows():
    return {
        "cue-1": {
            "order": 4,
            "words": [
                {"text": "What’s ", "start_ms": 400, "end_ms": 640},
                {"text": "the ", "start_ms": 670, "end_ms": 750},
                {"text": "point?", "start_ms": 790, "end_ms": 1100},
            ],
        },
    }


def test_publishes_full_lesson_with_original_word_timing():
    practices = build_structures_in_context([_card()], _rows())
    assert practices == [{
        "cue_order": 4,
        "type": "phrasal_verb",
        "expression_en": "What's the point?",
        "word_indexes": [0, 1, 2],
        "meaning_pt": "Qual é o sentido?",
        "explanation_pt": "Pergunta pelo propósito de uma ação.",
        "example_en": "What's the point of arguing?",
        "example_pt": "Qual é o sentido de discutir?",
        "start_ms": 400,
        "end_ms": 1100,
    }]


def test_does_not_invent_timings_when_focus_words_cannot_be_found():
    with pytest.raises(StructuresInContextError, match="contiguous source words"):
        build_structures_in_context([_card(focus_text="point the")], _rows())


def test_does_not_silently_publish_incomplete_mini_lesson():
    with pytest.raises(StructuresInContextError, match="missing its mini-lesson"):
        build_structures_in_context([_card(explanation_pt="")], _rows())


def test_does_not_use_a_different_cue_as_fallback():
    with pytest.raises(StructuresInContextError, match="no published source cue"):
        build_structures_in_context([_card(cue_id="missing")], _rows())


def test_keeps_repeated_independent_lessons_from_same_cue():
    lessons = build_structures_in_context([_card(), _card(meaning="Por quê?")], _rows())
    assert len(lessons) == 2
    assert [lesson["meaning_pt"] for lesson in lessons] == [
        "Qual é o sentido?", "Por quê?",
    ]
    assert all(lesson["cue_order"] == 4 for lesson in lessons)
