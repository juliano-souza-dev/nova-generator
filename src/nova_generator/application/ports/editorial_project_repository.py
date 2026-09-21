from __future__ import annotations

from typing import Protocol
from uuid import UUID

from nova_generator.domain.projects.entities import (
    Cue,
    EditorialRevision,
    Project,
    Scene,
    WordTiming,
)


class EditorialProjectRepository(Protocol):
    def save_project(self, project: Project) -> None: ...

    def save_scene(self, scene: Scene) -> None: ...

    def save_cue(self, cue: Cue, words: list[WordTiming]) -> None: ...

    def save_revision(self, revision: EditorialRevision) -> None: ...

    def get_project(self, project_id: UUID) -> Project | None: ...

    def get_scene_cues(self, scene_id: UUID) -> list[Cue]: ...

    def get_cue_words(self, cue_id: UUID) -> list[WordTiming]: ...

    def list_revisions(self, scene_id: UUID) -> list[EditorialRevision]: ...
