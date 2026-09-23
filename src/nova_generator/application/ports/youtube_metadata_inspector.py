from typing import Protocol

from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeSourceUnavailable(ValueError):
    """Raised when a YouTube video cannot be inspected by the operator."""


class YoutubeSourceMetadata(Protocol):
    video: YoutubeVideo
    title: str
    channel: str | None


class YoutubeMetadataInspector(Protocol):
    """Reads public source metadata without downloading its media streams."""

    def inspect(self, video: YoutubeVideo) -> YoutubeSourceMetadata: ...
