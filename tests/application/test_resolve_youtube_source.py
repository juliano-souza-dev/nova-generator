from contextlib import nullcontext
from datetime import UTC, datetime

from nova_generator.application.use_cases.resolve_youtube_source import ResolveYoutubeSource
from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo


class InMemoryCache:
    def __init__(self, metadata: YoutubeMediaMetadata | None) -> None:
        self.metadata = metadata
        self.locked_video: YoutubeVideo | None = None

    def acquire(self, video: YoutubeVideo, *, timeout_seconds: float = 30.0):
        self.locked_video = video
        return nullcontext()

    def find_verified(self, video: YoutubeVideo) -> YoutubeMediaMetadata | None:
        return self.metadata

    def save_verified(self, metadata: YoutubeMediaMetadata) -> None:
        self.metadata = metadata


def test_resolution_returns_reused_when_a_verified_source_exists() -> None:
    video = YoutubeVideo("dQw4w9WgXcQ")
    metadata = YoutubeMediaMetadata(
        video=video,
        source_file="source.mp4",
        sha256="a" * 64,
        size_bytes=1,
        duration_ms=1,
        video_codec="h264",
        audio_codec="aac",
        created_at_utc=datetime.now(UTC),
        last_used_at_utc=datetime.now(UTC),
    )
    cache = InMemoryCache(metadata)

    result = ResolveYoutubeSource(cache).execute("https://youtu.be/dQw4w9WgXcQ")

    assert result.status == "reused"
    assert result.metadata == metadata
    assert cache.locked_video == video


def test_resolution_returns_missing_without_downloading() -> None:
    result = ResolveYoutubeSource(InMemoryCache(None)).execute("https://youtu.be/dQw4w9WgXcQ")

    assert result.status == "missing"
    assert result.metadata is None
