from datetime import UTC, datetime

from nova_generator.api.dependencies import get_session_factory
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository


def test_voice_setup_does_not_starve_other_media_jobs(client):
    repository = SqlAlchemyJobRepository(get_session_factory())
    setup = repository.enqueue(
        kind="qwen.setup",
        input={"model_id": "qwen3-tts-1.7b-voice-design"},
        idempotency_key="setup-test",
        max_attempts=2,
    )
    media = repository.enqueue(
        kind="tiktok.render",
        input={"project_id": "video-test"},
        idempotency_key="media-test",
        max_attempts=2,
    )
    now = datetime.now(UTC)

    media_claim = repository.claim_next(
        worker_id="media", now=now, excluded_kinds=("qwen.setup",)
    )
    assert media_claim is not None
    assert media_claim.id == media.id
    setup_claim = repository.claim_next(
        worker_id="setup", now=now, allowed_kinds=("qwen.setup",)
    )
    assert setup_claim is not None
    assert setup_claim.id == setup.id
