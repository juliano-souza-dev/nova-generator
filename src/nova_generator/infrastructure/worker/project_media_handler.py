from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from threading import Event, Thread
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.download_youtube_source import DownloadYoutubeSource
from nova_generator.domain.jobs import Job
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.projects.entities import Project
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache
from nova_generator.infrastructure.worker.ingest_scene_media_handler import (
    IngestSceneMediaJobHandler,
)
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


class ProjectMediaJobHandler:
    """Resolve all media paths from a project and verified cache entry at execution time."""

    def __init__(
        self,
        projects: SqlAlchemyEditorialProjectRepository,
        cache: FileYoutubeMediaCache,
        downloader: DownloadYoutubeSource,
        ingestion: IngestSceneMediaJobHandler,
        project_root: Path,
    ) -> None:
        self._projects = projects
        self._cache = cache
        self._downloader = downloader
        self._ingestion = ingestion
        self._project_root = project_root

    def download(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project = self._project(job)
        video = self._video(project.provenance)
        if video.video_id != job.input.get("video_id"):
            raise ValueError("project source changed after download was queued")
        with _keep_lease(execution):
            result = self._downloader.execute(video.canonical_url)
        execution.heartbeat()
        return {
            "project_id": str(project.id),
            "video_id": result.video.video_id,
            "cache_status": result.status,
            "source_sha256": result.metadata.sha256,
            "duration_ms": result.metadata.duration_ms,
        }

    def ingest(self, job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        project = self._project(job)
        video = self._video(project.provenance)
        if video.video_id != job.input.get("video_id"):
            raise ValueError("project source changed after cut was queued")
        metadata = self._cache.find_verified(video)
        if metadata is None or metadata.sha256 != job.input.get("source_sha256"):
            raise ValueError("verified project source changed; enqueue a new cut")
        start_ms, end_ms = job.input.get("start_ms"), job.input.get("end_ms")
        if (
            not isinstance(start_ms, int)
            or isinstance(start_ms, bool)
            or start_ms < 0
            or not isinstance(end_ms, int)
            or isinstance(end_ms, bool)
            or end_ms <= start_ms
            or end_ms > metadata.duration_ms
        ):
            raise ValueError("cut interval is outside the verified source")
        source = self._cache.source_path(video)
        output = self._project_root / str(project.id) / "cuts" / f"{job.id}.mp4"
        safe_job = replace(
            job,
            input={
                "source": str(source),
                "output": str(output),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "language": job.input.get("language"),
                "bucket_ms": 40,
            },
        )
        with _keep_lease(execution):
            result = self._ingestion(safe_job, execution)
        result.pop("cut_file", None)
        return {
            **result,
            "project_id": str(project.id),
            "video_id": video.video_id,
            "source_sha256": metadata.sha256,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "duration_ms": end_ms - start_ms,
        }

    def _project(self, job: Job) -> Project:
        project_id = UUID(str(job.input["project_id"]))
        project = self._projects.get_project(project_id)
        if project is None:
            raise ValueError("project no longer exists")
        return project

    @staticmethod
    def _video(provenance: dict[str, Any]) -> YoutubeVideo:
        video_id = provenance.get("youtube_video_id")
        if not isinstance(video_id, str):
            raise ValueError("project has no YouTube source")
        return YoutubeVideo(video_id)


@contextmanager
def _keep_lease(execution: JobExecution) -> Iterator[None]:
    """Renew the durable lease while yt-dlp, FFmpeg or ASR blocks the worker."""
    execution.heartbeat()
    stopped = Event()
    errors: list[Exception] = []

    def renew() -> None:
        while not stopped.wait(20):
            try:
                execution.heartbeat()
            except Exception as error:
                errors.append(error)
                return

    thread = Thread(target=renew, name="media-job-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=1)
        if errors:
            raise errors[0]
