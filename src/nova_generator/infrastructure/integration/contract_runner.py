"""Run the repository's Generator--iHub contract fixtures without iHub access.

Usage: ``python -m nova_generator.infrastructure.integration.contract_runner``.
"""

from __future__ import annotations

import json
from pathlib import Path

from .ihub_contracts import ContractViolation, validate_anki_audio, validate_story

_ROOT = Path(__file__).resolve().parents[4] / "contracts" / "generator-ihub" / "v1" / "fixtures"


def main() -> int:
    checks = (
        (_ROOT / "valid" / "hub-final-anki-audio.json", validate_anki_audio, False),
        (_ROOT / "valid" / "story-text-audio.json", validate_story, False),
        (_ROOT / "invalid" / "hub-final-overlapping-cues.json", validate_anki_audio, True),
        (_ROOT / "invalid" / "hub-final-youtube-id-mismatch.json", validate_anki_audio, True),
        (_ROOT / "invalid" / "story-highlight-outside-text.json", validate_story, True),
        (_ROOT / "invalid" / "story-unsorted-cues.json", validate_story, True),
    )
    failed = False
    for path, validator, expects_failure in checks:
        try:
            validator(json.loads(path.read_text(encoding="utf-8")))
            accepted = True
        except ContractViolation:
            accepted = False
        success = accepted is not expects_failure
        print(f"{'OK' if success else 'FAIL'} {path.name}")
        failed = failed or not success
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
