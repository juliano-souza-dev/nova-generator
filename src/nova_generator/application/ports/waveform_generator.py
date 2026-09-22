from pathlib import Path
from typing import Protocol

from nova_generator.domain.ingestion import WaveformMetadata


class WaveformGenerator(Protocol):
    def generate(self, source: Path, *, bucket_ms: int = 40) -> WaveformMetadata:
        """Return precomputed waveform peaks for a media source."""
