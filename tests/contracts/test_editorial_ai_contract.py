import json
from pathlib import Path

import jsonschema
import pytest


def test_editorial_ai_13_contract_has_valid_and_invalid_fixtures() -> None:
    root = Path(__file__).parents[2] / "contracts" / "editorial-ai" / "v1.3"
    schema = json.loads((root / "suggestions.schema.json").read_text(encoding="utf-8"))
    valid = json.loads((root / "fixtures" / "valid.json").read_text(encoding="utf-8"))
    invalid = json.loads(
        (root / "fixtures" / "invalid-missing-surface.json").read_text(encoding="utf-8")
    )

    jsonschema.validate(valid, schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, schema)
