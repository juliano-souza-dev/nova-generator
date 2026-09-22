from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

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
