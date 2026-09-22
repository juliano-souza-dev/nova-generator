from __future__ import annotations

import json
import subprocess
from pathlib import Path


class FfprobeWavProbe:
    """Validates emitted WAV codec, duration, rate and channels with FFprobe."""

    def __init__(self, executable: str = "ffprobe") -> None:
        self._executable = executable

    def inspect_wav(self, source: Path) -> tuple[int, int, int]:
        completed = subprocess.run(
            [
                self._executable,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(source),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if completed.returncode:
            raise RuntimeError("FFprobe recusou o WAV sintetizado.")
        try:
            payload = json.loads(completed.stdout)
            stream = next(item for item in payload["streams"] if item["codec_type"] == "audio")
            if str(stream.get("codec_name")) not in {"pcm_s16le", "pcm_s24le", "pcm_f32le"}:
                raise ValueError("codec WAV não canônico")
            duration = float(payload.get("format", {}).get("duration", 0))
            rate, channels = int(stream["sample_rate"]), int(stream["channels"])
        except (KeyError, StopIteration, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("FFprobe retornou um WAV inválido.") from exc
        if duration <= 0 or rate <= 0 or channels <= 0:
            raise RuntimeError("WAV sintetizado não possui duração ou formato válido.")
        return round(duration * 1000), rate, channels
