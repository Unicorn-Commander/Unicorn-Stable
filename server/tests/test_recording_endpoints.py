"""Recording routes (design §8) — handlers called directly with doubles.

LiveKit, Redis and the database are mocked; these pin the HTTP mapping of
every refusal in the policy matrix, who may delete/download, and that the
service is called with the right facts.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import app.api.recording as R
from app.config import Settings
from app.models.room import MemberRole
from app.services.call_recording import RecordingError
from recording_fakes import FakeDB, FakeResult, room

PID = uuid.uuid4()
USER = {"participant_id": PID, "roles": ["stable-recorder"], "display_name": "Aaron", "username": "aaron"}
NOBODY = {"participant_id": uuid.uuid4(), "roles": [], "display_name": "Guest"}
ENABLED = Settings(call_recording_enabled=True)
DISABLED = Settings(call_recording_enabled=False)


def _db_with_room(r, member_role=None):
    """First execute → the room; the next → the caller's RoomMember (or None)."""
    calls = {"n": 0}

    def router(stmt):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResult(scalar=r)
        member = SimpleNamespace(role=member_role) if member_role else None
        return FakeResult(scalar=member)

    return FakeDB(router=router)


class StartRoute(IsolatedAsyncioTestCase):
    async def _start(self, r, user=USER, settings=ENABLED, body=None, active=None, start=None):
        with patch.object(R.call_recording, "active_recording", AsyncMock(return_value=active)), patch.object(
            R.call_recording, "start_recording", start or AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), kind="audio"))
        ) as started, patch.object(
            R.call_recording, "room_recording_state", AsyncMock(return_value={"active": True, "policy": r.recording_policy, "kind": "audio"})
        ):
            out = await R.start_recording(r.id, body, user, _db_with_room(r), settings, None, None)
            return out, started

    async def test_policy_off_is_403_even_for_entitled(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(recording_policy="off"))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_unentitled_is_403(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(), user=NOBODY)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_master_switch_off_is_503(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(), settings=DISABLED)
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_already_active_is_409(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(), active=SimpleNamespace(id=uuid.uuid4()))
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_capacity_full_is_429_with_a_plain_message(self) -> None:
        start = AsyncMock(side_effect=RecordingError("capacity", 429, "Video recording capacity is full (2)"))
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(), body=R.RecordingStartBody(kind="composite"), start=start)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("capacity", ctx.exception.detail)

    async def test_egress_down_is_503(self) -> None:
        start = AsyncMock(side_effect=RecordingError("egress_unavailable", 503, "no egress"))
        with self.assertRaises(HTTPException) as ctx:
            await self._start(room(), start=start)
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_success_calls_the_service_with_the_caller_as_starter(self) -> None:
        r = room(recording_kind="composite")
        out, started = await self._start(r, body=R.RecordingStartBody(kind="audio"))
        self.assertTrue(out["active"])
        kwargs = started.await_args.kwargs
        self.assertEqual(kwargs["kind"], "audio")  # body overrides the room default
        self.assertEqual(kwargs["started_by"], PID)
        self.assertEqual(kwargs["trigger"], "user")
        self.assertFalse(kwargs["allow_fallback"], "a manual composite must refuse, not degrade")
        self.assertEqual(kwargs["started_by_name"], "Aaron")

    async def test_kind_defaults_to_the_rooms_kind(self) -> None:
        r = room(recording_kind="composite")
        _, started = await self._start(r, body=None)
        self.assertEqual(started.await_args.kwargs["kind"], "composite")


class StopRoute(IsolatedAsyncioTestCase):
    async def _stop(self, r, user=USER, active=SimpleNamespace(id=uuid.uuid4()), member_role=None):
        with patch.object(R.call_recording, "active_recording", AsyncMock(return_value=active)), patch.object(
            R.call_recording, "stop_room_recording", AsyncMock(return_value=1)
        ) as stopped, patch.object(
            R.call_recording, "room_recording_state", AsyncMock(return_value={"active": False, "policy": r.recording_policy, "kind": "audio"})
        ):
            out = await R.stop_recording(r.id, user, _db_with_room(r, member_role), ENABLED, None, None)
            return out, stopped

    async def test_nothing_active_is_409(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._stop(room(), active=None)
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_always_room_needs_owner_or_admin(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._stop(room(recording_policy="always"), member_role=MemberRole.MEMBER)
        self.assertEqual(ctx.exception.status_code, 403)
        out, stopped = await self._stop(room(recording_policy="always"), member_role=MemberRole.ADMIN)
        self.assertEqual(out["stopped"], 1)
        self.assertEqual(stopped.await_args.kwargs["reason"], "stop_requested")

    async def test_on_request_room_any_entitled_member_may_stop(self) -> None:
        out, _ = await self._stop(room(), member_role=MemberRole.MEMBER)
        self.assertEqual(out["stopped"], 1)

    async def test_unentitled_is_403(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._stop(room(), user=NOBODY)
        self.assertEqual(ctx.exception.status_code, 403)


def _egress_row(r, **overrides):
    base = dict(
        id=uuid.uuid4(),
        room_id=r.id,
        egress_id="EG_1",
        kind="audio",
        status="complete",
        started_by=None,
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        duration_seconds=12.0,
        storage_url=None,
        file_path="/egress-out/x.ogg",
        file_size_bytes=10,
        mo_session_id=None,
        handoff_status="none",
        retention_until=datetime.now(timezone.utc) + timedelta(days=30),
        legal_hold=False,
        created_at=datetime.now(timezone.utc),
        livekit_room_name=r.livekit_room_name,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _db_with_row(row, member_role=None):
    calls = {"n": 0}

    def router(stmt):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResult(scalar=row)
        return FakeResult(scalar=SimpleNamespace(role=member_role) if member_role else None)

    return FakeDB(router=router)


class DeleteRoute(IsolatedAsyncioTestCase):
    async def test_non_owner_non_starter_is_403(self) -> None:
        r = room()
        with self.assertRaises(HTTPException) as ctx:
            await R.delete_recording(r.id, "EG_1", USER, _db_with_row(_egress_row(r), MemberRole.MEMBER), ENABLED)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_legal_hold_is_423(self) -> None:
        r = room()
        row = _egress_row(r, legal_hold=True)
        with self.assertRaises(HTTPException) as ctx:
            await R.delete_recording(r.id, str(row.id), USER, _db_with_row(row, MemberRole.OWNER), ENABLED)
        self.assertEqual(ctx.exception.status_code, 423)

    async def test_in_flight_is_409(self) -> None:
        r = room()
        row = _egress_row(r, status="active", started_by=PID)
        with self.assertRaises(HTTPException) as ctx:
            await R.delete_recording(r.id, str(row.id), USER, _db_with_row(row), ENABLED)
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_starter_may_delete_and_files_are_purged(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, storage_url="https://garage/stable/k.ogg")

        async def purge(settings, target):
            target.storage_url = None
            target.file_path = None
            return {"storage": "deleted", "local": "deleted"}

        db = _db_with_row(row)  # not owner/admin — starter alone suffices
        with patch.object(R.call_recording, "purge_recording_files", purge):
            resp = await R.delete_recording(r.id, str(row.id), USER, db, ENABLED)
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(row.status, "deleted")
        self.assertEqual(db.commits, 1)

    async def test_storage_delete_failure_is_reported_not_hidden(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, storage_url="https://garage/stable/k.ogg")

        async def purge(settings, target):
            return {"storage": "storage DELETE returned HTTP 500", "local": "deleted"}

        with patch.object(R.call_recording, "purge_recording_files", purge):
            with self.assertRaises(HTTPException) as ctx:
                await R.delete_recording(r.id, str(row.id), USER, _db_with_row(row), ENABLED)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertNotEqual(row.status, "deleted")

    async def test_unknown_recording_is_404(self) -> None:
        r = room()
        with self.assertRaises(HTTPException) as ctx:
            await R.delete_recording(r.id, "EG_nope", USER, FakeDB(), ENABLED)
        self.assertEqual(ctx.exception.status_code, 404)


class DownloadRoute(IsolatedAsyncioTestCase):
    S3 = Settings(
        recording_s3_endpoint="https://garage.test",
        recording_s3_bucket="stable",
        recording_s3_access_key="ak",
        recording_s3_secret_key="sk",
    )

    async def test_no_stored_copy_is_404(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID)
        with self.assertRaises(HTTPException) as ctx:
            await R.download_recording(r.id, str(row.id), USER, _db_with_row(row), self.S3)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_member_who_is_neither_owner_nor_starter_is_403(self) -> None:
        r = room()
        row = _egress_row(r, storage_url="https://garage.test/stable/stable-recordings/r/x.ogg")
        with self.assertRaises(HTTPException) as ctx:
            await R.download_recording(r.id, str(row.id), USER, _db_with_row(row, MemberRole.MEMBER), self.S3)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_owner_gets_a_presigned_link(self) -> None:
        r = room()
        row = _egress_row(r, storage_url="https://garage.test/stable/stable-recordings/r/x.ogg")
        out = await R.download_recording(r.id, str(row.id), USER, _db_with_row(row, MemberRole.OWNER), self.S3)
        self.assertIn("X-Amz-Signature=", out["url"])
        self.assertTrue(out["url"].startswith("https://garage.test/stable/stable-recordings/r/x.ogg?"))
        self.assertNotIn("sk", out["url"].split("?")[1].replace("X-Amz-SignedHeaders", ""))
        self.assertEqual(out["content_type"], "audio/ogg")


class ListRoute(IsolatedAsyncioTestCase):
    async def test_listing_carries_names_links_and_permissions(self) -> None:
        r = room()
        mine = _egress_row(r, started_by=PID, mo_session_id="sess-1", storage_url="https://garage/x")
        theirs = _egress_row(r, started_by=uuid.uuid4(), kind="composite")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[mine, theirs])
            if calls["n"] == 2:  # participants
                return FakeResult(rows=[(PID, "Aaron", "aaron"), (theirs.started_by, None, "shafen")])
            if calls["n"] == 3:  # transcript exports
                return FakeResult(rows=[("sess-1", "https://mo.test/sessions/sess-1")])
            return FakeResult(scalar=SimpleNamespace(role=MemberRole.MEMBER))

        out = await R.list_recordings(r.id, USER, FakeDB(router=router), 50)
        self.assertEqual(len(out), 2)
        me, other = out
        self.assertEqual(me.started_by_name, "Aaron")
        self.assertEqual(me.mo_session_url, "https://mo.test/sessions/sess-1")
        self.assertTrue(me.can_delete)
        self.assertTrue(me.can_download)
        self.assertEqual(other.started_by_name, "shafen")
        self.assertFalse(other.can_delete, "a plain member may see, not delete, another's recording")
        self.assertFalse(other.can_download)
        self.assertEqual(other.kind, "composite")

    async def test_listing_falls_back_to_configured_meeting_ops_base(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, mo_session_id="12345")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[row])
            if calls["n"] == 2:  # participants
                return FakeResult(rows=[(PID, "Aaron", "aaron")])
            if calls["n"] == 3:  # no transcript export row
                return FakeResult(rows=[])
            return FakeResult(scalar=SimpleNamespace(role=MemberRole.MEMBER))

        out = await R.list_recordings(
            r.id,
            USER,
            FakeDB(router=router),
            50,
            Settings(meeting_ops_url="https://mo.test///"),
        )
        self.assertEqual(out[0].mo_session_url, "https://mo.test/sessions/12345")

    async def test_listing_quotes_fallback_session_id_path_delimiters(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, mo_session_id="session/with?query")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[row])
            if calls["n"] == 2:
                return FakeResult(rows=[(PID, "Aaron", "aaron")])
            if calls["n"] == 3:
                return FakeResult(rows=[])
            return FakeResult(scalar=SimpleNamespace(role=MemberRole.MEMBER))

        out = await R.list_recordings(
            r.id,
            USER,
            FakeDB(router=router),
            50,
            Settings(meeting_ops_url="https://mo.test///"),
        )
        self.assertEqual(
            out[0].mo_session_url,
            "https://mo.test/sessions/session%2Fwith%3Fquery",
        )

    async def test_listing_has_no_meeting_ops_fallback_without_a_base(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, mo_session_id="12345")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[row])
            if calls["n"] == 2:
                return FakeResult(rows=[(PID, "Aaron", "aaron")])
            if calls["n"] == 3:
                return FakeResult(rows=[])
            return FakeResult(scalar=SimpleNamespace(role=MemberRole.MEMBER))

        out = await R.list_recordings(r.id, USER, FakeDB(router=router), 50, Settings())
        self.assertIsNone(out[0].mo_session_url)

    async def test_listing_export_url_wins_over_the_fallback(self) -> None:
        r = room()
        row = _egress_row(r, started_by=PID, mo_session_id="12345")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[row])
            if calls["n"] == 2:
                return FakeResult(rows=[(PID, "Aaron", "aaron")])
            if calls["n"] == 3:
                return FakeResult(rows=[("12345", "https://mo.test/exported/12345")])
            return FakeResult(scalar=SimpleNamespace(role=MemberRole.MEMBER))

        out = await R.list_recordings(
            r.id,
            USER,
            FakeDB(router=router),
            50,
            Settings(meeting_ops_url="https://mo.test"),
        )
        self.assertEqual(out[0].mo_session_url, "https://mo.test/exported/12345")

    async def test_empty_room_lists_nothing(self) -> None:
        out = await R.list_recordings(uuid.uuid4(), USER, FakeDB(router=lambda s: FakeResult(rows=[])), 50)
        self.assertEqual(out, [])


class StateRoute(IsolatedAsyncioTestCase):
    async def test_state_says_whether_this_caller_can_record(self) -> None:
        r = room(recording_policy="on_request")
        with patch.object(R.call_recording, "room_recording_state", AsyncMock(return_value={"active": False, "policy": "on_request", "kind": "audio"})):
            out = await R.get_recording_state(r.id, USER, _db_with_room(r))
            self.assertTrue(out["can_record"])
            out = await R.get_recording_state(r.id, NOBODY, _db_with_room(r))
            self.assertFalse(out["can_record"])


class AdminBulkRoute(IsolatedAsyncioTestCase):
    async def test_non_admin_is_403_before_any_write(self) -> None:
        body = R.BulkPolicyBody(policy="always", kind="audio")
        with self.assertRaises(HTTPException) as ctx:
            await R.set_recording_policy_bulk(body, USER, None)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_admin_reaches_the_bulk_service(self) -> None:
        admin = {**USER, "roles": ["stable-admin"], "username": "aaron"}
        body = R.BulkPolicyBody(policy="always", kind="audio", rooms="all_active", dry_run=True)
        with patch.object(
            R.recording_policy_admin, "apply_recording_policy", AsyncMock(return_value={"changed": 3})
        ) as apply:
            out = await R.set_recording_policy_bulk(body, admin, FakeDB())
        self.assertEqual(out, {"changed": 3})
        kwargs = apply.await_args.kwargs
        self.assertTrue(kwargs["all_active"])
        self.assertIsNone(kwargs["room_ids"])
        self.assertTrue(kwargs["dry_run"])
        self.assertEqual(kwargs["actor"], "user:aaron")
        self.assertEqual(kwargs["via"], "api")

    async def test_bad_input_is_400(self) -> None:
        admin = {**USER, "roles": ["admin"]}
        body = R.BulkPolicyBody(policy="always", rooms=[uuid.uuid4()])
        with patch.object(
            R.recording_policy_admin,
            "apply_recording_policy",
            AsyncMock(side_effect=R.recording_policy_admin.PolicyChangeError("unknown room ids")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await R.set_recording_policy_bulk(body, admin, FakeDB())
        self.assertEqual(ctx.exception.status_code, 400)


class RoutesMounted(TestCase):
    def test_new_recording_routes_are_under_v1(self) -> None:
        from app.main import create_app

        app = create_app()
        mounted = {
            (method.lower(), path)
            for path, operations in (app.openapi().get("paths") or {}).items()
            for method in operations
        }
        expected = {
            ("post", "/api/v1/rooms/{room_id}/recording/start"),
            ("post", "/api/v1/rooms/{room_id}/recording/stop"),
            ("get", "/api/v1/rooms/{room_id}/recording"),
            ("get", "/api/v1/rooms/{room_id}/recordings"),
            ("get", "/api/v1/rooms/{room_id}/recordings/{recording_id}/download"),
            ("delete", "/api/v1/rooms/{room_id}/recordings/{recording_id}"),
            ("post", "/api/v1/admin/recording/policy"),
        }
        self.assertEqual(expected - mounted, set())

    def test_item_routes_require_membership_and_admin_route_a_real_user(self) -> None:
        import typing

        def deps(fn):
            hints = typing.get_type_hints(fn, include_extras=True, globalns=vars(R))
            out = []
            for ann in hints.values():
                for meta in getattr(ann, "__metadata__", ()):
                    dep = getattr(meta, "dependency", None)
                    if dep is not None:
                        out.append(dep.__name__)
            return out

        for fn in (R.start_recording, R.stop_recording, R.list_recordings, R.get_recording_state,
                   R.delete_recording, R.download_recording):
            self.assertIn("require_room_member", deps(fn), fn.__name__)
        self.assertIn("get_current_user", deps(R.set_recording_policy_bulk))
