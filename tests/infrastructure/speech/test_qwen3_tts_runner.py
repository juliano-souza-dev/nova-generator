import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from nova_generator.infrastructure.speech import qwen3_tts_runner


def test_structured_qwen_batch_processes_more_than_twenty_chunks(monkeypatch, tmp_path):
    model_dir = tmp_path / "models" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")

    generated = []

    def generate_voice_design(**kwargs):
        generated.append(kwargs)
        return [[0.1] * 64], 24000

    model = SimpleNamespace(generate_voice_design=generate_voice_design)
    factory = Mock(return_value=model)
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        float32="float32",
        manual_seed=Mock(),
    )

    def write_wav(path, _wave, _sample_rate, **_kwargs):
        Path(path).write_bytes(b"RIFF test wav")

    modules = {
        "torch": torch,
        "soundfile": SimpleNamespace(write=write_wav),
        "qwen_tts": SimpleNamespace(
            Qwen3TTSModel=SimpleNamespace(from_pretrained=factory)
        ),
    }
    monkeypatch.setattr(qwen3_tts_runner, "import_module", modules.__getitem__)
    monkeypatch.setattr(qwen3_tts_runner, "_smooth_segment_edges", lambda wave, _sr: wave)
    monkeypatch.setenv("NOVA_GENERATOR_QWEN_MODEL_ROOT", str(tmp_path / "models"))

    segments = [
        {
            "text": f"Literal chunk number {index}.",
            "language": "en" if index % 2 == 0 else "pt",
            "seed": 42,
            "output": str(tmp_path / f"chunk-{index:02d}.wav"),
        }
        for index in range(25)
    ]
    request = {
        "profile": {
            "model_id": "qwen3-tts-1.7b-voice-design",
            "parameters": {"instruct": "Voz feminina brasileira, suave e clara."},
        },
        "segments": segments,
    }
    monkeypatch.setattr(
        qwen3_tts_runner.sys, "stdin", io.StringIO(json.dumps(request))
    )

    qwen3_tts_runner.main()

    assert factory.call_count == 1
    assert len(generated) == 25
    assert torch.manual_seed.call_count == 25
    assert generated[0]["language"] == "English"
    assert generated[1]["language"] == "Portuguese"
    assert "brasileira" not in generated[0]["instruct"].lower()
    assert "american english pronunciation" in generated[0]["instruct"].lower()
    assert generated[1]["instruct"] == "Voz feminina brasileira, suave e clara."
    assert all(call.args == (42,) for call in torch.manual_seed.call_args_list)
    assert all(Path(segment["output"]).is_file() for segment in segments)


def test_legacy_parser_no_longer_has_a_twenty_segment_limit():
    script = " ".join(f"[en]Sentence {index}.[/en]" for index in range(25))

    segments = qwen3_tts_runner.parse_narration(script)

    assert len(segments) == 25
