from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class EditorialCuePrompt:
    id: str
    order: int
    original_en: str
    current_en: str
    current_pt: str


@dataclass(frozen=True)
class EditorialSuggestion:
    cue_id: str
    order: int
    approved_en: str
    approved_pt: str
    notes: str = ""


@dataclass(frozen=True)
class EditorialAssistanceResult:
    scene_id: str
    input_sha256: str
    provider: str
    model: str
    suggestions: tuple[EditorialSuggestion, ...]
    rate_limits: dict[str, str]


class EditorialAssistant(Protocol):
    def suggest(
        self,
        *,
        scene_id: str,
        input_sha256: str,
        cues: tuple[EditorialCuePrompt, ...],
    ) -> EditorialAssistanceResult: ...
