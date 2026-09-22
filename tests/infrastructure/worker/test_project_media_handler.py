from datetime import UTC, datetime
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from nova_generator.api.dependencies import get_session_factory
from nova_generator.domain.jobs import Job
from nova_generator.domain.media.cache import YoutubeMediaMetadata
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.projects.entities import Project
from nova_generator.infrastructure.database.editorial_project_repository import (
    SqlAlchemyEditorialProjectRepository,
)
from nova_generator.infrastructure.filesystem.youtube_media_cache import FileYoutubeMediaCache
from nova_generator.infrastructure.worker.project_media_handler import ProjectMediaJobHandler


def test_ingest_worker_derives_project_paths_and_rejects_changed_source(client, tmp_path):
    repository = SqlAlchemyEditorialProjectRepository(get_session_factory())
    project_id = uuid4()
    video = YoutubeVideo("dQw4w9WgXcQ")
    repository.save_project(
        Project(
            project_id,
            "Lesson",
            "dialogue",
            {
                "youtube_video_id": video.video_id,
            },
        )
    )
    cache = FileYoutubeMediaCache(tmp_path / "cache")
    source = cache.source_path(video)
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"source")
    digest = sha256(source.read_bytes()).hexdigest()
    now = datetime.now(UTC)
    cache.save_verified(
        YoutubeMediaMetadata(
            video=video,
            source_file="source.mp4",
            sha256=digest,
            size_bytes=source.stat().st_size,
            duration_ms=8000,
            video_codec="h264",
            audio_codec="aac",
            created_at_utc=now,
            last_used_at_utc=now,
        )
    )
    captured = []

    def ingest(job, _execution):
        captured.append(job.input)
        return {
            "cut_file": job.input["output"],
            "waveform": {"peaks": [0.5]},
            "transcript_candidate": {"cues": []},
        }

    handler = ProjectMediaJobHandler(repository, cache, Mock(), ingest, tmp_path / "projects")
    job = Job(
        uuid4(),
        "ingest_scene_media",
        "queued",
        {
            "project_id": str(project_id),
            "video_id": video.video_id,
            "source_sha256": digest,
            "start_ms": 100,
            "end_ms": 5100,
            "source": "C:/untrusted.mp4",
            "output": "C:/untrusted-output.mp4",
        },
        None,
        0,
        3,
    )
    execution = SimpleNamespace(raise_if_cancelled=lambda: None, heartbeat=lambda: None)
    output = handler.ingest(job, execution)
    assert captured[0]["source"] == str(source)
    assert captured[0]["output"] == str(
        tmp_path / "projects" / str(project_id) / "cuts" / f"{job.id}.mp4"
    )
    assert "cut_file" not in output
    assert output["start_ms"] == 100 and output["duration_ms"] == 5000

    source.write_bytes(b"changed")
    with pytest.raises(ValueError, match="verified project source changed"):
        handler.ingest(job, execution)
