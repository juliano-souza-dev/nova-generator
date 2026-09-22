from pathlib import Path
from typing import Protocol

from nova_generator.domain.exports import ReelInterval


class ReelValidator(Protocol):
    def validate(self, *, reel: Path, intervals: list[ReelInterval]) -> None: ...
