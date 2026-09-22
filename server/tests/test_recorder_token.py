"""The recorder token — a composite egress' own broadcast credential.

Structural + behavioural assertions in the style of test_broadcast_tokens.py:
what the LiveKit grant allows (nothing but a hidden subscribe), how the token
is marked without a schema change, that no user-facing mint can forge one,
and that it never shows up as a "broadcast" on the consent surface.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

import app.api.broadcast as B
from app.auth.gateway_auth import hash_key
from app.config import Settings
from recording_fakes import FakeDB, FakeResult, room


def _recorder_row(room_id, **overrides):
    base = dict(
        id=uuid.uuid4(),
        room_id=room_id,
        participant_identity=B.RECORDER_IDENTITY,
        participant_label="recorder",
        token_prefix="sbt-recorder",
        token_hash=hash_key("sbt-raw-recorder"),
        allow_audio=True,
        label=B.recorder_label(uuid.uuid4()),
        created_by=B.RECORDER_CREATED_BY,
        created_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
        revoked_at=None,
        last_used_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class GrantShape(TestCase):
    def test_recorder_grant_is_hidden_and_subscribe_only(self) -> None:
        g = B.recorder_grants("stable-room")
        self.assertFalse(g.can_publish, "the egress viewer must never publish")
        self.assertFalse(g.can_publish_data)
        self.assertTrue(g.can_subscribe)
        self.assertTrue(g.hidden, "must not appear to humans in the call")
        self.assertTrue(g.room_join)
        self.assertEqual(g.room, "stable-room")


class TemplateUrl(TestCase):
    def test_uses_the_rt_param_never_token(self) -> None:
        rid = uuid.uuid4()
        url = B.composite_template_url(Settings(public_base_url="https://stable.test/"), rid, "sbt-raw")
        self.assertEqual(url, f"https://stable.test/broadcast/{rid}/composite?rt=sbt-raw")
        # LiveKit appends its own `token=` — ours must not collide with it.
        self.assertNotIn("token=", url)
        self.assertEqual(B.RECORDER_QUERY_PARAM, "rt")

    def test_explicit_base_url_wins(self) -> None:
        rid = uuid.uuid4()
        url = B.composite_template_url(
            Settings(public_base_url="https://stable.test", call_recording_composite_base_url="http://web:3000/"),
            rid,
            "x",
        )
        self.assertTrue(url.startswith(f"http://web:3000/broadcast/{rid}/composite?"))


class Marking(TestCase):
    def test_kind_is_the_created_by_identity_pair(self) -> None:
        self.assertTrue(B.is_recorder_token(_recorder_row(uuid.uuid4())))
        # A user-minted row can set a label but not created_by or "*".
        self.assertFalse(
            B.is_recorder_token(
                _recorder_row(uuid.uuid4(), created_by="a-user-sub", label="recorder:spoof")
            )
        )
        self.assertFalse(
            B.is_recorder_token(_recorder_row(uuid.uuid4(), participant_identity="aaron_1234"))
        )

    def test_token_info_carries_kind(self) -> None:
        info = B._to_info(_recorder_row(uuid.uuid4()))
        self.assertEqual(info["kind"], "recorder")
        self.assertTrue(info["active"])
        human = _recorder_row(uuid.uuid4(), created_by="sub", participant_identity="aaron_1")
        self.assertEqual(B._to_info(human)["kind"], "broadcast")


class MintAndRevoke(IsolatedAsyncioTestCase):
    async def test_user_mint_refuses_the_reserved_identity_before_any_lookup(self) -> None:
        body = B.MintBroadcastBody(room="r", participant_identity=B.RECORDER_IDENTITY)
        with self.assertRaises(HTTPException) as ctx:
            # db=None: any lookup would explode, proving the refusal comes first.
            await B.mint_broadcast_token(body, {"participant_id": uuid.uuid4()}, None)
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_mint_recorder_token_shape(self) -> None:
        db = FakeDB()
        r = room()
        egress_row_id = uuid.uuid4()
        raw, row = await B.mint_recorder_token(db, r, egress_row_id=egress_row_id, ttl_seconds=3600)
        self.assertTrue(raw.startswith("sbt-"))
        self.assertEqual(row.token_hash, hash_key(raw))
        self.assertEqual(row.participant_identity, B.RECORDER_IDENTITY)
        self.assertEqual(row.created_by, B.RECORDER_CREATED_BY)
        self.assertEqual(row.label, f"recorder:{egress_row_id}")
        self.assertTrue(row.allow_audio, "a recording without audio is not a recording")
        self.assertTrue(B.is_recorder_token(row))
        remaining = (row.expires_at - datetime.now(timezone.utc)).total_seconds()
        self.assertLessEqual(remaining, 3600 + 5)
        self.assertGreater(remaining, 3500)
        self.assertEqual(db.commits, 1)

    async def test_revoke_marks_rows_and_evicts_the_viewer(self) -> None:
        egress_row_id = uuid.uuid4()
        row = _recorder_row(uuid.uuid4(), label=B.recorder_label(egress_row_id))
        db = FakeDB(router=lambda stmt: FakeResult(rows=[row]))
        lk = SimpleNamespace(remove_participant=AsyncMock())
        n = await B.revoke_recorder_tokens(db, lk, egress_row_id=egress_row_id, room_name="stable-x")
        self.assertEqual(n, 1)
        self.assertIsNotNone(row.revoked_at)
        lk.remove_participant.assert_awaited_once_with(
            room_name="stable-x", identity=B._viewer_identity(row.id)
        )
        self.assertEqual(db.commits, 1)

    async def test_revoke_is_fail_open(self) -> None:
        db = FakeDB(router=lambda stmt: (_ for _ in ()).throw(RuntimeError("db down")))
        self.assertEqual(await B.revoke_recorder_tokens(db, None, egress_row_id=uuid.uuid4()), 0)


class JoinAsRecorder(IsolatedAsyncioTestCase):
    async def test_join_returns_a_composite_grant(self) -> None:
        r = room()
        token_row = _recorder_row(r.id)
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            return FakeResult(scalar=token_row if calls["n"] == 1 else r)

        db = FakeDB(router=router)
        captured: dict = {}

        def generate_token(**kwargs):
            captured.update(kwargs)
            return "lk-jwt"

        lk = SimpleNamespace(generate_token=generate_token)
        request = SimpleNamespace(
            headers={"Authorization": "Bearer sbt-raw-recorder"}, client=None
        )
        settings = Settings(livekit_public_url="wss://lk.test", livekit_api_key="k", livekit_api_secret="s")
        out = await B.broadcast_join(request, db, lk, settings, None)
        self.assertEqual(out["mode"], "composite")
        self.assertEqual(out["participant_identity"], B.RECORDER_IDENTITY)
        self.assertTrue(out["allow_audio"])
        self.assertEqual(out["livekit_url"], "wss://lk.test")
        grants = captured["grants"]
        self.assertFalse(grants.can_publish)
        self.assertFalse(grants.can_publish_data)
        self.assertTrue(grants.hidden)
        self.assertTrue(grants.can_subscribe)
        self.assertEqual(captured["name"], "recorder")
        self.assertEqual(captured["identity"], B._viewer_identity(token_row.id))
        # Bounded to the token's remaining life and the 1h cap.
        self.assertLessEqual(captured["ttl"], B.LIVEKIT_TOKEN_MAX_TTL_S)
        self.assertIsNotNone(token_row.last_used_at)

    async def test_join_with_an_ordinary_token_is_unchanged(self) -> None:
        r = room()
        token_row = _recorder_row(
            r.id, created_by="sub", participant_identity="aaron_1", allow_audio=False,
            token_hash=hash_key("sbt-raw-human"),
        )
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            return FakeResult(scalar=token_row if calls["n"] == 1 else r)

        lk = SimpleNamespace(generate_token=lambda **kw: "lk")
        request = SimpleNamespace(headers={"Authorization": "Bearer sbt-raw-human"}, client=None)
        out = await B.broadcast_join(request, FakeDB(router=router), lk, Settings(), None)
        self.assertEqual(out["mode"], "participant")
        self.assertEqual(out["participant_identity"], "aaron_1")


class ConsentSurface(IsolatedAsyncioTestCase):
    async def test_active_broadcasts_leave_recorder_tokens_out(self) -> None:
        r = room()
        recorder = _recorder_row(r.id)
        human = _recorder_row(r.id, created_by="sub", participant_identity="aaron_1")
        calls = {"n": 0}

        def router(stmt):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[r])  # _resolve_room → scalars().first()
            if calls["n"] == 2:
                return FakeResult(scalar=uuid.uuid4())  # is_room_member
            return FakeResult(rows=[human, recorder])

        out = await B.list_active_broadcasts("r", {"participant_id": uuid.uuid4()}, FakeDB(router=router))
        self.assertEqual([b["participant_identity"] for b in out["broadcasting"]], ["aaron_1"])

    def test_viewer_identity_is_still_a_service_identity(self) -> None:
        from app.services.call_recording import is_service_identity

        self.assertTrue(is_service_identity(B._viewer_identity(uuid.uuid4())))
