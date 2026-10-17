from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2] / "contracts" / "materials-ai" / "v1"


def test_material_ai_output_schema_and_fixtures() -> None:
    schema = json.loads((ROOT / "output.schema.json").read_text(encoding="utf-8"))
    valid = json.loads((ROOT / "fixtures" / "valid-output.json").read_text(encoding="utf-8"))
    invalid = json.loads((ROOT / "fixtures" / "invalid-output.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    assert validator.is_valid(valid)
    assert not validator.is_valid(invalid)


def test_material_ai_input_schema_is_valid() -> None:
    schema = json.loads((ROOT / "input.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    assert "source" in schema["required"]
    assert "instructions" in schema["required"]
