"""Nav v3 fix lane 4 — migration 024 restores what it overwrites, and leaves
perry alone (REVIEW-4.md P2-7).

e20c618's upgrade overwrote a pre-existing ``owner`` / ``crew`` with no
marker and its downgrade removed them: ``brigade:dev-shafen-z13`` lost its
JWT-stamped ``owner: "shafen"`` on a round trip, while the docstring said
"restores what it changed". And it gave ``perry`` — who exists in both
worlds — ``owner: aaron`` and ``crew: true``, which alone makes a
Brigade-served row non-house.

Now every key 024 writes leaves ``<key>_before_024`` (JSON null when the row
had none) and downgrade restores from it. perry gets nothing.

These tests pin the SQL. The behaviour was measured on PostgreSQL 17 with
rows that already carried an owner, crew, kind and role line (lane report):
upgrade twice is identical; upgrade then downgrade is byte-identical to the
start.

Every test here FAILED on e20c618 unless its docstring says it is a pin.
"""

from __future__ import annotations

import importlib.util
import pathlib
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _load_024():
    root = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "024_crew_seat_flags.py"
    spec = importlib.util.spec_from_file_location("m024_fix4", root)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _run(mod, direction):
    conn = MagicMock()
    with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute") as op_exec:
        getattr(mod, direction)()
    calls = [(" ".join(str(c.args[0]).split()), c.args[1] if len(c.args) > 1 else {}) for c in conn.execute.call_args_list]
    return calls, " ".join(str(c.args[0]) for c in op_exec.call_args_list)


BASE = "COALESCE(metadata, jsonb_build_object('metadata_null_before_024', true))"


def _marker_clause(key):
    return (f"CASE WHEN {BASE} ? '{key}_before_024' THEN '{{}}'::jsonb "
            f"ELSE jsonb_build_object('{key}_before_024', COALESCE({BASE} -> '{key}', 'null'::jsonb)) END")


class P2_7_PerryGetsNothing(TestCase):
    def test_perry_is_in_no_list(self) -> None:
        mod = _load_024()
        self.assertEqual(mod.BRIGADE_SERVED_IDS, ("perry",))
        for name in ("CREW_SEATS", "WORKER_SEATS", "SEAT_OWNERS", "INTEGRATION_IDS", "GUEST_AGENT_IDS", "ROLE_LINES"):
            self.assertNotIn("perry", getattr(mod, name), name)
        self.assertEqual(len([a for a, o in mod.CREW_SEATS.items() if o == "aaron"]), 18)
        self.assertEqual(len(mod.SEAT_OWNERS), 31)

    def test_no_statement_writes_to_perry(self) -> None:
        mod = _load_024()
        for direction in ("upgrade", "downgrade"):
            calls, _ops = _run(mod, direction)
            for sql, params in calls:
                self.assertNotEqual(params.get("sub"), "brigade:perry", sql)
                self.assertNotEqual(params.get("agent_id"), "perry", sql)
                if "'brigade:perry'" in sql:
                    # the only mention: an explicit exclusion
                    self.assertIn("keycloak_sub NOT IN ('brigade:perry')", sql)

    def test_an_id_brigade_serves_is_skipped_even_if_a_list_names_it(self) -> None:
        mod = _load_024()
        mod.CREW_SEATS["perry"] = "aaron"
        mod.SEAT_OWNERS["perry"] = "aaron"
        calls, _ops = _run(mod, "upgrade")
        self.assertEqual([params for _sql, params in calls if params.get("sub") == "brigade:perry"], [])


class P2_7_EveryKeyLeavesAMarker(TestCase):
    def test_the_owner_merge_saves_what_was_there(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        owner = [(sql, p) for sql, p in calls if p.get("sub") == "brigade:dev-shafen-z13" and '"owner"' in p.get("patch", "")]
        self.assertEqual(len(owner), 1)
        sql, params = owner[0]
        self.assertEqual(params["patch"], '{"owner": ["shafen", "shafenkhan"], "crew": true}')
        self.assertEqual(
            sql,
            f"UPDATE participants SET metadata = {BASE} || {_marker_clause('owner')} || {_marker_clause('crew')} "
            "|| CAST(:patch AS jsonb) WHERE keycloak_sub = :sub",
        )

    def test_a_worker_marks_owner_only(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        sql, params = [(s, p) for s, p in calls if p.get("sub") == "brigade:planning-officer" and '"owner"' in p.get("patch", "")][0]
        self.assertEqual(params["patch"], '{"owner": "aaron"}')
        self.assertIn("owner_before_024", sql)
        self.assertNotIn("crew_before_024", sql)             # 024 does not write crew there, so it marks nothing

    def test_backend_kind_and_role_line_are_marked_the_same_way(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        by_patch = {}
        for sql, params in calls:
            by_patch.setdefault(params.get("patch"), sql)
        self.assertIn(_marker_clause("backend"), by_patch['{"backend": "runner"}'])
        self.assertIn(_marker_clause("kind"), by_patch['{"kind": "integration"}'])
        self.assertIn(_marker_clause("kind"), by_patch['{"kind": "guest_agent"}'])
        role = [sql for sql, p in calls if "role_line" in p.get("patch", "")]
        self.assertEqual(len(role), 2)
        for sql in role:
            self.assertIn(_marker_clause("role_line"), sql)
            self.assertIn(f"AND NOT ({BASE} ? 'role_line')", sql)   # never over a hand-set line

    def test_a_marker_is_written_once(self) -> None:
        """Idempotence: a row that carries the marker keeps it, so a re-run
        cannot save 024's own value as "what was there before"."""
        mod = _load_024()
        sql = mod._stamp_sql("keycloak_sub = :sub", ["owner"])
        self.assertIn(f"CASE WHEN {BASE} ? 'owner_before_024' THEN '{{}}'::jsonb ELSE", sql)
        self.assertEqual(mod.MARKED_KEYS, ("owner", "crew", "backend", "kind", "role_line"))
        self.assertEqual(mod.marker_of("owner"), "owner_before_024")


class P2_7_DowngradeIsTheInverse(TestCase):
    def test_each_key_goes_back_to_its_marker(self) -> None:
        mod = _load_024()
        calls, ops = _run(mod, "downgrade")
        statements = [sql for sql, _p in calls]
        for key in mod.MARKED_KEYS:
            marker = f"{key}_before_024"
            self.assertIn(
                "UPDATE participants SET metadata = "
                f"CASE WHEN metadata -> '{marker}' = 'null'::jsonb THEN (metadata - '{key}') - '{marker}' "
                f"ELSE jsonb_set(metadata - '{marker}', '{{{key}}}', metadata -> '{marker}') END "
                f"WHERE metadata ? '{marker}'",
                statements,
            )
        self.assertIn("DROP INDEX IF EXISTS ix_messages_room_id_sender_id", ops)

    def test_downgrade_touches_only_rows_upgrade_marked(self) -> None:
        calls, _ops = _run(_load_024(), "downgrade")
        for sql, params in calls:
            self.assertEqual(params, {}, sql)                # no per-seat statement: the markers say which rows
            self.assertTrue(
                "_before_024'" in sql.split("WHERE", 1)[1] or "display_name_by_024" in sql, sql)
        joined = " ".join(sql for sql, _p in calls)
        self.assertNotIn("metadata - 'crew' - 'owner'", joined)   # e20c618 removed them whatever set them

    def test_the_null_marker_is_handled_last(self) -> None:
        """PIN (already true on e20c618): it must stay last, after every
        other marker has come off."""
        calls, _ops = _run(_load_024(), "downgrade")
        self.assertIn("WHERE metadata ? 'metadata_null_before_024'", calls[-1][0])
        self.assertIn("THEN NULL", calls[-1][0])

    def test_the_docstring_says_what_downgrade_does(self) -> None:
        doc = " ".join((_load_024().__doc__ or "").split())
        self.assertIn("RESTORED, not removed", doc)
        self.assertIn("``perry`` GETS NOTHING", doc)
        self.assertIn("ONE PERSON WITH TWO ACCOUNTS", doc)
        self.assertIn("What downgrade does NOT undo", doc)
