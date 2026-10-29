"""TikTok sources are standalone and ASR drafts never require editorial approval."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from nova_generator.api.routes import tiktok_media
from nova_generator.domain.jobs import Job
from nova_generator.domain.tiktok_media import MediaCaption, MediaProjectEdit
from nova_generator.infrastructure.filesystem.tiktok_media_store import (
    MediaConflict,
    MediaProjectStore,
)
from nova_generator.infrastructure.worker.tiktok_source_handler import TikTokSourceJobHandler


def _job(kind: str, project_id, video_id: str, revision: int, **kwargs) -> Job:
    return Job(
        id=uuid4(),
        kind=kind,
        status="running",
        input={"project_id": str(project_id), "video_id": video_id, "revision": revision, **kwargs},
        idempotency_key=None,
        attempt=1,
        max_attempts=2,
    )


def test_independent_source_and_transcript_preserve_editor_revision(tmp_path) -> None:
    store = MediaProjectStore(tmp_path)
    created = store.create("Música", "lyrics_video")
    linked = store.set_youtube_source(created.id, created.revision, "dQw4w9WgXcQ")
    assert linked.source_project_id is None
    assert linked.source_scene_id is None
    assert linked.source_youtube_id == "dQw4w9WgXcQ"
    caption = MediaCaption(cue_id=uuid4(), start_ms=100, end_ms=800, en="Hello!", pt="")
    job_id = uuid4()
    transcribed = store.attach_transcript(
        created.id,
        revision=linked.revision,
        video_id="dQw4w9WgXcQ",
        cut_job_id=job_id,
        captions=[caption],
    )
    assert transcribed.video_captions == [caption]
    # A retried worker may not rewrite captions that the user has since edited.
    updated = store.update(
        transcribed.id,
        MediaProjectEdit(
            revision=transcribed.revision,
            title="Música",
            format="lyrics_video",
            theme="ihub",
            slides=transcribed.slides,
            video_captions=[caption.model_copy(update={"pt": "Olá!"})],
        ),
    )
    assert (
        store.attach_transcript(
            created.id,
            revision=linked.revision,
            video_id="dQw4w9WgXcQ",
            cut_job_id=job_id,
            captions=[caption],
        )
        .video_captions[0]
        .pt
        == "Olá!"
    )
    with pytest.raises(MediaConflict):
        store.attach_transcript(
            created.id,
            revision=linked.revision,
            video_id="dQw4w9WgXcQ",
            cut_job_id=uuid4(),
            captions=[caption],
        )
    assert updated.revision == transcribed.revision + 1
    replacement = store.set_youtube_source(updated.id, updated.revision, "9bZkp7q19f0")
    assert replacement.video_captions == []
    assert replacement.source_cut_job_id is None


def test_youtube_endpoint_queues_tiktok_job_without_editorial_project(
    monkeypatch, tmp_path
) -> None:
    store = MediaProjectStore(tmp_path)
    created = store.create("Conteúdo", "lyrics_video")
    queued = []

    def enqueue(**kwargs):
        queued.append(kwargs)
        return SimpleNamespace(id=uuid4(), status="queued")

    monkeypatch.setattr(tiktok_media, "_store", lambda: store)
    monkeypatch.setattr(tiktok_media, "get_enqueue_job", lambda: SimpleNamespace(execute=enqueue))
    app = FastAPI()
    app.include_router(tiktok_media.router)
    response = TestClient(app).post(
        f"/tiktok-media/projects/{created.id}/source/youtube",
        json={"url": "https://youtu.be/dQw4w9WgXcQ", "revision": created.revision},
    )
    assert response.status_code == 202
    assert response.json()["project"]["source_youtube_id"] == "dQw4w9WgXcQ"
    assert response.json()["project"]["source_project_id"] is None
    assert queued[0]["kind"] == "tiktok.download"
    assert queued[0]["input"]["project_id"] == str(created.id)
    assert (
        TestClient(app)
        .put(
            f"/tiktok-media/projects/{created.id}",
            json={
                "title": "Conteúdo",
                "revision": 2,
                "format": "lyrics_video",
                "theme": "ihub",
                "slides": [item.model_dump(mode="json") for item in created.slides],
                "source_youtube_id": "9bZkp7q19f0",
            },
        )
        .status_code
        == 422
    )


def test_independent_render_needs_valid_timing_but_no_editorial_repository() -> None:
    caption = MediaCaption(cue_id=uuid4(), start_ms=100, end_ms=900, en="Go!", pt="")
    project = tiktok_media.MediaProject(
        title="Rascunho",
        slides=[tiktok_media.MediaSlide()],
        source_youtube_id="dQw4w9WgXcQ",
        source_cut_job_id=uuid4(),
        video_captions=[caption],
    )
    tiktok_media._validate_video_captions(project, 1000)
    with pytest.raises(HTTPException, match="inglês"):
        tiktok_media._validate_video_captions(
            project.model_copy(update={"video_captions": [caption.model_copy(update={"en": ""})]}),
            1000,
        )


def test_cut_resolves_its_own_completed_job_not_an_editorial_scene(monkeypatch, tmp_path) -> None:
    store = MediaProjectStore(tmp_path)
    project = store.create("Independent", "lyrics_video")
    project = store.set_youtube_source(project.id, project.revision, "dQw4w9WgXcQ")
    job_id = uuid4()
    caption = MediaCaption(cue_id=uuid4(), start_ms=0, end_ms=500, en="Hi")
    project = store.attach_transcript(
        project.id,
        revision=project.revision,
        video_id="dQw4w9WgXcQ",
        cut_job_id=job_id,
        captions=[caption],
    )
    cut = store.directory(project.id) / "cuts" / f"{job_id}.mp4"
    cut.parent.mkdir(parents=True)
    cut.write_bytes(b"verified fixture")
    job = SimpleNamespace(
        id=job_id,
        kind="tiktok.ingest",
        status="succeeded",
        input={
            "project_id": str(project.id),
            "video_id": "dQw4w9WgXcQ",
        },
        output={"duration_ms": 2000},
    )
    monkeypatch.setattr(tiktok_media, "_store", lambda: store)
    monkeypatch.setattr(tiktok_media, "get_session_factory", lambda: None)
    monkeypatch.setattr(
        tiktok_media,
        "SqlAlchemyJobRepository",
        lambda _: SimpleNamespace(get=lambda _: job),
    )
    assert tiktok_media._video_cut(project) == (cut, 2000)


def test_ingest_attaches_asr_as_editable_captions(tmp_path) -> None:
    store = MediaProjectStore(tmp_path)
    project = store.create("Fonte", "lyrics_video")
    project = store.set_youtube_source(project.id, project.revision, "dQw4w9WgXcQ")
    source = tmp_path / "verified.mp4"
    source.write_bytes(b"source")
    metadata = SimpleNamespace(sha256="abc", duration_ms=9000)
    cache = SimpleNamespace(
        find_verified=lambda _: metadata,
        source_path=lambda _: source,
    )
    candidate = {
        "engine": "whisper",
        "model": "small",
        "language": "en",
        "cues": [
            {"start_ms": 100, "end_ms": 900, "text": "What's the point?", "words": []},
            {"start_ms": 1100, "end_ms": 1900, "text": "Let's go.", "words": []},
        ],
    }

    def ingest(job, _execution):
        assert job.input["source"] == str(source)
        assert job.input["start_ms"] == 1000
        assert job.input["end_ms"] == 5000
        assert "tiktok-media" in job.input["output"]
        return {"transcript_candidate": candidate}

    handler = TikTokSourceJobHandler(store, cache, None, ingest)
    job = _job(
        "tiktok.ingest",
        project.id,
        "dQw4w9WgXcQ",
        project.revision,
        source_sha256="abc",
        start_ms=1000,
        end_ms=5000,
        language="en",
    )
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    result = handler.ingest(job, execution)
    assert result["caption_count"] == 2
    saved = store.get(project.id)
    assert saved is not None
    assert saved.source_cut_job_id == job.id
    assert [c.en for c in saved.video_captions] == ["What's the point?", "Let's go."]
    assert all(c.pt == "" for c in saved.video_captions)
    assert saved.source_project_id is None and saved.source_scene_id is None
