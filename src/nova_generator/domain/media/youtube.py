from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


class InvalidYoutubeUrl(ValueError):
    """Raised when a URL cannot identify exactly one YouTube video."""


@dataclass(frozen=True)
class YoutubeVideo:
    """The stable identity of a YouTube video, independent of its input URL."""

    video_id: str

    def __post_init__(self) -> None:
        if not _VIDEO_ID_PATTERN.fullmatch(self.video_id):
            raise InvalidYoutubeUrl("O ID do vídeo do YouTube deve ter 11 caracteres válidos.")

    @property
    def canonical_url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.video_id}"

    @classmethod
    def from_url(cls, raw_url: str) -> YoutubeVideo:
        candidate = raw_url.strip()
        if not candidate:
            raise InvalidYoutubeUrl("Informe uma URL do YouTube.")
        if "://" not in candidate:
            candidate = f"https://{candidate}"

        parsed = urlparse(candidate)
        host = (parsed.hostname or "").lower()
        path_parts = [part for part in parsed.path.split("/") if part]
        video_id: str | None = None
        if host == "youtu.be":
            video_id = path_parts[0] if path_parts else None
        elif host in _YOUTUBE_HOSTS:
            if parsed.path == "/watch":
                video_id = parse_qs(parsed.query).get("v", [None])[0]
            elif len(path_parts) >= 2 and path_parts[0] in {"embed", "shorts", "live", "v"}:
                video_id = path_parts[1]
        if not isinstance(video_id, str):
            raise InvalidYoutubeUrl("A URL não contém um vídeo do YouTube suportado.")
        return cls(video_id=video_id)
