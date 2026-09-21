from __future__ import annotations

import unittest

from materials_final import _clean_final_words


class FinalWordTimingTest(unittest.TestCase):
    def test_preserves_text_order_and_normalizes_regressive_start(self) -> None:
        words = [
            {"text": "I", "start_ms": 8924, "end_ms": 9060},
            {"text": "found", "start_ms": 8819, "end_ms": 9904},
            {"text": "this", "start_ms": 9143, "end_ms": 10154},
        ]

        result = _clean_final_words(words)

        self.assertEqual([item["text"] for item in result], ["I", "found", "this"])
        self.assertEqual([item["start_ms"] for item in result], [8924, 8924, 9143])


if __name__ == "__main__":
    unittest.main()
