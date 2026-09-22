"""Backfill agent hubs — one canonical room per (human, agent) pair; every
existing per-chat agent room becomes a THREAD under its hub.

Revision ID: 022_agent_hubs_backfill
Revises: 021_conversation_model

Design: docs/design/stable-ux-north-star-2026-09-21.md §3.

What qualifies as an agent chat: a ``dm`` / ``group_dm`` room whose metadata
names a ``brigade_agent_id`` and which has EXACTLY ONE human member (the
"Chat with Majik" rooms every New chat minted). Group DMs with two or more
humans are left alone — they are shared conversations, not one person's
history with one agent.

For each distinct (human, agent) pair among those rooms the migration
ensures one ``agent_hub`` room (metadata ``agent_hub = {human_id, agent_id}``,
enforced unique by a partial index), seeds its members (the human as OWNER,
the agent participant as MEMBER with ``agent_mode = 'answers_all'``) and sets
``parent_room_id`` on each chat room. Nothing is renamed, moved or archived.

Idempotent: re-running finds the hubs it already made and parents nothing
twice. Downgrade un-parents every thread it parented and deletes only the
hubs it created (``metadata.backfill_022 = true``); hubs made later by the
API are not touched.
"""

from __future__ import annotations

import logging

from alembic import op
import sqlalchemy as sa

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
# "022_agent_hubs_backfill" is 23 chars.
revision = "022_agent_hubs_backfill"
down_revision = "021_conversation_model"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# A candidate is an unparented agent chat with exactly one human member.
_CANDIDATES_CTE = """
    candidates AS (
        SELECT r.id AS room_id,
               r.org_id,
               (r.metadata ->> 'brigade_agent_id') AS agent_id,
               (
                   SELECT m.participant_id
                   FROM room_members m
                   JOIN participants p ON p.id = m.participant_id
                   WHERE m.room_id = r.id AND p.participant_type = 'human'
                   LIMIT 1
               ) AS human_id
        FROM rooms r
        WHERE r.room_type IN ('dm', 'group_dm')
          AND r.parent_room_id IS NULL
          AND (r.metadata ? 'brigade_agent_id')
          AND COALESCE(r.metadata ->> 'brigade_agent_id', '') <> ''
          AND (
              SELECT count(*)
              FROM room_members m2
              JOIN participants p2 ON p2.id = m2.participant_id
              WHERE m2.room_id = r.id AND p2.participant_type = 'human'
          ) = 1
    )
"""


def _scalar(conn, sql: str) -> int:
    return int(conn.execute(sa.text(sql)).scalar() or 0)


def upgrade() -> None:
    conn = op.get_bind()

    before_candidates = _scalar(
        conn, f"WITH {_CANDIDATES_CTE} SELECT count(*) FROM candidates"
    )
    before_hubs = _scalar(
        conn, "SELECT count(*) FROM rooms WHERE room_type = 'agent_hub'"
    )

    # One hub per (human, agent) — the uniqueness the API relies on.
    op.execute(
        sa.text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_agent_hub
            ON rooms (
                (metadata -> 'agent_hub' ->> 'human_id'),
                (metadata -> 'agent_hub' ->> 'agent_id')
            )
            WHERE room_type = 'agent_hub'
            """
        )
    )

    # 1) Create the missing hubs. Slug = hub-<12 hex of the pair> so a re-run
    #    (or a concurrent API ensure) lands on the same name.
    op.execute(
        sa.text(
            f"""
            WITH {_CANDIDATES_CTE},
            pairs AS (
                SELECT DISTINCT human_id, agent_id, min(org_id::text) AS org_id
                FROM candidates
                WHERE human_id IS NOT NULL
                GROUP BY human_id, agent_id
            )
            INSERT INTO rooms (
                name, display_name, description, room_type, livekit_room_name,
                max_participants, metadata, is_archived, created_by, org_id,
                visibility
            )
            SELECT
                'hub-' || left(md5(p.human_id::text || ':' || p.agent_id), 12),
                COALESCE(ap.display_name, initcap(replace(p.agent_id, '-', ' '))),
                NULL,
                'agent_hub',
                'stable-hub-' || left(md5(p.human_id::text || ':' || p.agent_id), 12),
                50,
                jsonb_build_object(
                    'agent_hub', jsonb_build_object(
                        'human_id', p.human_id::text,
                        'agent_id', p.agent_id
                    ),
                    'brigade_agent_id', p.agent_id,
                    'backfill_022', true
                ),
                false,
                p.human_id,
                p.org_id::uuid,
                'public'
            FROM pairs p
            LEFT JOIN participants ap
                   ON ap.keycloak_sub = 'brigade:' || p.agent_id
            WHERE NOT EXISTS (
                SELECT 1 FROM rooms hx
                WHERE hx.room_type = 'agent_hub'
                  AND hx.metadata -> 'agent_hub' ->> 'human_id' = p.human_id::text
                  AND hx.metadata -> 'agent_hub' ->> 'agent_id' = p.agent_id
            )
            """
        )
    )

    # 2) Seed hub members: the human owns it; the agent answers everything.
    op.execute(
        sa.text(
            """
            INSERT INTO room_members (room_id, participant_id, role)
            SELECT hx.id, (hx.metadata -> 'agent_hub' ->> 'human_id')::uuid, 'owner'
            FROM rooms hx
            WHERE hx.room_type = 'agent_hub'
              AND NOT EXISTS (
                  SELECT 1 FROM room_members m
                  WHERE m.room_id = hx.id
                    AND m.participant_id = (hx.metadata -> 'agent_hub' ->> 'human_id')::uuid
              )
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO room_members (room_id, participant_id, role, agent_mode)
            SELECT hx.id, ap.id, 'member', 'answers_all'
            FROM rooms hx
            JOIN participants ap
              ON ap.keycloak_sub = 'brigade:' || (hx.metadata -> 'agent_hub' ->> 'agent_id')
            WHERE hx.room_type = 'agent_hub'
              AND NOT EXISTS (
                  SELECT 1 FROM room_members m
                  WHERE m.room_id = hx.id AND m.participant_id = ap.id
              )
            """
        )
    )

    # 3) Parent every candidate chat under its hub.
    op.execute(
        sa.text(
            f"""
            WITH {_CANDIDATES_CTE}
            UPDATE rooms r
               SET parent_room_id = hx.id
              FROM candidates c
              JOIN rooms hx
                ON hx.room_type = 'agent_hub'
               AND hx.metadata -> 'agent_hub' ->> 'human_id' = c.human_id::text
               AND hx.metadata -> 'agent_hub' ->> 'agent_id' = c.agent_id
             WHERE r.id = c.room_id
               AND r.parent_room_id IS NULL
            """
        )
    )

    after_hubs = _scalar(
        conn, "SELECT count(*) FROM rooms WHERE room_type = 'agent_hub'"
    )
    parented = _scalar(
        conn,
        "SELECT count(*) FROM rooms r JOIN rooms h ON h.id = r.parent_room_id "
        "WHERE h.room_type = 'agent_hub' AND h.metadata ? 'backfill_022'",
    )
    log.info(
        "022_agent_hubs_backfill: candidates=%s hubs_before=%s hubs_after=%s "
        "hubs_created=%s threads_parented=%s",
        before_candidates,
        before_hubs,
        after_hubs,
        after_hubs - before_hubs,
        parented,
    )


def downgrade() -> None:
    conn = op.get_bind()
    # Un-parent only what this migration parented (children of backfill hubs),
    # then remove those hubs (memberships cascade). API-made hubs survive.
    op.execute(
        sa.text(
            """
            UPDATE rooms r SET parent_room_id = NULL
             WHERE r.parent_room_id IN (
                SELECT id FROM rooms
                 WHERE room_type = 'agent_hub' AND metadata ? 'backfill_022'
             )
            """
        )
    )
    removed = _scalar(
        conn,
        "SELECT count(*) FROM rooms WHERE room_type = 'agent_hub' "
        "AND metadata ? 'backfill_022'",
    )
    op.execute(
        sa.text(
            "DELETE FROM rooms WHERE room_type = 'agent_hub' AND metadata ? 'backfill_022'"
        )
    )
    op.execute(sa.text("DROP INDEX IF EXISTS uq_rooms_agent_hub"))
    log.info("022_agent_hubs_backfill downgrade: hubs_removed=%s", removed)
