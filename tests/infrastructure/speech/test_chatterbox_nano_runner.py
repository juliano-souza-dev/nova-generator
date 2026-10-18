"""Nano loader compatibility tests without downloading a model or importing Torch."""

from pathlib import Path

import pytest

from nova_generator.infrastructure.speech.chatterbox_nano_runner import _load_nano_model


class PipTurboOnly:
    called = False

    @classmethod
    def from_pretrained(cls, device: str):
        cls.called = True
        return ("turbo", device)


class SourceNanoCapable:
    calls: list[tuple[str, bool]] = []

    @classmethod
    def from_pretrained(cls, device: str, nano: bool = False):
        cls.calls.append((device, nano))
        return ("nano" if nano else "turbo", device)


def test_runner_does_not_fall_back_to_turbo_when_pypi_lacks_nano() -> None:
    PipTurboOnly.called = False
    with pytest.raises(RuntimeError, match=r"não suporta nano=True"):
        _load_nano_model(PipTurboOnly, "cpu")
    assert PipTurboOnly.called is False


def test_runner_explicitly_loads_nano_on_compatible_chatterbox() -> None:
    SourceNanoCapable.calls.clear()
    assert _load_nano_model(SourceNanoCapable, "cpu") == ("nano", "cpu")
    assert SourceNanoCapable.calls == [("cpu", True)]


def test_windows_bootstrap_installs_nano_source_instead_of_incompatible_pypi() -> None:
    startup = (
        Path(__file__).resolve().parents[3] / "scripts" / "start-local.ps1"
    ).read_text(encoding="utf-8")
    assert "chatterbox-tts==0.1.7" not in startup
    assert 'git+https://github.com/resemble-ai/chatterbox.git@$ChatterboxNanoCommit' in startup
    assert "inspect.signature(ChatterboxTurboTTS.from_pretrained)" in startup
    assert "Test-TtsRuntime $TtsPython" in startup
