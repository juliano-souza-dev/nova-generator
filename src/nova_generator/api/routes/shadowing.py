"""Shadowing API: generate, revise and approve short single-speaker cue groups."""

from __future__ import annotations

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_editorial_repository
from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.use_cases.prepare_shadowing import (
    PrepareShadowing,
    ShadowingError,
)
from nova_generator.core.settings import get_settings

router = APIRouter(prefix="/projects/{project_id}/shadowing", tags=["shadowing"])


class ApproveShadowingRequest(BaseModel):
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class EditShadowingRequest(BaseModel):
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    groups: list[list[UUID]] = Field(max_length=250)


def _service(repository: EditorialProjectRepository) -> PrepareShadowing:
    return PrepareShadowing(repository, get_settings().project_root)


def _execute(fn):
    try:
        return fn()
    except ShadowingError as error:
        detail = str(error)
        raise HTTPException(
            404 if "not found" in detail else 409, detail=detail
        ) from error


@router.get("")
def list_shadowing(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> list[dict]:
    return _execute(lambda: _service(repository).scenes(project_id))


@router.get("/{scene_id}")
def get_shadowing(
    project_id: UUID,
    scene_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(lambda: _service(repository).scene(project_id, scene_id))


@router.get("/{scene_id}/package")
def download_shadowing_package(
    project_id: UUID,
    scene_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> JSONResponse:
    package = _execute(lambda: _service(repository).package(project_id, scene_id))
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": 'attachment; filename="shadowing-ai-input.json"'},
    )


@router.post("/{scene_id}/generate")
def generate_shadowing_groq(
    project_id: UUID,
    scene_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    settings = get_settings()
    return _execute(
        lambda: _service(repository).generate_groq(
            project_id,
            scene_id,
            api_key=settings.groq_api_key,
            model=settings.groq_editorial_model,
        )
    )


@router.post("/{scene_id}/import")
async def import_shadowing_proposal(
    project_id: UUID,
    scene_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
    file: Annotated[UploadFile, File()],
) -> dict:
    contents = await file.read(1_000_001)
    if len(contents) > 1_000_000:
        raise HTTPException(413, detail="O JSON de Shadowing ultrapassa 1 MB")
    try:
        document = json.loads(contents)
    except (ValueError, UnicodeDecodeError) as error:
        raise HTTPException(422, detail="JSON de Shadowing inválido") from error
    return _execute(
        lambda: _service(repository).import_result(project_id, scene_id, document)
    )


@router.put("/{scene_id}/blocks")
def edit_shadowing_blocks(
    project_id: UUID,
    scene_id: UUID,
    payload: EditShadowingRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(
        lambda: _service(repository).edit(
            project_id,
            scene_id,
            payload.source_sha256,
            payload.plan_sha256,
            [[str(cue_id) for cue_id in group] for group in payload.groups],
        )
    )


@router.post("/{scene_id}/approval")
def approve_shadowing(
    project_id: UUID,
    scene_id: UUID,
    payload: ApproveShadowingRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(
        lambda: _service(repository).approve(
            project_id, scene_id, payload.source_sha256, payload.plan_sha256
        )
    )
