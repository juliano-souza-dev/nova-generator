from __future__ import annotations

import subprocess
from pathlib import Path

from nova_generator.domain.ingestion import SourceCut


class SourceCutError(RuntimeError):
    pass


class FfmpegSourceCutter:
    """Accurate re-encoded cuts; output is atomically installed per project."""

    def __init__(self, executable: str = "ffmpeg") -> None:
        self._executable = executable

    def cut(self, request: SourceCut) -> Path:
        if not request.source.is_file():
            raise SourceCutError("A fonte de vídeo não existe.")
        request.output.parent.mkdir(parents=True, exist_ok=True)
        staging = request.output.with_name(f"{request.output.stem}.partial{request.output.suffix}")
        self._remove(staging)
        command = [
            self._executable,
            "-y",
            "-ss",
            f"{request.start_ms / 1000:.3f}",
            "-i",
            str(request.source),
            "-t",
            f"{request.duration_ms / 1000:.3f}",
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(staging),
        ]
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=600, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self._remove(staging)
            raise SourceCutError("Não foi possível executar FFmpeg para criar o corte.") from exc
        if completed.returncode != 0 or not staging.is_file() or staging.stat().st_size == 0:
            self._remove(staging)
            raise SourceCutError(completed.stderr.strip() or "FFmpeg não criou o corte.")
        staging.replace(request.output)
        return request.output

    @staticmethod
    def _remove(path: Path) -> None:
        if path.exists():
            path.unlink()
