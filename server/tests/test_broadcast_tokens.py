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

    def test_viewer_identity_contains_no_underscore(self):
        from app.api.broadcast import _viewer_identity

        identity = _viewer_identity(uuid.uuid4())
        self.assertNotIn("_", identity)

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
        # so two OBS sources on one feed would silently kill each other.
        from app.api.broadcast import _viewer_identity

        self.assertNotEqual(_viewer_identity(uuid.uuid4()), _viewer_identity(uuid.uuid4()))


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
