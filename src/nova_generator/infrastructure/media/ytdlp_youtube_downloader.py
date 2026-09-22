from __future__ import annotations

from pathlib import Path
from typing import Any

from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeDownloadError(RuntimeError):
    """Raised when yt-dlp cannot create a usable local MP4 source."""


class YtDlpYoutubeDownloader:
    """yt-dlp adapter that writes only to an application-provided staging directory."""

    def download(self, video: YoutubeVideo, destination_directory: Path) -> Path:
        try:
            import yt_dlp
        except ModuleNotFoundError as exc:  # pragma: no cover - installation failure
            raise YoutubeDownloadError("yt-dlp não está instalado.") from exc

        destination_directory.mkdir(parents=True, exist_ok=True)
        template = destination_directory / "source.%(ext)s"
        options: dict[str, Any] = {
            "format": "bv*+ba/b",
            "outtmpl": str(template),
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "retries": 3,
            "fragment_retries": 3,
            "extractor_retries": 2,
            "socket_timeout": 25,
        }
        try:
            with yt_dlp.YoutubeDL(options) as downloader:
                exit_code = downloader.download([video.canonical_url])
        except Exception as exc:
            raise YoutubeDownloadError(f"yt-dlp falhou para {video.video_id}: {exc}") from exc
        if exit_code not in (None, 0):
            raise YoutubeDownloadError(f"yt-dlp encerrou com código {exit_code}.")

        candidates = sorted(
            (
                path
                for path in destination_directory.glob("source.*")
                if path.is_file()
                and path.suffix.lower() == ".mp4"
                and path.stat().st_size > 0
            ),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        if not candidates:
            raise YoutubeDownloadError("yt-dlp não produziu uma fonte MP4 válida.")
        return candidates[0]
