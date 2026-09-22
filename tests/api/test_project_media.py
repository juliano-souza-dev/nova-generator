from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID

from nova_generator.api.dependencies import get_session_factory
from nova_generator.core.settings import get_settings
from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.infrastructure.database.job_repository import SqlAlchemyJobRepository
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache


def _verified_source(tmp_path, project_id: str):
    video = YoutubeVideo("dQw4w9WgXcQ")
    cache = FileYoutubeMediaCache(tmp_path / "media")
    source = cache.source_path(video)
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"verified-video")
    digest = sha256(source.read_bytes()).hexdigest()
    now = datetime.now(UTC)
    cache.save_verified(
        YoutubeMediaMetadata(
            video=video,
            source_file="source.mp4",
            sha256=digest,
            size_bytes=source.stat().st_size,
            duration_ms=90_000,
            video_codec="h264",
            audio_codec="aac",
            source_url=video.canonical_url,
            created_at_utc=now,
            last_used_at_utc=now,
            use_count=1,
        )
    )
    return source, digest


def test_project_media_scopes_source_cut_and_candidate(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_GENERATOR_MEDIA_CACHE_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("NOVA_GENERATOR_PROJECT_ROOT", str(tmp_path / "projects"))
    get_settings.cache_clear()
    project = client.post(
        "/api/projects",
        json={
            "title": "Lesson",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
        },
    ).json()
    project_id = project["id"]
    base = f"/api/projects/{project_id}/media"
    assert client.get(base).json()["source_ready"] is False
    assert client.post(f"{base}/ingest", json={"start_ms": 0, "end_ms": 1000}).status_code == 422
    source, digest = _verified_source(tmp_path, project_id)
    snapshot = client.get(base).json()
    assert snapshot["source_ready"] is True
    assert snapshot["duration_ms"] == 90_000
    assert client.get(snapshot["source_url"]).content == source.read_bytes()
    assert client.post(f"{base}/ingest", json={"start_ms": 0, "end_ms": 91_000}).status_code == 422

    queued = client.post(
        f"{base}/ingest", json={"start_ms": 1000, "end_ms": 5000, "language": "en"}
    )
    assert queued.status_code == 202
    job_id = queued.json()["id"]
    jobs = SqlAlchemyJobRepository(get_session_factory())
    job = jobs.get(job_id)
    assert job and job.input == {
        "project_id": project_id,
        "video_id": "dQw4w9WgXcQ",
        "source_sha256": digest,
        "start_ms": 1000,
        "end_ms": 5000,
        "language": "en",
    }
    assert client.post(f"{base}/ingest", json={"start_ms": 0, "end_ms": 2000}).status_code == 409
    claimed = jobs.claim_next(worker_id="test-worker", now=datetime.now(UTC))
    assert claimed and str(claimed.id) == job_id
    cut = tmp_path / "projects" / project_id / "cuts" / f"{job_id}.mp4"
    cut.parent.mkdir(parents=True, exist_ok=True)
    cut.write_bytes(b"project-cut")
    assert jobs.succeed(
        job_id=job_id,
        worker_id="test-worker",
        now=datetime.now(UTC),
        output={
            "project_id": project_id,
            "video_id": "dQw4w9WgXcQ",
            "source_sha256": digest,
            "start_ms": 1000,
            "end_ms": 5000,
            "duration_ms": 4000,
            "waveform": {"sample_rate_hz": 8000, "bucket_ms": 40, "peaks": [0.2]},
            "transcript_candidate": {
                "engine": "faster-whisper",
                "model": "small",
                "language": "en",
                "cues": [],
            },
        },
    )
    snapshot = client.get(base).json()
    assert snapshot["ingest_job_id"] == job_id
    assert snapshot["waveform"]["peaks"] == [0.2]
    assert snapshot["transcript_candidate"]["engine"] == "faster-whisper"
    assert client.get(snapshot["cut_url"]).content == b"project-cut"
    other = client.post("/api/projects", json={"title": "Other"}).json()
    assert client.get(f"/api/projects/{other['id']}/media/cuts/{job_id}").status_code == 404
    assert client.get(f"{base}/cuts/{UUID(int=0)}").status_code == 404


def test_download_job_uses_project_identity(client):
    project = client.post(
        "/api/projects",
        json={
            "title": "Lesson",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
        },
    ).json()
    base = f"/api/projects/{project['id']}/media"
    queued = client.post(f"{base}/download")
    assert queued.status_code == 202
    assert client.post(f"{base}/download").json()["id"] == queued.json()["id"]
    assert client.get(base).json()["download_status"] == "queued"
