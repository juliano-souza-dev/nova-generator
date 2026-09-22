from __future__ import annotations

import subprocess
from pathlib import Path


class FfmpegStoryVideoRenderer:
    """FFmpeg implementation; cues are independently renderable and concat-safe."""

    def __init__(self, executable: str = "ffmpeg", fps: int = 30) -> None:
        self._executable, self._fps = executable, fps

    def render_cue(self, *, image: Path, audio: Path, output: Path) -> Path:
        output.parent.mkdir(parents=True, exist_ok=True)
        self._run([
            "-y", "-loop", "1", "-i", str(image), "-i", str(audio), "-shortest",
            "-r", str(self._fps), "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart", str(output),
        ])
        return output

    def concat(self, *, cue_videos: list[Path], output: Path) -> Path:
        if not cue_videos:
            raise ValueError("A história requer ao menos um vídeo de cue.")
        output.parent.mkdir(parents=True, exist_ok=True)
        listing = output.with_suffix(".concat.txt")
        listing.write_text(
            "".join(f"file '{path.resolve().as_posix()}'\n" for path in cue_videos),
            encoding="utf-8",
        )
        try:
            self._run(["-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy",
                       "-movflags", "+faststart", str(output)])
        finally:
            listing.unlink(missing_ok=True)
        return output

    def _run(self, args: list[str]) -> None:
        completed = subprocess.run(
            [self._executable, *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
        )
        if completed.returncode:
            raise RuntimeError(
                completed.stderr.strip() or "FFmpeg falhou ao renderizar a história."
            )
