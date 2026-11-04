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
from nova_generator.infrastructure.speech.qwen3_tts_runner import main, parse_narration
from nova_generator.infrastructure.speech.routing_synthesizer import RoutingSpeechSynthesizer


def test_bilingual_parser_keeps_language_order_and_old_plain_text():
    assert parse_narration("Uma frase comum.") == [("pt", "Uma frase comum.")]
    assert parse_narration(" [pt]Olha![/pt] [en]Look at that![/en] ") == [
        ("pt", "Olha!"),
        ("en", "Look at that!"),
    ]
    assert parse_narration("[EN]Watch out![/en]") == [("en", "Watch out!")]


@pytest.mark.parametrize(
    "invalid",
    [
        "[pt]Sem fechamento",
        "[pt] [/pt]",
        "Texto sem marcação [en]Hello[/en]",
        "[pt]Olá[/pt] texto perdido",
        "[pt]Olá [en]Hello[/en][/pt]",
        "[en]Hello[/pt]",
    ],
)
def test_bilingual_parser_rejects_broken_markup(invalid):
    with pytest.raises(ValueError):
        parse_narration(invalid)


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
    with pytest.raises(ValueError, match="exigem uma voz Qwen3-TTS"):
        router.synthesize(
            text="[pt]Oi![/pt][en]Hi![/en]",
            profile=profile("chatterbox-turbo", "a" * 64),
            parameters={}, output=tmp_path / "unsupported.wav",
        )
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


def test_bilingual_runner_switches_language_and_inserts_one_300ms_gap(tmp_path, monkeypatch):
    model_dir = _fake_weights(tmp_path / "qwen", "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
    calls = []
    model = SimpleNamespace(
        generate_voice_design=lambda **kwargs: (
            calls.append(kwargs) or [[0.25, 0.5]], 24000
        ),
    )
    qwen = SimpleNamespace(
        Qwen3TTSModel=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model)
    )
    cuda = SimpleNamespace(is_available=lambda: False)
    torch = SimpleNamespace(cuda=cuda, float32="float32", float16="float16", bfloat16="bfloat16")
    outputs = []
    soundfile = SimpleNamespace(
        write=lambda path, samples, rate, **kwargs: outputs.append((samples, rate))
    )

    class WaveBuffer(list):
        def reshape(self, *_):
            return self

    numpy = SimpleNamespace(
        float32="float32",
        zeros=lambda count, dtype: [0.0] * count,
        asarray=lambda samples, dtype: WaveBuffer(samples),
        concatenate=lambda parts: [sample for part in parts for sample in part],
    )
    monkeypatch.setitem(sys.modules, "qwen_tts", qwen)
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "soundfile", soundfile)
    monkeypatch.setitem(sys.modules, "numpy", numpy)
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(model_dir.parent))
    request = {
        "text": "[pt]Vamos aprender.[/pt] [en]Let's learn![/en]",
        "profile": {
            "model_id": VOICE_DESIGN,
            "parameters": {"instruct": "Voz brasileira didática e expressiva."},
        },
        "parameters": {},
        "output": str(tmp_path / "lesson.wav"),
        "reference_audio_sha256": None,
        "reference_root": None,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    main()
    assert [call["language"] for call in calls] == ["Portuguese", "English"]
    samples, rate = outputs[0]
    assert rate == 24000
    assert len(samples) == 4 + 7200
    assert samples[:2] == [0.25, 0.5]
    assert samples[2 : 2 + 7200] == [0.0] * 7200
    assert samples[-2:] == [0.25, 0.5]
