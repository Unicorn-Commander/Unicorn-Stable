"""Nav v3 crew + seat flags — DATA migration (design §2.0, C3, R10) plus the
history index.

Revision ID: 024_crew_seat_flags
Revises: 023_recording_policy

The Nav v3 server reads participant-metadata facts that nothing wrote
before: ``owner`` (the username, or usernames, that own a seat — ownership
decides room privacy), ``crew`` (a seat is a conversational crew member),
and ``kind`` (``integration``: webhooks, relays, probes, smoke identities;
``guest_agent``: an outside account's agent). Shipping the flags WITH the
code is what keeps deploy order from blanking the crew and the New picker.

THE MAPPING below is Persephone's, decided from the LIVE key list (32
non-revoked key agent ids, measured 2026-09-29). Nothing is guessed beyond
it: an id that is not listed gets no owner and no kind from this migration.

* ``perry`` GETS NOTHING. He exists in both worlds — a gateway key AND a
  place in Brigade's roster — and an ``owner`` alone would make him
  non-house, so every room he is in would read ``shared`` and ``/crew``
  would list him as Aaron's seat. Persephone decides him per deploy; ids in
  ``BRIGADE_SERVED_IDS`` are skipped by every statement here.
* A list-form ``owner`` means ONE PERSON WITH TWO ACCOUNTS (Shafen's rows
  ``shafen`` and ``shafenkhan``) and must never name two people. Only this
  operator-reviewed migration writes a list; the key API takes one name.
* ``backend = "runner"`` is stamped ONLY on a listed seat whose agent id
  holds a non-revoked gateway key, and only when the row does not already
  say ``runner``.
* ``agent-claude-code`` is renamed "Rook" (the gateway minted it as "Claude
  Code" from its agent id) — marked, so downgrade never touches a hand-set
  name — and both Rook and Persephone get a ``role_line`` unless they
  already have one.
* Threads seeded from a message get ``metadata.thread.seed_sender_id`` from
  the SOURCE line's real author (``messages.sender_id`` of
  ``thread.seed_message_id``), never from client-writable metadata.
* ``ix_messages_room_id_sender_id``: the room-class history read
  (distinct sender ids per room) is an index-only scan of it.

EVERY KEY THIS MIGRATION WRITES LEAVES A MARKER, ``<key>_before_024``,
holding the value the row had before (JSON null when it had none). That is
what makes the two promises below true rather than approximately true:

* Idempotent. A marker is written once; a re-run finds it and changes
  nothing. Measured on PostgreSQL 17: upgrade twice gives an identical
  table.
* Downgrade is the inverse. Each marked key goes back to the marked value
  (or is removed when there was none), the marker comes off, and a row
  whose metadata was NULL is NULL again. A pre-existing ``owner``,
  ``crew``, ``kind``, ``backend`` or ``role_line`` — one the JWT path or an
  operator had set before this ran — is therefore RESTORED, not removed.
  Measured on PostgreSQL 17: upgrade then downgrade gives the table it
  started from.

What downgrade does NOT undo: ``thread.seed_sender_id`` (a fact about a
line, harmless to older code) — and any row this migration never touched.
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

AARON = "aaron"
#: One person, two accounts. Never two people.
SHAFEN = ["shafen", "shafenkhan"]

#: Conversational seats: owned, on the crew.
CREW_SEATS: dict[str, str | list[str]] = {
    **{
        agent_id: AARON
        for agent_id in (
            "persephone",
            "claude-code",
            "claude",
            "claude-dev",
            "codex",
            "codex-astra",
            "chatgpt",
            "chat-companion",
            "grok",
            "zen",
            "deepseek-flash",
            "producer",
            "osprey",
            "tern",
            "qwen-35b",
            "colonel",
            "gunny",
            "gfl-studio-director",
        )
    },
    **{
        agent_id: SHAFEN
        for agent_id in (
            "shafen-claude-code",
            "dev-shafen-z13",
            "shox",
            "okapi-grok",
            "gerenuk-codex",
            "kudu-sonnet",
            "oryx-gpt",
            "dikdik-haiku",
            "eland-qwen",
        )
    },
}

#: Pipeline workers: owned, NOT people you chat with (crew stays false).
WORKER_SEATS: dict[str, str | list[str]] = {
    agent_id: AARON
    for agent_id in ("planning-officer", "corporal-scratch", "contracts-counsel", "accounting-cfo")
}

#: Every seat this migration owns (kept under the old name for readers).
SEAT_OWNERS: dict[str, str | list[str]] = {**CREW_SEATS, **WORKER_SEATS}

#: Integrations by agent id (no owner, never crew) — on top of the
#: ``webhook:%`` sub / ``webhook-%`` username patterns.
INTEGRATION_IDS: tuple[str, ...] = (
    "texts-relay",
    "talk-controls-app",
    "reddit-scout",
    "taxsq-dryrun",
    "deploy2-smoke",
    "webhook-dev-stable",
)

#: Outside accounts' agents (no owner, never crew).
GUEST_AGENT_IDS: tuple[str, ...] = ("guest-northbridgetax", "statewide-agent")

#: Ids that exist in BOTH worlds: a gateway key and a place in Brigade's
#: roster. This migration writes NOTHING to them — no owner, no crew, no
#: backend — whatever list they might also appear in. Measured 2026-09-29:
#: perry is in Brigade's roster (General Counsel); producer is not.
BRIGADE_SERVED_IDS: tuple[str, ...] = ("perry",)

ROLE_LINES: dict[str, str] = {
    "claude-code": "Aaron's Mac Studio seat — Build In Public showrunner",
    "persephone": "Aaron's Mac Studio seat — main assistant",
}

#: Markers upgrade leaves so downgrade can restore exactly what it changed.
MARKER_SUFFIX = "_before_024"
#: Every metadata key this migration may write, i.e. every key downgrade
#: restores from its marker.
MARKED_KEYS: tuple[str, ...] = ("owner", "crew", "backend", "kind", "role_line")
RENAME_MARKER = "display_name_by_024"
BACKEND_MARKER = "backend" + MARKER_SUFFIX
NULL_MARKER = "metadata_null" + MARKER_SUFFIX
INDEX_NAME = "ix_messages_room_id_sender_id"

#: The row's metadata, or — when it has none — an object that says so.
#: (``jsonb_build_object`` rather than a JSON literal: no colon for the
#: bind-parameter parser to trip over.)
_METADATA_OR_MARKED = f"COALESCE(metadata, jsonb_build_object('{NULL_MARKER}', true))"


def marker_of(key: str) -> str:
    return key + MARKER_SUFFIX


def _stamp_sql(where: str, keys: tuple[str, ...] | list[str]) -> str:
    """Merge ``:patch`` into the rows ``where`` names. For each of ``keys``
    (the keys the patch sets) the value the row had BEFORE is saved under
    its marker — once: a row that already carries the marker keeps it, so a
    re-run changes nothing."""
    base = _METADATA_OR_MARKED
    markers = "".join(
        f" || CASE WHEN {base} ? '{marker_of(key)}' THEN '{{}}'::jsonb "
        f"ELSE jsonb_build_object('{marker_of(key)}', COALESCE({base} -> '{key}', 'null'::jsonb)) END"
        for key in keys
    )
    return (
        f"UPDATE participants SET metadata = {base}{markers} || "
        f"CAST(:patch AS jsonb) WHERE {where}"
    )


def _restore_sql(key: str) -> str:
    """Put ``key`` back to what its marker says (remove it when the marker
    is JSON null) and take the marker off — on exactly the rows upgrade
    marked."""
    marker = marker_of(key)
    return (
        "UPDATE participants SET metadata = "
        f"CASE WHEN metadata -> '{marker}' = 'null'::jsonb "
        f"THEN (metadata - '{key}') - '{marker}' "
        f"ELSE jsonb_set(metadata - '{marker}', '{{{key}}}', metadata -> '{marker}') END "
        f"WHERE metadata ? '{marker}'"
    )


def _quoted(values: tuple[str, ...] | list[str]) -> str:
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def _ids_where(agent_ids: tuple[str, ...]) -> str:
    """Rows of the named agent ids: the ``brigade:<id>`` sub, or the
    ``agent-<id>`` / bare username some of them were created with."""
    subs = _quoted([f"brigade:{a}" for a in agent_ids])
    names = _quoted([f"agent-{a}" for a in agent_ids] + list(agent_ids))
    return f"participant_type = 'agent' AND (keycloak_sub IN ({subs}) OR username IN ({names}))"


def _integration_where() -> str:
    return (
        "participant_type = 'agent' AND ("
        "keycloak_sub LIKE 'webhook:%' OR username LIKE 'webhook-%' OR "
        + _ids_where(INTEGRATION_IDS).removeprefix("participant_type = 'agent' AND ")
        + ")"
    )


#: ``backend = runner`` for one listed seat — only with a live key, and only
#: when it would change something.
_BACKEND_WHERE = (
    "keycloak_sub = :sub "
    "AND COALESCE(metadata ->> 'backend', '') <> 'runner' "
    "AND EXISTS (SELECT 1 FROM agent_gateway_keys k "
    "WHERE k.agent_id = :agent_id AND k.revoked_at IS NULL)"
)


def upgrade() -> None:
    conn = op.get_bind()

    for agent_id, owner in SEAT_OWNERS.items():
        if agent_id in BRIGADE_SERVED_IDS:
            continue
        patch: dict = {"owner": owner}
        if agent_id in CREW_SEATS:
            patch["crew"] = True
        conn.execute(
            sa.text(_stamp_sql("keycloak_sub = :sub", list(patch))),
            {"sub": f"brigade:{agent_id}", "patch": json.dumps(patch)},
        )
        conn.execute(
            sa.text(_stamp_sql(_BACKEND_WHERE, ["backend"])),
            {
                "sub": f"brigade:{agent_id}",
                "agent_id": agent_id,
                "patch": json.dumps({"backend": "runner"}),
            },
        )
        role = ROLE_LINES.get(agent_id)
        if role:
            # Never over a hand-set role_line.
            conn.execute(
                sa.text(
                    _stamp_sql(
                        f"keycloak_sub = :sub AND NOT ({_METADATA_OR_MARKED} ? 'role_line')",
                        ["role_line"],
                    )
                ),
                {"sub": f"brigade:{agent_id}", "patch": json.dumps({"role_line": role})},
            )

    # Rook was minted as "Claude Code" from its agent id; acceptance §5.3 is
    # "zero rows named Claude Code". Only the minted name is touched, and the
    # rename is marked so downgrade never reverts a hand-set name.
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Rook', "
            f"metadata = {_METADATA_OR_MARKED} || CAST(:patch AS jsonb) "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Claude Code'"
        ),
        {"patch": json.dumps({RENAME_MARKER: "Rook"})},
    )

    served = _quoted([f"brigade:{a}" for a in BRIGADE_SERVED_IDS])
    conn.execute(
        sa.text(_stamp_sql(f"{_integration_where()} AND keycloak_sub NOT IN ({served})", ["kind"])),
        {"patch": json.dumps({"kind": "integration"})},
    )
    conn.execute(
        sa.text(
            _stamp_sql(f"{_ids_where(GUEST_AGENT_IDS)} AND keycloak_sub NOT IN ({served})", ["kind"])
        ),
        {"patch": json.dumps({"kind": "guest_agent"})},
    )

    # Threads seeded from a message: record the seed's TRUE author on the
    # thread from the SOURCE line itself (thread.seed_message_id →
    # messages.sender_id; JSON null when that sender is gone) — never from
    # a line's client-writable metadata. Only threads that never had the
    # key are touched.
    conn.execute(
        sa.text(
            """
            UPDATE rooms r
            SET metadata = jsonb_set(
                COALESCE(r.metadata, '{}'::jsonb),
                '{thread,seed_sender_id}',
                COALESCE(to_jsonb(m.sender_id::text), 'null'::jsonb),
                true
            )
            FROM messages m
            WHERE r.metadata -> 'thread' ->> 'seed_message_id' IS NOT NULL
              AND m.id::text = r.metadata -> 'thread' ->> 'seed_message_id'
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

    # Every key upgrade wrote goes back to what its marker says, on exactly
    # the rows upgrade marked.
    for key in MARKED_KEYS:
        conn.execute(sa.text(_restore_sql(key)))
    conn.execute(
        sa.text(
            "UPDATE participants SET display_name = 'Claude Code', "
            f"metadata = metadata - '{RENAME_MARKER}' "
            "WHERE keycloak_sub = 'brigade:claude-code' AND display_name = 'Rook' "
            f"AND metadata ->> '{RENAME_MARKER}' = 'Rook'"
        )
    )
    # Last: a row that had no metadata before upgrade has none again, unless
    # something else was written to it in between.
    conn.execute(
        sa.text(
            "UPDATE participants SET metadata = "
            f"CASE WHEN metadata - '{NULL_MARKER}' = '{{}}'::jsonb THEN NULL "
            f"ELSE metadata - '{NULL_MARKER}' END "
            f"WHERE metadata ? '{NULL_MARKER}'"
        )
    )
    # seed_sender_id is a fact, not a flag; leaving it in place is harmless.
