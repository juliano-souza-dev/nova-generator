from __future__ import annotations

import json
import subprocess
from pathlib import Path

from nova_generator.domain.exports import ReelInterval


class FfprobeReelValidator:
    """Checks the rendered MP4 and that every published seek point exposes audio."""

    def __init__(self, executable: str = "ffprobe", tolerance_ms: int = 150) -> None:
        self._executable = executable
        self._tolerance_ms = tolerance_ms

    def validate(self, *, reel: Path, intervals: list[ReelInterval]) -> None:
        if not reel.is_file() or reel.stat().st_size == 0 or not intervals:
            raise ValueError("Reel ausente ou sem intervalos.")
        duration_ms, has_audio, has_video = self._format(reel)
        if not has_audio or not has_video:
            raise ValueError("Reel deve conter streams de áudio e vídeo.")
        if duration_ms + self._tolerance_ms < intervals[-1].end_ms:
            raise ValueError("Duração do reel não cobre o último intervalo.")
        for interval in intervals:
            if not self._has_audio_at(reel, interval.start_ms):
                raise ValueError(f"O reel não permite seek de áudio no cue {interval.cue_order}.")

    def _format(self, reel: Path) -> tuple[int, bool, bool]:
        payload = self._run(["-show_format", "-show_streams", str(reel)])
        streams = payload.get("streams", [])
        if not isinstance(streams, list):
            raise ValueError("FFprobe não retornou streams do reel.")
        duration = float(payload.get("format", {}).get("duration", 0))
        return (
            round(duration * 1000),
            any(s.get("codec_type") == "audio" for s in streams if isinstance(s, dict)),
            any(s.get("codec_type") == "video" for s in streams if isinstance(s, dict)),
        )

    def _has_audio_at(self, reel: Path, start_ms: int) -> bool:
        payload = self._run(
            [
                "-read_intervals",
                f"{start_ms / 1000:.3f}%+0.1",
                "-show_packets",
                "-select_streams",
                "a",
                str(reel),
            ]
        )
        packets = payload.get("packets")
        return isinstance(packets, list) and bool(packets)

    def _run(self, args: list[str]) -> dict[str, object]:
        completed = subprocess.run(
            [self._executable, "-v", "error", "-of", "json", *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if completed.returncode:
            raise ValueError("FFprobe não conseguiu validar o reel.")
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ValueError("FFprobe retornou JSON inválido para o reel.") from exc
        return payload if isinstance(payload, dict) else {}
