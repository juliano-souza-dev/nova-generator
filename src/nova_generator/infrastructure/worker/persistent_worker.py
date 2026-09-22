from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from threading import Event
from typing import Any

from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.core.observability import configure_json_logging, metrics
from nova_generator.domain.jobs import Job

JobHandler = Callable[[Job, "JobExecution"], dict[str, Any]]


class JobCancelled(Exception):
    pass


class JobExecution:
    def __init__(self, repository: JobRepository, job: Job, worker_id: str) -> None:
        self._repository, self._job, self._worker_id = repository, job, worker_id

    def heartbeat(self) -> None:
        if not self._repository.heartbeat(
            job_id=str(self._job.id), worker_id=self._worker_id, now=_utcnow()
        ):
            raise RuntimeError("job lease is no longer owned by this worker")

    def raise_if_cancelled(self) -> None:
        if self._repository.cancellation_requested(
            job_id=str(self._job.id), worker_id=self._worker_id
        ):
            raise JobCancelled()


class PersistentWorker:
    def __init__(
        self,
        repository: JobRepository,
        worker_id: str,
        handlers: dict[str, JobHandler],
        heartbeat_timeout: timedelta = timedelta(minutes=2),
        logger: logging.Logger | None = None,
    ) -> None:
        configure_json_logging()
        self._repository, self._worker_id, self._handlers = repository, worker_id, handlers
        self._heartbeat_timeout, self._logger = (
            heartbeat_timeout,
            logger or logging.getLogger("nova_generator.worker"),
        )

    def run_once(self) -> bool:
        now = _utcnow()
        recovered = self._repository.recover_abandoned(
            before=now - self._heartbeat_timeout, now=now
        )
        if recovered:
            self._log("jobs_recovered", count=recovered)
        job = self._repository.claim_next(worker_id=self._worker_id, now=now)
        if job is None:
            return False
        execution = JobExecution(self._repository, job, self._worker_id)
        started = time.monotonic()
        ids = _safe_ids(job.input)
        self._log("job_started", job_id=str(job.id), kind=job.kind, attempt=job.attempt, **ids)
        try:
            execution.raise_if_cancelled()
            handler = self._handlers.get(job.kind)
            if handler is None:
                raise ValueError(f"unsupported job kind: {job.kind}")
            output = handler(job, execution)
            execution.raise_if_cancelled()
            self._repository.succeed(
                job_id=str(job.id), worker_id=self._worker_id, output=output, now=_utcnow()
            )
            self._log(
                "job_succeeded", job_id=str(job.id), kind=job.kind, **(ids | _safe_ids(output))
            )
            metrics.record("job_succeeded", duration_ms=int((time.monotonic() - started) * 1000))
        except JobCancelled:
            self._repository.cancel(job_id=str(job.id), worker_id=self._worker_id, now=_utcnow())
            self._log("job_cancelled", job_id=str(job.id), kind=job.kind, **ids)
            metrics.record("job_cancelled", duration_ms=int((time.monotonic() - started) * 1000))
        except Exception as error:
            self._repository.fail(
                job_id=str(job.id),
                worker_id=self._worker_id,
                error_message=str(error),
                now=_utcnow(),
            )
            self._log(
                "job_failed", job_id=str(job.id), kind=job.kind, result=type(error).__name__, **ids
            )
            metrics.record("job_failed", duration_ms=int((time.monotonic() - started) * 1000))
        return True

    def run_forever(self, *, poll_interval_seconds: float, stop_event: Event) -> None:
        """Poll durable storage until the host asks this process to stop."""
        if poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        self._log("worker_started")
        while not stop_event.is_set():
            if not self.run_once():
                stop_event.wait(poll_interval_seconds)
        self._log("worker_stopped")

    def _log(self, event: str, **fields: object) -> None:
        self._logger.info(event, extra={"worker_id": self._worker_id, **fields})


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _safe_ids(payload: dict[str, Any]) -> dict[str, str]:
    return {
        key: value
        for key in ("project_id", "artifact_id")
        if isinstance(value := payload.get(key), str)
        and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value)
    }
