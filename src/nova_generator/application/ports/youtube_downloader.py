from pathlib import Path
from typing import Protocol

from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeDownloader(Protocol):
    """Downloads one canonical YouTube source into the caller's staging directory."""

    def download(self, video: YoutubeVideo, destination_directory: Path) -> Path: ...
