"""Shadowing API: pre-produce the exercise, then approve its current snapshot."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
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


def _execute(fn):
    try:
        return fn()
    except ShadowingError as error:
        detail = str(error)
        raise HTTPException(404 if "not found" in detail else 409, detail=detail) from error


@router.get("")
def list_shadowing(
    project_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> list[dict]:
    return _execute(lambda: PrepareShadowing(repository, get_settings().project_root).scenes(project_id))


@router.get("/{scene_id}")
def get_shadowing(
    project_id: UUID,
    scene_id: UUID,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(
        lambda: PrepareShadowing(repository, get_settings().project_root).scene(project_id, scene_id)
    )


@router.post("/{scene_id}/approval")
def approve_shadowing(
    project_id: UUID,
    scene_id: UUID,
    payload: ApproveShadowingRequest,
    repository: Annotated[EditorialProjectRepository, Depends(get_editorial_repository)],
) -> dict:
    return _execute(
        lambda: PrepareShadowing(repository, get_settings().project_root).approve(
            project_id, scene_id, payload.source_sha256
        )
    )
