from __future__ import annotations

import json
from pathlib import Path

import pytest

from nova_generator.domain.exports import ReelInterval
from nova_generator.infrastructure.exports.ffprobe_reel_validator import FfprobeReelValidator


class Completed:
    returncode = 0
    stderr = ""

    def __init__(self, payload: dict) -> None:
        self.stdout = json.dumps(payload)


def test_validator_requires_audio_packets_for_each_interval(tmp_path: Path, monkeypatch) -> None:
    reel = tmp_path / "reel.mp4"
    reel.write_bytes(b"mp4")
    calls = 0

    def fake_run(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return Completed(
                {
                    "format": {"duration": "2.0"},
                    "streams": [{"codec_type": "audio"}, {"codec_type": "video"}],
                }
            )
        return Completed({"packets": [{"pts_time": "0.0"}]})

    monkeypatch.setattr("subprocess.run", fake_run)
    FfprobeReelValidator().validate(
        reel=reel, intervals=[ReelInterval(1, 0, 1000, "a" * 64, "b" * 64)]
    )


def test_validator_rejects_a_seek_without_audio_packets(tmp_path: Path, monkeypatch) -> None:
    reel = tmp_path / "reel.mp4"
    reel.write_bytes(b"mp4")
    responses = iter(
        [
            Completed(
                {
                    "format": {"duration": "2.0"},
                    "streams": [{"codec_type": "audio"}, {"codec_type": "video"}],
                }
            ),
            Completed({"packets": []}),
        ]
    )
    monkeypatch.setattr("subprocess.run", lambda *args, **kwargs: next(responses))
    with pytest.raises(ValueError, match="seek"):
        FfprobeReelValidator().validate(
            reel=reel, intervals=[ReelInterval(1, 0, 1000, "a" * 64, "b" * 64)]
        )
