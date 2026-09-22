from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from nova_generator.application.ports.media_probe import MediaProbe
from nova_generator.application.ports.youtube_downloader import YoutubeDownloader
from nova_generator.application.ports.youtube_media_cache import YoutubeMediaCache
from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo


@dataclass(frozen=True)
class DownloadYoutubeSourceResult:
    video: YoutubeVideo
    status: str
    metadata: YoutubeMediaMetadata


class DownloadYoutubeSource:
    """Reuse a verified source or download, inspect and atomically cache it once."""

    def __init__(
        self,
        cache: YoutubeMediaCache,
        downloader: YoutubeDownloader,
        probe: MediaProbe,
    ) -> None:
        self._cache = cache
        self._downloader = downloader
        self._probe = probe

    def execute(self, raw_url: str) -> DownloadYoutubeSourceResult:
        video = YoutubeVideo.from_url(raw_url)
        with self._cache.acquire(video):
            reusable = self._cache.find_verified(video)
            if reusable:
                metadata = reusable.mark_used()
                self._cache.save_verified(metadata)
                return DownloadYoutubeSourceResult(video, "reused", metadata)

            staging = self._cache.staging_directory(video)
            try:
                downloaded = self._downloader.download(video, staging)
                self._assert_staged_file(downloaded, staging)
                inspection = self._probe.inspect(downloaded)
                installed = self._cache.install_source(video, downloaded)
                now = datetime.now(UTC)
                metadata = YoutubeMediaMetadata(
                    video=video,
                    source_file=installed.name,
                    sha256=self._sha256(installed),
                    size_bytes=installed.stat().st_size,
                    duration_ms=inspection.duration_ms,
                    video_codec=inspection.video_codec,
                    audio_codec=inspection.audio_codec,
                    source_url=video.canonical_url,
                    created_at_utc=now,
                    last_used_at_utc=now,
                    use_count=1,
                )
                self._cache.save_verified(metadata)
                return DownloadYoutubeSourceResult(video, "downloaded", metadata)
            finally:
                shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _assert_staged_file(source: Path, staging: Path) -> None:
        if source.parent != staging or not source.is_file() or source.stat().st_size == 0:
            raise ValueError("O downloader deve retornar um MP4 não vazio no diretório temporário.")
        if source.suffix.lower() != ".mp4":
            raise ValueError("A fonte baixada deve ser normalizada para MP4.")

    @staticmethod
    def _sha256(path: Path) -> str:
        import hashlib

        digest = hashlib.sha256()
        with path.open("rb") as file:
            for block in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
