from __future__ import annotations

import io
import json
import sys
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.speech_language import synthesis_language_parameters
from nova_generator.core.settings import Settings
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.speech import qwen3_tts_runner
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
    assert parse_narration("Clique em [OK].") == [("pt", "Clique em [OK].")]
    assert parse_narration(" [pt]Olha![/pt] [en]Look at that![/en] ") == [
        ("pt", "Olha!"),
        ("en", "Look at that!"),
    ]
    assert parse_narration("[EN]Watch out![/en]") == [("en", "Watch out!")]


def test_bilingual_parser_resolves_nested_tags_without_changing_spoken_words():
    assert parse_narration(
        "[pt]Hoje usamos [en]watch[/en] para falar de assistir.[/pt]"
    ) == [
        ("pt", "Hoje usamos"),
        ("en", "watch"),
        ("pt", "para falar de assistir."),
    ]
    assert parse_narration(
        "[pt][pt]Olá, pessoal![/pt] [en]Hello, everyone![/en][/pt]"
    ) == [("pt", "Olá, pessoal!"), ("en", "Hello, everyone!")]
    # The TikTok button may wrap text that was already tagged by an imported draft.
    assert parse_narration("[pt][pt]Olá![/pt][/pt]\n[en][en]Hello![/en][/en]") == [
        ("pt", "Olá!"),
        ("en", "Hello!"),
    ]
    assert parse_narration("[pt]Hoje [pt]vamos[/pt] aprender.[/pt]") == [
        ("pt", "Hoje vamos aprender.")
    ]
    assert parse_narration("[pt]Oi![/pt] [pt]Tudo bem?[/pt]") == [
        ("pt", "Oi!"),
        ("pt", "Tudo bem?"),
    ]


@pytest.mark.parametrize(
    "invalid",
    [
        "[pt]Sem fechamento",
        "[pt] [/pt]",
        "Texto sem marcação [en]Hello[/en]",
        "[pt]Olá[/pt] texto perdido",
        "[pt]Olá [en]Hello[/pt][/en]",
        "[pt][en] [/en]Olá[/pt]",
        "[pt]Olá [es]Hola[/es][/pt]",
        "[en]Hello[/pt]",
        "[es]Hola[/es]",
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


def test_qwen_model_hash_does_not_accept_huggingface_cache_metadata_as_weights(tmp_path):
    root = tmp_path / "qwen"
    model = root / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    cache = model / ".cache" / "huggingface" / "download"
    cache.mkdir(parents=True)
    (model / "config.json").write_text("{}", encoding="utf-8")
    (cache / "model.safetensors.incomplete").write_bytes(b"partial")
    with pytest.raises(ValueError, match="Pesos .safetensors"):
        qwen_model_sha256(Settings(qwen_model_root=root), VOICE_DESIGN)


def test_qwen_parameters_require_design_or_authorized_clone():
    validate_qwen_voice(VOICE_DESIGN, None, {"instruct": "Voz brasileira muito natural."})
    validate_qwen_voice(VOICE_CLONE, "a" * 64, {"reference_text": "Olá, mundo."})
    with pytest.raises(ValueError, match="não utiliza áudio"):
        validate_qwen_voice(VOICE_DESIGN, "a" * 64, {"instruct": "Voz brasileira muito natural."})
    with pytest.raises(ValueError, match="transcrição"):
        validate_qwen_voice(VOICE_CLONE, "a" * 64, {})


def test_qwen_language_is_explicit_and_not_sent_to_legacy_engines():
    qwen = VoiceProfileSnapshot(uuid4(), "Qwen", 1, VOICE_DESIGN, "a" * 64, None, {})
    legacy = VoiceProfileSnapshot(uuid4(), "Legacy", 1, "chatterbox-turbo", "a" * 64, None, {})
    assert synthesis_language_parameters(qwen, "English") == {
        "language": "English",
        "seed": 42,
    }
    assert synthesis_language_parameters(qwen, "Portuguese") == {
        "language": "Portuguese",
        "seed": 42,
    }
    assert synthesis_language_parameters(legacy, "English") == {}
    with pytest.raises(ValueError, match="Idioma Qwen"):
        synthesis_language_parameters(qwen, "Spanish")


def test_qwen_default_language_can_be_english_without_tags():
    assert parse_narration("Welcome", "en") == [("en", "Welcome")]


def test_router_keeps_legacy_profiles(tmp_path):
    _fake_weights(tmp_path, "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
    settings = Settings(qwen_model_root=tmp_path)
    fingerprint = qwen_model_sha256(settings, VOICE_DESIGN)
    qwen = SimpleNamespace(synthesize=lambda **kwargs: "QWEN")
    legacy = SimpleNamespace(synthesize=lambda **kwargs: "CHATTERBOX")
    router = RoutingSpeechSynthesizer(chatterbox=legacy, qwen=qwen, settings=settings)

    def profile(model_id, digest):
        return VoiceProfileSnapshot(uuid4(), "Ana", 1, model_id, digest, None, {})

    assert (
        router.synthesize(
            text="Olá",
            profile=profile(VOICE_DESIGN, fingerprint),
            parameters={},
            output=tmp_path / "qwen.wav",
        )
        == "QWEN"
    )
    assert (
        router.synthesize(
            text="Hello",
            profile=profile("chatterbox-turbo", "a" * 64),
            parameters={},
            output=tmp_path / "legacy.wav",
        )
        == "CHATTERBOX"
    )
    with pytest.raises(ValueError, match="exigem uma voz Qwen3-TTS"):
        router.synthesize(
            text="[pt]Oi![/pt][en]Hi![/en]",
            profile=profile("chatterbox-turbo", "a" * 64),
            parameters={},
            output=tmp_path / "unsupported.wav",
        )
    with pytest.raises(ValueError, match="exigem uma voz Qwen3-TTS"):
        router.synthesize(
            text="[es]Hola[/es]",
            profile=profile("chatterbox-turbo", "a" * 64),
            parameters={},
            output=tmp_path / "unknown-language.wav",
        )
    with pytest.raises(ValueError, match="pesos locais"):
        router.synthesize(
            text="Olá",
            profile=profile(VOICE_DESIGN, "a" * 64),
            parameters={},
            output=tmp_path / "qwen-stale.wav",
        )


@pytest.mark.parametrize("voice_mode", [VOICE_DESIGN, VOICE_CLONE])
def test_runner_generates_portuguese_wav_offline_with_fake_model(tmp_path, monkeypatch, voice_mode):
    root = tmp_path / "qwen"
    variant = (
        "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
        if voice_mode == VOICE_DESIGN
        else "Qwen3-TTS-12Hz-1.7B-Base"
    )
    _fake_weights(root, variant)
    calls = []
    model = SimpleNamespace(
        generate_voice_design=lambda **kwargs: (calls.append(("design", kwargs)) or [[0.1]], 24000),
        generate_voice_clone=lambda **kwargs: (calls.append(("clone", kwargs)) or [[0.1]], 24000),
    )
    qwen = SimpleNamespace(
        Qwen3TTSModel=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model)
    )
    cuda = SimpleNamespace(is_available=lambda: False)
    torch = SimpleNamespace(
        cuda=cuda,
        float32="float32",
        float16="float16",
        bfloat16="bfloat16",
        manual_seed=lambda _seed: None,
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
        "parameters": {"language": "English"},
        "output": str(output),
        "reference_audio_sha256": reference,
        "reference_root": str(reference_root) if reference_root else None,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    main()
    assert output.read_bytes() == b"RIFF-test"
    assert calls[0][0] == ("design" if voice_mode == VOICE_DESIGN else "clone")
    assert calls[0][1]["language"] == "English"
    if voice_mode == VOICE_DESIGN:
        assert calls[0][1]["do_sample"] is True


@pytest.mark.parametrize("voice_mode", [VOICE_DESIGN, VOICE_CLONE])
def test_bilingual_runner_preserves_voice_and_inserts_only_between_segments(
    tmp_path, monkeypatch, voice_mode
):
    variant = (
        "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
        if voice_mode == VOICE_DESIGN
        else "Qwen3-TTS-12Hz-1.7B-Base"
    )
    model_dir = _fake_weights(tmp_path / "qwen", variant)
    calls = []
    model = SimpleNamespace(
        generate_voice_design=lambda **kwargs: (
            calls.append(("design", kwargs)) or [[0.25, 0.5]],
            24000,
        ),
        generate_voice_clone=lambda **kwargs: (
            calls.append(("clone", kwargs)) or [[0.25, 0.5]],
            24000,
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
    monkeypatch.setattr(qwen3_tts_runner, "_smooth_segment_edges", lambda wave, _sr: wave)
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(model_dir.parent))
    reference = None
    reference_root = None
    parameters = {"instruct": "Voz brasileira didática e expressiva."}
    if voice_mode == VOICE_CLONE:
        reference_root = tmp_path / "references"
        reference_root.mkdir()
        sample = b"dummy-reference"
        reference = sha256(sample).hexdigest()
        (reference_root / f"{reference}.wav").write_bytes(sample)
        parameters = {"reference_text": "Este áudio é a minha voz."}

    request = {
        "text": "[pt][pt]Vamos aprender.[/pt] [en]Let's learn![/en]"
        " [pt]Continue comigo.[/pt][/pt]",
        "profile": {"model_id": voice_mode, "parameters": parameters},
        "parameters": {},
        "output": str(tmp_path / "lesson.wav"),
        "reference_audio_sha256": reference,
        "reference_root": str(reference_root) if reference_root else None,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    main()
    assert [call[1]["language"] for call in calls] == [
        "Portuguese",
        "English",
        "Portuguese",
    ]
    assert all(call[0] == ("design" if voice_mode == VOICE_DESIGN else "clone") for call in calls)
    if voice_mode == VOICE_CLONE:
        assert all(call[1]["ref_audio"].endswith(f"{reference}.wav") for call in calls)
        assert all(call[1]["ref_text"] == parameters["reference_text"] for call in calls)
    samples, rate = outputs[0]
    assert rate == 24000
    assert len(samples) == 6 + (2 * 7200)
    assert samples[:2] == [0.25, 0.5]
    assert samples[2 : 2 + 7200] == [0.0] * 7200
    assert samples[-2:] == [0.25, 0.5]


def test_bilingual_parser_limits_segment_count():
    spoken = " ".join("[en]Hi![/en]" for _ in range(257))
    with pytest.raises(ValueError, match="256 trechos"):
        parse_narration(spoken)
