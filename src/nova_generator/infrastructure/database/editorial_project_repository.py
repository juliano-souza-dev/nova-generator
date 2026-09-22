from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nova_generator.domain.projects.entities import (
    Cue,
    EditorialRevision,
    Project,
    Scene,
    WordTiming,
)
from nova_generator.infrastructure.database.models import (
    CueRecord,
    EditorialRevisionRecord,
    ProjectRecord,
    SceneRecord,
    WordTimingRecord,
)

SessionFactory = Callable[[], Session]


class SqlAlchemyEditorialProjectRepository:
    """SQLAlchemy adapter. Literal strings are serialized without normalization."""

    def __init__(self, session_factory: SessionFactory) -> None:
        self._session_factory = session_factory

    def save_project(self, project: Project) -> None:
        with self._session_factory() as session:
            session.merge(
                ProjectRecord(
                    id=project.id,
                    title=project.title,
                    content_type=project.content_type,
                    provenance_json=_dump(project.provenance),
                )
            )
            session.commit()

    def save_scene(self, scene: Scene) -> None:
        with self._session_factory() as session:
            session.merge(
                SceneRecord(
                    id=scene.id,
                    project_id=scene.project_id,
                    order=scene.order,
                    duration_ms=scene.duration_ms,
                    source_video_id=scene.source_video_id,
                    provenance_json=_dump(scene.provenance),
                )
            )
            session.commit()

    def save_cue(self, cue: Cue, words: list[WordTiming]) -> None:
        with self._session_factory() as session:
            session.merge(_cue_record(cue))
            stored_ids = set(
                session.scalars(
                    select(WordTimingRecord.id).where(WordTimingRecord.cue_id == cue.id)
                ).all()
            )
            new_ids = {word.id for word in words}
            for word in words:
                session.merge(_word_record(word))
            if stored_ids - new_ids:
                session.query(WordTimingRecord).filter(
                    WordTimingRecord.id.in_(stored_ids - new_ids)
                ).delete(synchronize_session=False)
            session.commit()

    def replace_scene_cues(
        self, scene_id: UUID, entries: list[tuple[Cue, list[WordTiming]]]
    ) -> None:
        """Atomically replace a scene cue set while revision snapshots retain its history."""
        with self._session_factory() as session:
            cue_ids = list(
                session.scalars(select(CueRecord.id).where(CueRecord.scene_id == scene_id))
            )
            if cue_ids:
                session.execute(
                    delete(WordTimingRecord).where(WordTimingRecord.cue_id.in_(cue_ids))
                )
            session.execute(delete(CueRecord).where(CueRecord.scene_id == scene_id))
            for cue, words in entries:
                session.add(_cue_record(cue))
                session.add_all(_word_record(word) for word in words)
            session.commit()

    def save_revision(self, revision: EditorialRevision) -> None:
        with self._session_factory() as session:
            session.merge(
                EditorialRevisionRecord(
                    id=revision.id,
                    project_id=revision.project_id,
                    scene_id=revision.scene_id,
                    cue_id=revision.cue_id,
                    sequence=revision.sequence,
                    command=revision.command,
                    author=revision.author,
                    origin=revision.origin,
                    before_snapshot_json=_dump(revision.before_snapshot),
                    after_snapshot_json=_dump(revision.after_snapshot),
                    before_sha256=revision.before_sha256,
                    after_sha256=revision.after_sha256,
                    created_at=revision.created_at,
                )
            )
            session.commit()

    def get_project(self, project_id: UUID) -> Project | None:
        with self._session_factory() as session:
            record = session.get(ProjectRecord, project_id)
            return _project(record) if record else None

    def list_projects(self) -> list[Project]:
        with self._session_factory() as session:
            records = session.scalars(
                select(ProjectRecord).order_by(ProjectRecord.created_at.desc())
            ).all()
            return [_project(record) for record in records]

    def delete_project(self, project_id: UUID) -> bool:
        with self._session_factory() as session:
            record = session.get(ProjectRecord, project_id)
            if record is None:
                return False
            session.delete(record)
            session.commit()
            return True

    def get_project_scenes(self, project_id: UUID) -> list[Scene]:
        with self._session_factory() as session:
            records = session.scalars(
                select(SceneRecord)
                .where(SceneRecord.project_id == project_id)
                .order_by(SceneRecord.order)
            ).all()
            return [_scene(record) for record in records]

    def get_scene_project_id(self, scene_id: UUID) -> UUID | None:
        with self._session_factory() as session:
            record = session.get(SceneRecord, scene_id)
            return record.project_id if record else None

    def get_cue(self, cue_id: UUID) -> Cue | None:
        with self._session_factory() as session:
            record = session.get(CueRecord, cue_id)
            return _cue(record) if record else None

    def get_scene_cues(self, scene_id: UUID) -> list[Cue]:
        with self._session_factory() as session:
            records = session.scalars(
                select(CueRecord).where(CueRecord.scene_id == scene_id).order_by(CueRecord.order)
            ).all()
            return [_cue(record) for record in records]

    def get_cue_words(self, cue_id: UUID) -> list[WordTiming]:
        with self._session_factory() as session:
            records = session.scalars(
                select(WordTimingRecord)
                .where(WordTimingRecord.cue_id == cue_id)
                .order_by(WordTimingRecord.order)
            ).all()
            return [_word(record) for record in records]

    def list_revisions(self, scene_id: UUID) -> list[EditorialRevision]:
        with self._session_factory() as session:
            records = session.scalars(
                select(EditorialRevisionRecord)
                .where(EditorialRevisionRecord.scene_id == scene_id)
                .order_by(EditorialRevisionRecord.sequence)
            ).all()
            return [_revision(record) for record in records]


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _load(value: str) -> dict[str, object]:
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _cue_record(value: Cue) -> CueRecord:
    return CueRecord(
        id=value.id,
        scene_id=value.scene_id,
        order=value.order,
        speech_start_ms=value.speech_start_ms,
        speech_end_ms=value.speech_end_ms,
        subtitle_start_ms=value.subtitle_start_ms,
        subtitle_end_ms=value.subtitle_end_ms,
        speaker=value.speaker,
        original_en=value.original_en,
        original_en_sha256=value.original_en_sha256,
        approved_en=value.approved_en,
        approved_en_sha256=value.approved_en_sha256,
        approved_pt=value.approved_pt,
        approved_pt_sha256=value.approved_pt_sha256,
        revision=value.revision,
        provenance_json=_dump(value.provenance),
    )


def _word_record(value: WordTiming) -> WordTimingRecord:
    return WordTimingRecord(
        id=value.id,
        cue_id=value.cue_id,
        order=value.order,
        surface=value.surface,
        start_ms=value.start_ms,
        end_ms=value.end_ms,
        original_start_ms=value.original_start_ms,
        original_end_ms=value.original_end_ms,
        provenance_json=_dump(value.provenance),
    )


def _project(value: ProjectRecord) -> Project:
    return Project(value.id, value.title, value.content_type, _load(value.provenance_json))


def _scene(value: SceneRecord) -> Scene:
    return Scene(
        value.id,
        value.project_id,
        value.order,
        value.duration_ms,
        value.source_video_id,
        _load(value.provenance_json),
    )


def _cue(value: CueRecord) -> Cue:
    return Cue(
        value.id,
        value.scene_id,
        value.order,
        value.speech_start_ms,
        value.speech_end_ms,
        value.subtitle_start_ms,
        value.subtitle_end_ms,
        value.speaker,
        value.original_en,
        value.approved_en,
        value.approved_pt,
        value.revision,
        _load(value.provenance_json),
    )


def _word(value: WordTimingRecord) -> WordTiming:
    return WordTiming(
        value.id,
        value.cue_id,
        value.order,
        value.surface,
        value.start_ms,
        value.end_ms,
        value.original_start_ms,
        value.original_end_ms,
        _load(value.provenance_json),
    )


def _revision(value: EditorialRevisionRecord) -> EditorialRevision:
    return EditorialRevision(
        value.id,
        value.project_id,
        value.scene_id,
        value.cue_id,
        value.sequence,
        value.command,
        value.author,
        value.origin,
        _load(value.before_snapshot_json),
        _load(value.after_snapshot_json),
        value.created_at,
    )
