from pathlib import Path
from typing import Protocol

from nova_generator.domain.exports import ExportCue


class AnkiPackageWriter(Protocol):
    def write(self, *, cues: list[ExportCue], output: Path, deck_name: str) -> Path: ...
