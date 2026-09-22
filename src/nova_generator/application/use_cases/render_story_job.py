from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from nova_generator.application.use_cases.render_story import RenderStory
from nova_generator.domain.jobs import Job
from nova_generator.domain.stories import StoryPackage
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.worker.persistent_worker import JobExecution

StoryProductionResolver = Callable[
    [str], tuple[StoryPackage, dict[str, Path], VoiceProfileSnapshot, Path]
]


class RenderStoryJob:
    """Worker handler for one production; RenderStory itself re-renders only stale cues."""

    kind = "story.render"

    def __init__(self, resolver: StoryProductionResolver, renderer: RenderStory) -> None:
        self._resolver, self._renderer = resolver, renderer

    def __call__(self, job: Job, execution: JobExecution) -> dict[str, object]:
        production_id = job.input.get("production_id")
        if not isinstance(production_id, str) or not production_id:
            raise ValueError("story.render requer input.production_id.")
        execution.raise_if_cancelled()
        package, images, voice, output_directory = self._resolver(production_id)
        execution.heartbeat()
        result = self._renderer.execute(
            package=package, images=images, voice=voice, output_directory=output_directory
        )
        execution.raise_if_cancelled()
        return {
            "production_id": production_id,
            "final_video_path": str(result.final_video_path),
            "manifest_path": str(result.manifest_path),
            "duration_ms": result.duration_ms,
            "cue_count": len(result.cues),
        }


