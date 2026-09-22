"""add durable worker leases and retry state

Revision ID: 20260921_0003
Revises: 20260921_0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260921_0003"
down_revision: str | Sequence[str] | None = "20260921_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "jobs", sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3")
    )
    op.add_column("jobs", sa.Column("worker_id", sa.String(length=255), nullable=True))
    op.add_column("jobs", sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "jobs", sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("jobs", sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("jobs", sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_jobs_worker_id", "jobs", ["worker_id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_worker_id", table_name="jobs")
    op.drop_column("jobs", "finished_at")
    op.drop_column("jobs", "started_at")
    op.drop_column("jobs", "cancel_requested_at")
    op.drop_column("jobs", "heartbeat_at")
    op.drop_column("jobs", "worker_id")
    op.drop_column("jobs", "max_attempts")
