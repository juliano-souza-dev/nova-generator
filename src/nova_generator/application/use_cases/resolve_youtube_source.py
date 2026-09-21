from __future__ import annotations

from dataclasses import dataclass

from nova_generator.application.ports.youtube_media_cache import YoutubeMediaCache
from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo


@dataclass(frozen=True)
class YoutubeSourceResolution:
    video: YoutubeVideo
    status: str
    metadata: YoutubeMediaMetadata | None


class ResolveYoutubeSource:
    """Resolve a YouTube URL to one reusable source without downloading media."""

    def __init__(self, cache: YoutubeMediaCache) -> None:
        self._cache = cache

    def execute(self, raw_url: str) -> YoutubeSourceResolution:
        video = YoutubeVideo.from_url(raw_url)
        # A cache miss is deliberately returned while holding no lock. The future
        # download use case will acquire the same per-video lock before writing.
        with self._cache.acquire(video):
            metadata = self._cache.find_verified(video)
        return YoutubeSourceResolution(
            video=video,
            status="reused" if metadata else "missing",
            metadata=metadata,
        )
