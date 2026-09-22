from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "retryable"]


@dataclass(frozen=True)
class Job:
    id: UUID
    kind: str
    status: JobStatus
    input: dict[str, Any]
    idempotency_key: str | None
    attempt: int
    max_attempts: int
    worker_id: str | None = None
    heartbeat_at: datetime | None = None
    cancel_requested_at: datetime | None = None
    output: dict[str, Any] | None = None
    error_message: str | None = None
