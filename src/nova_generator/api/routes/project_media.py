from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_enqueue_job, get_session_factory
from nova_generator.application.use_cases.manage_jobs import EnqueueJob
from nova_generator.core.settings import get_settings
from nova_generator.domain.jobs import Job
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache

router = APIRouter(prefix="/projects/{project_id}/media", tags=["project-media"])


class CutInput(BaseModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    language: str | None = Field(default="en", max_length=12)


class JobReference(BaseModel):
    id: UUID
    status: str


class MediaSnapshot(BaseModel):
    source_ready: bool
    source_url: str | None
    duration_ms: int | None
    download_job_id: UUID | None
    download_status: str | None
    download_error: str | None
    ingest_job_id: UUID | None
    ingest_status: str | None
    ingest_error: str | None
    cut_url: str | None
    cut_start_ms: int | None
    cut_end_ms: int | None
    waveform: dict[str, Any] | None
    transcript_candidate: dict[str, Any] | None


def _projects() -> SqlAlchemyEditorialProjectRepository:
    return SqlAlchemyEditorialProjectRepository(get_session_factory())


def _jobs() -> SqlAlchemyJobRepository:
    return SqlAlchemyJobRepository(get_session_factory())


def _source(project_id: UUID):
    project = _projects().get_project(project_id)
    if project is None:
        raise HTTPException(404, detail="project not found")
    video_id = project.provenance.get("youtube_video_id")
    if not isinstance(video_id, str):
        return project, None, None
    video = YoutubeVideo(video_id)
    cache = FileYoutubeMediaCache(get_settings().media_cache_root)
    return project, video, cache.find_verified(video)


def _latest(project_id: UUID, kind: str, status_filter: str | None = None) -> Job | None:
    return _jobs().latest_for_project(str(project_id), kind, status_filter)


@router.get("", response_model=MediaSnapshot)
def get_project_media(project_id: UUID) -> MediaSnapshot:
    _project, video, metadata = _source(project_id)
    download = _latest(project_id, "download_youtube")
    ingest = _latest(project_id, "ingest_scene_media")
    completed = _latest(project_id, "ingest_scene_media", "succeeded")
    if completed and (
        metadata is None
        or completed.output is None
        or completed.output.get("source_sha256") != metadata.sha256
        or video is None
        or completed.output.get("video_id") != video.video_id
    ):
        completed = None
    cut_path = (
        get_settings().project_root / str(project_id) / "cuts" / f"{completed.id}.mp4"
        if completed
        else None
    )
    cut_ready = bool(cut_path and cut_path.is_file() and cut_path.stat().st_size > 0)
    output = completed.output if completed and cut_ready else None
    base = f"{get_settings().api_prefix}/projects/{project_id}/media"
    return MediaSnapshot(
        source_ready=metadata is not None,
        source_url=f"{base}/source" if metadata else None,
        duration_ms=metadata.duration_ms if metadata else None,
        download_job_id=download.id if download else None,
        download_status=download.status if download else None,
        download_error=download.error_message if download else None,
        ingest_job_id=completed.id if completed and cut_ready else None,
        ingest_status=ingest.status if ingest else None,
        ingest_error=ingest.error_message if ingest else None,
        cut_url=f"{base}/cuts/{completed.id}" if completed and cut_ready else None,
        cut_start_ms=output.get("start_ms") if output else None,
        cut_end_ms=output.get("end_ms") if output else None,
        waveform=output.get("waveform") if output else None,
        transcript_candidate=output.get("transcript_candidate") if output else None,
    )


@router.get("/source")
def stream_project_source(project_id: UUID) -> FileResponse:
    _project, video, metadata = _source(project_id)
    if video is None or metadata is None:
        raise HTTPException(404, detail="verified source not ready")
    path = FileYoutubeMediaCache(get_settings().media_cache_root).source_path(video)
    return FileResponse(
        path, media_type="video/mp4", filename="source.mp4", content_disposition_type="inline"
    )


@router.get("/cuts/{job_id}")
def stream_project_cut(project_id: UUID, job_id: UUID) -> FileResponse:
    _source(project_id)
    job = _jobs().get(str(job_id))
    if (
        job is None
        or job.kind != "ingest_scene_media"
        or job.status != "succeeded"
        or job.input.get("project_id") != str(project_id)
    ):
        raise HTTPException(404, detail="cut not found")
    path = get_settings().project_root / str(project_id) / "cuts" / f"{job_id}.mp4"
    if not path.is_file():
        raise HTTPException(404, detail="cut not found")
    return FileResponse(
        path, media_type="video/mp4", filename="cut.mp4", content_disposition_type="inline"
    )


@router.post("/download", response_model=JobReference, status_code=status.HTTP_202_ACCEPTED)
def queue_source_download(
    project_id: UUID, enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)]
) -> JobReference:
    _project, video, _metadata = _source(project_id)
    if video is None:
        raise HTTPException(422, detail="project has no YouTube source")
    current = _latest(project_id, "download_youtube")
    if current and current.status in {"queued", "running", "retryable"}:
        return JobReference(id=current.id, status=current.status)
    job = enqueue.execute(
        kind="download_youtube",
        input={"project_id": str(project_id), "video_id": video.video_id},
        idempotency_key=None,
    )
    return JobReference(id=job.id, status=job.status)


@router.post("/ingest", response_model=JobReference, status_code=status.HTTP_202_ACCEPTED)
def queue_scene_ingestion(
    project_id: UUID,
    payload: CutInput,
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> JobReference:
    _project, video, metadata = _source(project_id)
    if video is None or metadata is None:
        raise HTTPException(422, detail="download and verify the source first")
    if payload.end_ms <= payload.start_ms or payload.end_ms > metadata.duration_ms:
        raise HTTPException(422, detail="cut interval must fit the verified source")
    current = _latest(project_id, "ingest_scene_media")
    if current and current.status in {"queued", "running", "retryable"}:
        raise HTTPException(409, detail="a cut is already being processed")
    job = enqueue.execute(
        kind="ingest_scene_media",
        input={
            "project_id": str(project_id),
            "video_id": video.video_id,
            "source_sha256": metadata.sha256,
            "start_ms": payload.start_ms,
            "end_ms": payload.end_ms,
            "language": payload.language,
        },
        idempotency_key=None,
    )
    return JobReference(id=job.id, status=job.status)
