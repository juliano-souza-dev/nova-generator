from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.domain.jobs import Job


class EnqueueJob:
    def __init__(self, repository: JobRepository) -> None:
        self._repository = repository

    def execute(
        self,
        *,
        kind: str,
        input: dict[str, Any],
        idempotency_key: str | None,
        max_attempts: int = 3,
    ) -> Job:
        if not kind.strip():
            raise ValueError("kind is required")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        return self._repository.enqueue(
            kind=kind, input=input, idempotency_key=idempotency_key, max_attempts=max_attempts
        )


class CancelJob:
    def __init__(self, repository: JobRepository) -> None:
        self._repository = repository

    def execute(self, job_id: str) -> Job | None:
        return self._repository.request_cancellation(job_id=job_id, now=_utcnow())


class ListJobs:
    def __init__(self, repository: JobRepository) -> None:
        self._repository = repository

    def execute(
        self, *, offset: int = 0, limit: int = 25, status: str | None = None
    ) -> tuple[list[Job], int]:
        return self._repository.list(offset=offset, limit=limit, status=status)


class GetJob:
    def __init__(self, repository: JobRepository) -> None:
        self._repository = repository

    def execute(self, job_id: str) -> Job | None:
        return self._repository.get(job_id)


class RetryJob:
    def __init__(self, repository: JobRepository) -> None:
        self._repository = repository

    def execute(self, job_id: str) -> Job | None:
        return self._repository.retry(job_id=job_id, now=_utcnow())


class RecoverAbandonedJobs:
    def __init__(self, repository: JobRepository, heartbeat_timeout: timedelta) -> None:
        self._repository = repository
        self._heartbeat_timeout = heartbeat_timeout

    def execute(self) -> int:
        now = _utcnow()
        return self._repository.recover_abandoned(before=now - self._heartbeat_timeout, now=now)


def _utcnow() -> datetime:
    return datetime.now(UTC)
