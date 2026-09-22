"""add immutable voice profile versions

Revision ID: 20260922_0004
Revises: 20260921_0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260922_0004"
down_revision: str | Sequence[str] | None = "20260921_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "voice_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("model_id", sa.String(255), nullable=False),
        sa.Column("model_sha256", sa.String(64), nullable=False),
        sa.Column("reference_audio_sha256", sa.String(64), nullable=True),
        sa.Column("parameters_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "version", name="uq_voice_profiles_version"),
    )
    op.create_index("ix_voice_profiles_profile_id", "voice_profiles", ["profile_id"])


def downgrade() -> None:
    op.drop_index("ix_voice_profiles_profile_id", table_name="voice_profiles")
    op.drop_table("voice_profiles")
