from pathlib import Path

import pytest

from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.media.ytdlp_youtube_downloader import (
    YoutubeDownloadError,
    YtDlpYoutubeDownloader,
)


class FakeYoutubeDl:
    attempts: list[str] = []
    succeeds_on = "b[ext=mp4]/b"

    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def download(self, _urls):
        selector = self.options["format"]
        self.attempts.append(selector)
        if selector != self.succeeds_on:
            raise RuntimeError("format unavailable")
        Path(self.options["outtmpl"].replace("%(ext)s", "mp4")).write_bytes(b"video")
        return 0


def test_downloader_uses_ordered_fallbacks(tmp_path):
    FakeYoutubeDl.attempts = []
    result = YtDlpYoutubeDownloader(FakeYoutubeDl).download(
        YoutubeVideo("dQw4w9WgXcQ"), tmp_path
    )
    assert result.read_bytes() == b"video"
    assert FakeYoutubeDl.attempts == ["bv*+ba/b", "b[ext=mp4]/b"]


def test_downloader_reports_every_failed_strategy(tmp_path):
    class AlwaysFails(FakeYoutubeDl):
        succeeds_on = "never"

    with pytest.raises(YoutubeDownloadError) as raised:
        YtDlpYoutubeDownloader(AlwaysFails).download(YoutubeVideo("dQw4w9WgXcQ"), tmp_path)
    assert all(name in str(raised.value) for name, _selector in YtDlpYoutubeDownloader.STRATEGIES)
