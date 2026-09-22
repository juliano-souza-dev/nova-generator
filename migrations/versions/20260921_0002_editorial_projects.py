"""persist projects, scenes, editorial cues, timings and revisions

Revision ID: 20260921_0002
Revises: 20260921_0001
Create Date: 2026-09-21 16:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260921_0002"
down_revision: str | Sequence[str] | None = "20260921_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=50), nullable=False),
        sa.Column("provenance_json", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP")
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "scenes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("source_video_id", sa.String(length=64)),
        sa.Column("provenance_json", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "order", name="uq_scenes_project_order"),
    )
    op.create_index("ix_scenes_project_id", "scenes", ["project_id"])
    op.create_table(
        "cues",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("speech_start_ms", sa.Integer(), nullable=False),
        sa.Column("speech_end_ms", sa.Integer(), nullable=False),
        sa.Column("subtitle_start_ms", sa.Integer(), nullable=False),
        sa.Column("subtitle_end_ms", sa.Integer(), nullable=False),
        sa.Column("speaker", sa.String(length=255), nullable=False),
        sa.Column("original_en", sa.Text(), nullable=False),
        sa.Column("original_en_sha256", sa.String(length=64), nullable=False),
        sa.Column("approved_en", sa.Text(), nullable=False),
        sa.Column("approved_en_sha256", sa.String(length=64), nullable=False),
        sa.Column("approved_pt", sa.Text(), nullable=False),
        sa.Column("approved_pt_sha256", sa.String(length=64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("provenance_json", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scene_id", "order", name="uq_cues_scene_order"),
    )
    op.create_index("ix_cues_scene_id", "cues", ["scene_id"])
    op.create_table(
        "word_timings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("cue_id", sa.Uuid(), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("surface", sa.Text(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("original_start_ms", sa.Integer(), nullable=False),
        sa.Column("original_end_ms", sa.Integer(), nullable=False),
        sa.Column("provenance_json", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["cue_id"], ["cues.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cue_id", "order", name="uq_word_timings_cue_order"),
    )
    op.create_index("ix_word_timings_cue_id", "word_timings", ["cue_id"])
    op.create_table(
        "editorial_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("cue_id", sa.Uuid()),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("command", sa.String(length=100), nullable=False),
        sa.Column("author", sa.String(length=255), nullable=False),
        sa.Column("origin", sa.String(length=100), nullable=False),
        sa.Column("before_snapshot_json", sa.Text(), nullable=False),
        sa.Column("after_snapshot_json", sa.Text(), nullable=False),
        sa.Column("before_sha256", sa.String(length=64), nullable=False),
        sa.Column("after_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["cue_id"], ["cues.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scene_id", "sequence", name="uq_editorial_revisions_scene_sequence"),
    )
    op.create_index("ix_editorial_revisions_project_id", "editorial_revisions", ["project_id"])
    op.create_index("ix_editorial_revisions_scene_id", "editorial_revisions", ["scene_id"])


def downgrade() -> None:
    op.drop_index("ix_editorial_revisions_scene_id", table_name="editorial_revisions")
    op.drop_index("ix_editorial_revisions_project_id", table_name="editorial_revisions")
    op.drop_table("editorial_revisions")
    op.drop_index("ix_word_timings_cue_id", table_name="word_timings")
    op.drop_table("word_timings")
    op.drop_index("ix_cues_scene_id", table_name="cues")
    op.drop_table("cues")
    op.drop_index("ix_scenes_project_id", table_name="scenes")
    op.drop_table("scenes")
    op.drop_table("projects")
