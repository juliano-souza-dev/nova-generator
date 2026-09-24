from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import (
    get_cancel_job,
    get_enqueue_job,
    get_job,
    get_list_jobs,
    get_retry_job,
)
from nova_generator.application.use_cases.manage_jobs import (
    CancelJob,
    EnqueueJob,
    GetJob,
    ListJobs,
    RetryJob,
)
from nova_generator.domain.jobs import Job

router = APIRouter(prefix="/jobs", tags=["jobs"])


class JobRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=100)
    input: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=255)
    max_attempts: int = Field(default=3, ge=1, le=20)


class JobResponse(BaseModel):
    id: str
    kind: str | None = None
    status: str
    attempt: int
    max_attempts: int | None = None
    input: dict[str, Any] | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    heartbeat_at: datetime | None = None
    cancel_requested_at: datetime | None = None
    can_cancel: bool = False
    can_retry: bool = False


class JobEventResponse(BaseModel):
    type: str
    occurred_at: datetime
    message: str


class JobDetailResponse(JobResponse):
    events: list[JobEventResponse]
    output: dict[str, Any] | None = None


class JobPageResponse(BaseModel):
    items: list[JobResponse]
    offset: int
    limit: int
    total: int


@router.post("", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
def enqueue_job(
    use_case: Annotated[EnqueueJob, Depends(get_enqueue_job)], payload: JobRequest
) -> JobResponse:
    job = use_case.execute(**payload.model_dump())
    return _response(job)


@router.get("", response_model=JobPageResponse)
def list_jobs(
    use_case: Annotated[ListJobs, Depends(get_list_jobs)],
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    status_filter: str | None = Query(default=None, alias="status"),
) -> JobPageResponse:
    items, total = use_case.execute(offset=offset, limit=limit, status=status_filter)
    return JobPageResponse(
        items=[_response(job) for job in items], offset=offset, limit=limit, total=total
    )


@router.get("/{job_id}", response_model=JobDetailResponse)
def get_job_snapshot(
    job_id: str, use_case: Annotated[GetJob, Depends(get_job)]
) -> JobDetailResponse:
    job = use_case.execute(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return JobDetailResponse(**_response(job).model_dump(), events=_events(job), output=job.output)


@router.post("/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: str, use_case: Annotated[CancelJob, Depends(get_cancel_job)]) -> JobResponse:
    job = use_case.execute(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return _response(job)


@router.post("/{job_id}/retry", response_model=JobResponse)
def retry_job(job_id: str, use_case: Annotated[RetryJob, Depends(get_retry_job)]) -> JobResponse:
    job = use_case.execute(job_id)
    if job is None:
        raise HTTPException(status_code=409, detail="job cannot be retried")
    return _response(job)


def _response(job: Job) -> JobResponse:
    return JobResponse(
        id=str(job.id),
        kind=job.kind,
        status=job.status,
        attempt=job.attempt,
        max_attempts=job.max_attempts,
        input=job.input,
        error_message=job.error_message,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        heartbeat_at=job.heartbeat_at,
        cancel_requested_at=job.cancel_requested_at,
        can_cancel=job.status in {"queued", "retryable", "running"},
        can_retry=job.status in {"failed", "cancelled"},
    )


def _events(job: Job) -> list[JobEventResponse]:
    candidates = [
        ("queued", job.created_at, "Job enfileirado"),
        ("started", job.started_at, "Processamento iniciado"),
        ("cancellation_requested", job.cancel_requested_at, "Cancelamento solicitado"),
        (job.status, job.finished_at, f"Job finalizado: {job.status}"),
    ]
    return [
        JobEventResponse(type=kind, occurred_at=at, message=message)
        for kind, at, message in candidates
        if at
    ]
