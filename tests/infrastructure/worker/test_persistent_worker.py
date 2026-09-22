from datetime import UTC, datetime, timedelta
from threading import Barrier, Thread

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
