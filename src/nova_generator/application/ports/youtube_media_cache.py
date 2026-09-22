from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Protocol

from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeMediaCache(Protocol):
    """Global cache for verified downloaded YouTube source files."""

    def acquire(
        self, video: YoutubeVideo, *, timeout_seconds: float = 30.0
    ) -> AbstractContextManager[None]: ...

    def find_verified(self, video: YoutubeVideo) -> YoutubeMediaMetadata | None: ...

    def save_verified(self, metadata: YoutubeMediaMetadata) -> None: ...

    def staging_directory(self, video: YoutubeVideo) -> Path: ...

    def install_source(self, video: YoutubeVideo, source: Path) -> Path: ...
