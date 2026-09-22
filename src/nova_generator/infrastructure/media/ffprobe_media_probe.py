from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from nova_generator.domain.media.probe import MediaInspection


class MediaProbeError(RuntimeError):
    """Raised when FFprobe cannot verify a media source."""


class FfprobeMediaProbe:
    """FFprobe adapter that accepts only sources with a video stream and duration."""

    def __init__(self, executable: str = "ffprobe") -> None:
        self._executable = executable

    def inspect(self, source: Path) -> MediaInspection:
        if not source.is_file() or source.stat().st_size == 0:
            raise MediaProbeError("A fonte para inspeção não existe ou está vazia.")
        try:
            completed = subprocess.run(
                [
                    self._executable,
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-of",
                    "json",
                    str(source),
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise MediaProbeError("Não foi possível executar FFprobe.") from exc
        if completed.returncode != 0:
            detail = completed.stderr.strip() or "erro não informado"
            raise MediaProbeError(f"FFprobe recusou a fonte: {detail}")
        try:
            payload = json.loads(completed.stdout)
            return self._inspection_from_payload(payload)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise MediaProbeError("FFprobe retornou metadados de mídia inválidos.") from exc

    @staticmethod
    def _inspection_from_payload(payload: object) -> MediaInspection:
        if not isinstance(payload, dict):
            raise ValueError("A resposta do FFprobe deve ser um objeto.")
        streams = payload.get("streams")
        if not isinstance(streams, list):
            raise ValueError("A resposta do FFprobe não contém streams.")
        video = next(
            (
                stream
                for stream in streams
                if isinstance(stream, dict) and stream.get("codec_type") == "video"
            ),
            None,
        )
        audio = next(
            (
                stream
                for stream in streams
                if isinstance(stream, dict) and stream.get("codec_type") == "audio"
            ),
            None,
        )
        if not isinstance(video, dict) or not str(video.get("codec_name", "")):
            raise ValueError("A fonte não contém stream de vídeo válido.")
        duration = FfprobeMediaProbe._duration_seconds(payload, video)
        return MediaInspection(
            duration_ms=max(1, round(duration * 1000)),
            video_codec=str(video["codec_name"]),
            audio_codec=str(audio["codec_name"]) if isinstance(audio, dict) else None,
        )

    @staticmethod
    def _duration_seconds(payload: dict[str, Any], video: dict[str, Any]) -> float:
        format_data = payload.get("format")
        candidates = [
            format_data.get("duration") if isinstance(format_data, dict) else None,
            video.get("duration"),
        ]
        for candidate in candidates:
            try:
                duration = float(candidate)
            except (TypeError, ValueError):
                continue
            if duration > 0:
                return duration
        raise ValueError("FFprobe não informou uma duração positiva.")
