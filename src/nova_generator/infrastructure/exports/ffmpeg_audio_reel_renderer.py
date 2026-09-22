from __future__ import annotations

import subprocess
from pathlib import Path

from nova_generator.domain.exports import ExportCue, ReelInterval


class FfmpegAudioReelRenderer:
    """Concatenates cue WAVs into a seekable MP4; intervals are sequential file durations."""

    def __init__(self, executable: str = "ffmpeg") -> None:
        self._executable = executable

    def render(self, *, cues: list[ExportCue], output: Path) -> tuple[Path, list[ReelInterval]]:
        output.parent.mkdir(parents=True, exist_ok=True)
        concat_file = output.with_suffix(".concat.txt")
        concat_file.write_text(
            "".join(
                f"file '{cue.audio_path.resolve().as_posix().replace("'", "'\\''")}'\n"
                for cue in cues
            ),
            encoding="utf-8",
        )
        try:
            total_seconds = sum(cue.duration_ms for cue in cues) / 1000
            command = [
                self._executable,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s=1280x720:r=30:d={total_seconds:.3f}",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(output),
            ]
            completed = subprocess.run(
                command, check=False, capture_output=True, text=True, encoding="utf-8", timeout=180
            )
            if completed.returncode:
                raise RuntimeError(completed.stderr.strip() or "FFmpeg falhou ao criar o reel.")
        finally:
            concat_file.unlink(missing_ok=True)
        intervals: list[ReelInterval] = []
        cursor = 0
        for cue in cues:
            intervals.append(
                ReelInterval(
                    cue.order, cursor, cursor + cue.duration_ms, cue.audio_sha256, cue.text_sha256
                )
            )
            cursor += cue.duration_ms
        return output, intervals
