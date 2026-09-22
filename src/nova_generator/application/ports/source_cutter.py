from pathlib import Path
from typing import Protocol

from nova_generator.domain.ingestion import SourceCut


class SourceCutter(Protocol):
    def cut(self, request: SourceCut) -> Path:
        """Render a project-local MP4 excerpt from a verified source."""
