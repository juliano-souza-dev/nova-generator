from __future__ import annotations

from typing import Any, cast

from nova_generator.application.ports.youtube_metadata_inspector import YoutubeSourceUnavailable
from nova_generator.domain.media.youtube import YoutubeVideo


class YtDlpYoutubeMetadataInspector:
    """Use yt-dlp extraction only; no media stream is downloaded."""

    def inspect(self, video: YoutubeVideo) -> YtDlpYoutubeSourceMetadata:
        try:
            import yt_dlp
        except ModuleNotFoundError as exc:  # pragma: no cover
            raise YoutubeSourceUnavailable("yt-dlp não está instalado.") from exc
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "socket_timeout": 20,
            "extractor_retries": 2,
        }
        try:
            with yt_dlp.YoutubeDL(cast(Any, options)) as downloader:
                payload = downloader.extract_info(video.canonical_url, download=False)
        except Exception as exc:
            message = _friendly_error(str(exc))
            raise YoutubeSourceUnavailable(message) from exc
        if not isinstance(payload, dict) or payload.get("id") != video.video_id:
            raise YoutubeSourceUnavailable(
                "O YouTube não retornou metadados válidos para esse vídeo."
            )
        title = payload.get("title")
        if not isinstance(title, str) or not title.strip():
            raise YoutubeSourceUnavailable("O vídeo não possui um título utilizável.")
        channel = payload.get("channel") or payload.get("uploader")
        return YtDlpYoutubeSourceMetadata(
            video, title, channel if isinstance(channel, str) else None
        )


class YtDlpYoutubeSourceMetadata:
    def __init__(self, video: YoutubeVideo, title: str, channel: str | None) -> None:
        self.video = video
        self.title = title
        self.channel = channel


def _friendly_error(detail: str) -> str:
    lowered = detail.casefold()
    if "private video" in lowered or "private" in lowered:
        return "O vídeo é privado e não pode ser usado."
    if "unavailable" in lowered or "not available" in lowered:
        return "O vídeo não está disponível, foi removido ou está bloqueado nesta região."
    return "Não foi possível acessar o vídeo. Confira a URL e tente novamente."
