"""External AI workbook content, Anki explanations and explicit material approval."""

from __future__ import annotations

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_editorial_repository
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.core.settings import get_settings

router = APIRouter(prefix="/projects/{project_id}/materials-ai", tags=["materials-ai"])


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


class AnkiCardEditRequest(BaseModel):
    expected_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    card: dict


@router.put("/anki/{scene_id}/cards/{card_id}")
def update_anki_card(
    project_id: UUID,
    scene_id: UUID,
    card_id: UUID,
    payload: AnkiCardEditRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(
        lambda: _exchange(repository).update_anki_card(
            project_id, scene_id, card_id, payload.card,
            expected_sha256=payload.expected_sha256,
        )
    )


@router.post("/approval")
def approve_external_materials(
    project_id: UUID,
    payload: ApproveMaterialRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(lambda: _exchange(repository).approve(project_id, payload.source_sha256))
