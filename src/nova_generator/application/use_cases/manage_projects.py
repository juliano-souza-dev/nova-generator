"""Project lifecycle commands kept independent from HTTP and SQLAlchemy."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from nova_generator.application.ports.editorial_project_repository import EditorialProjectRepository
from nova_generator.application.ports.job_repository import JobRepository
from nova_generator.application.ports.youtube_media_cache import YoutubeMediaCache
from nova_generator.domain.media.youtube import YoutubeVideo
from nova_generator.domain.projects.entities import Project, Scene


class ProjectCommandError(ValueError):
    pass


@dataclass(frozen=True)
class ManagedProject:
    project: Project
    cache_status: str
    source_video_id: str | None
    job_status: str


class ManageProjects:
    def __init__(
        self,
        repository: EditorialProjectRepository,
        cache: YoutubeMediaCache,
        jobs: JobRepository,
    ) -> None:
        self._repository = repository
        self._cache = cache
        self._jobs = jobs

    def list(self, *, search: str = "", include_archived: bool = False) -> list[ManagedProject]:
        needle = search.casefold().strip()
        projects = self._repository.list_projects()
        return [
            self._managed(project)
            for project in projects
            if (include_archived or not _archived(project))
            and (not needle or needle in project.title.casefold())
        ]

    def get(self, project_id: UUID) -> ManagedProject:
        return self._managed(self._require(project_id))

    def create(self, *, title: str, content_type: str, youtube_url: str | None) -> ManagedProject:
        project = Project(uuid4(), _title(title), content_type, _provenance(youtube_url))
        self._repository.save_project(project)
        return self._managed(project)

    def archive(self, project_id: UUID, *, archived: bool) -> ManagedProject:
        project = self._require(project_id)
        provenance = {**project.provenance, "lifecycle": "archived" if archived else "active"}
        updated = Project(project.id, project.title, project.content_type, provenance)
        self._repository.save_project(updated)
        return self._managed(updated)

    def duplicate(self, project_id: UUID) -> ManagedProject:
        original = self._require(project_id)
        copy = Project(
            uuid4(),
            _copy_title(original.title),
            original.content_type,
            {**original.provenance, "lifecycle": "active", "duplicated_from": str(original.id)},
        )
        self._repository.save_project(copy)
        for scene in self._repository.get_project_scenes(original.id):
            self._repository.save_scene(
                Scene(
                    uuid4(),
                    copy.id,
                    scene.order,
                    scene.duration_ms,
                    scene.source_video_id,
                    scene.provenance,
                )
            )
        return self._managed(copy)

    def delete(self, project_id: UUID) -> None:
        if not self._repository.delete_project(project_id):
            raise ProjectCommandError("project not found")

    def _require(self, project_id: UUID) -> Project:
        project = self._repository.get_project(project_id)
        if project is None:
            raise ProjectCommandError("project not found")
        return project

    def _managed(self, project: Project) -> ManagedProject:
        video_id = project.provenance.get("youtube_video_id")
        if not isinstance(video_id, str):
            return ManagedProject(project, "not_configured", None, self._job_status(project))
        video = YoutubeVideo(video_id)
        return ManagedProject(
            project,
            "reused" if self._cache.find_verified(video) else "missing",
            video.video_id,
            self._job_status(project),
        )

    def _job_status(self, project: Project) -> str:
        return self._jobs.latest_status_for_project(str(project.id)) or "idle"


def _title(value: str) -> str:
    title = value.strip()
    if not title:
        raise ProjectCommandError("title is required")
    return title


def _provenance(youtube_url: str | None) -> dict[str, Any]:
    provenance: dict[str, Any] = {"lifecycle": "active"}
    if youtube_url:
        video = YoutubeVideo.from_url(youtube_url)
        provenance.update({"youtube_url": video.canonical_url, "youtube_video_id": video.video_id})
    return provenance


def _archived(project: Project) -> bool:
    return project.provenance.get("lifecycle") == "archived"


def _copy_title(title: str) -> str:
    suffix = " (cópia)"
    return f"{title[: 255 - len(suffix)]}{suffix}"
