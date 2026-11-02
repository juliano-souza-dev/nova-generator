"""Quick FFmpeg smoke for the new animated-background/ASS combination."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from nova_generator.domain.tiktok_media import MediaCaption, MediaCaptionStyle
from nova_generator.infrastructure.exports.tiktok_captions import render_ass


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg indisponível")
def test_aurora_subtitles_and_outro_are_renderable_by_ffmpeg(tmp_path: Path) -> None:
    caption = MediaCaption(
        cue_id=uuid4(), start_ms=0, end_ms=700,
        en="Count on me", pt="Conte comigo", note="Count on: confiar em alguém",
    )
    (tmp_path / "captions.ass").write_text(
        render_ass(
            [caption], MediaCaptionStyle(template="handwriting", position="center"),
            paper_theme="aurora", outro=(700, 1000),
        ),
        encoding="utf-8",
    )
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "gradients=s=180x320:r=10:c0=0x0B1732:c1=0x21577B:"
        "c2=0x593B7A:n=3:t=spiral:speed=0.003:d=1",
        "-vf", "setsar=1,vignette=PI/7,ass=captions.ass,format=yuv420p",
        "-frames:v", "10", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "final.mp4",
    ]
    result = subprocess.run(
        command, cwd=tmp_path, capture_output=True, text=True, check=False, timeout=40
    )
    assert result.returncode == 0, result.stderr[-2500:]
    assert (tmp_path / "final.mp4").stat().st_size > 500
