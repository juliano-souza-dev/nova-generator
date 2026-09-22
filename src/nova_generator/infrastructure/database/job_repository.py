from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.database.models import JobRecord

SessionFactory = Callable[[], Session]


class SqlAlchemyJobRepository:
    """SQLite-safe queue using a conditional UPDATE as the lease primitive."""

    def __init__(self, session_factory: SessionFactory) -> None:
        self._session_factory = session_factory

    def enqueue(
        self, *, kind: str, input: dict[str, Any], idempotency_key: str | None, max_attempts: int
    ) -> Job:
        with self._session_factory() as session:
            if idempotency_key:
                existing = session.scalar(
                    select(JobRecord).where(JobRecord.idempotency_key == idempotency_key)
                )
                if existing:
                    return _job(existing)
            record = JobRecord(
                kind=kind,
                status="queued",
                idempotency_key=idempotency_key,
                input_json=_dump(input),
                max_attempts=max_attempts,
            )
            session.add(record)
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                existing = session.scalar(
                    select(JobRecord).where(JobRecord.idempotency_key == idempotency_key)
                )
                if existing is None:
                    raise
                return _job(existing)
            session.refresh(record)
            return _job(record)

    def claim_next(self, *, worker_id: str, now: datetime) -> Job | None:
        with self._session_factory() as session:
            candidate_id = session.scalar(
                select(JobRecord.id)
                .where(JobRecord.status.in_(("queued", "retryable")))
                .order_by(JobRecord.created_at, JobRecord.id)
                .limit(1)
            )
            if candidate_id is None:
                return None
            result = session.execute(
                update(JobRecord)
                .where(
                    and_(
                        JobRecord.id == candidate_id, JobRecord.status.in_(("queued", "retryable"))
                    )
                )
                .values(
                    status="running",
                    worker_id=worker_id,
                    heartbeat_at=now,
                    started_at=now,
                    attempt=JobRecord.attempt + 1,
                    error_message=None,
                    updated_at=now,
                )
            )
            if result.rowcount != 1:
                session.rollback()
                return None
            record = session.get(JobRecord, candidate_id)
            session.commit()
            return _job(record) if record else None

    def heartbeat(self, *, job_id: str, worker_id: str, now: datetime) -> bool:
        return self._owned_update(job_id, worker_id, {"heartbeat_at": now, "updated_at": now})

    def cancellation_requested(self, *, job_id: str, worker_id: str) -> bool:
        with self._session_factory() as session:
            return (
                session.scalar(
                    select(JobRecord.id).where(
                        JobRecord.id == UUID(job_id),
                        JobRecord.worker_id == worker_id,
                        JobRecord.status == "running",
                        JobRecord.cancel_requested_at.is_not(None),
                    )
                )
                is not None
            )

    def request_cancellation(self, *, job_id: str, now: datetime) -> Job | None:
        with self._session_factory() as session:
            record = session.get(JobRecord, UUID(job_id))
            if record is None:
                return None
            if record.status in {"queued", "retryable"}:
                record.status, record.finished_at = "cancelled", now
            elif record.status == "running":
                record.cancel_requested_at = now
            session.commit()
            return _job(record)

    def succeed(
        self, *, job_id: str, worker_id: str, output: dict[str, Any], now: datetime
    ) -> bool:
        return self._owned_update(
            job_id,
            worker_id,
            {
                "status": "succeeded",
                "output_json": _dump(output),
                "finished_at": now,
                "heartbeat_at": now,
                "updated_at": now,
            },
        )

    def fail(self, *, job_id: str, worker_id: str, error_message: str, now: datetime) -> bool:
        with self._session_factory() as session:
            record = session.scalar(
                select(JobRecord).where(
                    JobRecord.id == UUID(job_id),
                    JobRecord.worker_id == worker_id,
                    JobRecord.status == "running",
                )
            )
            if record is None:
                return False
            record.status = "retryable" if record.attempt < record.max_attempts else "failed"
            record.error_message, record.finished_at, record.heartbeat_at, record.updated_at = (
                error_message,
                now,
                now,
                now,
            )
            session.commit()
            return True

    def cancel(self, *, job_id: str, worker_id: str, now: datetime) -> bool:
        return self._owned_update(
            job_id,
            worker_id,
            {"status": "cancelled", "finished_at": now, "heartbeat_at": now, "updated_at": now},
        )

    def recover_abandoned(self, *, before: datetime, now: datetime) -> int:
        with self._session_factory() as session:
            result = session.execute(
                update(JobRecord)
                .where(JobRecord.status == "running", JobRecord.heartbeat_at < before)
                .values(
                    status=case(
                        (JobRecord.attempt >= JobRecord.max_attempts, "failed"), else_="retryable"
                    ),
                    worker_id=None,
                    error_message="worker heartbeat expired",
                    finished_at=now,
                    updated_at=now,
                )
            )
            session.commit()
            return result.rowcount or 0

    def get(self, job_id: str) -> Job | None:
        with self._session_factory() as session:
            record = session.get(JobRecord, UUID(job_id))
            return _job(record) if record else None

    def latest_status_for_project(self, project_id: str) -> str | None:
        """Return the newest job explicitly associated with this project."""
        with self._session_factory() as session:
            record = session.scalar(
                select(JobRecord)
                .where(JobRecord.input_json.contains(f'"project_id":"{project_id}"'))
                .order_by(JobRecord.created_at.desc(), JobRecord.id.desc())
                .limit(1)
            )
            return record.status if record else None

    def _owned_update(self, job_id: str, worker_id: str, values: dict[str, Any]) -> bool:
        with self._session_factory() as session:
            result = session.execute(
                update(JobRecord)
                .where(
                    JobRecord.id == UUID(job_id),
                    JobRecord.worker_id == worker_id,
                    JobRecord.status == "running",
                )
                .values(**values)
            )
            session.commit()
            return result.rowcount == 1


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _job(record: JobRecord) -> Job:
    return Job(
        id=record.id,
        kind=record.kind,
        status=record.status,
        input=json.loads(record.input_json),
        idempotency_key=record.idempotency_key,
        attempt=record.attempt,
        max_attempts=record.max_attempts,
        worker_id=record.worker_id,
        heartbeat_at=record.heartbeat_at,
        cancel_requested_at=record.cancel_requested_at,
        output=json.loads(record.output_json) if record.output_json else None,
        error_message=record.error_message,
    )
