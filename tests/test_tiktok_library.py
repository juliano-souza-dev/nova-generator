"""Completed videos remain discoverable independently of the editor's transient job state."""

import json
from uuid import uuid4

from nova_generator.infrastructure.filesystem.tiktok_media_library import (
    list_completed_tiktok_videos,
)
from nova_generator.infrastructure.filesystem.tiktok_media_store import MediaProjectStore


def _render(root, project, *, complete=True, valid_video=True, title="SEE, LOOK e WATCH 🎬"):
    render_id = uuid4()
    directory = root / "tiktok-media" / str(project.id) / "renders" / str(render_id)
    directory.mkdir(parents=True)
    (directory / "snapshot.json").write_text(
        json.dumps({"project": {"title": title, "format": "lesson_video"}}, ensure_ascii=False),
        encoding="utf-8",
    )
    (directory / "final.mp4").write_bytes(
        b"\x00\x00\x00\x18ftypisom" + b"video" if valid_video else b"broken"
    )
    if complete:
        (directory / "manifest.json").write_text(
            json.dumps(
                {
                    "contract": "nova-tiktok-media-render/1",
                    "project_id": str(project.id),
                    "render_id": str(render_id),
                    "duration_ms": 52_000,
                    "video_sha256": "a" * 64,
                    "visual_mode": "slides",
                }
            ),
            encoding="utf-8",
        )
    return render_id, directory


def test_library_recovers_every_completed_render_after_reopening_store(tmp_path):
    project = MediaProjectStore(tmp_path).create("Microaula", "lesson_video")
    first, _ = _render(tmp_path, project)
    second, _ = _render(tmp_path, project, title="Nova versão")
    videos = list_completed_tiktok_videos(tmp_path)
    assert {item["render_id"] for item in videos} == {str(first), str(second)}
    assert next(item for item in videos if item["render_id"] == str(first))["title"] == (
        "SEE, LOOK e WATCH 🎬"
    )
    assert all(item["duration_ms"] == 52_000 for item in videos)
    assert all(item["size_bytes"] > 12 for item in videos)
    # No in-memory render/job IDs are needed after a restart.
    assert list_completed_tiktok_videos(tmp_path) == videos


def test_library_never_shows_incomplete_or_missing_media(tmp_path):
    project = MediaProjectStore(tmp_path).create("Aula", "lesson_video")
    good, _ = _render(tmp_path, project)
    _, incomplete = _render(tmp_path, project, complete=False)
    _, invalid = _render(tmp_path, project, valid_video=False)
    _, missing = _render(tmp_path, project)
    (missing / "final.mp4").unlink()
    result = list_completed_tiktok_videos(tmp_path)
    assert [item["render_id"] for item in result] == [str(good)]
    assert (incomplete / "snapshot.json").is_file()
    assert (invalid / "manifest.json").is_file()


def test_library_rejects_tampered_or_foreign_manifest(tmp_path):
    project = MediaProjectStore(tmp_path).create("Aula", "lesson_video")
    _, directory = _render(tmp_path, project)
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["project_id"] = str(uuid4())
    path.write_text(json.dumps(manifest), encoding="utf-8")
    assert list_completed_tiktok_videos(tmp_path) == []
