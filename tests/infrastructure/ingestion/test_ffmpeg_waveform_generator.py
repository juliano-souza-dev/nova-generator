import subprocess
from pathlib import Path

import pytest

from nova_generator.infrastructure.ingestion.ffmpeg_waveform_generator import (
    FfmpegWaveformGenerator,
    WaveformGenerationError,
)


def test_generates_normalized_bucket_peaks(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "cut.mp4"
    source.write_bytes(b"video")
    # 320 samples at 8kHz, bucket=20ms => two buckets with peaks 0.5 and 1.0.
    pcm = (16384).to_bytes(2, "little", signed=True) * 160 + (-32768).to_bytes(
        2, "little", signed=True
    ) * 160
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, pcm, b""),
    )

    waveform = FfmpegWaveformGenerator(sample_rate_hz=8000).generate(source, bucket_ms=20)

    assert waveform.peaks == (0.5, 1.0)


def test_rejects_ffmpeg_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "cut.mp4"
    source.write_bytes(b"video")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1, b"", b"no audio"),
    )
    with pytest.raises(WaveformGenerationError, match="no audio"):
        FfmpegWaveformGenerator().generate(source)
