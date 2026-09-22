from pathlib import Path
from typing import Protocol

from nova_generator.domain.exports import ExportCue, ReelInterval


class AudioReelRenderer(Protocol):
    def render(self, *, cues: list[ExportCue], output: Path) -> tuple[Path, list[ReelInterval]]: ...
