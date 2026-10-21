"""The external AI, not Anki, owns English in Context."""

import json
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.structures_in_context import (
    StructuresInContextError,
    load_external_structures,
    prepare_external_structures,
    write_external_structures,
)


def _suggestion(word_ids=None, expression="What's the point?"):
    ids = word_ids or ["word-1", "word-2", "word-3"]
    return {
        "cue_id": "cue-1",
        "approved_en": "What's the point?",
        "approved_pt": "Qual é o sentido?",
        "word_translations": [
            {"word_id": ids[0], "leading": "", "surface": "What's"},
            {"word_id": ids[1], "leading": " ", "surface": "the"},
            {"word_id": ids[2], "leading": " ", "surface": "point?"},
        ],
        "context_practices": [{
            "type": "expression",
            "word_ids": ids,
            "expression_en": expression,
            "highlight": expression,
            "meaning_pt": "Qual é o sentido?",
            "explanation_pt": "Pergunta pelo propósito de uma ação.",
            "example_en": "What's the point of arguing?",
            "example_pt": "Qual é o sentido de discutir?",
        }],
    }


def test_preparation_preserves_external_ai_mini_lesson_and_stable_ids():
    original = _suggestion()
    prepared = prepare_external_structures([original])
    assert len(prepared) == 1
    assert prepared[0]["word_ids"] == ["word-1", "word-2", "word-3"]
    assert prepared[0]["expression_en"] == "What's the point?"
    assert prepared[0]["highlight"] == "What's the point?"
    assert prepared[0]["meaning_pt"] == "Qual é o sentido?"
    assert prepared[0]["explanation_pt"] == "Pergunta pelo propósito de uma ação."
    assert prepared[0]["example_en"] == "What's the point of arguing?"


def test_rejects_wrong_order_and_unknown_word_ids():
    wrong_order = _suggestion()
    wrong_order["context_practices"][0]["word_ids"] = [
        "word-2", "word-1",
    ]
    with pytest.raises(StructuresInContextError, match="contiguous"):
        prepare_external_structures([wrong_order])

    unknown = _suggestion()
    unknown["context_practices"][0]["word_ids"] = ["not-in-cue"]
    with pytest.raises(StructuresInContextError, match="unknown word"):
        prepare_external_structures([unknown])


def test_rejects_expression_not_supported_by_editorial_words():
    with pytest.raises(StructuresInContextError, match="does not match"):
        prepare_external_structures([_suggestion(expression="What's your point?")])


def test_empty_practices_are_allowed_on_cues_without_useful_structures():
    suggestion = _suggestion()
    suggestion["context_practices"] = []
    assert prepare_external_structures([suggestion]) == []


def test_context_snapshot_survives_a_save_and_reload(tmp_path):
    project_id, scene_id = uuid4(), uuid4()
    source = _suggestion()
    write_external_structures(
        tmp_path, project_id, scene_id, "a" * 64, [source]
    )
    result = load_external_structures(tmp_path, project_id, [scene_id])
    assert result[0]["meaning_pt"] == "Qual é o sentido?"
    path = (
        tmp_path / str(project_id) / "editorial-ai"
        / f"scene-{scene_id}-english-in-context.json"
    )
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["contract"] == "nova-generator-english-in-context/1.0"
    assert document["input_sha256"] == "a" * 64


def test_rejects_highlight_that_is_not_the_exact_selected_expression():
    suggestion = _suggestion()
    suggestion["context_practices"][0]["highlight"] = "the point"
    with pytest.raises(StructuresInContextError, match="highlight"):
        prepare_external_structures([suggestion])


def test_legacy_context_without_highlight_still_uses_expression():
    suggestion = _suggestion()
    suggestion["context_practices"][0].pop("highlight")
    result = prepare_external_structures([suggestion])
    assert result[0]["highlight"] == "What's the point?"
