from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock

from nova_generator.application.ports.youtube_metadata_inspector import (
    YoutubeMetadataInspector,
    YoutubeSourceUnavailable,
)
from nova_generator.domain.media.youtube import YoutubeVideo


@dataclass(frozen=True)
class InspectedYoutubeSource:
    video: YoutubeVideo
    title: str
    channel: str | None
    inspected_at_utc: datetime


class InspectYoutubeSource:
    """Inspect once and briefly reuse the verified result during project creation."""

    def __init__(self, inspector: YoutubeMetadataInspector, ttl: timedelta = timedelta(minutes=10)):
        self._inspector = inspector
        self._ttl = ttl
        self._cache: dict[str, InspectedYoutubeSource] = {}
        self._lock = Lock()

    def execute(self, raw_url: str) -> InspectedYoutubeSource:
        video = YoutubeVideo.from_url(raw_url)
        now = datetime.now(UTC)
        with self._lock:
            cached = self._cache.get(video.video_id)
            if cached is not None and now - cached.inspected_at_utc <= self._ttl:
                return cached
        metadata = self._inspector.inspect(video)
        title = metadata.title.strip()
        if not title:
            raise YoutubeSourceUnavailable("O vídeo não possui um título utilizável.")
        result = InspectedYoutubeSource(video, title[:255], metadata.channel, now)
        with self._lock:
            self._cache[video.video_id] = result
        return result
