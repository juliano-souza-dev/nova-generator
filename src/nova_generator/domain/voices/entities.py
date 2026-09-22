from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any
from uuid import UUID


def _canonical_hash(value: object) -> str:
    import json

    return sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


@dataclass(frozen=True)
class VoiceProfile:
    """A versioned local synthesis configuration; reference media is never embedded."""

    id: UUID
    name: str
    version: int
    model_id: str
    model_sha256: str
    reference_audio_sha256: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.name.strip() or self.version < 1 or not self.model_id.strip():
            raise ValueError("Perfil de voz requer nome, versão positiva e modelo.")
        if len(self.model_sha256) != 64:
            raise ValueError("Perfil de voz requer hash SHA-256 do modelo.")

    def snapshot(self) -> VoiceProfileSnapshot:
        return VoiceProfileSnapshot(
            profile_id=self.id,
            name=self.name,
            version=self.version,
            model_id=self.model_id,
            model_sha256=self.model_sha256,
            reference_audio_sha256=self.reference_audio_sha256,
            parameters=dict(self.parameters),
        )


@dataclass(frozen=True)
class VoiceProfileSnapshot:
    """Frozen voice identity saved by exports so later edits cannot change their sound."""

    profile_id: UUID
    name: str
    version: int
    model_id: str
    model_sha256: str
    reference_audio_sha256: str | None
    parameters: dict[str, Any]

    @property
    def sha256(self) -> str:
        return _canonical_hash(
            {
                "profile_id": str(self.profile_id),
                "name": self.name,
                "version": self.version,
                "model_id": self.model_id,
                "model_sha256": self.model_sha256,
                "reference_audio_sha256": self.reference_audio_sha256,
                "parameters": self.parameters,
            }
        )


@dataclass(frozen=True)
class SynthesizedSpeech:
    audio_path: str
    text_sha256: str
    profile: VoiceProfileSnapshot
    parameters: dict[str, Any]
    duration_ms: int
    sample_rate: int
    channels: int

    @property
    def cache_key(self) -> str:
        return _canonical_hash(
            {
                "text_sha256": self.text_sha256,
                "profile": self.profile.sha256,
                "parameters": self.parameters,
            }
        )
