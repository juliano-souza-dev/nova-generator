from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from typing import Any
from uuid import UUID


def utf8_sha256(value: str) -> str:
    """Hash literal text without normalization or whitespace trimming."""
    return sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Project:
    id: UUID
    title: str
    content_type: str
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Scene:
    id: UUID
    project_id: UUID
    order: int
    duration_ms: int
    source_video_id: str | None = None
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class WordTiming:
    id: UUID
    cue_id: UUID
    order: int
    surface: str
    start_ms: int
    end_ms: int
    original_start_ms: int
    original_end_ms: int
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Cue:
    id: UUID
    scene_id: UUID
    order: int
    speech_start_ms: int
    speech_end_ms: int
    subtitle_start_ms: int
    subtitle_end_ms: int
    speaker: str
    original_en: str
    approved_en: str
    approved_pt: str
    revision: int = 1
    provenance: dict[str, Any] = field(default_factory=dict)

    @property
    def original_en_sha256(self) -> str:
        return utf8_sha256(self.original_en)

    @property
    def approved_en_sha256(self) -> str:
        return utf8_sha256(self.approved_en)

    @property
    def approved_pt_sha256(self) -> str:
        return utf8_sha256(self.approved_pt)


@dataclass(frozen=True)
class EditorialRevision:
    id: UUID
    project_id: UUID
    scene_id: UUID
    cue_id: UUID | None
    sequence: int
    command: str
    author: str
    origin: str
    before_snapshot: dict[str, Any]
    after_snapshot: dict[str, Any]
    created_at: datetime

    @property
    def before_sha256(self) -> str:
        return _snapshot_sha256(self.before_snapshot)

    @property
    def after_sha256(self) -> str:
        return _snapshot_sha256(self.after_snapshot)


def _snapshot_sha256(snapshot: dict[str, Any]) -> str:
    import json

    return sha256(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
            "utf-8"
        )
    ).hexdigest()
