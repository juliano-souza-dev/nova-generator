from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeDownloadError(RuntimeError):
    """Raised when yt-dlp cannot create a usable local MP4 source."""


class YtDlpYoutubeDownloader:
    """yt-dlp adapter that writes only to an application-provided staging directory."""

    STRATEGIES = (
        ("best-av-merge", "bv*+ba/b"),
        ("progressive-mp4", "b[ext=mp4]/b"),
        ("compatible-video-audio", "bv+ba/b"),
        ("last-resort", "best"),
    )

    def __init__(self, factory: Callable[[Any], Any] | None = None) -> None:
        self._factory = factory

    def download(self, video: YoutubeVideo, destination_directory: Path) -> Path:
        if self._factory is None:
            try:
                import yt_dlp
            except ModuleNotFoundError as exc:  # pragma: no cover - installation failure
                raise YoutubeDownloadError("yt-dlp não está instalado.") from exc
            factory = yt_dlp.YoutubeDL
        else:
            factory = self._factory

        destination_directory.mkdir(parents=True, exist_ok=True)
        failures: list[str] = []
        for strategy, format_selector in self.STRATEGIES:
            for old in destination_directory.glob("source.*"):
                if old.is_file():
                    old.unlink()
            options: dict[str, Any] = {
                "format": format_selector,
                "outtmpl": str(destination_directory / "source.%(ext)s"),
                "merge_output_format": "mp4",
                "remuxvideo": "mp4",
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
                "retries": 3,
                "fragment_retries": 3,
                "extractor_retries": 2,
                "socket_timeout": 25,
            }
            logging.getLogger(__name__).info(
                "youtube_download_attempt",
                extra={"video_id": video.video_id, "strategy": strategy},
            )
            try:
                with factory(cast(Any, options)) as downloader:
                    exit_code = downloader.download([video.canonical_url])
                candidate = self._candidate(destination_directory)
                if exit_code in (None, 0) and candidate is not None:
                    logging.getLogger(__name__).info(
                        "youtube_download_succeeded",
                        extra={"video_id": video.video_id, "strategy": strategy},
                    )
                    return candidate
                failures.append(f"{strategy}: saída sem MP4 utilizável")
            except Exception as exc:
                failures.append(f"{strategy}: {exc}")
        detail = "; ".join(failures)
        raise YoutubeDownloadError(
            f"Todas as alternativas de download falharam para {video.video_id}: {detail}"
        )

    @staticmethod
    def _candidate(destination_directory: Path) -> Path | None:
        candidates = sorted(
            (
                path
                for path in destination_directory.glob("source.*")
                if path.is_file() and path.suffix.lower() == ".mp4" and path.stat().st_size > 0
            ),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        return candidates[0] if candidates else None
