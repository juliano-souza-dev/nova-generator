from pathlib import Path
from typing import Protocol

from nova_generator.domain.ingestion import TranscriptCandidate


class SpeechTranscriber(Protocol):
    def transcribe(self, source: Path, *, language: str | None = None) -> TranscriptCandidate:
        """Create a review candidate. It must never write approved editorial fields."""
