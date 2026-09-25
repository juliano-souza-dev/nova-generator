from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class EditorialWordPrompt:
    id: str
    order: int
    surface: str
    current_pt: str | None = None
    semantic_group_id: str | None = None
    semantic_group_role: str | None = None


@dataclass(frozen=True)
class EditorialCuePrompt:
    id: str
    order: int
    original_en: str
    current_en: str
    current_pt: str
    words: tuple[EditorialWordPrompt, ...] = ()


@dataclass(frozen=True)
class EditorialSemanticUnit:
    word_ids: tuple[str, ...]
    pt: str


@dataclass(frozen=True)
class EditorialWordTranslation:
    word_id: str
    pt: str


@dataclass(frozen=True)
class EditorialSuggestion:
    cue_id: str
    order: int
    approved_en: str
    approved_pt: str
    notes: str = ""
    word_translations: tuple[EditorialWordTranslation, ...] = field(default_factory=tuple)
    semantic_units: tuple[EditorialSemanticUnit, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class EditorialAssistanceResult:
    scene_id: str
    input_sha256: str
    provider: str
    model: str
    suggestions: tuple[EditorialSuggestion, ...]
    rate_limits: dict[str, str]
    contract_version: str | None = None


class EditorialAssistant(Protocol):
    def suggest(
        self,
        *,
        scene_id: str,
        input_sha256: str,
        cues: tuple[EditorialCuePrompt, ...],
    ) -> EditorialAssistanceResult: ...
