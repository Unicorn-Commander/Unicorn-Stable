"""Recording policy — per-room policy + kind, per-egress provenance and
retention.

Revision ID: 023_recording_policy
Revises: 022_agent_hubs_backfill

Design: docs/design/stable-ux-north-star-2026-09-21.md §8.

Today recording is one instance-wide boolean (``CALL_RECORDING_ENABLED``) and
an audio-only egress per call. These columns are the contract the recording
lane (L8s) implements against; this revision only adds them with safe
defaults (``off`` / ``audio``) so nothing records that did not before.

* ``rooms.recording_policy`` — ``off`` | ``on_request`` | ``always``.
* ``rooms.recording_kind``   — ``audio`` | ``composite`` | ``track``.
* ``call_egresses.kind``     — what this egress captured.
* ``call_egresses.started_by`` — the participant who started it (NULL for
  policy-driven ``always`` starts).
* ``call_egresses.storage_url`` — where the finished file lives after upload
  (Studio Storage / Garage), so the local file can be deleted.
* ``call_egresses.retention_until`` / ``legal_hold`` — the retention sweep's
  inputs; ``legal_hold`` blocks deletion regardless of the date.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
# "023_recording_policy" is 20 chars.
revision = "023_recording_policy"
down_revision = "022_agent_hubs_backfill"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column(
            "recording_policy",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'off'"),
        ),
    )
    op.create_check_constraint(
        "ck_rooms_recording_policy",
        "rooms",
        "recording_policy IN ('off', 'on_request', 'always')",
    )
    op.add_column(
        "rooms",
        sa.Column(
            "recording_kind",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'audio'"),
        ),
    )
    op.create_check_constraint(
        "ck_rooms_recording_kind",
        "rooms",
        "recording_kind IN ('audio', 'composite', 'track')",
    )

    op.add_column(
        "call_egresses",
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'audio'"),
        ),
    )
    op.create_check_constraint(
        "ck_call_egresses_kind",
        "call_egresses",
        "kind IN ('audio', 'composite', 'track')",
    )
    op.add_column(
        "call_egresses",
        sa.Column("started_by", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_call_egresses_started_by_participants",
        "call_egresses",
        "participants",
        ["started_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "call_egresses",
        sa.Column("storage_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "call_egresses",
        sa.Column("retention_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "call_egresses",
        sa.Column(
            "legal_hold",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "ix_call_egresses_retention_until", "call_egresses", ["retention_until"]
    )


def downgrade() -> None:
    op.drop_index("ix_call_egresses_retention_until", table_name="call_egresses")
    op.drop_column("call_egresses", "legal_hold")
    op.drop_column("call_egresses", "retention_until")
    op.drop_column("call_egresses", "storage_url")
    op.drop_constraint(
        "fk_call_egresses_started_by_participants", "call_egresses", type_="foreignkey"
    )
    op.drop_column("call_egresses", "started_by")
    op.drop_constraint("ck_call_egresses_kind", "call_egresses", type_="check")
    op.drop_column("call_egresses", "kind")

    op.drop_constraint("ck_rooms_recording_kind", "rooms", type_="check")
    op.drop_column("rooms", "recording_kind")
    op.drop_constraint("ck_rooms_recording_policy", "rooms", type_="check")
    op.drop_column("rooms", "recording_policy")
