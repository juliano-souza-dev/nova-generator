"""Resolve a reviewed package and frozen voice snapshot for the durable Story job."""

from __future__ import annotations

import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.render_story import RenderStory
from nova_generator.domain.jobs import Job
from nova_generator.domain.stories import validate_story_package
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


def make_story_render_handler(
    root: Path, renderer: RenderStory
) -> Callable[[Job, JobExecution], dict[str, Any]]:
    def handle(job: Job, execution: JobExecution) -> dict[str, Any]:
        production_id = str(job.input["production_id"])
        if str(UUID(production_id)) != production_id:
            raise ValueError("production_id inválido")
        directory = root / "stories" / production_id
        archive_path = directory / "package.zip"
        package = validate_story_package(archive_path)
        raw = job.input["voice_snapshot"]
        if not isinstance(raw, dict):
            raise ValueError("Snapshot da voz ausente")
        snapshot = VoiceProfileSnapshot(
            profile_id=UUID(str(raw["profile_id"])),
            name=str(raw["name"]),
            version=int(raw["version"]),
            model_id=str(raw["model_id"]),
            model_sha256=str(raw["model_sha256"]),
            reference_audio_sha256=raw.get("reference_audio_sha256"),
            parameters=dict(raw["parameters"]),
        )
        if snapshot.sha256 != raw.get("snapshot_sha256"):
            raise ValueError("Hash do snapshot da voz diverge")
        images: dict[str, Path] = {}
        with zipfile.ZipFile(archive_path) as archive:
            for image in package.images:
                path = directory / "review" / image.path
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.is_file():
                    path.write_bytes(archive.read(image.path))
                images[image.path] = path
        execution.raise_if_cancelled()
        execution.heartbeat()
        result = renderer.execute(
            package=package,
            images=images,
            voice=snapshot,
            output_directory=directory / "render",
        )
        execution.raise_if_cancelled()
        return {
            "production_id": production_id,
            "final_video_path": str(result.final_video_path),
            "manifest_path": str(result.manifest_path),
            "duration_ms": result.duration_ms,
        }

    return handle
