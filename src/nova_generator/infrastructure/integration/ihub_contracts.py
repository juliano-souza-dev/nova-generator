"""JSON Schema and semantic validation for Generator--iHub payloads.

Schemas describe the wire shape.  The checks below deliberately live beside the
adapter because ordering, interval overlap, URL/ID equivalence and literal
highlight occurrences cannot be expressed completely in JSON Schema.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError

from nova_generator.domain.media.youtube import InvalidYoutubeUrl, YoutubeVideo

_HIGHLIGHT_TYPES = {"important_word", "structure", "phrasal_verb"}
_CONTRACT_ROOT = Path(__file__).resolve().parents[4] / "contracts" / "generator-ihub" / "v1"


@dataclass(frozen=True)
class ContractIssue:
    """A stable, field-oriented reason a public payload is unacceptable."""

    path: str
    message: str


class ContractViolation(ValueError):
    def __init__(self, issues: list[ContractIssue]) -> None:
        self.issues = tuple(issues)
        super().__init__("; ".join(f"{issue.path}: {issue.message}" for issue in issues))


def validate_anki_audio(document: dict[str, Any]) -> None:
    """Validate the ``ankiAudio`` extension consumed by iHub.

    The surrounding ``hub_final.json`` remains intentionally extensible because
    it also carries legacy material fields owned by iHub.
    """
    _validate_schema(document, "hub-final.schema.json")
    cues = document["ankiAudio"]["cues"]
    issues: list[ContractIssue] = []
    _validate_timeline(
        cues,
        order_key="cue_order",
        start_key="start_ms",
        end_key="end_ms",
        duration=None,
        path="$.ankiAudio.cues",
        issues=issues,
    )
    _raise_if_issues(issues)


def validate_story(document: dict[str, Any]) -> None:
    """Validate the public ``immersionhub-text-audio`` 1.1 story envelope."""
    _validate_schema(document, "immersionhub-text-audio-1.1.schema.json")
    issues: list[ContractIssue] = []
    path = "$.youtubeUrl"
    try:
        video = YoutubeVideo.from_url(document["youtubeUrl"])
        if video.video_id != document["youtubeVideoId"]:
            issues.append(ContractIssue(path, "must identify youtubeVideoId exactly"))
    except InvalidYoutubeUrl as exc:
        issues.append(ContractIssue(path, str(exc)))

    _validate_timeline(
        document["cues"],
        order_key="order",
        start_key="startMs",
        end_key="endMs",
        duration=document["durationMs"],
        path="$.cues",
        issues=issues,
    )
    for index, cue in enumerate(document["cues"]):
        _validate_highlights(cue, f"$.cues[{index}].highlights", issues)
    _raise_if_issues(issues)


def _validate_schema(document: dict[str, Any], filename: str) -> None:
    schema_file = _CONTRACT_ROOT / "schemas" / filename
    try:
        schema = json.loads(schema_file.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
    except (OSError, json.JSONDecodeError, SchemaError) as exc:
        raise RuntimeError(f"Schema de contrato indisponível: {schema_file}") from exc
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    issues = [
        ContractIssue(_json_path(error.absolute_path), error.message)
        for error in errors
    ]
    _raise_if_issues(issues)


def _validate_timeline(
    cues: list[dict[str, Any]],
    *,
    order_key: str,
    start_key: str,
    end_key: str,
    duration: int | None,
    path: str,
    issues: list[ContractIssue],
) -> None:
    previous_end = 0
    for index, cue in enumerate(cues):
        cue_path = f"{path}[{index}]"
        expected_order = index + 1
        if cue[order_key] != expected_order:
            issues.append(ContractIssue(f"{cue_path}.{order_key}", "must be sequential from 1"))
        start, end = cue[start_key], cue[end_key]
        if end <= start:
            issues.append(ContractIssue(f"{cue_path}.{end_key}", "must be greater than start"))
        if start < previous_end:
            issues.append(ContractIssue(cue_path, "must not overlap the preceding cue"))
        if duration is not None and end > duration:
            issues.append(ContractIssue(f"{cue_path}.{end_key}", "must not exceed durationMs"))
        previous_end = max(previous_end, end)


def _validate_highlights(
    cue: dict[str, Any], path: str, issues: list[ContractIssue]) -> None:
    literal_en = cue["en"]
    for index, highlight in enumerate(cue["highlights"]):
        item_path = f"{path}[{index}]"
        text, kind = highlight["text"], highlight["type"]
        if kind not in _HIGHLIGHT_TYPES:
            issues.append(ContractIssue(f"{item_path}.type", "is not a supported pedagogical type"))
        occurrence = highlight["occurrence"]
        if _count_literal(literal_en, text) < occurrence:
            issues.append(
                ContractIssue(
                    f"{item_path}.text", "must occur literally at the declared occurrence in cue.en"
                )
            )


def _count_literal(text: str, needle: str) -> int:
    count, start = 0, 0
    while (found := text.find(needle, start)) >= 0:
        count += 1
        start = found + len(needle)
    return count


def _json_path(path: Any) -> str:
    return "$" + "".join(f"[{part}]" if isinstance(part, int) else f".{part}" for part in path)


def _raise_if_issues(issues: list[ContractIssue]) -> None:
    if issues:
        raise ContractViolation(issues)
