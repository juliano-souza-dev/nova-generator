"""Animated TikTok scenes keep backward compatibility and render deterministic motion."""

import struct
import zlib
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nova_generator.api.routes.tiktok_media import _valid_scene_png
from nova_generator.domain.tiktok_media import MediaProject, MediaSlide, new_media_project
from nova_generator.infrastructure.filesystem.tiktok_media_store import (
    MediaConflict,
    MediaProjectStore,
)
from nova_generator.infrastructure.worker.tiktok_media_handler import _slide_motion_filter


def test_animated_project_is_additive_and_older_projects_remain_static():
    previous = new_media_project("Aula", "lesson_video")
    animated = new_media_project("Palavras em contexto", "lesson_video", animated_scenes=True)
    assert previous.animated_scenes is False
    assert previous.slides[0].motion == "still"
    assert animated.animated_scenes is True
    assert animated.slides[0].motion == "zoom_in"
    restored = MediaProject.model_validate_json(animated.model_dump_json())
    assert restored == animated


def test_animated_slide_rejects_invalid_camera_preset_and_file_path():
    with pytest.raises(ValidationError):
        MediaSlide(motion="rotation")
    with pytest.raises(ValidationError):
        MediaSlide(background_image="../outside.png")


def test_image_upload_is_revision_safe_and_scoped_to_slide(tmp_path):
    store = MediaProjectStore(tmp_path)
    project = store.create("Aula", "lesson_video", animated_scenes=True)
    other = store.create("Outro", "lesson_video")
    slide_id = project.slides[0].id
    updated = store.set_slide_image(
        project.id, revision=project.revision, slide_id=slide_id, content=b"png-bytes"
    )
    filename = updated.slides[0].background_image
    assert filename is not None and filename.endswith(".png")
    assert (store.directory(project.id) / "assets" / filename).read_bytes() == b"png-bytes"
    assert updated.revision == project.revision + 1
    assert store.get(other.id) == other
    with pytest.raises(MediaConflict):
        store.set_slide_image(
            project.id, revision=project.revision, slide_id=slide_id, content=b"stale"
        )
    with pytest.raises(ValueError):
        store.set_slide_image(
            project.id, revision=updated.revision, slide_id=str(uuid4()), content=b"wrong"
        )
    replacement = store.set_slide_image(
        project.id, revision=updated.revision, slide_id=slide_id, content=b"new-png"
    )
    assert not (store.directory(project.id) / "assets" / filename).exists()
    assert replacement.slides[0].background_image != filename


def test_ffmpeg_camera_presets_are_bounded_and_use_requested_resolution():
    assert _slide_motion_filter("still", 4500, 1080) == "scale=1080:1920,format=yuv420p"
    for preset in ("zoom_in", "zoom_out", "pan_left", "pan_right"):
        spec = _slide_motion_filter(preset, 5000, 720)
        assert "zoompan=" in spec
        assert "s=720x1280:fps=30" in spec
        assert "format=yuv420p" in spec
    with pytest.raises(ValueError):
        _slide_motion_filter("rotate", 3000, 720)


def test_upload_png_checks_dimensions_chunks_and_crc():
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload))
        )

    header = struct.pack(">IIBBBBB", 1080, 1920, 8, 6, 0, 0, 0)
    rows = zlib.compress((b"\x00" * (1080 * 4 + 1)) * 1920)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", rows)
        + chunk(b"IEND", b"")
    )
    assert _valid_scene_png(png)
    assert not _valid_scene_png(png[:-1])
    assert not _valid_scene_png(png[:24] + b"corrupt" + png[31:])
