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
    ) -> AbstractContextManager[None]:
        """Serialize inspection or creation of one video's cache entry."""

    def find_verified(self, video: YoutubeVideo) -> YoutubeMediaMetadata | None:
        """Return metadata only when its local source file still matches its hash."""

    def save_verified(self, metadata: YoutubeMediaMetadata) -> None:
        """Persist metadata after a future downloader has atomically installed its source."""

    def staging_directory(self, video: YoutubeVideo) -> Path:
        """Return an isolated temporary directory in the cache filesystem."""

    def install_source(self, video: YoutubeVideo, source: Path) -> Path:
        """Atomically promote a validated staged source to the canonical cache path."""
