from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import sleep

import pytest

from nova_generator.application.use_cases.download_youtube_source import DownloadYoutubeSource
from nova_generator.domain.media.probe import MediaInspection
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache


class FakeDownloader:
    def __init__(self, contents: bytes = b"verified mp4 bytes") -> None:
        self.contents = contents
        self.calls = 0

    def download(self, video: YoutubeVideo, destination_directory: Path) -> Path:
        self.calls += 1
        destination = destination_directory / "downloaded.mp4"
        destination.write_bytes(self.contents)
        return destination


class FakeProbe:
    def __init__(self) -> None:
        self.calls = 0

    def inspect(self, source: Path) -> MediaInspection:
        self.calls += 1
        assert source.read_bytes()
        return MediaInspection(duration_ms=1234, video_codec="h264", audio_codec="aac")


def test_download_installs_verified_source_once_then_reuses_it(tmp_path) -> None:
    cache = FileYoutubeMediaCache(tmp_path)
    downloader = FakeDownloader()
    probe = FakeProbe()
    use_case = DownloadYoutubeSource(cache, downloader, probe)

    first = use_case.execute("https://youtu.be/dQw4w9WgXcQ")
    second = use_case.execute("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    assert first.status == "downloaded"
    assert first.metadata.duration_ms == 1234
    assert first.metadata.video_codec == "h264"
    assert first.metadata.audio_codec == "aac"
    assert second.status == "reused"
    assert second.metadata.use_count == 2
    assert downloader.calls == 1
    assert probe.calls == 1
    assert (tmp_path / "youtube" / "dQw4w9WgXcQ" / "source.mp4").is_file()


def test_corrupted_cached_source_is_replaced_by_a_new_verified_download(tmp_path) -> None:
    cache = FileYoutubeMediaCache(tmp_path)
    downloader = FakeDownloader(b"first")
    probe = FakeProbe()
    use_case = DownloadYoutubeSource(cache, downloader, probe)
    use_case.execute("https://youtu.be/dQw4w9WgXcQ")
    (tmp_path / "youtube" / "dQw4w9WgXcQ" / "source.mp4").write_bytes(b"corrupted")

    downloader.contents = b"replacement"
    result = use_case.execute("https://youtu.be/dQw4w9WgXcQ")

    assert result.status == "downloaded"
    assert downloader.calls == 2
    assert result.metadata.size_bytes == len(b"replacement")


def test_concurrent_resolvers_download_one_source_under_the_video_lock(tmp_path) -> None:
    class SlowDownloader(FakeDownloader):
        def download(self, video: YoutubeVideo, destination_directory: Path) -> Path:
            sleep(0.1)
            return super().download(video, destination_directory)

    downloader = SlowDownloader()
    use_case = DownloadYoutubeSource(FileYoutubeMediaCache(tmp_path), downloader, FakeProbe())
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                use_case.execute,
                ["https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/watch?v=dQw4w9WgXcQ"],
            )
        )

    assert sorted(result.status for result in results) == ["downloaded", "reused"]
    assert downloader.calls == 1


def test_failed_probe_does_not_install_a_partial_source(tmp_path) -> None:
    class FailingProbe:
        def inspect(self, source: Path) -> MediaInspection:
            raise RuntimeError("invalid media")

    cache = FileYoutubeMediaCache(tmp_path)
    use_case = DownloadYoutubeSource(cache, FakeDownloader(), FailingProbe())

    with pytest.raises(RuntimeError, match="invalid media"):
        use_case.execute("https://youtu.be/dQw4w9WgXcQ")

    entry = tmp_path / "youtube" / "dQw4w9WgXcQ"
    assert not (entry / "source.mp4").exists()
    assert not list(entry.glob(".download-*"))
