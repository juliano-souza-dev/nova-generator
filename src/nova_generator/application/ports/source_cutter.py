from pathlib import Path
from typing import Protocol

from nova_generator.domain.ingestion import SourceCut


class SourceCutter(Protocol):
    def cut(self, request: SourceCut) -> Path: ...
