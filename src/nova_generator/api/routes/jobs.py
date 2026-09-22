from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_cancel_job, get_enqueue_job
from nova_generator.application.use_cases.manage_jobs import CancelJob, EnqueueJob

router = APIRouter(prefix="/jobs", tags=["jobs"])


class JobRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=100)
    input: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=255)
    max_attempts: int = Field(default=3, ge=1, le=20)


class JobResponse(BaseModel):
    id: str
    status: str
    attempt: int


@router.post("", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
def enqueue_job(
    use_case: Annotated[EnqueueJob, Depends(get_enqueue_job)], payload: JobRequest
) -> JobResponse:
    job = use_case.execute(**payload.model_dump())
    return JobResponse(id=str(job.id), status=job.status, attempt=job.attempt)


@router.post("/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: str, use_case: Annotated[CancelJob, Depends(get_cancel_job)]) -> JobResponse:
    job = use_case.execute(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return JobResponse(id=str(job.id), status=job.status, attempt=job.attempt)
