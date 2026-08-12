"""Guest access hardening — per-invite opt-ins + a per-invite history floor.

Revision ID: 015_guest_hardening
Revises: 014_guest_access
"""

from alembic import op
import sqlalchemy as sa

# NOTE: revision ids are stored in alembic_version.version_num, a varchar(32).
# "015_guest_hardening" is 19 chars. A 33-char id once rolled back an entire
# migration at the version stamp — keep these short.
revision = "015_guest_hardening"
down_revision = "014_guest_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Two per-invite opt-ins, both CLOSED by default in the database itself
    # ------------------------------------------------------------------
    # 014 shipped these two behaviours hard-off in Python. Making them
    # per-invite is only safe if the DEFAULT is still off for every row that
    # already exists and for every row written by a code path that has not
    # heard of the columns — hence NOT NULL + server_default false rather than
    # a nullable flag whose NULL a reader might coerce to True.
    op.add_column(
        "guest_invites",
        sa.Column(
            "allow_agent_trigger",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "guest_invites",
        sa.Column(
            "allow_mention_email",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # ------------------------------------------------------------------
    # The history floor
    # ------------------------------------------------------------------
    # Before this, a guest read the room's ENTIRE back-history: an invite to
    # today's call handed an outsider every message the room ever held. The
    # floor is stored per invite so the decision is made once, by the owner, at
    # mint — and read on every message fetch.
    #
    # server_default now() is the restrictive answer, so a row inserted without
    # naming this column shows the guest nothing older than that row. The
    # BACKFILL below deliberately uses created_at instead of now(): an invite
    # minted an hour ago should keep the boundary it would have been given
    # (its own creation), not have an hour of the call it was minted for
    # retroactively hidden.
    op.add_column(
        "guest_invites",
        sa.Column(
            "history_from",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.execute("UPDATE guest_invites SET history_from = created_at")


def downgrade() -> None:
    op.drop_column("guest_invites", "history_from")
    op.drop_column("guest_invites", "allow_mention_email")
    op.drop_column("guest_invites", "allow_agent_trigger")
