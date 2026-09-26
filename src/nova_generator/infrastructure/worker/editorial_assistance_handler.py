from __future__ import annotations

from dataclasses import asdict
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.editorial_assistance import (
    RunEditorialAssistance,
    load_persisted_editorial_preparation,
    persist_editorial_preparation,
)
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.worker.persistent_worker import JobExecution


class EditorialAssistanceJobHandler:
    def __init__(
        self, use_case: RunEditorialAssistance, repository: EditorialProjectRepository
    ) -> None:
        self._use_case = use_case
        self._repository = repository

    def __call__(self, job: Job, execution: JobExecution) -> dict[str, object]:
        scene_id = job.input.get("scene_id")
        input_sha256 = job.input.get("input_sha256")
        if not isinstance(scene_id, str) or not isinstance(input_sha256, str):
            raise ValueError("scene_id and input_sha256 are required")
        execution.raise_if_cancelled()
        scene_uuid = UUID(scene_id)
        result = load_persisted_editorial_preparation(
            self._repository, scene_uuid, input_sha256
        )
        if result is None:
            result = self._use_case.execute(
                scene_uuid, expected_input_sha256=input_sha256
            )
            persist_editorial_preparation(
                self._repository, result, author="editorial-assistance-worker"
            )
        return {
            "scene_id": result.scene_id,
            "input_sha256": result.input_sha256,
            "provider": result.provider,
            "model": result.model,
            "rate_limits": result.rate_limits,
            "suggestions": [asdict(item) for item in result.suggestions],
        }
