"""Regression gates for independent 35–60 second Shadowing productions."""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nova_generator.application.use_cases import tiktok_shadowing
from nova_generator.domain.tiktok_media import MediaProject, MediaSlide, ShadowingClip
from nova_generator.infrastructure.worker import tiktok_media_handler


def _project(ids: list[str] | None = None) -> MediaProject:
    return MediaProject(
        title="Shadowing TikTok", format="shadowing_video", slides=[MediaSlide()],
        source_project_id=uuid4(), source_scene_id=uuid4(),
        shadowing_clip=ShadowingClip(
            source_sha256="a" * 64, plan_sha256="b" * 64,
            block_ids=ids or ["block-1", "block-2", "block-3", "block-4"],
        ),
    )


def _blocks() -> list[dict]:
    return [
        {
            "id": f"block-{index}", "start_ms": (index - 1) * 5000,
            "end_ms": (index - 1) * 5000 + 3500,
            "pause_duration_ms": 5500,
            "en": "It's all right!", "pt": "Está tudo bem!",
        }
        for index in range(1, 5)
    ]


def _plan(status: str = "approved") -> dict:
    return {
        "status": status, "source_sha256": "a" * 64,
        "plan_sha256": "b" * 64, "duration_ms": 30_000,
        "blocks": _blocks(),
    }


def test_shadowing_clip_is_versioned_and_keeps_older_productions_compatible() -> None:
    ordinary = MediaProject(title="Regular", slides=[MediaSlide()])
    assert ordinary.shadowing_clip is None
    assert MediaProject.model_validate_json(ordinary.model_dump_json()) == ordinary
    project = _project()
    assert project.shadowing_clip is not None
    assert project.shadowing_clip.block_ids == ["block-1", "block-2", "block-3", "block-4"]
    with pytest.raises(ValidationError, match="repetido"):
        ShadowingClip(source_sha256="a" * 64, plan_sha256="b" * 64, block_ids=["x", "x"])


def test_resolves_only_approved_snapshot_and_35_to_60_seconds(monkeypatch) -> None:
    plan = _plan()
    monkeypatch.setattr(
        tiktok_shadowing, "PrepareShadowing",
        lambda *_: SimpleNamespace(scene=lambda *_: plan),
    )
    monkeypatch.setattr(
        tiktok_shadowing, "get_settings", lambda: SimpleNamespace(project_root=Path(".")),
    )
    project = _project()
    blocks, duration = tiktok_shadowing.resolve_tiktok_shadowing(project, object())  # type: ignore[arg-type]
    assert [block["id"] for block in blocks] == ["block-1", "block-2", "block-3", "block-4"]
    assert duration == 36_000

    with pytest.raises(tiktok_shadowing.TikTokShadowingError, match="35 a 60"):
        tiktok_shadowing.resolve_tiktok_shadowing(_project(["block-1"]), object())  # type: ignore[arg-type]
    plan["status"] = "draft"
    with pytest.raises(tiktok_shadowing.TikTokShadowingError, match="Aprove"):
        tiktok_shadowing.resolve_tiktok_shadowing(project, object())  # type: ignore[arg-type]
    plan["status"] = "approved"
    plan["plan_sha256"] = "c" * 64
    with pytest.raises(tiktok_shadowing.TikTokShadowingError, match="alterado"):
        tiktok_shadowing.resolve_tiktok_shadowing(project, object())  # type: ignore[arg-type]


def test_ffmpeg_shadowing_preserves_original_voice_then_inserts_silent_repetition(
    monkeypatch, tmp_path: Path
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"frozen source for argument validation")
    commands: list[list[str]] = []
    monkeypatch.setattr(
        tiktok_media_handler, "_run_ffmpeg", lambda args, **_kwargs: commands.append(args)
    )
    blocks = _blocks()
    duration, digest = tiktok_media_handler._render_shadowing_source(
        _project(),
        {
            "source_video_sha256": sha256(source.read_bytes()).hexdigest(),
            "source_duration_ms": 30_000,
            "shadowing_blocks": blocks,
            "shadowing_duration_ms": 36_000,
        },
        tmp_path,
        SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None),
    )
    assert duration == [3500, 5500] * 4
    assert digest == sha256(source.read_bytes()).hexdigest()
    assert len(commands) == 9  # 4 real speech segments, 4 silent pauses, 1 concat
    assert str(source.resolve()) in commands[0]
    assert any("anullsrc" in arg for arg in commands[1])
    assert "concat" in commands[-1]
    assert "Está tudo bem!" in (tmp_path / "00-listen.ass").read_text(encoding="utf-8")
    assert "SUA VEZ" in (tmp_path / "00-repeat.ass").read_text(encoding="utf-8")
