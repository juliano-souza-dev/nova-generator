from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from datetime import datetime
from pathlib import Path

from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo


class YoutubeCacheLockTimeout(TimeoutError):
    """Raised when another process keeps a video cache entry locked too long."""


class FileYoutubeMediaCache:
    """Filesystem implementation of the global cache, without media downloading."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def acquire(
        self, video: YoutubeVideo, *, timeout_seconds: float = 30.0
    ) -> AbstractContextManager[None]:
        return self._lock(self._directory(video) / ".download.lock", timeout_seconds)

    def find_verified(self, video: YoutubeVideo) -> YoutubeMediaMetadata | None:
        directory = self._directory(video)
        metadata_path = directory / "metadata.json"
        source_path = directory / "source.mp4"
        if (
            not metadata_path.is_file()
            or not source_path.is_file()
            or source_path.stat().st_size == 0
        ):
            return None
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata = self._metadata_from_payload(payload)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
        if metadata.video != video or source_path.stat().st_size != metadata.size_bytes:
            return None
        return metadata if self._sha256(source_path) == metadata.sha256 else None

    def save_verified(self, metadata: YoutubeMediaMetadata) -> None:
        directory = self._directory(metadata.video)
        source_path = directory / metadata.source_file
        if not source_path.is_file() or source_path.stat().st_size != metadata.size_bytes:
            raise ValueError("A fonte local não corresponde ao metadata informado.")
        if self._sha256(source_path) != metadata.sha256:
            raise ValueError("O hash da fonte local não corresponde ao metadata informado.")
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / "metadata.json"
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(self._payload(metadata), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temporary, destination)

    def staging_directory(self, video: YoutubeVideo) -> Path:
        directory = self._directory(video)
        directory.mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(prefix=".download-", dir=directory))

    def source_path(self, video: YoutubeVideo) -> Path:
        """Return the canonical path after the caller has verified the cache entry."""
        return self._directory(video) / "source.mp4"

    def install_source(self, video: YoutubeVideo, source: Path) -> Path:
        directory = self._directory(video)
        if source.parent.parent != directory:
            raise ValueError("A fonte temporária deve pertencer à entrada do cache.")
        if not source.is_file() or source.stat().st_size == 0:
            raise ValueError("A fonte temporária deve existir e não pode estar vazia.")
        destination = directory / "source.mp4"
        # Staging and destination share a filesystem; replace makes readers see
        # either the complete old source or the complete newly validated source.
        os.replace(source, destination)
        return destination

    def _directory(self, video: YoutubeVideo) -> Path:
        return self._root / "youtube" / video.video_id

    @contextmanager
    def _lock(self, path: Path, timeout_seconds: float) -> Iterator[None]:
        path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + timeout_seconds
        descriptor: int | None = None
        while descriptor is None:
            try:
                descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(descriptor, str(os.getpid()).encode())
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise YoutubeCacheLockTimeout(
                        f"Cache YouTube bloqueado: {path.parent.name}"
                    ) from None
                time.sleep(0.05)
        try:
            yield
        finally:
            os.close(descriptor)
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for block in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @staticmethod
    def _payload(metadata: YoutubeMediaMetadata) -> dict[str, object]:
        return {
            "schema": metadata.schema,
            "schema_version": metadata.schema_version,
            "video_id": metadata.video.video_id,
            "canonical_url": metadata.video.canonical_url,
            "source_file": metadata.source_file,
            "sha256": metadata.sha256,
            "size_bytes": metadata.size_bytes,
            "duration_ms": metadata.duration_ms,
            "video_codec": metadata.video_codec,
            "audio_codec": metadata.audio_codec,
            "source_url": metadata.source_url,
            "created_at_utc": metadata.created_at_utc.isoformat(),
            "last_used_at_utc": metadata.last_used_at_utc.isoformat(),
            "use_count": metadata.use_count,
        }

    @staticmethod
    def _metadata_from_payload(payload: object) -> YoutubeMediaMetadata:
        if not isinstance(payload, dict):
            raise ValueError("metadata.json deve ser um objeto.")
        return YoutubeMediaMetadata(
            video=YoutubeVideo(str(payload["video_id"])),
            source_file=str(payload["source_file"]),
            sha256=str(payload["sha256"]),
            size_bytes=int(payload["size_bytes"]),
            duration_ms=int(payload["duration_ms"]),
            video_codec=str(payload["video_codec"]),
            audio_codec=(str(payload["audio_codec"]) if payload.get("audio_codec") else None),
            source_url=str(payload.get("source_url", "")),
            created_at_utc=datetime.fromisoformat(str(payload["created_at_utc"])),
            last_used_at_utc=datetime.fromisoformat(str(payload["last_used_at_utc"])),
            use_count=int(payload.get("use_count", 0)),
            schema=str(payload.get("schema", "")),
            schema_version=str(payload.get("schema_version", "")),
        )
