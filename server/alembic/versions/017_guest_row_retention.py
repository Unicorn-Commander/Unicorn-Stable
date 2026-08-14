"""Indexes for the guest_invites / guest_sessions retention sweep.

Revision ID: 017_guest_row_retention
Revises: 016_guest_participant_gc

No columns, no constraints, no data. 016 gave the guest PARTICIPANT a
lifecycle; this one is for the two tables the feature actually added, which
had none at all. Revocation and expiry are STAMPS on ``guest_invites`` /
``guest_sessions`` (``revoked_at``) — grep the tree and you will not find a
single DELETE against either table — so every link an owner ever minted and
every redemption of it accumulated forever. ``sweep_guest_rows`` in
app/services/guest_reaper.py is the bound. This migration is what stops that
bound from being a table scan.

WHAT THE SWEEP ACTUALLY RUNS
----------------------------
Both stages are the same shape — "the oldest rows whose expiry is further back
than the retention window, capped at :batch" —::

    ... WHERE expires_at <= now() - make_interval(days => :days)
        ORDER BY expires_at
        LIMIT :batch

which a btree on ``expires_at`` answers by walking from the oldest row and
STOPPING at the first one inside the window. An idle pass (the overwhelmingly
common case: this runs every 60 seconds forever, in every uvicorn worker, and
the windows are 90 and 365 days) becomes one index probe.

Without it both are a sequential scan plus a sort of the whole table. That is
the failure mode migration 016 called out for ``ix_messages_sender_id`` and it
is the same one here: a garbage collector that gets slower the more history you
have is one an operator eventually turns off.

``ix_guest_sessions_expires_at`` IS NOT ONLY FOR THE NEW SWEEP. The
expired-session claim that has run since 014 (``_CLAIM_SQL``) also does
``ORDER BY gs.expires_at LIMIT :batch``, and ``guest_sessions`` had indexes on
token_hash, invite_id, room_id and participant_id but none on expires_at — so
that claim has been sorting the entire table once a minute per worker since the
feature shipped. This fixes a live cost, not just a hypothetical one.

The invite stage's other guard, ``NOT EXISTS (SELECT 1 FROM guest_sessions
WHERE invite_id = ...)``, needs no new index: ``ix_guest_sessions_invite_id``
from 014 already serves it.

WHY NEITHER INDEX IS PARTIAL — the same trap 016 documented
-----------------------------------------------------------
The tempting index is partial (``WHERE revoked_at IS NOT NULL`` or a predicate
naming the ``'guest'`` participant_type). Anything that names the enum label
added by 014 fails on a FRESH database — PostgreSQL refuses to USE a new enum
value in the transaction that added it
(``asyncpg.exceptions.UnsafeNewEnumValueUsageError``) — while passing on every
already-migrated one, which is the worst shape a migration bug comes in. These
two indexes name no enum value and no predicate at all, so they carry no such
hazard, and they answer the question the sweep actually asks.

``CREATE INDEX IF NOT EXISTS`` rather than ``op.create_index`` so a re-run, or
a database where an operator already added one by hand, is a no-op instead of a
failure. Not CONCURRENTLY: alembic runs each migration in a transaction and
CREATE INDEX CONCURRENTLY cannot run inside one. These two tables are small
(one row per invite minted / guest redeemed) and the lock is brief.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# NOTE: revision ids are stored in alembic_version.version_num, a varchar(32).
# "017_guest_row_retention" is 23 chars. A 33-char id once rolled back an
# entire migration at the version stamp — keep these short.
revision: str = "017_guest_row_retention"
down_revision: Union[str, None] = "016_guest_participant_gc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Serves the retention purge AND the expired-session claim that has run
    # unindexed since 014.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_guest_sessions_expires_at
            ON guest_sessions (expires_at)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_guest_invites_expires_at
            ON guest_invites (expires_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_guest_invites_expires_at")
    op.execute("DROP INDEX IF EXISTS ix_guest_sessions_expires_at")
