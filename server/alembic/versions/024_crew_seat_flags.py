"""Nav v3 crew + seat flags — DATA migration (design §2.0, C3, R10).

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
* ``agent-claude-code`` is renamed "Rook" (the gateway minted it as "Claude
  Code" from its agent id) and both Rook and Persephone get a ``role_line``.
* ``webhook:*`` / ``projectops:*`` senders and the named relays / probes
  get ``kind = "integration"``.
* Threads seeded from a message get ``metadata.thread.seed_sender_id``
  backfilled from the seed line's own metadata, so the classifier knows the
  seed's true author instead of treating every old seed as foreign.

Idempotent: every statement is a ``||`` merge or a conditional UPDATE; a
re-run changes nothing. Downgrade removes exactly the keys upgrade set on
exactly the rows it named (and puts Rook's minted name back).
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
        patch: dict = {"crew": True, "owner": owner}
        role = ROLE_LINES.get(agent_id)
        if role:
            patch["role_line"] = role
        conn.execute(
            sa.text(_merge_sql("keycloak_sub = :sub")),
            {"sub": f"brigade:{agent_id}", "patch": json.dumps(patch)},
        )

    # Rook was minted as "Claude Code" from its agent id; acceptance §5.3 is
    # "zero rows named Claude Code". Only the minted name is touched.
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Rook' "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Claude Code'"
        )
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


def downgrade() -> None:
    conn = op.get_bind()
    for agent_id in SEAT_OWNERS:
        conn.execute(
            sa.text(
                "UPDATE participants SET metadata = metadata - 'crew' - 'owner' - 'role_line' "
                "WHERE keycloak_sub = :sub AND metadata IS NOT NULL"
            ),
            {"sub": f"brigade:{agent_id}"},
        )
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Claude Code' "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Rook'"
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
