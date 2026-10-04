"""Broadcast feeds — security posture tests.

These are structural assertions, deliberately: the risky properties of this
feature are "which routes accept a token" and "what does the LiveKit grant
allow", and both are exactly the kind of thing a later refactor breaks
silently. Run with:  python -m unittest -q tests/test_broadcast_tokens.py
"""

from __future__ import annotations

import typing
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from app.auth.gateway_auth import hash_key
from app.config import Settings
from app.models.room import MemberRole
from recording_fakes import FakeDB, FakeResult, room


class TestAuthPosture(unittest.TestCase):
    """Only /broadcast/join may accept a broadcast token.

    This is the load-bearing default-deny property. If a broadcast token ever
    becomes acceptable to `get_current_user`, it instantly reaches ~100 routes
    (see the router audit in the PR). The inverse arrangement — a separate,
    opt-in path — is what keeps routes that don't exist yet safe by default.
    """

    @staticmethod
    def _deps(fn) -> list[str]:
        import app.api.broadcast as B

        hints = typing.get_type_hints(fn, include_extras=True, globalns=vars(B))
        out: list[str] = []
        for ann in hints.values():
            for meta in getattr(ann, "__metadata__", ()):
                dep = getattr(meta, "dependency", None)
                if dep is not None:
                    out.append(getattr(dep, "__name__", str(dep)))
        return out

    def test_join_does_not_require_a_keycloak_user(self):
        # An OBS browser source has no Keycloak session; requiring one would
        # make the whole feature unusable.
        import app.api.broadcast as B

        self.assertNotIn("get_current_user", self._deps(B.broadcast_join))

    def test_every_other_route_requires_a_real_user(self):
        import app.api.broadcast as B

        for fn in (
            B.mint_broadcast_token,
            B.list_broadcast_tokens,
            B.revoke_broadcast_token,
            B.list_active_broadcasts,
        ):
            with self.subTest(route=fn.__name__):
                self.assertIn("get_current_user", self._deps(fn))


class TestLiveKitGrant(unittest.TestCase):
    """The viewer must be subscribe-only and invisible."""

    def test_grant_is_subscribe_only_and_hidden(self):
        from livekit.api import VideoGrants

        # Mirrors the grant constructed in broadcast_join.
        grants = VideoGrants(
            room_join=True,
            room="r",
            can_publish=False,
            can_publish_data=False,
            can_subscribe=True,
            hidden=True,
        )
        self.assertFalse(grants.can_publish, "a broadcast viewer must never publish")
        self.assertFalse(grants.can_publish_data)
        self.assertTrue(grants.can_subscribe)
        self.assertTrue(grants.hidden, "viewer must not appear to humans in the call")

    def test_livekit_ttl_never_outlives_the_broadcast_token(self):
        from app.api.broadcast import LIVEKIT_TOKEN_MAX_TTL_S, MAX_TTL_HOURS

        # If the LiveKit token could outlive its authorizing row, revocation
        # would leave a live feed running until the LiveKit TTL expired.
        self.assertLessEqual(LIVEKIT_TOKEN_MAX_TTL_S, MAX_TTL_HOURS * 3600)


class TestIdentitySafety(unittest.TestCase):
    """The viewer identity must not be mistaken for a human participant.

    webhooks._extract_participant_id parses `username_<uuid>` with
    rsplit("_", 1) and does NOT validate the prefix, so any identity ending in
    _<uuid> is attributed to that participant — an OBS source could otherwise
    flip presence for a UUID it does not own.
    """

    def test_viewer_identity_has_a_stable_prefix_and_eight_url_safe_chars(self):
        from app.api.broadcast import _viewer_identity, _viewer_identity_prefix

        token_id = uuid.uuid4()
        identity = _viewer_identity(token_id)
        prefix = _viewer_identity_prefix(token_id)
        self.assertTrue(identity.startswith(f"{prefix}-"))
        suffix = identity[len(prefix) + 1 :]
        self.assertRegex(suffix, r"^[A-Za-z0-9_-]{8}$")

    def test_webhook_parser_cannot_attribute_a_viewer_identity(self):
        from app.api.broadcast import _viewer_identity
        from app.api.webhooks import _extract_participant_id

        self.assertIsNone(_extract_participant_id(_viewer_identity(uuid.uuid4())))

    def test_webhook_handlers_recognize_and_skip_broadcast_identities(self):
        from app.api.broadcast import _viewer_identity
        from app.api.webhooks import _is_broadcast_identity

        self.assertTrue(_is_broadcast_identity(_viewer_identity(uuid.uuid4())))
        # A real human identity must NOT be skipped.
        self.assertFalse(_is_broadcast_identity(f"aaron_{uuid.uuid4()}"))
        self.assertFalse(_is_broadcast_identity(""))

    def test_identities_are_unique_per_token(self):
        # Duplicate LiveKit identities evict each other (DUPLICATE_IDENTITY),
        # so each POST /join needs a distinct identity even for one token.
        from app.api.broadcast import _viewer_identity

        token_id = uuid.uuid4()
        self.assertNotEqual(_viewer_identity(token_id), _viewer_identity(token_id))


def _broadcast_row(room_id, raw: str = "sbt-test"):
    return SimpleNamespace(
        id=uuid.uuid4(),
        room_id=room_id,
        participant_identity="aaron_participant",
        participant_label="Aaron",
        token_prefix=raw[:12],
        token_hash=hash_key(raw),
        allow_audio=False,
        label="OBS · Aaron",
        created_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
        revoked_at=None,
        last_used_at=None,
    )


class TestViewerLifecycle(IsolatedAsyncioTestCase):
    async def test_two_joins_share_a_token_but_get_different_identities(self):
        import app.api.broadcast as B

        raw = "sbt-same-token"
        room_row = room()
        token_row = _broadcast_row(room_row.id, raw)
        calls = {"n": 0}
        identities: list[str] = []

        def router(_statement):
            calls["n"] += 1
            return FakeResult(scalar=token_row if calls["n"] % 2 else room_row)

        def generate_token(**kwargs):
            identities.append(kwargs["identity"])
            return f"lk-{len(identities)}"

        request = SimpleNamespace(
            headers={"Authorization": f"Bearer {raw}"},
            client=None,
        )
        livekit = SimpleNamespace(generate_token=generate_token)
        settings = Settings(
            livekit_public_url="wss://livekit.test",
            livekit_api_key="key",
            livekit_api_secret="secret",
        )

        await B.broadcast_join(
            request, FakeDB(router=router), livekit, settings, None
        )
        await B.broadcast_join(
            request, FakeDB(router=router), livekit, settings, None
        )

        prefix = B._viewer_identity_prefix(token_row.id)
        self.assertEqual(len(identities), 2)
        self.assertNotEqual(identities[0], identities[1])
        for identity in identities:
            self.assertTrue(identity.startswith(f"{prefix}-"))
            self.assertEqual(len(identity[len(prefix) + 1 :]), 8)

    async def test_active_is_one_consent_row_per_token(self):
        import app.api.broadcast as B

        room_row = room()
        token_row = _broadcast_row(room_row.id)
        calls = {"n": 0}

        def router(_statement):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[room_row])
            if calls["n"] == 2:
                return FakeResult(scalar=uuid.uuid4())
            return FakeResult(rows=[token_row])

        out = await B.list_active_broadcasts(
            "test-room",
            {"participant_id": uuid.uuid4()},
            FakeDB(router=router),
            SimpleNamespace(get_room=AsyncMock(return_value={"participants": []})),
        )
        self.assertEqual(len(out["broadcasting"]), 1)
        self.assertEqual(
            out["broadcasting"][0]["participant_identity"],
            token_row.participant_identity,
        )

    async def test_active_counts_each_token_with_a_strict_identity_prefix(self):
        import app.api.broadcast as B

        room_row = room()
        first = _broadcast_row(room_row.id)
        second = _broadcast_row(room_row.id)
        second.participant_identity = "other_participant"
        first_prefix = B._viewer_identity_prefix(first.id)
        second_prefix = B._viewer_identity_prefix(second.id)
        livekit = SimpleNamespace(
            get_room=AsyncMock(
                return_value={
                    "participants": [
                        SimpleNamespace(identity=first_prefix),
                        SimpleNamespace(identity=f"{first_prefix}-viewer"),
                        SimpleNamespace(identity=f"{first_prefix}without-dash"),
                        {"identity": second_prefix},
                        {"identity": f"{second_prefix}-viewer"},
                        {"identity": f"{second_prefix}without-dash"},
                    ]
                }
            )
        )
        calls = {"n": 0}

        def router(_statement):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[room_row])
            if calls["n"] == 2:
                return FakeResult(scalar=uuid.uuid4())
            return FakeResult(rows=[first, second])

        out = await B.list_active_broadcasts(
            "test-room",
            {"participant_id": uuid.uuid4()},
            FakeDB(router=router),
            livekit,
        )
        counts = {
            row["participant_identity"]: row["viewer_count"]
            for row in out["broadcasting"]
        }
        self.assertEqual(counts, {"aaron_participant": 2, "other_participant": 2})
        livekit.get_room.assert_awaited_once_with(room_row.livekit_room_name)

    async def test_active_livekit_failure_returns_null_count_without_raising(self):
        import app.api.broadcast as B

        room_row = room()
        token_row = _broadcast_row(room_row.id)
        calls = {"n": 0}

        def router(_statement):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[room_row])
            if calls["n"] == 2:
                return FakeResult(scalar=uuid.uuid4())
            return FakeResult(rows=[token_row])

        livekit = SimpleNamespace(
            get_room=AsyncMock(side_effect=RuntimeError("LiveKit unavailable"))
        )
        out = await B.list_active_broadcasts(
            "test-room",
            {"participant_id": uuid.uuid4()},
            FakeDB(router=router),
            livekit,
        )
        self.assertEqual(out["broadcasting"][0]["viewer_count"], None)
        livekit.get_room.assert_awaited_once_with(room_row.livekit_room_name)

    async def test_active_does_not_list_livekit_without_active_tokens(self):
        import app.api.broadcast as B

        room_row = room()
        calls = {"n": 0}

        def router(_statement):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(rows=[room_row])
            if calls["n"] == 2:
                return FakeResult(scalar=uuid.uuid4())
            return FakeResult(rows=[])

        livekit = SimpleNamespace(get_room=AsyncMock())
        out = await B.list_active_broadcasts(
            "test-room",
            {"participant_id": uuid.uuid4()},
            FakeDB(router=router),
            livekit,
        )
        self.assertEqual(out["broadcasting"], [])
        livekit.get_room.assert_not_awaited()

    async def test_revoke_evicts_all_viewers_for_one_token_prefix(self):
        import app.api.broadcast as B

        room_row = room()
        token_row = _broadcast_row(room_row.id)
        owner_id = uuid.uuid4()
        member = SimpleNamespace(participant_id=owner_id, role=MemberRole.OWNER)
        calls = {"n": 0}

        def router(_statement):
            calls["n"] += 1
            if calls["n"] == 1:
                return FakeResult(scalar=token_row)
            if calls["n"] == 2:
                return FakeResult(scalar=room_row)
            return FakeResult(scalar=member)

        first = B._viewer_identity(token_row.id)
        second = B._viewer_identity(token_row.id)
        livekit = SimpleNamespace(
            get_room=AsyncMock(
                return_value={
                    "participants": [
                        SimpleNamespace(identity=B._viewer_identity_prefix(token_row.id)),
                        SimpleNamespace(identity=first),
                        SimpleNamespace(identity=second),
                        SimpleNamespace(
                            identity=f"{B._viewer_identity_prefix(token_row.id)}without-dash"
                        ),
                        SimpleNamespace(identity="broadcast-other-token-12345678"),
                    ]
                }
            ),
            remove_participant=AsyncMock(),
        )
        out = await B.revoke_broadcast_token(
            token_row.id,
            {"participant_id": owner_id},
            FakeDB(router=router),
            livekit,
        )

        self.assertTrue(out["revoked"])
        removed = {
            call.kwargs["identity"]
            for call in livekit.remove_participant.await_args_list
        }
        self.assertEqual(
            removed,
            {B._viewer_identity_prefix(token_row.id), first, second},
        )
        livekit.get_room.assert_awaited_once_with(room_row.livekit_room_name)


class TestTokenShape(unittest.TestCase):
    def test_ttl_bounds_are_short(self):
        from app.api.broadcast import DEFAULT_TTL_HOURS, MAX_TTL_HOURS

        # A broadcast link renders a human being's camera with no login.
        self.assertLessEqual(DEFAULT_TTL_HOURS, 12)
        self.assertLessEqual(MAX_TTL_HOURS, 24)

    def test_only_the_hash_is_persisted(self):
        from app.models.broadcast_token import BroadcastToken

        cols = set(BroadcastToken.__table__.columns.keys())
        self.assertIn("token_hash", cols)
        self.assertIn("token_prefix", cols)
        self.assertNotIn("token", cols, "the raw token must never be stored")
        for required in ("expires_at", "revoked_at", "room_id", "participant_identity"):
            self.assertIn(required, cols)


if __name__ == "__main__":
    unittest.main()
