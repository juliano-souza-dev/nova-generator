from __future__ import annotations

from uuid import UUID

from nova_generator.application.use_cases.editorial_assistance import RunEditorialAssistance
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


class EditorialAssistanceJobHandler:
    def __init__(self, use_case: RunEditorialAssistance) -> None:
        self._use_case = use_case

    def __call__(self, job: Job, execution: JobExecution) -> dict[str, object]:
        scene_id = job.input.get("scene_id")
        if not isinstance(scene_id, str):
            raise ValueError("scene_id is required")
        execution.raise_if_cancelled()
        result = self._use_case.execute(UUID(scene_id))
        return {
            "scene_id": result.scene_id,
            "input_sha256": result.input_sha256,
            "provider": result.provider,
            "model": result.model,
            "rate_limits": result.rate_limits,
            "suggestions": [item.__dict__ for item in result.suggestions],
        }
