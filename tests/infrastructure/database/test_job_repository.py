from datetime import UTC, datetime, timedelta

from nova_generator.infrastructure.database.base import Base
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.database.session import (
    create_database_engine,
    create_session_factory,
)


def test_job_is_claimed_once_and_recovered_after_lease_expiry(tmp_path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'jobs.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyJobRepository(create_session_factory(engine))
    created = repository.enqueue(
        kind="test", input={"x": 1}, idempotency_key="source-1", max_attempts=2
    )
    duplicate = repository.enqueue(
        kind="test", input={"x": 2}, idempotency_key="source-1", max_attempts=2
    )
    assert duplicate.id == created.id
    now = datetime.now(UTC)
    claimed = repository.claim_next(worker_id="worker-a", now=now)
    assert claimed and claimed.status == "running"
    assert repository.claim_next(worker_id="worker-b", now=now) is None
    assert repository.recover_abandoned(before=now + timedelta(seconds=1), now=now) == 1
    retried = repository.claim_next(worker_id="worker-b", now=now)
    assert retried and retried.attempt == 2
    assert repository.fail(
        job_id=str(retried.id), worker_id="worker-b", error_message="boom", now=now
    )
    assert repository.get(str(retried.id)).status == "failed"


def test_running_job_cancels_cooperatively(tmp_path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'jobs.db'}")
    Base.metadata.create_all(engine)
    repository = SqlAlchemyJobRepository(create_session_factory(engine))
    job = repository.enqueue(kind="test", input={}, idempotency_key=None, max_attempts=1)
    running = repository.claim_next(worker_id="worker-a", now=datetime.now(UTC))
    assert running and running.id == job.id
    requested = repository.request_cancellation(job_id=str(job.id), now=datetime.now(UTC))
    assert requested and requested.status == "running"
    assert repository.cancellation_requested(job_id=str(job.id), worker_id="worker-a")
    assert repository.cancel(job_id=str(job.id), worker_id="worker-a", now=datetime.now(UTC))
    assert repository.get(str(job.id)).status == "cancelled"
