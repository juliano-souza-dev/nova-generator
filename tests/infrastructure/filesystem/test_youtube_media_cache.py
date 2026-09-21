import hashlib
from datetime import UTC, datetime

import pytest

from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.filesystem.youtube_media_cache import (
    FileYoutubeMediaCache,
    YoutubeCacheLockTimeout,
)


def _metadata(video: YoutubeVideo, contents: bytes) -> YoutubeMediaMetadata:
    return YoutubeMediaMetadata(
        video=video,
        source_file="source.mp4",
        sha256=hashlib.sha256(contents).hexdigest(),
        size_bytes=len(contents),
        duration_ms=1000,
        created_at_utc=datetime.now(UTC),
        last_used_at_utc=datetime.now(UTC),
    )


def test_cache_reads_only_a_source_that_matches_metadata_hash(tmp_path) -> None:
    cache = FileYoutubeMediaCache(tmp_path)
    video = YoutubeVideo("dQw4w9WgXcQ")
    contents = b"local media fixture"
    source = tmp_path / "youtube" / video.video_id / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(contents)
    metadata = _metadata(video, contents)

    cache.save_verified(metadata)

    assert cache.find_verified(video) == metadata
    source.write_bytes(b"corrupted")
    assert cache.find_verified(video) is None


def test_video_locks_are_isolated_and_released(tmp_path) -> None:
    cache = FileYoutubeMediaCache(tmp_path)
    first = YoutubeVideo("dQw4w9WgXcQ")
    second = YoutubeVideo("M7lc1UVf-VE")

    with cache.acquire(first):
        with cache.acquire(second, timeout_seconds=0):
            pass
        with pytest.raises(YoutubeCacheLockTimeout):
            with cache.acquire(first, timeout_seconds=0):
                pass

    with cache.acquire(first, timeout_seconds=0):
        pass
