import subprocess
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.speech.chatterbox_nano_synthesizer import (
    ChatterboxNanoSynthesizer,
)


class FakeWavProbe:
    def inspect_wav(self, source: Path) -> tuple[int, int, int]:
        return (500, 24000, 1)


def test_chatterbox_runner_is_isolated_and_returns_wav_metadata(tmp_path) -> None:
    output = tmp_path / "out.wav"
    profile = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    completed = Mock(
        returncode=0,
        stdout='{"duration_ms": 500, "sample_rate": 24000, "channels": 1}',
        stderr="",
    )

    def runner(*args, **kwargs):
        output.write_bytes(b"RIFF wav")
        return completed

    with patch("subprocess.run", side_effect=runner) as run:
        speech = ChatterboxNanoSynthesizer(Path("runner.py"), wav_probe=FakeWavProbe()).synthesize(
            text="Hello", profile=profile, parameters={}, output=output
        )
    assert speech.duration_ms == 500
    assert run.call_args.args[0][1] == "runner.py"
    assert "Hello" in run.call_args.kwargs["input"]


def test_chatterbox_timeout_is_reported_as_timeout_not_startup_error(tmp_path) -> None:
    output = tmp_path / "timeout.wav"
    profile = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    with patch(
        "subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd=["python", "runner.py"], timeout=300),
    ):
        with pytest.raises(RuntimeError, match="excedeu 300 segundos") as exc_info:
            ChatterboxNanoSynthesizer(Path("runner.py"), wav_probe=FakeWavProbe()).synthesize(
                text="Hello", profile=profile, parameters={}, output=output
            )
    assert isinstance(exc_info.value.__cause__, subprocess.TimeoutExpired)


def test_chatterbox_timeout_logs_captured_stderr_and_stdout(tmp_path) -> None:
    output = tmp_path / "timeout.wav"
    profile = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    expired = subprocess.TimeoutExpired(
        cmd=["python", "runner.py"],
        timeout=300,
        output=b"loading model...",
        stderr=b"Traceback: model stalled",
    )
    with (
        patch("subprocess.run", side_effect=expired),
        patch("nova_generator.infrastructure.speech.chatterbox_nano_synthesizer.logger.error")
        as log_error,
    ):
        with pytest.raises(RuntimeError, match="excedeu 300 segundos"):
            ChatterboxNanoSynthesizer(Path("runner.py"), wav_probe=FakeWavProbe()).synthesize(
                text="Hello", profile=profile, parameters={}, output=output
            )
    log_error.assert_called_once()
    assert "chatterbox_subprocess_timeout" in log_error.call_args.args[0]
    assert "Traceback: model stalled" in log_error.call_args.args[3]
    assert "loading model..." in log_error.call_args.args[4]
