from pathlib import Path
from typing import Protocol

from nova_generator.domain.exports import ExportCue


class AnkiPackageWriter(Protocol):
    def write(
        self,
        *,
        cues: list[ExportCue],
        output: Path,
        deck_name: str,
        include_audio: bool = True,
        rich_cards: dict[str, dict] | None = None,
    ) -> Path: ...
