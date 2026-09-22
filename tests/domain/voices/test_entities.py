from uuid import uuid4

import pytest

from nova_generator.domain.voices import VoiceProfile


def test_voice_snapshot_is_stable_and_includes_versioned_configuration() -> None:
    profile = VoiceProfile(
        uuid4(), "Narradora", 2, "chatterbox-nano", "a" * 64, "b" * 64, {"exaggeration": 0.5}
    )
    snapshot = profile.snapshot()
    assert snapshot.version == 2
    assert len(snapshot.sha256) == 64


def test_voice_profile_requires_model_hash() -> None:
    with pytest.raises(ValueError):
        VoiceProfile(uuid4(), "Narradora", 1, "nano", "short")
