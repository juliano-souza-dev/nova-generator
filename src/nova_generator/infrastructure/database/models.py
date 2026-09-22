from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from nova_generator.infrastructure.database.base import Base

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "retryable"]


class JobRecord(Base):
    """Durable work item leased by one persistent worker at a time."""

    __tablename__ = "jobs"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(String(100), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True, default="queued")
    idempotency_key: Mapped[str | None] = mapped_column(String(255), unique=True)
    input_json: Mapped[str] = mapped_column(Text)
    output_json: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    attempt: Mapped[int] = mapped_column(default=0)
    max_attempts: Mapped[int] = mapped_column(default=3)
    worker_id: Mapped[str | None] = mapped_column(String(255), index=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ProjectRecord(Base):
    __tablename__ = "projects"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(50), default="dialogue")
    provenance_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    scenes: Mapped[list["SceneRecord"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class SceneRecord(Base):
    __tablename__ = "scenes"
    __table_args__ = (UniqueConstraint("project_id", "order", name="uq_scenes_project_order"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    order: Mapped[int] = mapped_column(Integer)
    duration_ms: Mapped[int] = mapped_column(Integer)
    source_video_id: Mapped[str | None] = mapped_column(String(64))
    provenance_json: Mapped[str] = mapped_column(Text, default="{}")
    project: Mapped[ProjectRecord] = relationship(back_populates="scenes")
    cues: Mapped[list["CueRecord"]] = relationship(
        back_populates="scene", cascade="all, delete-orphan"
    )


class CueRecord(Base):
    __tablename__ = "cues"
    __table_args__ = (UniqueConstraint("scene_id", "order", name="uq_cues_scene_order"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    scene_id: Mapped[UUID] = mapped_column(ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    order: Mapped[int] = mapped_column(Integer)
    speech_start_ms: Mapped[int] = mapped_column(Integer)
    speech_end_ms: Mapped[int] = mapped_column(Integer)
    subtitle_start_ms: Mapped[int] = mapped_column(Integer)
    subtitle_end_ms: Mapped[int] = mapped_column(Integer)
    speaker: Mapped[str] = mapped_column(String(255), default="")
    original_en: Mapped[str] = mapped_column(Text)
    original_en_sha256: Mapped[str] = mapped_column(String(64))
    approved_en: Mapped[str] = mapped_column(Text)
    approved_en_sha256: Mapped[str] = mapped_column(String(64))
    approved_pt: Mapped[str] = mapped_column(Text)
    approved_pt_sha256: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    provenance_json: Mapped[str] = mapped_column(Text, default="{}")
    scene: Mapped[SceneRecord] = relationship(back_populates="cues")
    words: Mapped[list["WordTimingRecord"]] = relationship(
        back_populates="cue", cascade="all, delete-orphan"
    )


class WordTimingRecord(Base):
    __tablename__ = "word_timings"
    __table_args__ = (UniqueConstraint("cue_id", "order", name="uq_word_timings_cue_order"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    cue_id: Mapped[UUID] = mapped_column(ForeignKey("cues.id", ondelete="CASCADE"), index=True)
    order: Mapped[int] = mapped_column(Integer)
    surface: Mapped[str] = mapped_column(Text)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    original_start_ms: Mapped[int] = mapped_column(Integer)
    original_end_ms: Mapped[int] = mapped_column(Integer)
    provenance_json: Mapped[str] = mapped_column(Text, default="{}")
    cue: Mapped[CueRecord] = relationship(back_populates="words")


class EditorialRevisionRecord(Base):
    __tablename__ = "editorial_revisions"
    __table_args__ = (
        UniqueConstraint("scene_id", "sequence", name="uq_editorial_revisions_scene_sequence"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    scene_id: Mapped[UUID] = mapped_column(ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    cue_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("cues.id", ondelete="SET NULL"), nullable=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    command: Mapped[str] = mapped_column(String(100))
    author: Mapped[str] = mapped_column(String(255))
    origin: Mapped[str] = mapped_column(String(100))
    before_snapshot_json: Mapped[str] = mapped_column(Text)
    after_snapshot_json: Mapped[str] = mapped_column(Text)
    before_sha256: Mapped[str] = mapped_column(String(64))
    after_sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
