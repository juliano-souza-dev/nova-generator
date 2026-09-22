from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.jobs import Job
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


def make_voice_preview_handler(
    synthesis: SynthesizeSpeech,
) -> Callable[[Job, JobExecution], dict[str, Any]]:
    def handle(job: Job, execution: JobExecution) -> dict[str, Any]:
        execution.raise_if_cancelled()
        raw = job.input["voice_snapshot"]
        if not isinstance(raw, dict):
            raise ValueError("voice snapshot missing")
        snapshot = VoiceProfileSnapshot(
            profile_id=UUID(str(raw["profile_id"])),
            name=str(raw["name"]),
            version=int(raw["version"]),
            model_id=str(raw["model_id"]),
            model_sha256=str(raw["model_sha256"]),
            reference_audio_sha256=(
                str(raw["reference_audio_sha256"]) if raw.get("reference_audio_sha256") else None
            ),
            parameters=dict(raw["parameters"]),
        )
        if snapshot.sha256 != raw.get("snapshot_sha256"):
            raise ValueError("voice snapshot hash mismatch")
        speech = synthesis.execute(text=str(job.input["text"]), profile=snapshot)
        execution.heartbeat()
        return {
            "audio_path": speech.audio_path,
            "duration_ms": speech.duration_ms,
            "snapshot_sha256": snapshot.sha256,
        }

    return handle
