"""Atomic file-based persistence for small, independent media storyboards."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from uuid import UUID

from nova_generator.domain.tiktok_media import (
    MediaCaption,
    MediaFormat,
    MediaProject,
    MediaProjectEdit,
    new_media_project,
)

_WRITE_LOCK = Lock()


class MediaConflict(ValueError):
    pass


class MediaProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root / "tiktok-media"

    def directory(self, project_id: UUID) -> Path:
        return self.root / str(project_id)

    @contextmanager
    def _locked(self, project_id: UUID) -> Iterator[None]:
        """Coordinate API and worker processes, including the Windows desktop runtime."""
        directory = self.directory(project_id)
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / ".project.lock").open("a+b") as handle:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                handle.write(b"0")
                handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def get(self, project_id: UUID) -> MediaProject | None:
        path = self.directory(project_id) / "project.json"
        if not path.is_file():
            return None
        return MediaProject.model_validate_json(path.read_text(encoding="utf-8"))

    def list(self) -> list[MediaProject]:
        if not self.root.exists():
            return []
        projects = []
        for item in self.root.iterdir():
            if not item.is_dir():
                continue
            try:
                project_id = UUID(item.name)
                project = self.get(project_id)
                if project is not None:
                    projects.append(project)
            except (ValueError, OSError):
                continue
        return sorted(
            projects,
            key=lambda p: (self.directory(p.id) / "project.json").stat().st_mtime,
            reverse=True,
        )

    def create(self, title: str, format: MediaFormat) -> MediaProject:
        project = new_media_project(title, format)
        with _WRITE_LOCK:
            self._write(project)
        return project

    def update(self, project_id: UUID, edit: MediaProjectEdit) -> MediaProject:
        with _WRITE_LOCK, self._locked(project_id):
            current = self.get(project_id)
            if current is None:
                raise FileNotFoundError("Projeto de mídia não encontrado.")
            if current.revision != edit.revision:
                raise MediaConflict(
                    "O projeto foi alterado em outra aba. Recarregue para evitar perda."
                )
            updated = MediaProject.model_validate(
                {
                    **current.model_dump(),
                    # Older clients omit video fields. Only explicit edits may
                    # modify a source/caption configuration persisted by v1.
                    **edit.model_dump(exclude_unset=True),
                    "revision": current.revision + 1,
                    "audio_filename": current.audio_filename,
                }
            )
            self._write(updated)
            return updated

    def set_audio(self, project_id: UUID, filename: str) -> MediaProject:
        with _WRITE_LOCK, self._locked(project_id):
            current = self.get(project_id)
            if current is None:
                raise FileNotFoundError("Projeto de mídia não encontrado.")
            updated = MediaProject.model_validate(
                {
                    **current.model_dump(),
                    "audio_filename": filename,
                    "revision": current.revision + 1,
                }
            )
            self._write(updated)
            return updated

    def set_youtube_source(self, project_id: UUID, revision: int, video_id: str) -> MediaProject:
        """Replace the source atomically, never attaching it to an editorial project."""
        with _WRITE_LOCK, self._locked(project_id):
            current = self.get(project_id)
            if current is None:
                raise FileNotFoundError("Produção não encontrada.")
            if current.revision != revision:
                raise MediaConflict("A produção mudou. Recarregue antes de trocar o vídeo.")
            updated = current.model_copy(
                update={
                    "source_youtube_id": video_id,
                    "source_cut_job_id": None,
                    "source_project_id": None,
                    "source_scene_id": None,
                    "video_captions": [],
                    "revision": current.revision + 1,
                }
            )
            self._write(updated)
            return updated

    def attach_transcript(
        self,
        project_id: UUID,
        *,
        revision: int,
        video_id: str,
        cut_job_id: UUID,
        captions: list[MediaCaption],
    ) -> MediaProject:
        """Publish a completed ASR draft only if the producer hasn't edited the source."""
        with _WRITE_LOCK, self._locked(project_id):
            current = self.get(project_id)
            if current is None or current.source_youtube_id != video_id:
                raise MediaConflict("A origem mudou durante a transcrição.")
            if current.source_cut_job_id == cut_job_id:
                return current  # A successful retry must not overwrite the editor's changes.
            if current.revision != revision:
                raise MediaConflict("A produção foi editada durante a transcrição. Refaça o corte.")
            updated = current.model_copy(
                update={
                    "source_cut_job_id": cut_job_id,
                    "video_captions": captions,
                    "revision": current.revision + 1,
                }
            )
            self._write(updated)
            return updated

    def _write(self, project: MediaProject) -> None:
        directory = self.directory(project.id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "project.json"
        temporary = directory / "project.json.tmp"
        temporary.write_text(
            json.dumps(project.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
