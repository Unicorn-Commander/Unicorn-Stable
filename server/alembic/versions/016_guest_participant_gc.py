"""Indexes for the guest Participant lifecycle sweep.

Revision ID: 016_guest_participant_gc
Revises: 015_guest_hardening

No columns. The tombstone itself rides in the existing ``participants.metadata``
JSONB under ``guest_retired_at`` — the same place this model already keeps
Stable-local facts Keycloak knows nothing about (``avatar_override_url``), and
the alternative is a NOT NULL migration on the busiest identity table in the
schema for a flag only guests will ever carry.

What DOES need a migration is the ability to FIND those rows cheaply. The
reaper (app/services/guest_reaper.py) runs two claims on every pass, forever,
in every uvicorn worker:

* stage one takes un-retired guests ordered by ``created_at``;
* stage two takes retired guests ordered by ``created_at`` and then asks
  ``NOT EXISTS (SELECT 1 FROM messages WHERE sender_id = ...)``.

``ix_participants_type_created`` serves the ``participant_type = <kind>``
ORDER BY ``created_at`` shape both of them use — and it is not guest-specific,
so the ~10 other sites that filter this table by kind (people directory, user
search, agent roster, push targeting, home counts) get it too.

``ix_messages_sender_id`` is NOT only for this. That column had no index at
all, so stage two's NOT EXISTS would have been a sequential scan of the entire
message table PER CANDIDATE ROW — a garbage collector that gets slower the more
history you have is one an operator eventually turns off.

WHY NEITHER INDEX IS PARTIAL, WHICH IS NOT A STYLE CHOICE
---------------------------------------------------------
The obvious index here is partial: ``WHERE participant_type = 'guest' AND
(metadata ->> 'guest_retired_at') IS NULL``, tiny and exact. It cannot be used.
Migration 014 adds ``'guest'`` to ``participant_type_enum``, and PostgreSQL
refuses to USE a newly-added enum label in the transaction that added it —
which is precisely what a fresh database does, running 014 and 016 in one
alembic run:

    asyncpg.exceptions.UnsafeNewEnumValueUsageError:
    unsafe use of new value "guest" of enum type participant_type_enum

That failure is invisible on any database that is ALREADY past 014 (where the
label was committed long ago) and fatal on every new install — the worst shape
a migration bug comes in. A plain composite index names no enum VALUE, so it
has no such hazard, and it answers the same question.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# NOTE: revision ids are stored in alembic_version.version_num, a varchar(32).
# "016_guest_participant_gc" is 24 chars. Keep these short.
revision: str = "016_guest_participant_gc"
down_revision: Union[str, None] = "015_guest_hardening"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Equality on the leading column, already ordered by the second: exactly
    # the "oldest N participants of this kind" scan both reaper stages do.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_participants_type_created
            ON participants (participant_type, created_at)
        """
    )
    # The safety check that decides whether a retired guest may be deleted at
    # all — and the index the schema was missing for every other "what did this
    # participant say" question.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_messages_sender_id ON messages (sender_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_messages_sender_id")
    op.execute("DROP INDEX IF EXISTS ix_participants_type_created")
