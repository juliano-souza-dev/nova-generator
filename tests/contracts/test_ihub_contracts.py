from __future__ import annotations

import json
from pathlib import Path

import pytest

from nova_generator.infrastructure.integration import (
    ContractViolation,
    validate_anki_audio,
    validate_story,
)
from nova_generator.infrastructure.integration.contract_runner import main

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "generator-ihub" / "v1" / "fixtures"


def _fixture(relative: str) -> dict:
    return json.loads((FIXTURES / relative).read_text(encoding="utf-8"))


def test_valid_contract_fixtures_are_accepted() -> None:
    validate_anki_audio(_fixture("valid/hub-final-anki-audio.json"))
    validate_story(_fixture("valid/story-text-audio.json"))


@pytest.mark.parametrize(
    ("relative", "validator"),
    [
        ("invalid/hub-final-overlapping-cues.json", validate_anki_audio),
        ("invalid/hub-final-youtube-id-mismatch.json", validate_anki_audio),
        ("invalid/story-highlight-outside-text.json", validate_story),
        ("invalid/story-unsorted-cues.json", validate_story),
    ],
)
def test_invalid_contract_fixtures_are_refused(relative: str, validator) -> None:
    with pytest.raises(ContractViolation):
        validator(_fixture(relative))


def test_story_rejects_interval_beyond_declared_duration() -> None:
    payload = _fixture("valid/story-text-audio.json")
    payload["cues"][0]["endMs"] = payload["durationMs"] + 1

    with pytest.raises(ContractViolation, match="durationMs"):
        validate_story(payload)


def test_highlights_keep_literal_unicode_and_declared_occurrence() -> None:
    payload = _fixture("valid/story-text-audio.json")
    payload["cues"][0]["en"] = "Maya said: “café”, café."
    payload["cues"][0]["highlights"] = [
        {"text": "café", "type": "important_word", "pt": "café", "occurrence": 2}
    ]
    validate_story(payload)


def test_fixture_runner_checks_the_adapter_contracts() -> None:
    assert main() == 0
