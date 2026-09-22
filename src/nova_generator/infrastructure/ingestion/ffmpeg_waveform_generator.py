from __future__ import annotations

import array
import subprocess
from pathlib import Path

from nova_generator.domain.ingestion import WaveformMetadata


class WaveformGenerationError(RuntimeError):
    pass


class FfmpegWaveformGenerator:
    def __init__(self, executable: str = "ffmpeg", sample_rate_hz: int = 8_000) -> None:
        self._executable = executable
        self._sample_rate_hz = sample_rate_hz

    def generate(self, source: Path, *, bucket_ms: int = 40) -> WaveformMetadata:
        if not source.is_file() or bucket_ms <= 0:
            raise WaveformGenerationError("Fonte e bucket de waveform são obrigatórios.")
        try:
            completed = subprocess.run(
                [
                    self._executable,
                    "-v",
                    "error",
                    "-i",
                    str(source),
                    "-map",
                    "0:a:0",
                    "-ac",
                    "1",
                    "-ar",
                    str(self._sample_rate_hz),
                    "-f",
                    "s16le",
                    "-",
                ],
                capture_output=True,
                timeout=300,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise WaveformGenerationError(
                "Não foi possível executar FFmpeg para a waveform."
            ) from exc
        if completed.returncode != 0:
            raise WaveformGenerationError(completed.stderr.decode("utf-8", "replace").strip())
        values = array.array("h")
        values.frombytes(completed.stdout)
        if not values:
            raise WaveformGenerationError("A fonte não contém áudio para a waveform.")
        samples_per_bucket = max(1, round(self._sample_rate_hz * bucket_ms / 1000))
        peaks = tuple(
            min(
                1.0,
                max(abs(sample) for sample in values[index : index + samples_per_bucket]) / 32768,
            )
            for index in range(0, len(values), samples_per_bucket)
        )
        return WaveformMetadata(self._sample_rate_hz, bucket_ms, peaks)
