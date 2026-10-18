"""External AI workbook content, Anki explanations and explicit material approval."""

from __future__ import annotations

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_editorial_repository, get_enqueue_job
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.manage_jobs import EnqueueJob
from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.core.settings import get_settings

router = APIRouter(prefix="/projects/{project_id}/materials-ai", tags=["materials-ai"])


class MaterialGenerationResponse(BaseModel):
    job_id: UUID
    status: str


class ApproveMaterialRequest(BaseModel):
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


def _exchange(repository: EditorialProjectRepository) -> MaterialsAiExchange:
    return MaterialsAiExchange(repository, get_settings().project_root)


def _execute(action):
    try:
        return action()
    except MaterialsAiError as error:
        detail = str(error)
        raise HTTPException(404 if "not found" in detail else 409, detail=detail) from error


@router.get("/package")
def download_external_material_package(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> JSONResponse:
    data = _execute(lambda: _exchange(repository).package(project_id))
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": 'attachment; filename="nova-materials-input.json"'},
    )


@router.get("/review")
def materials_review(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(lambda: _exchange(repository).status(project_id))


@router.post("/import")
async def import_external_materials(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
    file: Annotated[UploadFile, File()],
) -> dict:
    content = await file.read(3_000_001)
    if len(content) > 3_000_000:
        raise HTTPException(413, detail="material response exceeds 3 MB")
    try:
        document = json.loads(content)
    except (ValueError, UnicodeDecodeError) as error:
        raise HTTPException(422, detail="invalid UTF-8 JSON") from error
    return _execute(lambda: _exchange(repository).import_result(project_id, document))


@router.post("/approval")
def approve_external_materials(
    project_id: UUID,
    payload: ApproveMaterialRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(lambda: _exchange(repository).approve(project_id, payload.source_sha256))


@router.post("/generate", response_model=MaterialGenerationResponse, status_code=status.HTTP_202_ACCEPTED)
def generate_pedagogical_materials(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
    enqueue: Annotated[EnqueueJob, Depends(get_enqueue_job)],
) -> MaterialGenerationResponse:
    """Generate real pedagogical content as a tracked background job."""
    if not get_settings().groq_api_key:
        raise HTTPException(
            409,
            detail="Groq não configurada. Configure a chave ou importe o JSON de IA externa.",
        )
    package = _execute(lambda: _exchange(repository).package(project_id))
    selected = [
        str(cue.id)
        for scene in repository.get_project_scenes(project_id)
        for cue in sorted(repository.get_scene_cues(scene.id), key=lambda item: item.order)
        if cue.provenance.get("anki_included") is not False
    ]
    if not selected:
        raise HTTPException(422, detail="Selecione ao menos um card Anki.")
    job = enqueue.execute(
        kind="generate_pedagogical_materials",
        input={
            "project_id": str(project_id),
            "source_sha256": package["source_sha256"],
            "selected_cue_ids": selected,
        },
        idempotency_key=None,
    )
    return MaterialGenerationResponse(job_id=job.id, status=job.status)
