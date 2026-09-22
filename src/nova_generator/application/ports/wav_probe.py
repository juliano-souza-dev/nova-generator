from pathlib import Path
from typing import Protocol


class WavProbe(Protocol):
    def inspect_wav(self, source: Path) -> tuple[int, int, int]: ...
