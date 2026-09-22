from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SourceCut:
    """A project-local excerpt; the global source is never modified."""

    source: Path
    output: Path
    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("O corte deve ter um intervalo positivo em milissegundos.")

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True)
class WaveformMetadata:
    """Small, JSON-serialisable peaks used by the React timeline."""

    sample_rate_hz: int
    bucket_ms: int
    peaks: tuple[float, ...]

    def __post_init__(self) -> None:
        if self.sample_rate_hz <= 0 or self.bucket_ms <= 0:
            raise ValueError("sample_rate_hz e bucket_ms devem ser positivos.")
        if not self.peaks or any(not 0 <= value <= 1 for value in self.peaks):
            raise ValueError("A waveform deve conter picos normalizados entre zero e um.")


@dataclass(frozen=True)
class TranscriptWordCandidate:
    surface: str
    start_ms: int
    end_ms: int
    probability: float | None = None

    def __post_init__(self) -> None:
        if not self.surface or self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("Uma palavra candidata precisa de texto e intervalo positivo.")
        if self.probability is not None and not 0 <= self.probability <= 1:
            raise ValueError("A probabilidade deve estar entre zero e um.")


@dataclass(frozen=True)
class TranscriptCueCandidate:
    start_ms: int
    end_ms: int
    text: str
    words: tuple[TranscriptWordCandidate, ...]
    language: str | None = None

    def __post_init__(self) -> None:
        if not self.text or self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("Um cue candidato precisa de texto e intervalo positivo.")
        if any(word.start_ms < self.start_ms or word.end_ms > self.end_ms for word in self.words):
            raise ValueError("As palavras candidatas devem ficar dentro do cue.")


@dataclass(frozen=True)
class TranscriptCandidate:
    """ASR output kept separate from literal, approved editorial text."""

    engine: str
    model: str
    source: Path
    language: str | None
    cues: tuple[TranscriptCueCandidate, ...]

    def __post_init__(self) -> None:
        if not self.engine or not self.model or not self.cues:
            raise ValueError("Um candidato ASR precisa de engine, modelo e cues.")
