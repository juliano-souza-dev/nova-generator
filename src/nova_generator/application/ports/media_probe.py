from pathlib import Path
from typing import Protocol

from nova_generator.domain.media.probe import MediaInspection


class MediaProbe(Protocol):
    """Inspects media without coupling application code to FFprobe."""

    def inspect(self, source: Path) -> MediaInspection: ...
