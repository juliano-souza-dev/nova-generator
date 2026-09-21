from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from editorial_contract import ContractViolation, validate_document  # noqa: E402


class EditorialContractTest(unittest.TestCase):
    def load(self, relative: str) -> dict:
        return json.loads((ROOT / "fixtures" / relative).read_text(encoding="utf-8"))

    def test_canonical_fixture_preserves_unicode_punctuation_and_tokens(self) -> None:
        document = self.load("valid/punctuation_unicode.json")
        validate_document(document)
        cue = document["cues"][0]
        self.assertEqual(cue["approved_en"]["value"], "“Don’t… stop,” she said.")
        self.assertEqual(cue["approved_pt"]["value"], "“Não… pare”, ela disse.")
        self.assertEqual("".join(token["surface"] for token in cue["tokens"]), cue["approved_en"]["value"])

    def test_rejects_fixtures_that_break_literal_or_timing_invariants(self) -> None:
        for fixture in ("invalid/token_text_mismatch.json", "invalid/overlapping_word_timing.json", "invalid/literal_hash_mismatch.json"):
            with self.subTest(fixture=fixture), self.assertRaises(ContractViolation):
                validate_document(self.load(fixture))

    def test_timing_change_cannot_change_literal_integrity(self) -> None:
        document = self.load("valid/punctuation_unicode.json")
        changed = copy.deepcopy(document)
        changed["cues"][0]["tokens"][1]["timing"] = {"start_ms": 130, "end_ms": 470}
        validate_document(changed)
        self.assertEqual(changed["cues"][0]["approved_en"], document["cues"][0]["approved_en"])


if __name__ == "__main__":
    unittest.main()
