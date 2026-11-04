import subprocess
import sys
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


@pytest.mark.parametrize("exit_code", [0, 2])
def test_voice_subprocess_handles_non_utf8_windows_output(tmp_path, exit_code: int) -> None:
    """A local-codepage diagnostic must not break the subprocess reader thread."""
    runner = tmp_path / "mixed_encoding.py"
    runner.write_text(
        "import json, pathlib, sys\n"
        "request = json.load(sys.stdin)\n"
        "sys.stderr.buffer.write(b'Erro: n\\xe3o foi poss\\xedvel\\n')\n"
        f"if not {exit_code}:\n"
        "    pathlib.Path(request['output']).write_bytes(b'RIFF wav')\n"
        f"sys.exit({exit_code})\n",
        encoding="utf-8",
    )
    output = tmp_path / "spoken.wav"
    profile = VoiceProfile(uuid4(), "Ana", 1, "qwen3-tts-1.7b-base", "a" * 64).snapshot()
    synthesizer = ChatterboxNanoSynthesizer(
        runner, executable=sys.executable, wav_probe=FakeWavProbe(), engine_name="Qwen3-TTS"
    )
    if exit_code:
        with pytest.raises(RuntimeError, match="Qwen3-TTS falhou: Erro: n") as exc_info:
            synthesizer.synthesize(text="Olá!", profile=profile, parameters={}, output=output)
        assert "NoneType" not in str(exc_info.value)
    else:
        speech = synthesizer.synthesize(
            text="Olá!", profile=profile, parameters={}, output=output
        )
        assert speech.duration_ms == 500


def test_voice_subprocess_missing_stderr_reports_original_failure(tmp_path) -> None:
    profile = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    with patch("subprocess.run", return_value=Mock(returncode=1, stderr=None, stdout=None)):
        with pytest.raises(RuntimeError, match="Chatterbox falhou: erro não informado"):
            ChatterboxNanoSynthesizer(Path("runner.py")).synthesize(
                text="Hello", profile=profile, parameters={}, output=tmp_path / "out.wav"
            )
