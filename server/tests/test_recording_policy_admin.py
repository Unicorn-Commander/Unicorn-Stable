"""Bulk recording-policy changes: the operator tool behind the deploy step."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock

from app.models.agent import AgentEvent
from app.services import recording_policy_admin as A
from recording_fakes import FakeDB, FakeResult, room, stmt_sql


class Validation(TestCase):
    def test_policy_and_kind_are_checked(self) -> None:
        self.assertEqual(A.validate("ALWAYS", None), ("always", None))
        self.assertEqual(A.validate("off", "Audio"), ("off", "audio"))
        with self.assertRaises(A.PolicyChangeError):
            A.validate("sometimes", None)
        with self.assertRaises(A.PolicyChangeError):
            A.validate("always", "video")


class Selection(IsolatedAsyncioTestCase):
    async def test_all_active_means_non_archived(self) -> None:
        db = FakeDB(router=lambda s: FakeResult(rows=[room()]))
        rooms = await A.select_rooms(db, all_active=True)
        self.assertEqual(len(rooms), 1)
        sql = stmt_sql(db.executed[0])
        self.assertIn("is_archived", sql)

    async def test_explicit_ids_must_all_exist(self) -> None:
        r = room()
        db = FakeDB(router=lambda s: FakeResult(rows=[r]))
        self.assertEqual(await A.select_rooms(db, room_ids=[str(r.id)]), [r])
        with self.assertRaises(A.PolicyChangeError):
            await A.select_rooms(db, room_ids=[str(r.id), str(uuid.uuid4())])
        with self.assertRaises(A.PolicyChangeError):
            await A.select_rooms(db, room_ids=["not-a-uuid"])
        with self.assertRaises(A.PolicyChangeError):
            await A.select_rooms(db, room_ids=[])


class Apply(IsolatedAsyncioTestCase):
    async def test_changes_rooms_and_writes_one_audit_row_each(self) -> None:
        already = room(name="already", recording_policy="always", recording_kind="audio")
        fresh = room(name="fresh", recording_policy="off", recording_kind="audio")
        db = FakeDB(router=lambda s: FakeResult(rows=[already, fresh]))
        summary = await A.apply_recording_policy(
            db, policy="always", kind="audio", all_active=True, actor="cli:aaron", via="cli"
        )
        self.assertEqual((summary["matched"], summary["changed"], summary["unchanged"]), (2, 1, 1))
        self.assertEqual(fresh.recording_policy, "always")
        self.assertEqual(already.recording_policy, "always")
        audits = [a for a in db.added if isinstance(a, AgentEvent)]
        self.assertEqual(len(audits), 1)
        audit = audits[0]
        self.assertEqual(audit.event_type, A.AUDIT_EVENT_TYPE)
        self.assertEqual(audit.agent_identity, "cli:aaron")
        self.assertEqual(audit.room_ref, str(fresh.id))
        self.assertEqual(audit.event_data["previous"], {"policy": "off", "kind": "audio"})
        self.assertEqual(audit.event_data["policy"], "always")
        self.assertEqual(audit.event_data["via"], "cli")
        self.assertEqual(db.commits, 1)

    async def test_kind_unset_keeps_each_rooms_kind(self) -> None:
        video = room(recording_policy="off", recording_kind="composite")
        db = FakeDB(router=lambda s: FakeResult(rows=[video]))
        await A.apply_recording_policy(db, policy="on_request", all_active=True, actor="x")
        self.assertEqual(video.recording_kind, "composite")
        self.assertEqual(video.recording_policy, "on_request")

    async def test_dry_run_writes_nothing(self) -> None:
        fresh = room(recording_policy="off")
        db = FakeDB(router=lambda s: FakeResult(rows=[fresh]))
        summary = await A.apply_recording_policy(
            db, policy="always", kind="audio", all_active=True, actor="x", dry_run=True
        )
        self.assertEqual(summary["changed"], 1)
        self.assertTrue(summary["dry_run"])
        self.assertEqual(fresh.recording_policy, "off")
        self.assertEqual(db.added, [])
        self.assertEqual(db.commits, 0)


class Cli(TestCase):
    def test_argument_contract(self) -> None:
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parents[1] / "scripts" / "set_recording_policy.py"
        spec = importlib.util.spec_from_file_location("set_recording_policy", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        args = mod._parse(["--policy", "always", "--kind", "audio", "--all-active", "--dry-run"])
        self.assertEqual((args.policy, args.kind, args.all_active, args.dry_run), ("always", "audio", True, True))
        args = mod._parse(["--policy", "off", "--room", "a", "--room", "b"])
        self.assertEqual(args.room, ["a", "b"])
        for bad in (["--policy", "always"], ["--policy", "never", "--all-active"], ["--policy", "off", "--all-active", "--room", "x"]):
            with self.subTest(argv=bad), self.assertRaises(SystemExit):
                mod._parse(bad)

    def test_run_calls_the_same_service_and_reports(self) -> None:
        import asyncio
        import importlib.util
        import io
        from contextlib import redirect_stdout
        from pathlib import Path
        from unittest.mock import patch

        import sqlalchemy.ext.asyncio as sa_async

        path = Path(__file__).resolve().parents[1] / "scripts" / "set_recording_policy.py"
        spec = importlib.util.spec_from_file_location("set_recording_policy_run", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        summary = {
            "policy": "always", "kind": "audio", "dry_run": False, "matched": 1, "changed": 1, "unchanged": 0,
            "rooms": [{"room_id": "r1", "name": "general", "previous": {"policy": "off", "kind": "audio"}, "policy": "always", "kind": "audio"}],
        }
        engine = SimpleNamespace(dispose=AsyncMock())
        apply = AsyncMock(return_value=summary)
        out = io.StringIO()
        with patch.object(sa_async, "create_async_engine", lambda *a, **k: engine), patch.object(
            sa_async, "async_sessionmaker", lambda *a, **k: (lambda: FakeDB())
        ), patch("app.services.recording_policy_admin.apply_recording_policy", apply), redirect_stdout(out):
            code = asyncio.run(mod._run(mod._parse(["--policy", "always", "--kind", "audio", "--all-active"])))
        self.assertEqual(code, 0)
        self.assertEqual(apply.await_args.kwargs["via"], "cli")
        self.assertTrue(apply.await_args.kwargs["all_active"])
        self.assertIn("changed=1", out.getvalue())
        self.assertIn("off/audio -> always/audio", out.getvalue())
        engine.dispose.assert_awaited_once()
