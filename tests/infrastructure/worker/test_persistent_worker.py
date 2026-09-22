import json
import logging
from datetime import UTC, datetime, timedelta
from io import StringIO
from threading import Barrier, Thread

from nova_generator.core.observability import JsonFormatter
from nova_generator.infrastructure.database import models  # noqa: F401
from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)
from nova_generator.infrastructure.worker.persistent_worker import PersistentWorker


def _repo(tmp_path):
    engine = create_database_engine(f"sqlite:///{tmp_path / 'jobs.db'}")
    Base.metadata.create_all(engine)
    return SqlAlchemyJobRepository(create_session_factory(engine))


def test_competing_workers_claim_one_job_once(tmp_path) -> None:
    repository = _repo(tmp_path)
    job = repository.enqueue(kind="ok", input={}, idempotency_key=None, max_attempts=2)
    barrier, claims = Barrier(2), []

    def claim(worker):
        barrier.wait()
        claims.append(repository.claim_next(worker_id=worker, now=datetime.now(UTC)))

    threads = [Thread(target=claim, args=(name,)) for name in ("a", "b")]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert [claim.id for claim in claims if claim] == [job.id]


def test_failure_retries_then_fails_after_limit(tmp_path) -> None:
    repository = _repo(tmp_path)
    job = repository.enqueue(kind="bad", input={}, idempotency_key="same", max_attempts=2)
    worker = PersistentWorker(
        repository, "worker", {"bad": lambda *_: (_ for _ in ()).throw(RuntimeError("boom"))}
    )
    assert worker.run_once() and repository.get(str(job.id)).status == "retryable"
    assert worker.run_once() and repository.get(str(job.id)).status == "failed"
    assert (
        repository.enqueue(
            kind="bad", input={"ignored": True}, idempotency_key="same", max_attempts=2
        ).id
        == job.id
    )


def test_abandoned_job_is_recovered_and_released(tmp_path) -> None:
    repository = _repo(tmp_path)
    job = repository.enqueue(kind="ok", input={}, idempotency_key=None, max_attempts=2)
    claimed = repository.claim_next(worker_id="dead", now=datetime.now(UTC) - timedelta(minutes=10))
    assert claimed and claimed.id == job.id
    assert (
        repository.recover_abandoned(
            before=datetime.now(UTC) - timedelta(minutes=2), now=datetime.now(UTC)
        )
        == 1
    )
    assert repository.get(str(job.id)).status == "retryable"
    assert repository.claim_next(worker_id="alive", now=datetime.now(UTC)).id == job.id


def test_cooperative_cancellation(tmp_path) -> None:
    repository = _repo(tmp_path)
    job = repository.enqueue(kind="cancel", input={}, idempotency_key=None, max_attempts=1)

    def handler(current, execution):
        repository.request_cancellation(job_id=str(current.id), now=datetime.now(UTC))
        execution.raise_if_cancelled()
        return {}

    assert PersistentWorker(repository, "worker", {"cancel": handler}).run_once()
    assert repository.get(str(job.id)).status == "cancelled"


def test_worker_logs_safe_correlations_without_private_error(tmp_path) -> None:
    repository = _repo(tmp_path)
    job = repository.enqueue(
        kind="media",
        input={"project_id": "project_1", "text": "private lesson"},
        idempotency_key=None,
        max_attempts=1,
    )
    stream = StringIO()
    logger = logging.getLogger("test_safe_worker")
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    try:

        def fail(*_args):
            raise RuntimeError("private lesson and token")

        PersistentWorker(repository, "worker_1", {"media": fail}, logger=logger).run_once()
    finally:
        logger.removeHandler(handler)
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [event["event"] for event in events] == ["job_started", "job_failed"]
    assert all(event["job_id"] == str(job.id) for event in events)
    assert all(event["project_id"] == "project_1" for event in events)
    assert "private lesson" not in stream.getvalue()
