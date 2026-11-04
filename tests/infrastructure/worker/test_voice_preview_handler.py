from __future__ import annotations

from uuid import uuid4

from nova_generator.domain.jobs import Job
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfileSnapshot
from nova_generator.infrastructure.worker.voice_preview_handler import make_voice_preview_handler


class _Execution:
    def __init__(self) -> None:
        self.heartbeats = 0

    def heartbeat(self) -> None:
        self.heartbeats += 1

    def raise_if_cancelled(self) -> None:
        return None


class _Synthesis:
    def __init__(self, execution: _Execution) -> None:
        self._execution = execution

    def execute(self, *, text: str, profile: VoiceProfileSnapshot) -> SynthesizedSpeech:
        # The lease must be renewed before a potentially long Qwen subprocess starts.
        assert self._execution.heartbeats == 1
        return SynthesizedSpeech("preview.wav", "a" * 64, profile, {}, 1200, 24000, 1)


def test_voice_preview_renews_lease_before_long_synthesis() -> None:
    snapshot = VoiceProfileSnapshot(
        uuid4(), "Narrador", 1, "qwen3-tts-1.7b-voice-design", "b" * 64,
        None, {"instruct": "Voz brasileira natural e expressiva para aulas."},
    )
    job = Job(
        uuid4(),
        "synthesize_voice_preview",
        "running",
        {
            "text": "Teste de prévia.",
            "voice_snapshot": {
                "profile_id": str(snapshot.profile_id),
                "name": snapshot.name,
                "version": snapshot.version,
                "model_id": snapshot.model_id,
                "model_sha256": snapshot.model_sha256,
                "reference_audio_sha256": None,
                "parameters": snapshot.parameters,
                "snapshot_sha256": snapshot.sha256,
            },
        },
        None,
        1,
        3,
    )
    execution = _Execution()

    result = make_voice_preview_handler(_Synthesis(execution))(job, execution)  # type: ignore[arg-type]

    assert result["duration_ms"] == 1200
    assert execution.heartbeats == 1
