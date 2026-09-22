import io
import json
import wave
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.filesystem.voice_references import FileVoiceReferenceStore
from nova_generator.infrastructure.speech.chatterbox_nano_runner import _resolve_reference
from nova_generator.infrastructure.speech.chatterbox_nano_synthesizer import (
    ChatterboxNanoSynthesizer,
)


def _wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 32000)
    return output.getvalue()


def test_synthesizer_passes_only_managed_reference_identity(tmp_path):
    store = FileVoiceReferenceStore(tmp_path)
    reference = store.save(_wav())
    snapshot = VoiceProfile(
        uuid4(), "Ana", 1, "chatterbox-nano", "a" * 64, reference.sha256
    ).snapshot()
    output = tmp_path / "out.wav"

    class Probe:
        def inspect_wav(self, source):
            return 2000, 16000, 1

    def run(*args, **kwargs):
        request = json.loads(kwargs["input"])
        assert request["reference_audio_sha256"] == reference.sha256
        assert request["reference_root"] == str(store.root.resolve())
        assert "reference_audio_path" not in request["profile"]["parameters"]
        output.write_bytes(_wav())
        return Mock(returncode=0)

    with patch("subprocess.run", side_effect=run):
        ChatterboxNanoSynthesizer(
            Path("runner.py"), wav_probe=Probe(), reference_store=store
        ).synthesize(text="Hello", profile=snapshot, parameters={}, output=output)
    assert _resolve_reference(reference.sha256, str(store.root)).read_bytes() == _wav()
    (store.root / f"{reference.sha256}.wav").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="ausente ou alterado"):
        ChatterboxNanoSynthesizer(
            Path("runner.py"), wav_probe=Probe(), reference_store=store
        ).synthesize(text="Hello", profile=snapshot, parameters={}, output=output)
    with pytest.raises(ValueError, match="diverge"):
        _resolve_reference(reference.sha256, str(store.root))


def test_reference_name_cannot_escape_store(tmp_path):
    store = FileVoiceReferenceStore(tmp_path)
    assert store.get("../secret") is None
    with pytest.raises(ValueError, match="inválido"):
        _resolve_reference("../secret", str(store.root))
