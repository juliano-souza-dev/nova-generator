from pathlib import Path
from typing import Protocol


class StoryVideoRenderer(Protocol):
    """FFmpeg adapter for a still image plus its canonical cue WAV."""

    def render_cue(self, *, image: Path, audio: Path, output: Path) -> Path: ...

    def concat(self, *, cue_videos: list[Path], output: Path) -> Path: ...
