from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MediaInspection:
    """Technical facts collected from a media source after it is downloaded."""

    duration_ms: int
    video_codec: str
    audio_codec: str | None

    def __post_init__(self) -> None:
        if self.duration_ms <= 0:
            raise ValueError("A duração da mídia deve ser positiva.")
        if not self.video_codec:
            raise ValueError("A mídia deve conter um stream de vídeo.")
