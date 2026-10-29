"""TikTok real-video render regression tests without external YouTube access."""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from nova_generator.api.routes import tiktok_media
from nova_generator.domain.tiktok_media import (
    MediaCaption,
    MediaCaptionStyle,
    MediaProject,
    MediaProjectEdit,
    MediaSlide,
)
from nova_generator.infrastructure.exports.tiktok_captions import render_ass
from nova_generator.infrastructure.filesystem.tiktok_media_store import MediaProjectStore
from nova_generator.infrastructure.worker import tiktok_media_handler


def _caption(start: int = 1200, end: int = 2700) -> MediaCaption:
    return MediaCaption(
        cue_id=uuid4(),
        start_ms=start,
        end_ms=end,
        en="This doesn't bother you, does it?",
        pt="Isso não te incomoda, né?",
        highlight="doesn't bother you",
    )


def test_video_fields_default_without_changing_legacy_projects() -> None:
    project = MediaProject(title="Primeiro carrossel", slides=[MediaSlide(en="Hi", pt="Oi")])
    restored = MediaProject.model_validate_json(project.model_dump_json())
    assert restored.source_scene_id is None
    assert restored.video_captions == []
    assert restored.caption_style == MediaCaptionStyle()
    assert project.contract == "nova-tiktok-media/1"

    with pytest.raises(ValidationError):
        MediaCaption(cue_id=uuid4(), start_ms=1800, end_ms=1800, en="Hi", pt="Oi")


def test_duplicate_cue_ids_and_invalid_color_are_rejected() -> None:
    caption = _caption()
    with pytest.raises(ValidationError):
        MediaProject(
            title="Legenda duplicada",
            slides=[MediaSlide()],
            video_captions=[caption, caption.model_copy()],
        )
    with pytest.raises(ValidationError):
        MediaCaptionStyle(text_color="#ff0000;ass=evil")


def test_caption_style_and_cues_round_trip_in_edit() -> None:
    caption = _caption()
    project = MediaProject(
        title="Lyrics",
        slides=[MediaSlide()],
        source_project_id=uuid4(),
        source_scene_id=uuid4(),
        video_captions=[caption],
        caption_style=MediaCaptionStyle(template="impact", position="center", animation="pop"),
    )
    edit = MediaProjectEdit.model_validate(
        {
            "title": project.title,
            "format": project.format,
            "theme": project.theme,
            "revision": project.revision,
            "source_project_id": project.source_project_id,
            "source_scene_id": project.source_scene_id,
            "slides": project.slides,
            "video_captions": project.video_captions,
            "caption_style": project.caption_style,
        }
    )
    assert edit.video_captions[0].en == caption.en
    assert edit.caption_style.animation == "pop"


def test_older_client_update_keeps_captions_and_source(tmp_path: Path) -> None:
    store = MediaProjectStore(tmp_path)
    created = store.create("Projeto antigo", "lyrics_video")
    source_project, scene_id, caption = uuid4(), uuid4(), _caption()
    store.update(
        created.id,
        MediaProjectEdit(
            revision=created.revision, title=created.title,
            format=created.format, theme=created.theme, slides=created.slides,
            source_project_id=source_project, source_scene_id=scene_id,
            video_captions=[caption],
        ),
    )
    current = store.get(created.id)
    assert current is not None
    legacy_edit = MediaProjectEdit(
        revision=current.revision, title="Renomeado", format=current.format,
        theme=current.theme, slides=current.slides,
    )
    changed = store.update(current.id, legacy_edit)
    assert changed.source_scene_id == scene_id
    assert changed.source_project_id == source_project
    assert changed.video_captions == [caption]


def test_ass_uses_cut_relative_timing_unicode_and_literal_escape() -> None:
    first = _caption(1200, 2700)
    second = MediaCaption(
        cue_id=uuid4(),
        start_ms=3400,
        end_ms=5000,
        en=r"Hello {\pos(0,0)}!",
        pt="Olá, coração!",
    )
    ass = render_ass([second, first], MediaCaptionStyle(template="karaoke"))
    assert "Dialogue: 0,0:00:01.20,0:00:02.70" in ass
    assert "Dialogue: 0,0:00:03.40,0:00:05.00" in ass
    assert "Isso não te incomoda, né?" in ass
    assert "{\\pos(0,0)}" not in ass
    assert "\uff5b" in ass
    assert "\\c&H" in ass


def test_music_mode_highlights_words_in_time_and_preserves_translation() -> None:
    caption = MediaCaption(
        cue_id=uuid4(),
        start_ms=1000,
        end_ms=2500,
        en="I'll be there!  Você também?",
        pt="Estarei lá!",
    )
    karaoke = render_ass([caption], MediaCaptionStyle(template="karaoke", position="center"))
    dialogue = karaoke.split("Dialogue: ", 1)[1]
    assert len(re.findall(r"\\kf\d+", dialogue)) == 5
    assert sum(map(int, re.findall(r"\\kf(\d+)", dialogue))) == 150
    without_karaoke_tags = re.sub(r"\{\\kf\d+\}", "", dialogue)
    assert "I'll" in without_karaoke_tags and "Você também?" in without_karaoke_tags
    assert "Estarei lá!" in dialogue
    assert "\\fs61" in dialogue  # Translation is smaller in music mode.
    assert "\\kf" not in render_ass([caption], MediaCaptionStyle(template="clean"))


def test_approved_caption_validation_checks_ownership_gaps_and_cut_bounds(monkeypatch) -> None:
    scene_id = uuid4()
    caption1 = _caption(1200, 2700)
    caption2 = _caption(3000, 4000)
    source_cues = [
        SimpleNamespace(
            id=caption.cue_id,
            approved_en=caption.en,
            approved_pt=caption.pt,
            provenance={"approval": "approved"},
        )
        for caption in (caption1, caption2)
    ]
    fake_repo = SimpleNamespace(get_scene_cues=lambda _scene_id: source_cues)
    monkeypatch.setattr(tiktok_media, "SqlAlchemyEditorialProjectRepository", lambda _: fake_repo)
    monkeypatch.setattr(tiktok_media, "get_session_factory", lambda: None)
    project = MediaProject(
        title="Legenda aprovada",
        slides=[MediaSlide()],
        source_scene_id=scene_id,
        video_captions=[caption1, caption2],
    )
    tiktok_media._validate_video_captions(project, 5500)
    with pytest.raises(HTTPException) as outside:
        tiktok_media._validate_video_captions(project, 3500)
    assert outside.value.status_code == 422
    crossing = project.model_copy(
        update={"video_captions": [caption1, caption2.model_copy(update={"start_ms": 2600})]}
    )
    with pytest.raises(HTTPException) as overlapping:
        tiktok_media._validate_video_captions(crossing, 5500)
    assert overlapping.value.status_code == 422


def test_source_cut_uses_scene_ingest_job_not_latest(monkeypatch, tmp_path: Path) -> None:
    project_id, scene_id, ingest_id = uuid4(), uuid4(), uuid4()
    project = MediaProject(
        title="Corte",
        slides=[MediaSlide()],
        source_project_id=project_id,
        source_scene_id=scene_id,
    )
    cut = tmp_path / str(project_id) / "cuts" / f"{ingest_id}.mp4"
    cut.parent.mkdir(parents=True)
    cut.write_bytes(b"fake test cut")
    scene = SimpleNamespace(id=scene_id, provenance={"ingest_job_id": str(ingest_id)})
    repository = SimpleNamespace(
        get_project_scenes=lambda pid: [scene] if pid == project_id else []
    )
    job = SimpleNamespace(
        kind="ingest_scene_media",
        status="succeeded",
        input={"project_id": str(project_id)},
        output={"duration_ms": 5000},
    )
    jobs = SimpleNamespace(get=lambda jid: job if jid == str(ingest_id) else None)
    monkeypatch.setattr(tiktok_media, "SqlAlchemyEditorialProjectRepository", lambda _: repository)
    monkeypatch.setattr(tiktok_media, "SqlAlchemyJobRepository", lambda _: jobs)
    monkeypatch.setattr(tiktok_media, "get_session_factory", lambda: None)
    monkeypatch.setattr(
        tiktok_media, "get_settings", lambda: SimpleNamespace(project_root=tmp_path)
    )
    assert tiktok_media._video_cut(project) == (cut, 5000)


def test_video_worker_verifies_source_digest_before_running_ffmpeg(monkeypatch, tmp_path) -> None:
    caption = _caption(150, 650)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not a real clip, but hash-verified")
    project = MediaProject(
        title="Video",
        slides=[MediaSlide()],
        video_captions=[caption],
    )
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    commands = []
    monkeypatch.setattr(
        tiktok_media_handler, "_run_ffmpeg", lambda args, **kw: commands.append((args, kw))
    )
    with pytest.raises(ValueError, match="mudou"):
        tiktok_media_handler._render_video_source(
            project,
            {"source_video_sha256": "0" * 64, "source_duration_ms": 1000},
            tmp_path,
            tmp_path / "other.wav",
            execution,
        )
    digest = sha256(source.read_bytes()).hexdigest()
    duration, verified = tiktok_media_handler._render_video_source(
        project,
        {"source_video_sha256": digest, "source_duration_ms": 1000, "audio_mode": "original"},
        tmp_path,
        tmp_path / "other.wav",
        execution,
    )
    assert duration == [1000]
    assert verified == digest
    assert "ass=captions.ass" in " ".join(commands[0][0])
    assert "0:a:0?" in commands[0][0]
    assert (tmp_path / "captions.ass").is_file()


def test_queued_video_is_blocked_if_cue_returns_to_draft_before_or_during_render(
    monkeypatch, tmp_path: Path
) -> None:
    project_id, scene_id, render_id = uuid4(), uuid4(), uuid4()
    caption = _caption(1200, 2500)
    project = MediaProject(
        title="Review again",
        slides=[MediaSlide()],
        source_project_id=project_id,
        source_scene_id=scene_id,
        video_captions=[caption],
    )
    state = {"approval": "approved"}
    source_cue = SimpleNamespace(
        scene_id=scene_id, approved_en="Original English", approved_pt="Português",
        provenance=state,
    )
    repository = SimpleNamespace(
        get_scene_project_id=lambda _scene: project_id,
        get_cue=lambda cue_id: source_cue if cue_id == caption.cue_id else None,
    )
    snapshot_dir = tmp_path / "tiktok-media" / str(project.id) / "renders" / str(render_id)
    snapshot_dir.mkdir(parents=True)
    source = snapshot_dir / "source.mp4"
    source.write_bytes(b"immutable scene cut")
    payload = {
        "project": project.model_dump(mode="json"),
        "visual_mode": "video_source", "audio_mode": "silent",
        "source_video_sha256": sha256(source.read_bytes()).hexdigest(),
        "source_duration_ms": 5000,
    }
    content = json.dumps(payload).encode()
    (snapshot_dir / "snapshot.json").write_bytes(content)
    job = SimpleNamespace(
        input={"project_id": str(project.id), "render_id": str(render_id),
               "snapshot_sha256": sha256(content).hexdigest()}
    )
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    monkeypatch.setattr(
        tiktok_media_handler, "get_settings", lambda: SimpleNamespace(media_cache_root=tmp_path)
    )
    render_calls = []

    def fake_render(arguments, **kwargs):
        render_calls.append(arguments)
        (snapshot_dir / "final.mp4").write_bytes(b"video not yet published")

    monkeypatch.setattr(tiktok_media_handler, "_run_ffmpeg", fake_render)
    handler = tiktok_media_handler.make_media_render_handler(None, repository)

    state["approval"] = "draft"  # Editorial rollback after enqueue, before job starts.
    with pytest.raises(ValueError, match="voltou a rascunho"):
        handler(job, execution)
    assert not render_calls

    state["approval"] = "approved"

    def rollback_during_ffmpeg(arguments, **kwargs):
        fake_render(arguments, **kwargs)
        state["approval"] = "draft"

    monkeypatch.setattr(tiktok_media_handler, "_run_ffmpeg", rollback_during_ffmpeg)
    with pytest.raises(ValueError, match="voltou a rascunho"):
        handler(job, execution)
    assert len(render_calls) == 1
    assert not (snapshot_dir / "manifest.json").exists()


def test_http_render_video_mode_accepts_no_slide_images_and_freezes_cut(
    monkeypatch, tmp_path: Path
) -> None:
    project = MediaProject(
        title="Video lyric", format="lyrics_video", slides=[MediaSlide()],
        source_project_id=uuid4(), source_scene_id=uuid4(), video_captions=[_caption()],
    )
    source = tmp_path / "original-cut.mp4"
    source.write_bytes(b"previously approved generator cut")
    expected_hash = sha256(source.read_bytes()).hexdigest()
    job_id = uuid4()
    store = SimpleNamespace(directory=lambda pid: tmp_path / str(pid))
    monkeypatch.setattr(tiktok_media, "_get", lambda _: project)
    monkeypatch.setattr(tiktok_media, "_store", lambda: store)
    monkeypatch.setattr(tiktok_media, "_video_cut", lambda _: (source, 5000))
    monkeypatch.setattr(tiktok_media, "_validate_video_captions", lambda *args: None)
    monkeypatch.setattr(tiktok_media, "_has_original_audio", lambda _: True)
    monkeypatch.setattr(
        tiktok_media, "get_enqueue_job",
        lambda: SimpleNamespace(
            execute=lambda **kwargs: SimpleNamespace(id=job_id, status="queued")
        ),
    )
    app = FastAPI()
    app.include_router(tiktok_media.router)
    result = TestClient(app).post(
        f"/tiktok-media/projects/{project.id}/render",
        data={
            "revision": project.revision,
            "visual_mode": "video_source",
            "audio_mode": "original",
        },
    )
    assert result.status_code == 202, result.text
    snapshot_dir = store.directory(project.id) / "renders" / result.json()["render_id"]
    payload = json.loads((snapshot_dir / "snapshot.json").read_text())
    assert payload["visual_mode"] == "video_source"
    assert payload["source_video_sha256"] == expected_hash
    assert payload["project"]["video_captions"][0]["start_ms"] == 1200
    assert (snapshot_dir / "source.mp4").read_bytes() == source.read_bytes()


def test_visual_effects_export_ass_tags_and_keep_literal_captions() -> None:
    caption = MediaCaption(
        cue_id=uuid4(), start_ms=1000, end_ms=3500,
        en="We could make it work!", pt="Podemos fazer isso dar certo!"
    )
    for name in ("handwriting", "neon", "popstar", "cinema"):
        ass = render_ass([caption], MediaCaptionStyle(template=name))
        assert "We could make it work!" in ass
        assert "Podemos fazer isso dar certo!" in ass
        assert "Dialogue: 0,0:00:01.00,0:00:03.50" in ass
        if name == "handwriting":
            assert r"\clip(" in ass
            assert r"\move(" in ass
            assert "✎" in ass
            assert ass.count("Dialogue: ") >= 3
        if name == "neon":
            assert r"\blur4" in ass
        if name == "popstar":
            assert r"\frz-3" in ass
        if name == "cinema":
            assert r"\fsp2" in ass


def test_new_styles_round_trip_without_migrating_old_projects() -> None:
    for name in ("handwriting", "neon", "popstar", "cinema"):
        project = MediaProject(
            title="Teste", slides=[MediaSlide()],
            caption_style=MediaCaptionStyle(template=name)
        )
        assert MediaProject.model_validate_json(
            project.model_dump_json()
        ).caption_style.template == name
