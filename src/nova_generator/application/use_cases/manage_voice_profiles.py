from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.application.ports.voice_profile_repository import VoiceProfileRepository
from nova_generator.domain.voices import VoiceProfile

PREVIEW_TEXT = "Hello. This is a local voice preview."


class ManageVoiceProfiles:
    def __init__(self, repository: VoiceProfileRepository, jobs: JobRepository) -> None:
        self._repository, self._jobs = repository, jobs

    def list(self) -> list[VoiceProfile]:
        return self._repository.list()

    def get(self, profile_id: UUID, version: int | None = None) -> VoiceProfile | None:
        return self._repository.get(profile_id, version)

    def create(self, **values: Any) -> VoiceProfile:
        profile = VoiceProfile(uuid4(), **values, version=1)
        self._repository.save(profile)
        self.preview(profile)
        return profile

    def version(self, profile_id: UUID, **values: Any) -> VoiceProfile:
        prior = self._repository.get(profile_id)
        if prior is None:
            raise ValueError("voice profile not found")
        profile = VoiceProfile(profile_id, version=prior.version + 1, **values)
        self._repository.save(profile)
        self.preview(profile)
        return profile

    def preview(self, profile: VoiceProfile):
        snapshot = profile.snapshot()
        return self._jobs.enqueue(
            kind="synthesize_voice_preview",
            input={"voice_snapshot": _payload(snapshot), "text": PREVIEW_TEXT},
            idempotency_key=f"voice-preview:{snapshot.sha256}",
            max_attempts=3,
        )


def _payload(snapshot: Any) -> dict[str, Any]:
    return {
        "profile_id": str(snapshot.profile_id),
        "name": snapshot.name,
        "version": snapshot.version,
        "model_id": snapshot.model_id,
        "model_sha256": snapshot.model_sha256,
        "reference_audio_sha256": snapshot.reference_audio_sha256,
        "parameters": snapshot.parameters,
        "snapshot_sha256": snapshot.sha256,
    }
