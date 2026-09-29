"""Nav v3 fix lane 3 — migration 024 (REVIEW-3.md P2-6 and the deploy
hazard).

The owner / crew / kind mapping is Persephone's, from the live key list
(2026-09-29): nothing is guessed beyond it. ``backend = runner`` is stamped
only on a listed seat that holds a non-revoked key and that Brigade does
not serve; the previous value is kept so downgrade restores it. The thread
seed backfill reads the SOURCE line's real author. Measured against a real
PostgreSQL 17 as well (see the lane report); these tests pin the SQL.

Every test here FAILED on 5ee32e9 unless its docstring says it is a pin.
"""

from __future__ import annotations

import importlib.util
import pathlib
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _load_024():
    root = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "024_crew_seat_flags.py"
    spec = importlib.util.spec_from_file_location("m024_fix3", root)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _run(mod, direction):
    conn = MagicMock()
    with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute") as op_exec:
        getattr(mod, direction)()
    calls = [(str(c.args[0]), c.args[1] if len(c.args) > 1 else {}) for c in conn.execute.call_args_list]
    return calls, " ".join(str(c.args[0]) for c in op_exec.call_args_list)


# ---------------------------------------------------------------------------
# P2-6 — migration 024: Persephone's mapping, guarded backend, real restore
# ---------------------------------------------------------------------------


class P2_6_Migration024(TestCase):
    AARON_CREW = {"persephone", "claude-code", "claude", "claude-dev", "codex", "codex-astra", "chatgpt", "chat-companion", "grok",
                  "zen", "deepseek-flash", "producer", "osprey", "tern", "perry", "qwen-35b", "colonel", "gunny", "gfl-studio-director"}
    AARON_WORKERS = {"planning-officer", "corporal-scratch", "contracts-counsel", "accounting-cfo"}
    SHAFEN_CREW = {"shafen-claude-code", "dev-shafen-z13", "shox", "okapi-grok", "gerenuk-codex", "kudu-sonnet", "oryx-gpt",
                   "dikdik-haiku", "eland-qwen"}

    def test_the_mapping_is_exactly_persephones_list(self) -> None:
        mod = _load_024()
        self.assertEqual({a for a, o in mod.CREW_SEATS.items() if o == "aaron"}, self.AARON_CREW)
        self.assertEqual({a for a, o in mod.CREW_SEATS.items() if o == ["shafen", "shafenkhan"]}, self.SHAFEN_CREW)
        self.assertEqual(set(mod.WORKER_SEATS), self.AARON_WORKERS)
        self.assertEqual(set(mod.WORKER_SEATS.values()), {"aaron"})
        self.assertEqual(set(mod.INTEGRATION_IDS), {"texts-relay", "talk-controls-app", "reddit-scout", "taxsq-dryrun", "deploy2-smoke", "webhook-dev-stable"})
        self.assertEqual(set(mod.GUEST_AGENT_IDS), {"guest-northbridgetax", "statewide-agent"})
        self.assertEqual(mod.BRIGADE_SERVED_IDS, ("perry",))
        # 32 seats, and no id is two things at once.
        self.assertEqual(len(mod.SEAT_OWNERS), 32)
        groups = [set(mod.CREW_SEATS), set(mod.WORKER_SEATS), set(mod.INTEGRATION_IDS), set(mod.GUEST_AGENT_IDS)]
        self.assertEqual(sum(len(g) for g in groups), len(set().union(*groups)))
        self.assertTrue(set(mod.BRIGADE_SERVED_IDS) <= set(mod.SEAT_OWNERS))

    def test_owner_and_crew_stamps(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        patches = {p["sub"]: p["patch"] for sql, p in calls if '"owner"' in p.get("patch", "") and "sub" in p}
        self.assertEqual(set(patches), {f"brigade:{a}" for a in self.AARON_CREW | self.AARON_WORKERS | self.SHAFEN_CREW})
        self.assertEqual(patches["brigade:persephone"], '{"owner": "aaron", "crew": true}')
        self.assertEqual(patches["brigade:planning-officer"], '{"owner": "aaron"}')          # a worker: never crew
        self.assertEqual(patches["brigade:shox"], '{"owner": ["shafen", "shafenkhan"], "crew": true}')
        self.assertNotIn("backend", "".join(patches.values()))                               # never in the blanket merge

    def test_backend_is_stamped_only_with_a_live_key_and_never_on_a_brigade_served_row(self) -> None:
        mod = _load_024()
        calls, _ops = _run(mod, "upgrade")
        stamps = [(sql, p) for sql, p in calls if "jsonb_build_object('backend', 'runner')" in sql]
        self.assertEqual({p["agent_id"] for _s, p in stamps}, set(mod.SEAT_OWNERS) - {"perry"})
        for sql, _p in stamps:
            low = sql.lower()
            self.assertIn("from agent_gateway_keys k", low)
            self.assertIn("k.revoked_at is null", low)
            self.assertIn("coalesce(p.metadata ->> 'backend', '') <> 'runner'", low)
            self.assertIn("backend_before_024", low)                                         # the old value is kept
        joined = "\n".join(sql for sql, _p in calls).lower()
        self.assertNotIn("brigade:dev-%", joined)                                            # no blanket dev-* stamp
        self.assertNotIn("projectops:", joined)                                              # nothing beyond the list

    def test_kinds(self) -> None:
        calls, ops = _run(_load_024(), "upgrade")
        integration = [sql for sql, p in calls if p.get("patch") == '{"kind": "integration"}']
        guest = [sql for sql, p in calls if p.get("patch") == '{"kind": "guest_agent"}']
        self.assertEqual((len(integration), len(guest)), (1, 1))
        self.assertIn("keycloak_sub like 'webhook:%'", integration[0].lower())
        self.assertIn("username like 'webhook-%'", integration[0].lower())
        for agent_id in ("texts-relay", "talk-controls-app", "reddit-scout", "taxsq-dryrun", "deploy2-smoke", "webhook-dev-stable"):
            self.assertIn(f"'brigade:{agent_id}'", integration[0])
        for agent_id in ("guest-northbridgetax", "statewide-agent"):
            self.assertIn(f"'brigade:{agent_id}'", guest[0])
        self.assertIn("create index if not exists ix_messages_room_id_sender_id on messages (room_id, sender_id)", ops.lower())

    def test_the_seed_backfill_reads_the_source_lines_real_author(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        backfill = [sql for sql, _p in calls if "seed_sender_id" in sql]
        self.assertEqual(len(backfill), 1)
        low = " ".join(backfill[0].lower().split())
        self.assertIn("to_jsonb(m.sender_id::text)", low)
        self.assertIn("m.id::text = r.metadata -> 'thread' ->> 'seed_message_id'", low)
        self.assertNotIn("thread_seed", low)                 # never the client-writable kind

    def test_downgrade_restores_what_upgrade_changed(self) -> None:
        calls, ops = _run(_load_024(), "downgrade")
        joined = " ".join("\n".join(sql for sql, _p in calls).lower().split())
        self.assertIn("where metadata ? 'backend_before_024'", joined)
        self.assertIn("jsonb_set(metadata - 'backend_before_024', '{backend}', metadata -> 'backend_before_024')", joined)
        self.assertIn("(metadata - 'backend') - 'backend_before_024'", joined)   # there was none before
        self.assertIn("metadata ->> 'display_name_by_024' = 'rook'", joined)
        self.assertIn("metadata ->> 'role_line' = :role", joined)
        self.assertIn("metadata ->> 'kind' = 'guest_agent'", joined)
        self.assertIn("drop index if exists ix_messages_room_id_sender_id", ops.lower())
        # A row that had NO metadata before upgrade has none again.
        self.assertIn("when metadata - 'metadata_null_before_024' = '{}'::jsonb then null", joined)
        self.assertIn("where metadata ? 'metadata_null_before_024'", joined)

    def test_a_row_without_metadata_is_marked_so_downgrade_can_restore_null(self) -> None:
        calls, _ops = _run(_load_024(), "upgrade")
        merges = [sql for sql, p in calls if "patch" in p and "update participants" in sql.lower()]
        self.assertTrue(merges)
        for sql in merges:
            self.assertIn("coalesce(metadata, jsonb_build_object('metadata_null_before_024', true))", " ".join(sql.lower().split()))
            self.assertNotIn("set metadata = '", sql.lower())      # never a whole-column rewrite
