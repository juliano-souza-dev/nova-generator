from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2] / "contracts" / "unified-preparation" / "v1"


def test_unified_ai_output_contract_fixtures():
    schema = json.loads((ROOT / "output.schema.json").read_text(encoding="utf-8"))
    valid = json.loads((ROOT / "fixtures" / "valid-output.json").read_text(encoding="utf-8"))
    invalid = json.loads((ROOT / "fixtures" / "invalid-output.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    assert validator.is_valid(valid)
    assert not validator.is_valid(invalid)
    assert "shadowing" not in schema["properties"]
    assert [section["id"] for section in valid["materials"]["sections"]] == [
        "learning_path",
        "vocabulary",
        "structures",
        "guided_practice",
        "activities",
        "challenge",
        "review",
    ]
