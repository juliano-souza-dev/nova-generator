from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from nova_generator.api.dependencies import get_inspect_youtube_source, get_manage_projects
from nova_generator.application.ports.youtube_metadata_inspector import YoutubeSourceUnavailable
from nova_generator.application.use_cases.inspect_youtube_source import InspectYoutubeSource
from nova_generator.application.use_cases.manage_projects import (
    ManagedProject,
    ManageProjects,
    ProjectCommandError,
)
from nova_generator.domain.media.youtube import InvalidYoutubeUrl

router = APIRouter(prefix="/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    content_type: str = Field(default="dialogue", min_length=1, max_length=50)
    youtube_url: str | None = Field(default=None, max_length=2048)


class ProjectResponse(BaseModel):
    id: UUID
    title: str
    content_type: str
    archived: bool
    youtube_url: str | None
    youtube_video_id: str | None
    cache_status: str
    job_status: str = "idle"


class InspectYoutubeRequest(BaseModel):
    youtube_url: str = Field(min_length=1, max_length=2048)


class InspectedYoutubeResponse(BaseModel):
    youtube_url: str
    youtube_video_id: str
    title: str
    channel: str | None


@router.post("/source-inspections", response_model=InspectedYoutubeResponse)
def inspect_source(
    payload: InspectYoutubeRequest,
    use_case: Annotated[InspectYoutubeSource, Depends(get_inspect_youtube_source)],
) -> InspectedYoutubeResponse:
    inspected = _execute(lambda: use_case.execute(payload.youtube_url))
    return InspectedYoutubeResponse(
        youtube_url=inspected.video.canonical_url,
        youtube_video_id=inspected.video.video_id,
        title=inspected.title,
        channel=inspected.channel,
    )


@router.get("", response_model=list[ProjectResponse])
def list_projects(
    use_case: Annotated[ManageProjects, Depends(get_manage_projects)],
    search: str = Query(default="", max_length=255),
    include_archived: bool = False,
) -> list[ProjectResponse]:
    return [
        _response(project)
        for project in use_case.list(search=search, include_archived=include_archived)
    ]


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: CreateProjectRequest,
    use_case: Annotated[ManageProjects, Depends(get_manage_projects)],
) -> ProjectResponse:
    return _execute(lambda: _response(use_case.create(**payload.model_dump())))


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: UUID, use_case: Annotated[ManageProjects, Depends(get_manage_projects)]
) -> ProjectResponse:
    return _execute(lambda: _response(use_case.get(project_id)))


@router.post(
    "/{project_id}/duplicate", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED
)
def duplicate_project(
    project_id: UUID, use_case: Annotated[ManageProjects, Depends(get_manage_projects)]
) -> ProjectResponse:
    return _execute(lambda: _response(use_case.duplicate(project_id)))


@router.post("/{project_id}/archive", response_model=ProjectResponse)
def archive_project(
    project_id: UUID, use_case: Annotated[ManageProjects, Depends(get_manage_projects)]
) -> ProjectResponse:
    return _execute(lambda: _response(use_case.archive(project_id, archived=True)))


@router.post("/{project_id}/restore", response_model=ProjectResponse)
def restore_project(
    project_id: UUID, use_case: Annotated[ManageProjects, Depends(get_manage_projects)]
) -> ProjectResponse:
    return _execute(lambda: _response(use_case.archive(project_id, archived=False)))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: UUID, use_case: Annotated[ManageProjects, Depends(get_manage_projects)]
) -> None:
    _execute(lambda: use_case.delete(project_id))


def _response(value: ManagedProject) -> ProjectResponse:
    provenance = value.project.provenance
    return ProjectResponse(
        id=value.project.id,
        title=value.project.title,
        content_type=value.project.content_type,
        archived=provenance.get("lifecycle") == "archived",
        youtube_url=provenance.get("youtube_url")
        if isinstance(provenance.get("youtube_url"), str)
        else None,
        youtube_video_id=value.source_video_id,
        cache_status=value.cache_status,
        job_status=value.job_status,
    )


def _execute(action):  # type: ignore[no-untyped-def]
    try:
        return action()
    except InvalidYoutubeUrl as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except YoutubeSourceUnavailable as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ProjectCommandError as error:
        raise HTTPException(
            status_code=404 if str(error).endswith("not found") else 422, detail=str(error)
        ) from error
