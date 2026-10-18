"""Regression: the installed Chatterbox factory accepts device, not nano."""

import io
import json
from types import SimpleNamespace
from unittest.mock import Mock

from nova_generator.infrastructure.speech import chatterbox_nano_runner


def test_chatterbox_factory_is_called_without_nano(monkeypatch, tmp_path) -> None:
    factory = Mock(
        return_value=SimpleNamespace(generate=Mock(return_value="audio"), sr=24000)
    )
    modules = {
        "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
        "torchaudio": SimpleNamespace(save=Mock()),
        "chatterbox.tts_turbo": SimpleNamespace(
            ChatterboxTurboTTS=SimpleNamespace(from_pretrained=factory)
        ),
    }
    monkeypatch.setattr(chatterbox_nano_runner, "import_module", modules.__getitem__)
    monkeypatch.setattr(
        chatterbox_nano_runner.sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "profile": {"model_id": "chatterbox-nano"},
                    "text": "Hello.",
                    "output": str(tmp_path / "output.wav"),
                }
            )
        ),
    )

    chatterbox_nano_runner.main()

    factory.assert_called_once_with(device="cpu")
    modules["torchaudio"].save.assert_called_once()


def test_runner_reports_missing_local_model_without_download(monkeypatch, tmp_path) -> None:
    import pytest

    factory = Mock(side_effect=OSError("offline model unavailable"))
    modules = {
        "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
        "torchaudio": SimpleNamespace(save=Mock()),
        "chatterbox.tts_turbo": SimpleNamespace(
            ChatterboxTurboTTS=SimpleNamespace(from_pretrained=factory)
        ),
    }
    monkeypatch.setattr(chatterbox_nano_runner, "import_module", modules.__getitem__)
    monkeypatch.setattr(
        chatterbox_nano_runner.sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "profile": {"model_id": "chatterbox-nano"},
                    "text": "Hello.",
                    "output": str(tmp_path / "output.wav"),
                }
            )
        ),
    )
    with pytest.raises(RuntimeError, match="cache local"):
        chatterbox_nano_runner.main()
    assert chatterbox_nano_runner.os.environ["HF_HUB_OFFLINE"] == "1"
    assert chatterbox_nano_runner.os.environ["TRANSFORMERS_OFFLINE"] == "1"
