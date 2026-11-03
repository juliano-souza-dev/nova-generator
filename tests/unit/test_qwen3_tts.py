from __future__ import annotations

import io
import json
import sys
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from nova_generator.core.settings import Settings
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.speech.qwen3_tts_models import (
    VOICE_CLONE,
    VOICE_DESIGN,
    qwen_model_sha256,
    validate_qwen_voice,
)
from nova_generator.infrastructure.speech.qwen3_tts_runner import main
from nova_generator.infrastructure.speech.routing_synthesizer import RoutingSpeechSynthesizer


def _fake_weights(root: Path, variant: str) -> Path:
    directory = root / variant
    directory.mkdir(parents=True)
    (directory / "config.json").write_text('{"model":"test"}', encoding="utf-8")
    (directory / "model.safetensors").write_bytes(b"dummy-weights")
    return directory


def test_qwen_model_hash_tracks_weight_changes(tmp_path):
    root = tmp_path / "qwen"
    model = _fake_weights(root, "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
    settings = Settings(qwen_model_root=root)
    first = qwen_model_sha256(settings, VOICE_DESIGN)
    assert len(first) == 64
    (model / "model.safetensors").write_bytes(b"new-dummy-weights")
    assert qwen_model_sha256(settings, VOICE_DESIGN) != first


def test_missing_qwen_weights_explains_offline_setup(tmp_path):
    with pytest.raises(ValueError, match="não instalado"):
        qwen_model_sha256(Settings(qwen_model_root=tmp_path), VOICE_DESIGN)


def test_qwen_parameters_require_design_or_authorized_clone():
    validate_qwen_voice(VOICE_DESIGN, None, {"instruct": "Voz brasileira muito natural."})
    validate_qwen_voice(VOICE_CLONE, "a" * 64, {"reference_text": "Olá, mundo."})
    with pytest.raises(ValueError, match="não utiliza áudio"):
        validate_qwen_voice(
            VOICE_DESIGN, "a" * 64, {"instruct": "Voz brasileira muito natural."}
        )
    with pytest.raises(ValueError, match="transcrição"):
        validate_qwen_voice(VOICE_CLONE, "a" * 64, {})


def test_router_keeps_legacy_profiles(tmp_path):
    _fake_weights(tmp_path, "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
    settings = Settings(qwen_model_root=tmp_path)
    fingerprint = qwen_model_sha256(settings, VOICE_DESIGN)
    qwen = SimpleNamespace(synthesize=lambda **kwargs: "QWEN")
    legacy = SimpleNamespace(synthesize=lambda **kwargs: "CHATTERBOX")
    router = RoutingSpeechSynthesizer(chatterbox=legacy, qwen=qwen, settings=settings)

    def profile(model_id, digest):
        return VoiceProfileSnapshot(uuid4(), "Ana", 1, model_id, digest, None, {})

    assert router.synthesize(
        text="Olá", profile=profile(VOICE_DESIGN, fingerprint),
        parameters={}, output=tmp_path / "qwen.wav",
    ) == "QWEN"
    assert router.synthesize(
        text="Hello", profile=profile("chatterbox-turbo", "a" * 64),
        parameters={}, output=tmp_path / "legacy.wav",
    ) == "CHATTERBOX"
    with pytest.raises(ValueError, match="pesos locais"):
        router.synthesize(
            text="Olá", profile=profile(VOICE_DESIGN, "a" * 64),
            parameters={}, output=tmp_path / "qwen-stale.wav",
        )


@pytest.mark.parametrize("voice_mode", [VOICE_DESIGN, VOICE_CLONE])
def test_runner_generates_portuguese_wav_offline_with_fake_model(
    tmp_path, monkeypatch, voice_mode
):
    root = tmp_path / "qwen"
    variant = (
        "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
        if voice_mode == VOICE_DESIGN else "Qwen3-TTS-12Hz-1.7B-Base"
    )
    _fake_weights(root, variant)
    calls = []
    model = SimpleNamespace(
        generate_voice_design=lambda **kwargs: (
            calls.append(("design", kwargs)) or [[0.1]], 24000
        ),
        generate_voice_clone=lambda **kwargs: (
            calls.append(("clone", kwargs)) or [[0.1]], 24000
        ),
    )
    qwen = SimpleNamespace(
        Qwen3TTSModel=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model)
    )
    cuda = SimpleNamespace(is_available=lambda: False)
    torch = SimpleNamespace(
        cuda=cuda, float32="float32", float16="float16", bfloat16="bfloat16"
    )
    soundfile = SimpleNamespace(
        write=lambda path, wav, sr, **kwargs: Path(path).write_bytes(b"RIFF-test")
    )
    monkeypatch.setitem(sys.modules, "qwen_tts", qwen)
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "soundfile", soundfile)
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(root))

    reference = None
    reference_root = None
    parameters = {"instruct": "Voz brasileira envolvente, suave e natural."}
    if voice_mode == VOICE_CLONE:
        reference_root = tmp_path / "references"
        reference_root.mkdir()
        sample = b"dummy-reference"
        reference = sha256(sample).hexdigest()
        (reference_root / f"{reference}.wav").write_bytes(sample)
        parameters = {"reference_text": "Esta é a minha voz."}

    output = tmp_path / "out.wav"
    request = {
        "text": "Hoje vamos aprender inglês.",
        "profile": {"model_id": voice_mode, "parameters": parameters},
        "parameters": {},
        "output": str(output),
        "reference_audio_sha256": reference,
        "reference_root": str(reference_root) if reference_root else None,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    main()
    assert output.read_bytes() == b"RIFF-test"
    assert calls[0][0] == ("design" if voice_mode == VOICE_DESIGN else "clone")
    assert calls[0][1]["language"] == "Portuguese"
