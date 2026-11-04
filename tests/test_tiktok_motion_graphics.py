"""Regression tests for timed TikTok motion graphics and sound metadata."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nova_generator.domain.tiktok_media import MediaCaptionStyle, MediaProject, MediaSlide, MotionGraphic
from nova_generator.infrastructure.exports.tiktok_captions import render_ass


def test_motion_graphics_are_optional_and_round_trip_with_legacy_projects() -> None:
    legacy = MediaProject(title="Vídeo legado", slides=[MediaSlide()])
    assert legacy.motion_graphics == []
    graphic = MotionGraphic(id="confirmacao-1", start_ms=2450, duration_ms=1100,
        icon="check", label="Correct!", animation="bounce", sound="success", position="top")
    restored = MediaProject.model_validate_json(MediaProject(title="Aula", motion_graphics=[graphic]).model_dump_json())
    assert restored.motion_graphics == [graphic]


def test_motion_graphics_reject_duplicate_ids_and_invalid_duration() -> None:
    with pytest.raises(ValidationError):
        MediaProject(title="Aula", motion_graphics=[MotionGraphic(id="same", start_ms=0), MotionGraphic(id="same", start_ms=1000)])
    with pytest.raises(ValidationError):
        MotionGraphic(start_ms=0, duration_ms=100)


def test_ass_contains_timed_animated_icon_and_safe_literal_label() -> None:
    graphic = MotionGraphic(id=str(uuid4()), start_ms=1250, duration_ms=900,
        icon="check", label=r"Done {\an8}", animation="pop", sound="ding", position="center")
    ass = render_ass([], MediaCaptionStyle(), motion_graphics=[graphic])
    assert "Dialogue: 1,0:00:01.25,0:00:02.15" in ass
    assert "✓" in ass and r"\fscx30" in ass
    assert "Done ｛＼an8｝" in ass


def test_disabled_motion_graphics_are_not_rendered() -> None:
    ass = render_ass([], MediaCaptionStyle(), motion_graphics=[MotionGraphic(start_ms=0, enabled=False)])
    assert "Dialogue: 1," not in ass
