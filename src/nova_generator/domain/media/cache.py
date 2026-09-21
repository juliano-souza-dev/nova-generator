from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime

from nova_generator.domain.media.youtube import YoutubeVideo


@dataclass(frozen=True)
class YoutubeMediaMetadata:
    """Immutable description of a verified source stored in the global cache."""

    video: YoutubeVideo
    source_file: str
    sha256: str
    size_bytes: int
    duration_ms: int
    created_at_utc: datetime
    last_used_at_utc: datetime
    use_count: int = 0
    schema: str = "generator-youtube-media-cache"
    schema_version: str = "1.0"

    def __post_init__(self) -> None:
        if self.source_file != "source.mp4":
            raise ValueError("A fonte do cache YouTube deve ser source.mp4.")
        if not self.sha256 or len(self.sha256) != 64:
            raise ValueError("O SHA-256 da fonte é obrigatório.")
        if self.size_bytes <= 0 or self.duration_ms <= 0:
            raise ValueError("A fonte do cache deve ter tamanho e duração positivos.")
        if self.use_count < 0:
            raise ValueError("use_count não pode ser negativo.")

    def mark_used(self, now: datetime | None = None) -> YoutubeMediaMetadata:
        return replace(
            self,
            last_used_at_utc=now or datetime.now(UTC),
            use_count=self.use_count + 1,
        )
