from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from uuid import UUID

from nova_generator.domain.voices import VoiceProfileSnapshot


@dataclass(frozen=True)
class ExportCue:
    """Approved cue paired with the exact local WAV used by every downstream artifact."""

    cue_id: UUID
    order: int
    approved_en: str
    approved_pt: str
    audio_path: Path
    duration_ms: int
    text_sha256: str

    def __post_init__(self) -> None:
        if self.order < 1 or self.duration_ms < 1 or not self.approved_en:
            raise ValueError("Cue exportável requer ordem, texto e duração positivos.")
        if len(self.text_sha256) != 64:
            raise ValueError("Cue exportável requer hash SHA-256 do texto.")

    @property
    def audio_sha256(self) -> str:
        if not self.audio_path.is_file() or self.audio_path.stat().st_size == 0:
            raise ValueError(f"WAV canônico ausente para cue {self.order}.")
        return sha256(self.audio_path.read_bytes()).hexdigest()


@dataclass(frozen=True)
class ReelInterval:
    cue_order: int
    start_ms: int
    end_ms: int
    audio_sha256: str
    text_sha256: str

    def __post_init__(self) -> None:
        if self.cue_order < 1 or self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("Intervalo de reel inválido.")
        if len(self.audio_sha256) != 64 or len(self.text_sha256) != 64:
            raise ValueError("Intervalo requer hashes SHA-256.")


@dataclass(frozen=True)
class AnkiAudioExport:
    apkg_path: Path
    reel_path: Path
    manifest_path: Path
    voice: VoiceProfileSnapshot
    intervals: tuple[ReelInterval, ...]
