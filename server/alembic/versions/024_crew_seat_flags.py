"""Nav v3 crew + seat flags — DATA migration (design §2.0, C3, R10) plus the
history index.

Revision ID: 024_crew_seat_flags
Revises: 023_recording_policy

The Nav v3 server reads three participant-metadata facts that nothing wrote
before: ``crew = true`` (a runner seat is on the crew), ``owner`` (the
username, or usernames, that own a seat — ownership decides room privacy)
and ``kind = "integration"`` (webhooks, relays, probes and smoke identities:
foreign everywhere, never people-like). Shipping the flags WITH the code is
what keeps deploy order from blanking the crew and the New picker (P1-5).

* Aaron's seats get ``crew = true, owner = "aaron"``; Shafen's get
  ``crew = true, owner = ["shafen", "shafenkhan"]`` (he has two usernames).
  Every one of them, and every ``brigade:dev-%`` row (JWT-path identities,
  which never have a key row), gets ``backend = "runner"``: migration 020
  stamped ``brigade`` on rows that had no key at the time, and a stale
  ``brigade`` backend would read as a house agent (P1-C).
* ``agent-claude-code`` is renamed "Rook" (the gateway minted it as "Claude
  Code" from its agent id) — marked, so downgrade never touches a hand-set
  name — and both Rook and Persephone get a ``role_line`` unless they
  already have one.
* ``webhook:*`` / ``projectops:*`` senders and the named relays / probes
  get ``kind = "integration"``.
* Threads seeded from a message get ``metadata.thread.seed_sender_id``
  backfilled from the seed line's own metadata, so the classifier knows the
  seed's true author instead of treating every old seed as foreign.
* ``ix_messages_room_id_sender_id``: the room-class history aggregate
  (``array_agg(DISTINCT sender_id) … GROUP BY room_id``) runs on every
  un-floored seat poll; without the index it reads the room's whole history.

Idempotent: every statement is a ``||`` merge or a conditional UPDATE; a
re-run changes nothing. Downgrade removes only what upgrade set — the marked
rename, the migration's own role_lines, the flags on the named rows — and
drops the index.
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
# "024_crew_seat_flags" is 19 chars.
revision = "024_crew_seat_flags"
down_revision = "023_recording_policy"
branch_labels = None
depends_on = None

#: agent_id → owner (a username or a list of usernames).
SEAT_OWNERS: dict[str, str | list[str]] = {
    "persephone": "aaron",
    "claude-code": "aaron",
    "codex-astra": "aaron",
    "grok": "aaron",
    "zen": "aaron",
    "claude": "aaron",
    "deepseek-flash": "aaron",
    "producer": "aaron",
    "osprey": "aaron",
    "tern": "aaron",
    "perry": "aaron",
    "shafen-claude-code": ["shafen", "shafenkhan"],
    "dev-shafen-z13": ["shafen", "shafenkhan"],
    "shox": ["shafen", "shafenkhan"],
    "okapi-grok": ["shafen", "shafenkhan"],
    "gerenuk-codex": ["shafen", "shafenkhan"],
    "kudu-sonnet": ["shafen", "shafenkhan"],
    "oryx-gpt": ["shafen", "shafenkhan"],
    "dikdik-haiku": ["shafen", "shafenkhan"],
    "eland-qwen": ["shafen", "shafenkhan"],
}

ROLE_LINES: dict[str, str] = {
    "claude-code": "Aaron's Mac Studio seat — Build In Public showrunner",
    "persephone": "Aaron's Mac Studio seat — main assistant",
}

#: participants.username values that are integrations, on top of the
#: ``webhook:*`` / ``projectops:*`` sub prefixes.
INTEGRATION_USERNAMES: tuple[str, ...] = (
    "agent-texts-relay",
    "agent-taxsq-dryrun",
    "agent-deploy2-smoke",
    "agent-webhook-dev-stable",
    "webhook-dev-stable",
)

#: Marker upgrade leaves when IT renamed the row, so downgrade can tell the
#: minted name from a hand-set one.
RENAME_MARKER = "display_name_by_024"
INDEX_NAME = "ix_messages_room_id_sender_id"


def _merge_sql(where: str) -> str:
    return (
        "UPDATE participants SET metadata = COALESCE(metadata, '{}'::jsonb) || "
        f"CAST(:patch AS jsonb) WHERE {where}"
    )


def _integration_where() -> str:
    names = ", ".join(f"'{n}'" for n in INTEGRATION_USERNAMES)
    return (
        "participant_type = 'agent' AND ("
        "keycloak_sub LIKE 'webhook:%' OR keycloak_sub LIKE 'projectops:%' "
        f"OR username LIKE 'webhook-%' OR username IN ({names}))"
    )


def upgrade() -> None:
    conn = op.get_bind()

    for agent_id, owner in SEAT_OWNERS.items():
        # crew + owner + backend=runner: a seat, whatever 020 left behind.
        conn.execute(
            sa.text(_merge_sql("keycloak_sub = :sub")),
            {"sub": f"brigade:{agent_id}", "patch": json.dumps({"crew": True, "owner": owner, "backend": "runner"})},
        )
        role = ROLE_LINES.get(agent_id)
        if role:
            # Never over a hand-set role_line.
            conn.execute(
                sa.text(_merge_sql("keycloak_sub = :sub AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'role_line')")),
                {"sub": f"brigade:{agent_id}", "patch": json.dumps({"role_line": role})},
            )

    # JWT-path identities (dev-<username>) never have a key row; a stale
    # backend=brigade from 020 would make them house agents (P1-C).
    conn.execute(
        sa.text(_merge_sql("keycloak_sub LIKE 'brigade:dev-%'")),
        {"patch": json.dumps({"backend": "runner"})},
    )

    # Rook was minted as "Claude Code" from its agent id; acceptance §5.3 is
    # "zero rows named Claude Code". Only the minted name is touched, and the
    # rename is marked so downgrade never reverts a hand-set name.
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Rook', "
            "metadata = COALESCE(metadata, '{}'::jsonb) || CAST(:patch AS jsonb) "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Claude Code'"
        ),
        {"patch": json.dumps({RENAME_MARKER: "Rook"})},
    )

    conn.execute(
        sa.text(_merge_sql(_integration_where())),
        {"patch": json.dumps({"kind": "integration"})},
    )

    # Threads seeded from a message: record the seed's true author on the
    # thread (R2) from the seed line's own metadata (kind = thread_seed).
    # Only threads that never had the key are touched.
    conn.execute(
        sa.text(
            """
            UPDATE rooms r
            SET metadata = jsonb_set(
                COALESCE(r.metadata, '{}'::jsonb),
                '{thread,seed_sender_id}',
                COALESCE(to_jsonb(m.metadata ->> 'seed_sender_id'), 'null'::jsonb),
                true
            )
            FROM messages m
            WHERE m.room_id = r.id
              AND m.metadata ->> 'kind' = 'thread_seed'
              AND r.metadata -> 'thread' ->> 'seed_message_id' IS NOT NULL
              AND NOT ((r.metadata -> 'thread') ? 'seed_sender_id')
            """
        )
    )

    op.execute(
        sa.text(f"CREATE INDEX IF NOT EXISTS {INDEX_NAME} ON messages (room_id, sender_id)")
    )


def downgrade() -> None:
    conn = op.get_bind()
    op.execute(sa.text(f"DROP INDEX IF EXISTS {INDEX_NAME}"))
    for agent_id in SEAT_OWNERS:
        conn.execute(
            sa.text(
                "UPDATE participants SET metadata = metadata - 'crew' - 'owner' "
                "WHERE keycloak_sub = :sub AND metadata IS NOT NULL"
            ),
            {"sub": f"brigade:{agent_id}"},
        )
        role = ROLE_LINES.get(agent_id)
        if role:
            # Only the migration's own line comes off; a hand-set one stays.
            conn.execute(
                sa.text(
                    "UPDATE participants SET metadata = metadata - 'role_line' "
                    "WHERE keycloak_sub = :sub AND metadata ->> 'role_line' = :role"
                ),
                {"sub": f"brigade:{agent_id}", "role": role},
            )
    # backend=runner is a fact about these rows, not a flag; left in place.
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Claude Code', "
            f"metadata = metadata - '{RENAME_MARKER}' "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Rook' "
            f"AND metadata ->> '{RENAME_MARKER}' = 'Rook'"
        )
    )
    conn.execute(
        sa.text(
            "UPDATE participants SET metadata = metadata - 'kind' "
            "WHERE metadata IS NOT NULL AND metadata ->> 'kind' = 'integration' AND "
            + _integration_where()
        )
    )
    # seed_sender_id is a fact, not a flag; leaving it in place is harmless.
