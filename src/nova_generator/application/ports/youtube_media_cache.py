from __future__ import annotations

from contextlib import AbstractContextManager
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
