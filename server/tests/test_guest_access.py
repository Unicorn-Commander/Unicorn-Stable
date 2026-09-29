"""Guest access — security posture tests.

THE NEGATIVE TESTS ARE THE DELIVERABLE. A guest is an outsider with no account
who was handed a link, so the interesting question is never "can they do the
thing they were invited to do" — it is "what ELSE can they reach". Almost
everything here is an assertion that something does NOT happen.

The single most important test in this file is
``RouterDefaultDenyTests.test_exactly_these_routes_accept_a_guest``: it walks
every route in the real application and asserts that the guest-reachable set is
EXACTLY the intended six. Adding a route that accepts guests without updating
that list is a test failure, which is the property that makes the design hold
after this PR is merged and forgotten.

Run with:  python -m unittest -v tests/test_guest_access.py
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _scalar_result(value: object) -> MagicMock:
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _scalars_result(values: list[object]) -> MagicMock:
    res = MagicMock()
    res.scalars.return_value.all.return_value = values
    return res


def _request(headers: dict[str, str] | None = None, client_host: str = "1.2.3.4"):
    """A minimal real starlette Request (not a mock) so header handling is the
    same code path the server actually runs."""
    from starlette.requests import Request

    raw = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": raw,
            "client": (client_host, 12345),
            "scheme": "http",
            "server": ("test", 80),
        }
    )


def _settings(**over) -> SimpleNamespace:
    base = dict(
        keycloak_url="https://kc.example",
        keycloak_realm="uchub",
        keycloak_client_id="stable",
        guest_access_enabled=True,
        guest_invite_default_ttl_hours=24,
        guest_invite_max_ttl_hours=168,
        guest_session_max_hours=12,
        rate_limit_enabled=False,
        rate_limit_guest_redeem_per_min=10,
        livekit_token_ttl_seconds=3600,
        livekit_api_key="k",
        livekit_api_secret="s",
        livekit_public_url="wss://lk.example",
        livekit_url="ws://lk:7880",
    )
    base.update(over)
    return SimpleNamespace(**base)


def _guest_user(room_id: uuid.UUID | None = None, **over) -> dict:
    """A guest principal exactly as ``guest_user_dict`` builds it."""
    from app.auth.guest_auth import GuestPrincipal, guest_user_dict

    principal = GuestPrincipal(
        session_id=over.pop("session_id", _uuid()),
        invite_id=over.pop("invite_id", _uuid()),
        room_id=room_id or _uuid(),
        participant_id=over.pop("participant_id", _uuid()),
        keycloak_sub=over.pop("keycloak_sub", f"guest:{_uuid()}"),
        username=over.pop("username", "guest-abc123"),
        display_name=over.pop("display_name", "Outside Guest"),
        can_publish=over.pop("can_publish", True),
        expires_at=over.pop("expires_at", _now() + timedelta(hours=4)),
    )
    user = guest_user_dict(principal)
    user.update(over)
    return user


def _walk_app_routes() -> list[tuple[str, object, set[str]]]:
    """Every registered APIRoute with its FULL resolved dependency callable set.

    Not a source grep — this reads what FastAPI actually wired up, which is
    what decides who gets in. FastAPI 0.141 wraps an included router in a proxy
    object rather than flattening its routes into ``app.routes``, so the walk
    has to descend through ``original_router`` and re-apply the include prefix.
    """
    from fastapi.routing import APIRoute

    import app.main as main

    def walk(routes, prefix: str = ""):
        for route in routes:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                ctx = getattr(route, "include_context", None)
                yield from walk(
                    inner.routes, prefix + (getattr(ctx, "prefix", "") or "")
                )
            elif isinstance(route, APIRoute):
                yield prefix + route.path, route

    def dep_names(dependant, acc: set[str]) -> set[str]:
        for sub in dependant.dependencies:
            if sub.call is not None:
                acc.add(getattr(sub.call, "__name__", str(sub.call)))
            dep_names(sub, acc)
        return acc

    return [
        (path, route, dep_names(route.dependant, set()))
        for path, route in walk(main.app.routes)
    ]


# Computed once at import: the audit below is the single most important test in
# this file, and every class that asserts on the route table shares this view.
APP_ROUTES = _walk_app_routes()


def _stub_clock():
    """A monotonic() stand-in that makes the ws refresh tick fire immediately.

    The first call seeds ``last_refresh``; every call after it is far enough in
    the future that the 4-second gate opens on the first loop iteration.
    """
    state = {"n": 0}

    def _clock() -> float:
        state["n"] += 1
        return 0.0 if state["n"] == 1 else 1000.0

    return _clock


# NOTE: always patch ``handler.time`` (the module reference inside the handler),
# never ``time.monotonic`` itself. asyncio's event loop reads the real
# time.monotonic for every timer, so patching it globally wedges the loop and
# the test hangs instead of failing.


class _FakeSessionFactory:
    """``app.state.db_session_factory`` stand-in: callable, async-context.

    A bare MagicMock silently fails ``async with``, and the ws refresh block
    swallows exceptions — so a mock that "doesn't work" makes the loop spin
    forever instead of failing the test. This makes it work.
    """

    def __init__(self, db=None):
        self.db = db if db is not None else AsyncMock()

    def __call__(self):
        return self

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *exc):
        return False


def _member_user(**over) -> dict:
    user = {
        "sub": "kc-adam",
        "email": "adam@example.com",
        "username": "adam",
        "display_name": "Adam",
        "roles": [],
        "participant_type": "human",
        "participant_id": _uuid(),
    }
    user.update(over)
    return user


# ---------------------------------------------------------------------------
# 1. THE STRUCTURAL DEFAULT-DENY
# ---------------------------------------------------------------------------


class GetCurrentUserRejectsGuestsTests(IsolatedAsyncioTestCase):
    """``get_current_user`` must refuse a guest credential OUTRIGHT.

    ~100 routes name this dependency explicitly. If it ever accepts a guest
    token, a guest instantly reaches all of them — and every route written
    afterwards too. This is the assertion that keeps routes that do not exist
    yet safe by default.
    """

    async def _call(self, token: str):
        from app.deps import get_current_user

        return await get_current_user(
            _request({"Authorization": f"Bearer {token}"}),
            _settings(),
            AsyncMock(),
        )

    async def test_guest_session_token_is_rejected(self) -> None:
        from app.auth.guest_auth import mint_session_token

        with self.assertRaises(HTTPException) as ctx:
            await self._call(mint_session_token())
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Guest credentials are not accepted", ctx.exception.detail)

    async def test_guest_invite_token_is_rejected(self) -> None:
        """An INVITE token is not an API credential anywhere but /guest/redeem."""
        from app.auth.guest_auth import mint_invite_token

        with self.assertRaises(HTTPException) as ctx:
            await self._call(mint_invite_token())
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_rejection_happens_before_any_keycloak_call(self) -> None:
        """Refused BY NAME, not by accident of failing JWT validation.

        Relying on "a guest token happens not to parse as a JWT" would be an
        accident, not a boundary — and it would also mean every guest request
        paid for a JWKS lookup.
        """
        from app.auth.guest_auth import mint_session_token
        from app import deps

        with patch.object(deps, "validate_token", AsyncMock()) as validate:
            with self.assertRaises(HTTPException):
                await self._call(mint_session_token())
        validate.assert_not_awaited()

    async def test_a_normal_bearer_token_still_reaches_validation(self) -> None:
        """Sanity check on the guard: it must not reject ordinary members."""
        from app import deps
        from jose import JWTError

        with patch.object(
            deps, "validate_token", AsyncMock(side_effect=JWTError("nope"))
        ) as validate:
            with self.assertRaises(HTTPException) as ctx:
                await self._call("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.x.y")
        validate.assert_awaited_once()
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertNotIn("Guest credentials", ctx.exception.detail)


class RouterDefaultDenyTests(unittest.TestCase):
    """Walk the REAL app and pin the guest-reachable surface.

    Not a source grep — this reads the resolved dependency tree of every
    registered route, which is what actually decides who gets in.
    """

    # The complete, intended guest surface. Adding to this list is a
    # deliberate security decision; the test exists so it cannot be an
    # accidental one.
    EXPECTED_GUEST_ROUTES = {
        ("GET", "/api/v1/rooms/{room_id}/messages"),
        ("POST", "/api/v1/rooms/{room_id}/messages"),
        ("GET", "/api/v1/rooms/{room_id}/members"),
        ("POST", "/api/v1/tokens/livekit"),
        ("GET", "/api/v1/guest/me"),
        ("POST", "/api/v1/guest/leave"),
    }

    # Routes a guest must never reach, named explicitly because they are the
    # ones the feature brief calls out.
    FORBIDDEN_PATHS = {
        "/api/v1/rooms",  # room list
        "/api/v1/rooms/browse",  # channel browser
        "/api/v1/rooms/{room_id}/messages/search",  # room search
        "/api/v1/search/messages",  # instance-wide search
        "/api/v1/brigade/agents",  # agent roster
        "/api/v1/knowledge/collections",  # knowledge bases
        "/api/v1/uploads",  # uploads
        "/api/v1/users/directory",  # people directory
        "/api/v1/users/search",  # realm user search
        "/api/v1/agent-access/grants",  # entitlement admin
    }

    # Also unreachable, but guarded by a constant-time INTERNAL admin bearer
    # rather than by get_current_user — so it gets the guest assertion without
    # the get_current_user one.
    INTERNAL_ONLY_PATHS = {
        "/api/v1/gateway/keys",  # gateway key administration
    }

    routes = APP_ROUTES

    def test_the_app_actually_has_routes(self) -> None:
        # Guard against the walker silently finding nothing, which would make
        # every assertion below vacuously true.
        self.assertGreater(len(self.routes), 100)

    def test_exactly_these_routes_accept_a_guest(self) -> None:
        found = {
            (method, path)
            for path, route, names in self.routes
            if "get_guest_or_member" in names
            for method in route.methods
            if method != "HEAD"
        }
        self.assertEqual(
            found,
            self.EXPECTED_GUEST_ROUTES,
            "The guest-reachable route set changed. If that was deliberate, "
            "update EXPECTED_GUEST_ROUTES *and* re-read the scope rules in "
            "app/deps.py — every guest route needs a room scope check.",
        )

    def test_named_forbidden_routes_are_member_only(self) -> None:
        by_path = {path: names for path, _r, names in self.routes}
        for path in self.FORBIDDEN_PATHS:
            with self.subTest(path=path):
                self.assertIn(path, by_path, f"route vanished: {path}")
                self.assertNotIn("get_guest_or_member", by_path[path])
                self.assertIn(
                    "get_current_user",
                    by_path[path],
                    "must sit behind the guest-refusing dependency",
                )

    def test_internal_admin_routes_are_not_guest_reachable(self) -> None:
        by_path = {path: names for path, _r, names in self.routes}
        for path in self.INTERNAL_ONLY_PATHS:
            with self.subTest(path=path):
                self.assertIn(path, by_path, f"route vanished: {path}")
                self.assertNotIn("get_guest_or_member", by_path[path])
                self.assertNotIn("get_current_user", by_path[path])

    def test_no_route_uses_both_principal_dependencies(self) -> None:
        """A route naming both would authenticate twice with different rules."""
        for path, route, names in self.routes:
            if "get_guest_or_member" in names and "get_current_user" in names:
                self.fail(f"{path} mixes guest and member principal deps")

    def test_guest_reachable_routes_all_enforce_room_scope(self) -> None:
        """Every guest route must gate the room, one way or another.

        Either it takes ``require_room_member_or_guest`` (which checks the
        credential's room AND membership), or its handler calls
        ``ensure_guest_room_scope`` itself, or it is one of the two
        ``/guest/*`` self-service routes that are scoped by construction
        (they only ever read the caller's own session).
        """
        import inspect

        self_scoped = {"/api/v1/guest/me", "/api/v1/guest/leave"}
        for path, route, names in self.routes:
            if "get_guest_or_member" not in names:
                continue
            if path in self_scoped:
                continue
            with self.subTest(path=path):
                if "require_room_member_or_guest" in names:
                    continue
                source = inspect.getsource(route.endpoint)
                self.assertIn(
                    "ensure_guest_room_scope",
                    source,
                    f"{path} accepts guests but never checks their room scope",
                )


class RateLimitDependencyTests(unittest.TestCase):
    """``deps.rate_limit`` hard-depends on ``get_current_user``.

    Putting it on a guest-reachable route would 401 every guest AT THE RATE
    LIMITER even though the route's own principal dependency accepted them —
    the same trap that made it unusable on /broadcast/join.
    """

    def test_guest_routes_do_not_use_the_member_only_rate_limiter(self) -> None:
        for path, route, names in APP_ROUTES:
            if "get_guest_or_member" not in names:
                continue
            with self.subTest(path=path):
                self.assertNotIn("get_current_user", names)

    def test_rate_limit_principal_keys_on_derived_ids_not_the_secret(self) -> None:
        import inspect

        from app.deps import rate_limit_principal

        source = inspect.getsource(rate_limit_principal)
        # Both keys are read off the principal the session row produced.
        self.assertIn('identifier=str(user["participant_id"])', source)
        self.assertIn("identifier=str(invite_id)", source)
        # Never the presented credential: keying on the secret would hand an
        # attacker a fresh bucket for every guess.
        self.assertNotIn("token", source.split('"""')[-1])


class GuestInviteRateLimitTests(IsolatedAsyncioTestCase):
    """The per-participant limit is a per-REDEMPTION limit for a guest.

    Every redemption mints a fresh Participant, so an invite with unlimited
    ``max_uses`` bought the whole send rate again for each guest behind it —
    N redemptions, N x the rate, out of one link. The invite is the thing the
    owner minted, reasons about, and can revoke, so it is the thing that has to
    carry an aggregate budget.
    """

    @staticmethod
    async def _charge(user: dict, *, invite_attr: str | None):
        """Run the dependency and return the (bucket, identifier) pairs charged."""
        from app.deps import rate_limit_principal

        dep = rate_limit_principal(
            "msg_send", "rate_limit_message_send_per_min",
            invite_limit_attr=invite_attr,
        )
        charged: list[tuple[str, str, int]] = []

        async def _fake_hit(_redis, *, bucket, identifier, limit, **_kw):
            charged.append((bucket, identifier, limit))

        settings = _settings(
            rate_limit_enabled=True,
            rate_limit_message_send_per_min=60,
            rate_limit_guest_invite_send_per_min=300,
        )
        with patch("app.deps._rate_limit_hit", AsyncMock(side_effect=_fake_hit)):
            await dep(user, AsyncMock(), settings)
        return charged

    async def test_a_guest_is_charged_to_the_invite_as_well(self) -> None:
        user = _guest_user()
        charged = await self._charge(
            user, invite_attr="rate_limit_guest_invite_send_per_min"
        )
        self.assertEqual(
            charged,
            [
                ("msg_send", str(user["participant_id"]), 60),
                ("msg_send:invite", str(user["guest_invite_id"]), 300),
            ],
        )

    async def test_two_redemptions_of_one_invite_share_the_invite_budget(self) -> None:
        """THE BUG, stated as a test: two guests, two participants, ONE link."""
        invite = _uuid()
        first = _guest_user(invite_id=invite)
        second = _guest_user(invite_id=invite)
        self.assertNotEqual(first["participant_id"], second["participant_id"])

        a = await self._charge(first, invite_attr="rate_limit_guest_invite_send_per_min")
        b = await self._charge(second, invite_attr="rate_limit_guest_invite_send_per_min")
        # Different per-participant buckets (they are different people)...
        self.assertNotEqual(a[0][1], b[0][1])
        # ...but the SAME invite bucket, which is what bounds the link.
        self.assertEqual(a[1][1], b[1][1])
        self.assertEqual(a[1][1], str(invite))

    async def test_the_per_participant_limit_is_kept_not_replaced(self) -> None:
        """Collapsing to the invite key alone would let one chatty guest on a
        shared link starve everyone else redeemed from it."""
        charged = await self._charge(
            _guest_user(), invite_attr="rate_limit_guest_invite_send_per_min"
        )
        self.assertEqual(charged[0][0], "msg_send")
        self.assertEqual(len(charged), 2)

    async def test_a_member_is_never_charged_to_an_invite(self) -> None:
        """A member's dict carries no `guest_invite_id` at all, so the second
        charge is a no-op for them by construction."""
        charged = await self._charge(
            _member_user(), invite_attr="rate_limit_guest_invite_send_per_min"
        )
        self.assertEqual(len(charged), 1)
        self.assertEqual(charged[0][0], "msg_send")

    async def test_routes_that_do_not_opt_in_are_unchanged(self) -> None:
        charged = await self._charge(_guest_user(), invite_attr=None)
        self.assertEqual(len(charged), 1)

    def test_the_send_route_actually_opts_in(self) -> None:
        """The layering is worth nothing if the one guest-reachable write route
        does not ask for it."""
        import inspect

        from app.api import messages

        source = inspect.getsource(messages.send_message)
        self.assertIn(
            'invite_limit_attr="rate_limit_guest_invite_send_per_min"', source
        )

    def test_the_invite_bucket_inherits_fail_open_rather_than_re_deriving(self) -> None:
        """``msg_send:invite`` is not a member of ``_FAIL_CLOSED_BUCKETS`` and
        never will be — re-deriving from the suffixed name would silently give
        the invite bucket a different outage posture from the base bucket."""
        import inspect

        from app.deps import rate_limit_principal

        source = inspect.getsource(rate_limit_principal)
        self.assertEqual(source.count("fail_open=effective_fail_open"), 2)


# ---------------------------------------------------------------------------
# 2. ROOM SCOPE — a guest reaches exactly one room
# ---------------------------------------------------------------------------


class RoomScopeTests(IsolatedAsyncioTestCase):
    def test_guest_may_not_name_another_room(self) -> None:
        from app.deps import ensure_guest_room_scope

        mine, theirs = _uuid(), _uuid()
        user = _guest_user(room_id=mine)
        ensure_guest_room_scope(user, mine)  # own room: fine
        with self.assertRaises(HTTPException) as ctx:
            ensure_guest_room_scope(user, theirs)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_scope_check_is_a_noop_for_members(self) -> None:
        from app.deps import ensure_guest_room_scope

        # A member's reach is decided by membership, not by this check.
        ensure_guest_room_scope(_member_user(), _uuid())

    def test_string_and_uuid_room_ids_compare_equal(self) -> None:
        """A path param arrives as uuid.UUID; the session row may hand back a
        string. A type mismatch here would fail OPEN if written as `!=` on
        mixed types, so the comparison is on str() of both."""
        from app.deps import ensure_guest_room_scope

        room = _uuid()
        ensure_guest_room_scope(_guest_user(room_id=room), str(room))
        ensure_guest_room_scope(_guest_user(room_id=room), room)

    async def test_require_room_member_or_guest_refuses_foreign_room_before_db(
        self,
    ) -> None:
        """Scope is checked BEFORE the membership query, so a guest asking
        about someone else's room never even causes a lookup."""
        from app.deps import require_room_member_or_guest

        db = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            await require_room_member_or_guest(
                room_id=_uuid(), user=_guest_user(room_id=_uuid()), db=db
            )
        self.assertEqual(ctx.exception.status_code, 403)
        db.execute.assert_not_awaited()

    async def test_require_room_member_or_guest_still_requires_membership(self) -> None:
        """Scope alone is not enough: the ordinary membership row must exist
        too. Two gates, both required."""
        from app.deps import require_room_member_or_guest

        room = _uuid()
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))  # not a member
        with self.assertRaises(HTTPException) as ctx:
            await require_room_member_or_guest(
                room_id=room, user=_guest_user(room_id=room), db=db
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_guest_cannot_read_messages_in_another_room(self) -> None:
        from app.deps import require_room_member_or_guest

        with self.assertRaises(HTTPException) as ctx:
            await require_room_member_or_guest(
                room_id=_uuid(), user=_guest_user(room_id=_uuid()), db=AsyncMock()
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_guest_cannot_post_to_another_room(self) -> None:
        """send_message checks scope before it touches MessageService."""
        from app.api import messages as messages_api
        from app.schemas.message import MessageCreate

        svc = MagicMock()
        svc.send_message = AsyncMock()
        with patch.object(
            messages_api, "_build_message_service", return_value=svc
        ):
            with self.assertRaises(HTTPException) as ctx:
                await messages_api.send_message(
                    room_id=_uuid(),
                    body=MessageCreate(content="hello"),
                    user=_guest_user(room_id=_uuid()),
                    db=AsyncMock(),
                    livekit=AsyncMock(),
                    request=None,
                )
        self.assertEqual(ctx.exception.status_code, 403)
        svc.send_message.assert_not_awaited()


async def _send_message_as(user: dict, room_id: uuid.UUID):
    """Drive ``send_message`` with every side effect patched, and hand back the
    two that guest policy decides: the mention-email dispatcher and the agent
    scheduler. Shared by the suppression tests and the opt-in tests so both
    exercise the identical code path."""
    from app.api import messages as messages_api
    from app.schemas.message import MessageCreate

    msg = SimpleNamespace(id=_uuid())
    svc = MagicMock()
    svc.send_message = AsyncMock(return_value=msg)
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(redis=None, db_session_factory=None))
    )
    with (
        patch.object(messages_api, "_build_message_service", return_value=svc),
        patch.object(messages_api, "_msg_to_response", MagicMock(
            return_value=SimpleNamespace(model_dump=lambda **_: {})
        )),
        patch.object(messages_api, "_ws_broadcast_room", AsyncMock()),
        patch.object(messages_api, "_maybe_dispatch_mention_emails", AsyncMock()) as mail,
        patch.object(messages_api, "schedule_agent_chat_response", MagicMock()) as agent,
        patch.object(
            messages_api, "_agent_chat_within_budget", AsyncMock(return_value=True)
        ),
        patch.object(
            messages_api, "_find_recent_send_by_client_msg_id",
            AsyncMock(return_value=None),
        ),
        patch("app.services.agent_status.mark_relay_pending_for_room", AsyncMock()),
        patch("app.services.push_service.dispatch_message_pushes", AsyncMock()),
    ):
        await messages_api.send_message(
            room_id=room_id,
            body=MessageCreate(content="hello @adam"),
            user=user,
            db=AsyncMock(),
            livekit=AsyncMock(),
            request=request,
        )
    return mail, agent


class GuestSideEffectSuppressionTests(IsolatedAsyncioTestCase):
    """Posting as a guest must not reach the room's agent or send mail."""

    async def _send_as(self, user: dict, room_id: uuid.UUID):
        from app.api import messages as messages_api
        from app.schemas.message import MessageCreate

        msg = SimpleNamespace(id=_uuid())
        svc = MagicMock()
        svc.send_message = AsyncMock(return_value=msg)
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(redis=None, db_session_factory=None))
        )
        with (
            patch.object(messages_api, "_build_message_service", return_value=svc),
            patch.object(messages_api, "_msg_to_response", MagicMock(
                return_value=SimpleNamespace(model_dump=lambda **_: {})
            )),
            patch.object(messages_api, "_ws_broadcast_room", AsyncMock()),
            patch.object(
                messages_api, "_maybe_dispatch_mention_emails", AsyncMock()
            ) as mail,
            patch.object(
                messages_api, "schedule_agent_chat_response", MagicMock()
            ) as agent,
            patch.object(
                messages_api, "_agent_chat_within_budget", AsyncMock(return_value=True)
            ),
            patch.object(
                messages_api, "_find_recent_send_by_client_msg_id",
                AsyncMock(return_value=None),
            ),
            # Imported lazily inside send_message; patched at the source module
            # so the member path does not fire real side effects in tests.
            patch(
                "app.services.agent_status.mark_relay_pending_for_room", AsyncMock()
            ),
            patch("app.services.push_service.dispatch_message_pushes", AsyncMock()),
        ):
            await messages_api.send_message(
                room_id=room_id,
                body=MessageCreate(content="hello @adam"),
                user=user,
                db=AsyncMock(),
                livekit=AsyncMock(),
                request=request,
            )
        return mail, agent

    async def test_guest_message_never_triggers_the_room_agent(self) -> None:
        """A guest's text must not become the prompt for a room-bound agent
        holding that room's knowledge, tools, and paid budget."""
        room = _uuid()
        _mail, agent = await self._send_as(_guest_user(room_id=room), room)
        agent.assert_not_called()

    async def test_guest_message_never_sends_branded_email(self) -> None:
        """The mention-email template interpolates the sender's chosen display
        name and message text into HTML sent from our domain."""
        room = _uuid()
        mail, _agent = await self._send_as(_guest_user(room_id=room), room)
        mail.assert_not_awaited()

    async def test_member_message_still_does_both(self) -> None:
        """The suppression must be guest-specific, not a silent regression for
        everyone else."""
        room = _uuid()
        mail, agent = await self._send_as(_member_user(), room)
        mail.assert_awaited()
        agent.assert_called()


class GuestPerInviteOptInTests(IsolatedAsyncioTestCase):
    """The two side effects are now PER-INVITE, and still default OFF.

    Both directions of both flags are asserted, because "the opt-in works" and
    "the default is closed" are two different claims and only testing the first
    is how a default quietly inverts.
    """

    async def _send_as(self, user: dict, room_id: uuid.UUID):
        return await _send_message_as(user, room_id)

    # -- agent trigger -----------------------------------------------------

    async def test_default_guest_does_not_trigger_the_agent(self) -> None:
        room = _uuid()
        _mail, agent = await self._send_as(_guest_user(room_id=room), room)
        agent.assert_not_called()

    async def test_opted_in_guest_does_trigger_the_agent(self) -> None:
        room = _uuid()
        _mail, agent = await self._send_as(
            _guest_user(room_id=room, guest_allow_agent_trigger=True), room
        )
        agent.assert_called()

    # -- mention email -----------------------------------------------------

    async def test_default_guest_sends_no_mention_email(self) -> None:
        room = _uuid()
        mail, _agent = await self._send_as(_guest_user(room_id=room), room)
        mail.assert_not_awaited()

    async def test_opted_in_guest_does_send_mention_email(self) -> None:
        room = _uuid()
        mail, _agent = await self._send_as(
            _guest_user(room_id=room, guest_allow_mention_email=True), room
        )
        mail.assert_awaited()

    # -- the flags are independent ----------------------------------------

    async def test_the_two_flags_do_not_imply_each_other(self) -> None:
        """Opting a guest into the agent must not also open the mail path —
        they are different blast radii (this room vs the org's mail domain)."""
        room = _uuid()
        mail, agent = await self._send_as(
            _guest_user(room_id=room, guest_allow_agent_trigger=True), room
        )
        agent.assert_called()
        mail.assert_not_awaited()

        mail2, agent2 = await self._send_as(
            _guest_user(room_id=room, guest_allow_mention_email=True), room
        )
        mail2.assert_awaited()
        agent2.assert_not_called()

    # -- the closed default is structural, not just conventional -----------

    def test_a_principal_built_with_no_flags_is_closed(self) -> None:
        """Anything constructing a GuestPrincipal without naming the grants
        gets the refused answer, so a future call site cannot open them by
        forgetting them."""
        from app.auth.guest_auth import GuestPrincipal, guest_user_dict

        principal = GuestPrincipal(
            session_id=_uuid(),
            invite_id=_uuid(),
            room_id=_uuid(),
            participant_id=_uuid(),
            keycloak_sub=f"guest:{_uuid()}",
            username="guest-x",
            display_name="X",
            can_publish=True,
            expires_at=_now() + timedelta(hours=1),
        )
        self.assertFalse(principal.allow_agent_trigger)
        self.assertFalse(principal.allow_mention_email)
        user = guest_user_dict(principal)
        self.assertFalse(user["guest_allow_agent_trigger"])
        self.assertFalse(user["guest_allow_mention_email"])

    def test_the_columns_default_false_in_the_database_too(self) -> None:
        """A row written by any path that has not heard of these columns must
        be closed, not open — so the default lives in PG, not only in Python."""
        from app.models.guest_access import GuestInvite

        for name in ("allow_agent_trigger", "allow_mention_email"):
            with self.subTest(column=name):
                col = GuestInvite.__table__.columns[name]
                self.assertFalse(col.nullable)
                self.assertIn("false", str(col.server_default.arg).lower())

    async def test_the_grants_are_read_live_off_the_invite(self) -> None:
        """Not copied onto the session at redemption: an owner who unticks a
        grant has it off on the guest's very next request, not only for guests
        who redeem later."""
        from app.auth.gateway_auth import hash_key
        from app.auth.guest_auth import verify_guest_session

        raw = "sgs-" + "b" * 43
        session = SimpleNamespace(
            id=_uuid(), token_hash=hash_key(raw), invite_id=_uuid(),
            room_id=_uuid(), participant_id=_uuid(), display_name="T",
            can_publish=True, created_at=_now(),
            expires_at=_now() + timedelta(hours=1), revoked_at=None,
        )
        participant = SimpleNamespace(
            id=session.participant_id, keycloak_sub=f"guest:{_uuid()}",
            username="guest-x", display_name="T",
        )
        for opened in (True, False):
            with self.subTest(allow_agent_trigger=opened):
                db = AsyncMock()
                db.execute = AsyncMock(
                    side_effect=[
                        _scalar_result(session),
                        _scalar_result(_invite(allow_agent_trigger=opened)),
                        _scalar_result(participant),
                    ]
                )
                principal = await verify_guest_session(raw, db)
                self.assertEqual(principal.allow_agent_trigger, opened)


class GuestInviteMintSurfaceTests(IsolatedAsyncioTestCase):
    """The owner surface must expose the widenings on create AND on list —
    an invite whose extra powers are invisible afterwards cannot be audited."""

    async def _mint(self, **body_over):
        from app.api import guests as guests_api
        from app.models.room import MemberRole

        room_id = _uuid()
        user = _member_user()
        added: list = []
        db = AsyncMock()
        db.add = MagicMock(side_effect=added.append)
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(SimpleNamespace(id=room_id, display_name="R", name="r")),
                _scalar_result(SimpleNamespace(id=_uuid(), role=MemberRole.OWNER)),
            ]
        )
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        body = guests_api.MintInviteBody(**body_over)
        result = await guests_api.mint_guest_invite(
            room_id=room_id, body=body, user=user, db=db, settings=_settings()
        )
        return result, added[0]

    async def test_defaults_are_closed_and_history_starts_at_mint(self) -> None:
        before = _now()
        result, row = await self._mint()
        self.assertFalse(row.allow_agent_trigger)
        self.assertFalse(row.allow_mention_email)
        # Nothing said before the link existed.
        self.assertGreaterEqual(row.history_from, before - timedelta(seconds=5))
        self.assertLessEqual(row.history_from, _now() + timedelta(seconds=5))
        self.assertFalse(result["allow_agent_trigger"])
        self.assertFalse(result["allow_mention_email"])
        self.assertIn("history_from", result)

    async def test_flags_round_trip_onto_the_row_and_the_response(self) -> None:
        result, row = await self._mint(
            allow_agent_trigger=True, allow_mention_email=True
        )
        self.assertTrue(row.allow_agent_trigger)
        self.assertTrue(row.allow_mention_email)
        self.assertTrue(result["allow_agent_trigger"])
        self.assertTrue(result["allow_mention_email"])

    async def test_history_hours_widens_the_window_backwards(self) -> None:
        _result, row = await self._mint(history_hours=24)
        delta = _now() - row.history_from
        self.assertGreater(delta, timedelta(hours=23))
        self.assertLess(delta, timedelta(hours=25))

    async def test_history_all_is_the_only_way_to_the_whole_room(self) -> None:
        """The pre-hardening behaviour still exists, but has to be asked for."""
        _result, row = await self._mint(history_all=True)
        self.assertLess(row.history_from, _now() - timedelta(days=365 * 20))

    async def test_history_all_overrides_history_hours(self) -> None:
        _result, row = await self._mint(history_all=True, history_hours=2)
        self.assertLess(row.history_from, _now() - timedelta(days=365 * 20))

    def test_list_response_carries_the_widenings(self) -> None:
        from app.api.guests import GuestInviteInfo, _invite_info

        info = _invite_info(
            _invite(allow_agent_trigger=True, allow_mention_email=False)
        )
        for key in ("allow_agent_trigger", "allow_mention_email", "history_from"):
            self.assertIn(key, info)
        # The declared response model must actually carry them, or FastAPI
        # filters them straight back out of the list endpoint.
        for key in ("allow_agent_trigger", "allow_mention_email", "history_from"):
            self.assertIn(key, GuestInviteInfo.model_fields)


# ---------------------------------------------------------------------------
# 3. REDEMPTION — no oracle, clean refusals
# ---------------------------------------------------------------------------


def _invite(**over) -> SimpleNamespace:
    base = dict(
        id=_uuid(),
        token_prefix="sgi-abcdefgh",
        token_hash="x" * 64,
        room_id=_uuid(),
        passphrase_hash=None,
        can_publish=True,
        max_uses=None,
        use_count=0,
        label=None,
        created_at=_now(),
        expires_at=_now() + timedelta(hours=6),
        revoked_at=None,
        last_used_at=None,
        # The three per-invite widenings, at their DEFAULTS. Every fixture in
        # this file starts closed; a test that wants one open says so.
        allow_agent_trigger=False,
        allow_mention_email=False,
        history_from=_now(),
    )
    base.update(over)
    return SimpleNamespace(**base)


class RedemptionRefusalTests(IsolatedAsyncioTestCase):
    """Unknown / revoked / expired / exhausted / wrong-passphrase are ONE answer."""

    async def _redeem(self, *, execute_results: list, passphrase: str | None = None):
        from app.api import guests as guests_api

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=execute_results)
        body = guests_api.RedeemBody(
            token="sgi-" + "a" * 40, display_name="Trudy", passphrase=passphrase
        )
        return await guests_api.redeem_guest_invite(
            body=body,
            request=_request(),
            db=db,
            settings=_settings(),
            redis=None,
        )

    async def _refusal(self, **kw) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            await self._redeem(**kw)
        return ctx.exception

    async def test_unknown_token_is_a_clean_403(self) -> None:
        from app.api.guests import INVALID_LINK_DETAIL

        exc = await self._refusal(execute_results=[_scalar_result(None)])
        self.assertEqual(exc.status_code, 403)
        self.assertEqual(exc.detail, INVALID_LINK_DETAIL)

    async def test_expired_invite_is_a_clean_refusal_not_a_stack_trace(self) -> None:
        from app.api.guests import INVALID_LINK_DETAIL

        expired = _invite(expires_at=_now() - timedelta(minutes=1))
        exc = await self._refusal(execute_results=[_scalar_result(expired)])
        self.assertEqual(exc.status_code, 403)
        self.assertEqual(exc.detail, INVALID_LINK_DETAIL)

    async def test_naive_expiry_timestamp_does_not_explode(self) -> None:
        """asyncpg can hand back a naive datetime; comparing it to an aware
        `now()` raises TypeError, which would be a 500 instead of a refusal."""
        naive = (_now() - timedelta(minutes=1)).replace(tzinfo=None)
        exc = await self._refusal(execute_results=[_scalar_result(_invite(expires_at=naive))])
        self.assertEqual(exc.status_code, 403)

    async def test_revoked_invite_is_refused(self) -> None:
        exc = await self._refusal(
            execute_results=[_scalar_result(_invite(revoked_at=_now()))]
        )
        self.assertEqual(exc.status_code, 403)

    async def test_wrong_passphrase_and_unknown_token_are_indistinguishable(
        self,
    ) -> None:
        """The load-bearing anti-oracle property: an attacker must not be able
        to learn that a token EXISTS by observing the response."""
        from app.auth.guest_auth import hash_passphrase

        protected = _invite(passphrase_hash=hash_passphrase("correct horse"))
        wrong = await self._refusal(
            execute_results=[_scalar_result(protected)], passphrase="wrong horse"
        )
        unknown = await self._refusal(execute_results=[_scalar_result(None)])

        self.assertEqual(wrong.status_code, unknown.status_code)
        self.assertEqual(wrong.detail, unknown.detail)
        self.assertEqual(wrong.headers, unknown.headers)

    async def test_exhausted_invite_is_refused(self) -> None:
        """max_uses is enforced by the atomic UPDATE: no row back = no seat."""
        full = _invite(max_uses=1, use_count=1)
        exc = await self._refusal(
            execute_results=[
                _scalar_result(full),  # invite lookup
                _scalar_result(SimpleNamespace(id=full.room_id, display_name="Show", name="show")),
                _scalar_result(None),  # conditional UPDATE claimed nothing
            ]
        )
        self.assertEqual(exc.status_code, 403)

    async def test_disabled_feature_is_a_404_not_a_403(self) -> None:
        """The kill switch hides the surface entirely rather than advertising
        a disabled one."""
        from app.api import guests as guests_api

        body = guests_api.RedeemBody(token="sgi-" + "a" * 40)
        with self.assertRaises(HTTPException) as ctx:
            await guests_api.redeem_guest_invite(
                body=body,
                request=_request(),
                db=AsyncMock(),
                settings=_settings(guest_access_enabled=False),
                redis=None,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_redemption_rate_limit_is_ip_keyed_and_fails_closed(self) -> None:
        from app.api import guests as guests_api

        seen: dict = {}

        async def _fake_hit(redis, **kw):
            seen.update(kw)

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        body = guests_api.RedeemBody(token="sgi-" + "a" * 40)
        with patch.object(guests_api, "_rate_limit_hit", AsyncMock(side_effect=_fake_hit)):
            with self.assertRaises(HTTPException):
                await guests_api.redeem_guest_invite(
                    body=body,
                    request=_request(client_host="9.9.9.9"),
                    db=db,
                    settings=_settings(rate_limit_enabled=True),
                    redis=AsyncMock(),
                )
        self.assertEqual(seen["bucket"], "guest_redeem")
        self.assertEqual(seen["identifier"], "9.9.9.9")
        # Never keyed on the presented secret — that would hand an attacker a
        # fresh bucket for every guess.
        self.assertNotIn("sgi-", str(seen["identifier"]))
        self.assertFalse(seen["fail_open"], "the one unauthenticated endpoint fails closed")


class RedemptionSuccessTests(IsolatedAsyncioTestCase):
    """The happy path, asserted for the SHAPE of what it creates."""

    async def _redeem(self, invite, *, display_name="  Ada   Lovelace  "):
        from app.api import guests as guests_api

        room = SimpleNamespace(
            id=invite.room_id, display_name="Build In Public", name="bip"
        )
        added: list = []
        db = AsyncMock()
        db.add = MagicMock(side_effect=added.append)
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(invite),
                _scalar_result(room),
                _scalar_result(1),  # atomic seat claim
            ]
        )

        async def _flush():
            for obj in added:
                if getattr(obj, "id", None) is None:
                    obj.id = _uuid()

        db.flush = AsyncMock(side_effect=_flush)
        db.commit = AsyncMock(side_effect=_flush)
        db.refresh = AsyncMock()
        body = guests_api.RedeemBody(
            token="sgi-" + "a" * 40, display_name=display_name
        )
        with patch("app.api.rooms._broadcast_members_changed", AsyncMock()):
            result = await guests_api.redeem_guest_invite(
                body=body, request=_request(), db=db, settings=_settings(), redis=None
            )
        return result, added

    async def test_creates_a_guest_typed_participant_with_a_synthetic_sub(
        self,
    ) -> None:
        from app.models.participant import Participant, ParticipantType

        _res, added = await self._redeem(_invite())
        participants = [o for o in added if isinstance(o, Participant)]
        self.assertEqual(len(participants), 1)
        guest = participants[0]
        self.assertEqual(guest.participant_type, ParticipantType.GUEST)
        self.assertTrue(guest.keycloak_sub.startswith("guest:"))
        # No underscore: webhooks._extract_participant_id parses a LiveKit
        # identity as `username_<uuid>` with rsplit("_", 1).
        self.assertNotIn("_", guest.username)

    async def test_joins_the_room_with_the_pre_carved_guest_role(self) -> None:
        from app.models.room import MemberRole, RoomMember

        invite = _invite()
        _res, added = await self._redeem(invite)
        members = [o for o in added if isinstance(o, RoomMember)]
        self.assertEqual(len(members), 1)
        self.assertEqual(members[0].role, MemberRole.GUEST)
        self.assertEqual(members[0].room_id, invite.room_id)

    async def test_session_token_is_returned_once_and_only_hashed_at_rest(
        self,
    ) -> None:
        from app.auth.gateway_auth import hash_key
        from app.models.guest_access import GuestSession

        _res, added = await self._redeem(_invite())
        sessions = [o for o in added if isinstance(o, GuestSession)]
        self.assertEqual(len(sessions), 1)
        raw = _res["session_token"]
        self.assertTrue(raw.startswith("sgs-"))
        self.assertEqual(sessions[0].token_hash, hash_key(raw))
        self.assertNotIn(raw, sessions[0].token_hash)
        self.assertNotIn(raw, sessions[0].token_prefix)

    async def test_session_never_outlives_its_invite(self) -> None:
        from app.models.guest_access import GuestSession

        short = _invite(expires_at=_now() + timedelta(minutes=30))
        _res, added = await self._redeem(short)
        session = [o for o in added if isinstance(o, GuestSession)][0]
        self.assertLessEqual(session.expires_at, short.expires_at)

    async def test_session_is_capped_even_on_a_week_long_invite(self) -> None:
        from app.models.guest_access import GuestSession

        long_lived = _invite(expires_at=_now() + timedelta(days=7))
        _res, added = await self._redeem(long_lived)
        session = [o for o in added if isinstance(o, GuestSession)][0]
        self.assertLess(session.expires_at, _now() + timedelta(hours=13))

    async def test_display_name_is_sanitized_before_it_is_stored(self) -> None:
        from app.models.participant import Participant

        _res, added = await self._redeem(_invite(), display_name="  Ada   Lovelace  ")
        guest = [o for o in added if isinstance(o, Participant)][0]
        self.assertEqual(guest.display_name, "Ada Lovelace")

    async def test_watch_only_invite_produces_a_watch_only_session(self) -> None:
        from app.models.guest_access import GuestSession

        res, added = await self._redeem(_invite(can_publish=False))
        session = [o for o in added if isinstance(o, GuestSession)][0]
        self.assertFalse(session.can_publish)
        self.assertFalse(res["can_publish"])


class AtomicSeatClaimTests(unittest.TestCase):
    def test_max_uses_is_enforced_in_the_database_not_in_python(self) -> None:
        """A read-then-write would let two guests race through the last seat of
        a max_uses=1 link."""
        import inspect

        from app.api.guests import redeem_guest_invite

        source = inspect.getsource(redeem_guest_invite)
        self.assertIn("UPDATE guest_invites", source)
        self.assertIn("use_count < max_uses", source)
        self.assertIn("RETURNING use_count", source)
        # The same statement re-checks revocation and expiry, so a revoke
        # landing mid-redemption also loses the race.
        self.assertIn("revoked_at IS NULL", source)
        self.assertIn("expires_at > now()", source)


# ---------------------------------------------------------------------------
# 4. PASSPHRASE HANDLING
# ---------------------------------------------------------------------------


class PassphraseTests(unittest.TestCase):
    def test_never_stored_in_plaintext(self) -> None:
        from app.auth.guest_auth import hash_passphrase

        stored = hash_passphrase("correct horse battery staple")
        self.assertNotIn("correct horse", stored)
        self.assertTrue(stored.startswith("pbkdf2_sha256$"))

    def test_salted_so_two_identical_passphrases_hash_differently(self) -> None:
        from app.auth.guest_auth import hash_passphrase

        self.assertNotEqual(hash_passphrase("hunter2"), hash_passphrase("hunter2"))

    def test_round_trips_and_rejects_the_wrong_one(self) -> None:
        from app.auth.guest_auth import hash_passphrase, verify_passphrase

        stored = hash_passphrase("hunter2")
        self.assertTrue(verify_passphrase("hunter2", stored))
        self.assertFalse(verify_passphrase("hunter3", stored))
        self.assertFalse(verify_passphrase("", stored))

    def test_malformed_or_missing_record_is_false_not_an_exception(self) -> None:
        from app.auth.guest_auth import verify_passphrase

        for bad in (None, "", "garbage", "pbkdf2_sha256$notanint$aa$bb", "a$b$c$d"):
            with self.subTest(stored=bad):
                self.assertFalse(verify_passphrase("x", bad))

    def test_comparison_is_constant_time(self) -> None:
        import inspect

        from app.auth import guest_auth

        self.assertIn(
            "hmac.compare_digest", inspect.getsource(guest_auth.verify_passphrase)
        )

    def test_burn_does_the_same_work_and_can_never_succeed(self) -> None:
        """The unknown-token path must cost what a real check costs, or the
        endpoint becomes a timing oracle for token existence."""
        import time

        from app.auth.guest_auth import burn_passphrase_time, hash_passphrase, verify_passphrase

        stored = hash_passphrase("hunter2")

        t0 = time.perf_counter()
        verify_passphrase("hunter2", stored)
        real = time.perf_counter() - t0

        t0 = time.perf_counter()
        burn_passphrase_time("hunter2")
        burned = time.perf_counter() - t0

        # Same order of magnitude — this is a smoke test for "we actually did
        # the KDF", not a precise timing measurement.
        self.assertGreater(burned, real / 4)
        self.assertIsNone(burn_passphrase_time("anything"))

    def test_iteration_count_is_not_token(self) -> None:
        from app.auth import guest_auth

        self.assertGreaterEqual(guest_auth._PBKDF2_ITERATIONS, 100_000)


# ---------------------------------------------------------------------------
# 5. REVOCATION + THE FORCE-CLOSE PRIMITIVE
# ---------------------------------------------------------------------------


class ForceDisconnectPrimitiveTests(IsolatedAsyncioTestCase):
    """Before this, the server had NO way to hang up on a live socket.

    `room_revoked` only unsubscribes a channel and mutates the authorizing
    room_ids list; ConnectionManager.disconnect only pops a dict; the real
    close lives in the endpoint's `finally`. A revoked guest would have kept a
    live, silent connection that still looked connected.
    """

    async def test_publishes_on_the_per_participant_channel(self) -> None:
        from app.ws.handler import FORCE_DISCONNECT_EVENT, publish_force_disconnect

        redis = AsyncMock()
        pid = str(_uuid())
        await publish_force_disconnect(redis, pid, reason="guest_invite_revoked")
        channel, payload = redis.publish.await_args.args
        self.assertEqual(channel, f"user:{pid}")
        data = json.loads(payload)
        self.assertEqual(data["type"], FORCE_DISCONNECT_EVENT)
        self.assertEqual(data["reason"], "guest_invite_revoked")

    async def test_never_raises_when_redis_is_down(self) -> None:
        """Revocation already stands in the database; the fan-out is the fast
        path, not the boundary, so it must not turn a revoke into a 500."""
        from app.ws.handler import publish_force_disconnect

        redis = AsyncMock()
        redis.publish = AsyncMock(side_effect=RuntimeError("redis is gone"))
        await publish_force_disconnect(redis, str(_uuid()), reason="x")

    async def test_forward_loop_sends_session_ended_then_breaks(self) -> None:
        """The break is what makes the close happen: it completes the pubsub
        task, which trips the endpoint's asyncio.wait(FIRST_COMPLETED) and runs
        the existing teardown."""
        from app.ws import handler as H

        messages = [
            {
                "type": "message",
                "data": json.dumps(
                    {"type": H.FORCE_DISCONNECT_EVENT, "reason": "guest_invite_revoked"}
                ),
            }
        ]

        class FakePubSub:
            def __init__(self):
                self.unsubscribed = False

            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                self.unsubscribed = True

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                return messages.pop(0) if messages else {"type": "none"}

        pubsub = FakePubSub()
        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=pubsub)
        sent: list = []
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        ws.send_json = AsyncMock(side_effect=lambda d: sent.append(d))

        # Must RETURN (not hang): the break is the whole point.
        await asyncio.wait_for(
            H._subscribe_to_rooms(redis, [str(_uuid())], ws, "p1", None),
            timeout=5,
        )
        self.assertEqual(sent, [{"type": "session_ended", "reason": "guest_invite_revoked"}])
        self.assertTrue(pubsub.unsubscribed)


class TerminateSessionsTests(IsolatedAsyncioTestCase):
    """Revoking must be true in four layers, not one."""

    async def _terminate(self):
        from app.api import guests as guests_api
        from app.models.guest_access import GuestSession

        participant_id = _uuid()
        session = GuestSession(
            id=_uuid(),
            token_hash="h" * 64,
            token_prefix="sgs-abc",
            invite_id=_uuid(),
            room_id=_uuid(),
            participant_id=participant_id,
            display_name="Trudy",
            can_publish=True,
            expires_at=_now() + timedelta(hours=1),
        )
        room = SimpleNamespace(
            id=session.room_id, livekit_room_name="stable-bip", display_name="BIP"
        )
        participant = SimpleNamespace(id=participant_id, username="guest-deadbeef")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalars_result([participant]))
        redis = AsyncMock()
        livekit = AsyncMock()
        with (
            patch("app.api.rooms._broadcast_members_changed", AsyncMock()),
            patch.object(guests_api, "publish_force_disconnect", AsyncMock()) as fd,
        ):
            count = await guests_api._terminate_sessions(
                db, redis, livekit, room, [session], reason="guest_invite_revoked"
            )
        return count, session, db, redis, livekit, fd, participant

    async def test_marks_the_row_revoked_first(self) -> None:
        """Layer 1 is the authoritative one: every later request fails on it,
        so it must be committed before the best-effort fan-out."""
        count, session, db, *_ = await self._terminate()
        self.assertEqual(count, 1)
        self.assertIsNotNone(session.revoked_at)
        db.commit.assert_awaited()

    async def test_deletes_the_room_membership(self) -> None:
        _count, _s, db, *_ = await self._terminate()
        statements = [str(c.args[0]) for c in db.execute.await_args_list]
        self.assertTrue(
            any("DELETE FROM room_members" in s for s in statements),
            f"expected a membership delete, got: {statements}",
        )

    async def test_fires_the_force_disconnect(self) -> None:
        _c, session, _db, _r, _lk, fd, _p = await self._terminate()
        fd.assert_awaited_once()
        self.assertEqual(fd.await_args.args[1], str(session.participant_id))

    async def test_evicts_from_livekit_with_the_canonical_identity(self) -> None:
        """Rebuilt with the shared helper, not a second copy of the f-string —
        a drifted identity would make eviction a silent no-op."""
        from app.api.tokens import livekit_identity

        _c, _s, _db, _r, livekit, _fd, participant = await self._terminate()
        livekit.remove_participant.assert_awaited_once()
        kwargs = livekit.remove_participant.await_args.kwargs
        self.assertEqual(kwargs["room_name"], "stable-bip")
        self.assertEqual(
            kwargs["identity"], livekit_identity(participant.username, participant.id)
        )

    async def test_a_livekit_outage_does_not_undo_the_revocation(self) -> None:
        from app.api import guests as guests_api
        from app.models.guest_access import GuestSession

        session = GuestSession(
            id=_uuid(), token_hash="h" * 64, token_prefix="sgs-abc",
            invite_id=_uuid(), room_id=_uuid(), participant_id=_uuid(),
            display_name="Trudy", can_publish=True,
            expires_at=_now() + timedelta(hours=1),
        )
        room = SimpleNamespace(id=session.room_id, livekit_room_name="r", display_name="R")
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [SimpleNamespace(id=session.participant_id, username="guest-x")]
            )
        )
        livekit = AsyncMock()
        livekit.remove_participant = AsyncMock(side_effect=RuntimeError("livekit down"))
        with patch("app.api.rooms._broadcast_members_changed", AsyncMock()):
            count = await guests_api._terminate_sessions(
                db, AsyncMock(), livekit, room, [session], reason="x"
            )
        self.assertEqual(count, 1)
        self.assertIsNotNone(session.revoked_at)


class CredentialRevocationCascadeTests(IsolatedAsyncioTestCase):
    """Revoking the INVITE must kill sessions already derived from it — checked
    on every request, so it holds even if the socket fan-out was missed."""

    async def _verify(self, session_over: dict, invite_over: dict):
        from app.auth.gateway_auth import hash_key
        from app.auth.guest_auth import GuestAuthError, verify_guest_session

        raw = "sgs-" + "a" * 43
        fields = dict(
            id=_uuid(),
            token_hash=hash_key(raw),
            invite_id=_uuid(),
            room_id=_uuid(),
            participant_id=_uuid(),
            display_name="Trudy",
            can_publish=True,
            expires_at=_now() + timedelta(hours=1),
            revoked_at=None,
        )
        fields.update(session_over)
        session = SimpleNamespace(**fields)
        invite = _invite(**invite_over)
        participant = SimpleNamespace(
            id=session.participant_id,
            keycloak_sub=f"guest:{_uuid()}",
            username="guest-x",
            display_name="Trudy",
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(session),
                _scalar_result(invite),
                _scalar_result(participant),
            ]
        )
        try:
            return await verify_guest_session(raw, db), None
        except GuestAuthError as exc:
            return None, exc

    async def test_healthy_session_resolves(self) -> None:
        principal, exc = await self._verify({}, {})
        self.assertIsNone(exc)
        self.assertIsNotNone(principal)

    async def test_revoked_invite_kills_a_healthy_session(self) -> None:
        principal, exc = await self._verify({}, {"revoked_at": _now()})
        self.assertIsNone(principal)
        self.assertEqual(exc.status_code, 401)

    async def test_expired_invite_kills_a_healthy_session(self) -> None:
        principal, exc = await self._verify(
            {}, {"expires_at": _now() - timedelta(minutes=1)}
        )
        self.assertIsNone(principal)

    async def test_revoked_session_is_refused(self) -> None:
        principal, exc = await self._verify({"revoked_at": _now()}, {})
        self.assertIsNone(principal)

    async def test_expired_session_is_refused(self) -> None:
        principal, exc = await self._verify(
            {"expires_at": _now() - timedelta(minutes=1)}, {}
        )
        self.assertIsNone(principal)

    async def test_every_failure_returns_the_same_detail(self) -> None:
        details = set()
        for session_over, invite_over in (
            ({"revoked_at": _now()}, {}),
            ({"expires_at": _now() - timedelta(minutes=1)}, {}),
            ({}, {"revoked_at": _now()}),
            ({}, {"expires_at": _now() - timedelta(minutes=1)}),
        ):
            _p, exc = await self._verify(session_over, invite_over)
            details.add((exc.status_code, exc.detail))
        self.assertEqual(len(details), 1, f"guest auth leaks a reason: {details}")

    async def test_an_unknown_token_is_refused_without_a_row(self) -> None:
        from app.auth.guest_auth import GuestAuthError, verify_guest_session

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        with self.assertRaises(GuestAuthError):
            await verify_guest_session("sgs-" + "z" * 43, db)

    async def test_a_non_guest_prefix_is_refused_without_touching_the_db(self) -> None:
        from app.auth.guest_auth import GuestAuthError, verify_guest_session

        db = AsyncMock()
        with self.assertRaises(GuestAuthError):
            await verify_guest_session("sbk-not-a-guest-token", db)
        db.execute.assert_not_awaited()


class OwnerOnlyManagementTests(IsolatedAsyncioTestCase):
    """Minting a guest link is an OWNER act, not a member act."""

    async def _owner_check(self, role):
        from app.api import guests as guests_api
        from app.models.room import MemberRole

        room_id = _uuid()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(SimpleNamespace(id=room_id, display_name="R", name="r")),
                _scalar_result(
                    None if role is None else SimpleNamespace(id=_uuid(), role=role)
                ),
            ]
        )
        return await guests_api._require_room_owner(db, room_id, _member_user())

    async def test_non_member_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._owner_check(None)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_plain_member_is_refused(self) -> None:
        from app.models.room import MemberRole

        with self.assertRaises(HTTPException) as ctx:
            await self._owner_check(MemberRole.MEMBER)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("owner", ctx.exception.detail.lower())

    async def test_admin_is_refused(self) -> None:
        """Deliberately stricter than other moderation: a guest link exposes
        the room's whole history plus live camera to an outsider."""
        from app.models.room import MemberRole

        with self.assertRaises(HTTPException) as ctx:
            await self._owner_check(MemberRole.ADMIN)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_owner_passes(self) -> None:
        from app.models.room import MemberRole

        room = await self._owner_check(MemberRole.OWNER)
        self.assertIsNotNone(room)

    async def test_a_guest_can_never_mint_an_invite(self) -> None:
        """Belt and braces on top of the dependency: mint sits behind
        get_current_user, which refuses guest credentials outright."""
        import typing

        import app.api.guests as G

        hints = typing.get_type_hints(
            G.mint_guest_invite, include_extras=True, globalns=vars(G)
        )
        deps = [
            getattr(meta.dependency, "__name__", "")
            for ann in hints.values()
            for meta in getattr(ann, "__metadata__", ())
            if getattr(meta, "dependency", None) is not None
        ]
        self.assertIn("get_current_user", deps)
        self.assertNotIn("get_guest_or_member", deps)


# ---------------------------------------------------------------------------
# 6. PARTICIPANT TYPE — guests stay out of the instance-wide directory
# ---------------------------------------------------------------------------


class ParticipantTypeTests(unittest.TestCase):
    def test_guest_is_a_third_kind_not_a_flavour_of_human(self) -> None:
        from app.models.participant import ParticipantType

        self.assertEqual(ParticipantType.GUEST.value, "guest")
        self.assertNotEqual(ParticipantType.GUEST, ParticipantType.HUMAN)
        self.assertNotEqual(ParticipantType.GUEST, ParticipantType.AGENT)

    def test_member_role_guest_needed_no_migration(self) -> None:
        from app.models.room import MemberRole

        self.assertEqual(MemberRole.GUEST.value, "guest")

    def test_migration_adds_the_pg_enum_value_idempotently(self) -> None:
        """The Python enum and the PG type must agree, or the first guest
        INSERT fails at runtime rather than at deploy."""
        import importlib.util
        import pathlib

        path = (
            pathlib.Path(__file__).resolve().parent.parent
            / "alembic"
            / "versions"
            / "014_guest_access.py"
        )
        source = path.read_text()
        self.assertIn(
            "ALTER TYPE participant_type_enum ADD VALUE IF NOT EXISTS 'guest'", source
        )
        spec = importlib.util.spec_from_file_location("m014", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.down_revision, "013_broadcast_tokens")
        # alembic_version.version_num is varchar(32); a 33-char id once rolled
        # back an entire migration at the version stamp.
        self.assertLessEqual(len(module.revision), 32)


class PeopleDirectoryExclusionTests(IsolatedAsyncioTestCase):
    """``people_directory`` is INSTANCE-WIDE, not room-scoped.

    A guest leaking into it would put every stranger who ever joined one call
    into every user's People drawer, permanently.
    """

    async def _captured_statement(self):
        from app.api import users as users_api

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalars_result([]))
        presence = AsyncMock()
        presence.get_statuses = AsyncMock(return_value={})
        await users_api.people_directory(
            user=_member_user(), db=db, presence=presence, q="", limit=10
        )
        return db.execute.await_args.args[0]

    async def test_directory_query_filters_to_humans_only(self) -> None:
        stmt = await self._captured_statement()
        compiled = str(
            stmt.compile(
                dialect=__import__(
                    "sqlalchemy.dialects.postgresql", fromlist=["dialect"]
                ).dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertIn("participant_type", compiled)
        self.assertIn("'human'", compiled)
        # …and 'guest' is a different literal, so a guest row cannot match.
        from app.models.participant import ParticipantType

        self.assertNotEqual(ParticipantType.GUEST.value, "human")

    def test_all_three_human_only_sites_in_users_py_are_intact(self) -> None:
        """Aaron's recon named three: the favourites validator, the directory,
        and the realm user search. All three must keep the filter."""
        import inspect

        from app.api import users as users_api

        source = inspect.getsource(users_api)
        self.assertEqual(
            source.count("Participant.participant_type == ParticipantType.HUMAN"),
            3,
            "a `== HUMAN` filter was added or removed in api/users.py — "
            "check whether guests can now leak into that surface",
        )

    def test_mention_email_and_push_targeting_also_exclude_guests(self) -> None:
        import inspect

        from app.api import messages as messages_api
        from app.services import push_service

        self.assertIn(
            "_PT.HUMAN",
            inspect.getsource(messages_api._maybe_dispatch_mention_emails),
        )
        self.assertIn(
            "ParticipantType.HUMAN", inspect.getsource(push_service)
        )

    def test_email_identity_linking_can_never_claim_a_guest(self) -> None:
        """A guest must never be linked to a Keycloak persona by email — that
        would promote a stranger into a real suite identity."""
        import inspect

        from app.services import participant_identity

        # The HUMAN filter lives in the candidate query the linker calls.
        self.assertIn(
            "ParticipantType.HUMAN",
            inspect.getsource(participant_identity._email_match_candidates),
        )


# ---------------------------------------------------------------------------
# 7. UNTRUSTED DISPLAY NAMES
# ---------------------------------------------------------------------------


class DisplayNameTests(unittest.TestCase):
    def test_length_is_hard_capped(self) -> None:
        from app.auth.guest_auth import MAX_DISPLAY_NAME, clean_display_name

        self.assertEqual(len(clean_display_name("A" * 500)), MAX_DISPLAY_NAME)
        self.assertLessEqual(MAX_DISPLAY_NAME, 64)

    def test_empty_and_whitespace_fall_back(self) -> None:
        from app.auth.guest_auth import clean_display_name

        self.assertEqual(clean_display_name(None), "Guest")
        self.assertEqual(clean_display_name("   "), "Guest")
        self.assertEqual(clean_display_name(""), "Guest")

    def test_invisible_and_bidi_characters_are_stripped(self) -> None:
        """Zero-width and RTL-override characters are how "Aaron" and "Aaron"
        become different strings, or how a name renders reversed in a roster."""
        from app.auth.guest_auth import clean_display_name

        self.assertEqual(clean_display_name("Aa​ron"), "Aaron")
        self.assertEqual(clean_display_name("‮Aaron"), "Aaron")
        self.assertEqual(clean_display_name("A﻿aron"), "Aaron")

    def test_control_characters_and_newlines_are_stripped(self) -> None:
        from app.auth.guest_auth import clean_display_name

        self.assertEqual(clean_display_name("Ada\nLovelace"), "Ada Lovelace")
        self.assertEqual(clean_display_name("Ada\x00Lovelace"), "AdaLovelace")

    def test_authorization_never_keys_on_the_name(self) -> None:
        """The name is data to render. Everything authorizing keys on ids."""
        import inspect

        from app import deps

        source = inspect.getsource(deps.ensure_guest_room_scope)
        self.assertIn("guest_room_id", source)
        self.assertNotIn("display_name", source)


# ---------------------------------------------------------------------------
# 8. WEBSOCKET
# ---------------------------------------------------------------------------


class GuestWebSocketTests(IsolatedAsyncioTestCase):
    async def test_guest_token_never_reaches_keycloak_validation(self) -> None:
        """Guests hold no realm token. Sending one to validate_token would be a
        pointless JWKS round-trip AND, worse, an invitation to later "fix" it
        by making the realm accept guests."""
        from app.ws import handler as H

        ws = MagicMock()
        with (
            patch.object(H, "validate_token", AsyncMock()) as validate,
            patch.object(H, "_authenticate_guest_ws", AsyncMock(return_value={"sub": "guest:1"})) as guest,
        ):
            result = await H._authenticate_ws(ws, "sgs-" + "a" * 43)
        validate.assert_not_awaited()
        guest.assert_awaited_once()
        self.assertEqual(result["sub"], "guest:1")

    async def test_member_token_still_goes_to_keycloak(self) -> None:
        from app.ws import handler as H

        ws = MagicMock()
        with (
            patch.object(H, "validate_token", AsyncMock(return_value={"sub": "kc-1"})),
            patch.object(H, "extract_user_identity", MagicMock(return_value={"sub": "kc-1"})),
            patch.object(H, "_authenticate_guest_ws", AsyncMock()) as guest,
        ):
            result = await H._authenticate_ws(ws, "eyJhbGciOi.x.y")
        guest.assert_not_awaited()
        self.assertEqual(result["sub"], "kc-1")

    async def test_guest_ws_auth_is_refused_when_the_feature_is_off(self) -> None:
        from app.ws import handler as H

        with patch.object(
            H, "get_settings", MagicMock(return_value=_settings(guest_access_enabled=False))
        ):
            self.assertIsNone(await H._authenticate_guest_ws(MagicMock(), "sgs-x"))

    async def test_room_ceiling_blocks_a_late_membership_from_widening_scope(
        self,
    ) -> None:
        """The refresh loop re-derives membership every 4s and subscribes to
        anything new. Without the ceiling, a membership row appearing later
        would quietly undo the credential's room scope."""
        from app.ws import handler as H

        allowed, sneaky = str(_uuid()), str(_uuid())
        subscribed: list = []

        class FakePubSub:
            async def subscribe(self, *a):
                subscribed.extend(a)

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()

        with patch.object(
            H, "_get_user_room_ids", AsyncMock(return_value=[allowed, sneaky])
        ):
            room_ids = [allowed]
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(
                    redis, room_ids, ws, "p1", {allowed}
                )
        self.assertIn(f"room:{allowed}", subscribed)
        self.assertNotIn(f"room:{sneaky}", subscribed)
        self.assertEqual(room_ids, [allowed])

    async def test_socket_ends_when_the_guest_session_dies(self) -> None:
        """HTTP re-checks the credential on every request; a socket
        authenticates ONCE and lives for hours. Without this tick an EXPIRED
        guest would keep receiving the room until their browser closed, and a
        revoked one would survive any Redis hiccup that swallowed the
        force-disconnect message."""
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                return {"type": "none"}

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        sent: list = []
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        ws.send_json = AsyncMock(side_effect=lambda d: sent.append(d))
        room = str(_uuid())

        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "guest_session_is_live", AsyncMock(return_value=False)),
            # Force the periodic tick to run on the very first pass.
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            await asyncio.wait_for(
                H._subscribe_to_rooms(
                    redis, [room], ws, "p1", {room}, "session-1"
                ),
                timeout=5,
            )
        self.assertEqual(
            sent, [{"type": "session_ended", "reason": "guest_session_ended"}]
        )

    async def test_socket_survives_while_the_session_is_live(self) -> None:
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "guest_session_is_live", AsyncMock(return_value=True)),
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(
                    redis, [room], ws, "p1", {room}, "session-1"
                )

    async def test_liveness_check_requires_both_session_and_invite(self) -> None:
        """A revoked INVITE must kill a session that is itself still healthy."""
        import inspect

        from app.auth import guest_auth

        source = inspect.getsource(guest_auth.guest_session_is_live)
        self.assertIn("GuestInvite.revoked_at.is_(None)", source)
        self.assertIn("GuestInvite.expires_at > now", source)
        self.assertIn("GuestSession.revoked_at.is_(None)", source)
        self.assertIn("GuestSession.expires_at > now", source)

    async def test_a_db_blip_in_the_liveness_check_fails_open(self) -> None:
        """Deliberate: a transient DB error must not kick every guest off the
        air mid-show. HTTP re-checks the credential on every request, so the
        socket check is a backstop — losing one tick of it is survivable, and
        the authoritative refusal still happens on the next API call."""
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        ws.send_json = AsyncMock()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(
                H, "guest_session_is_live", AsyncMock(side_effect=RuntimeError("db"))
            ),
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(
                    redis, [room], ws, "p1", {room}, "session-1"
                )
        ws.send_json.assert_not_awaited()

    async def test_liveness_is_false_when_no_row_matches(self) -> None:
        from app.auth.guest_auth import guest_session_is_live

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        self.assertFalse(await guest_session_is_live(db, _uuid()))

    async def test_member_sockets_pay_nothing_for_the_guest_check(self) -> None:
        """guest_session_id is None for members, so the extra query never runs."""
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "guest_session_is_live", AsyncMock()) as live,
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(redis, [room], ws, "p1", None, None)
        live.assert_not_awaited()

    def test_endpoint_intersects_guest_rooms(self) -> None:
        import inspect

        from app.ws import handler as H

        source = inspect.getsource(H.websocket_endpoint)
        self.assertIn("allowed_room_ids", source)
        self.assertIn("guest_session_id", source)
        self.assertIn('user.get("is_guest")', source)


# ---------------------------------------------------------------------------
# 9. LIVEKIT GRANT
# ---------------------------------------------------------------------------


class GuestLiveKitTokenTests(IsolatedAsyncioTestCase):
    async def _mint(self, user: dict, room_id: uuid.UUID, **settings_over):
        from app.api import tokens as tokens_api
        from app.schemas.auth import TokenRequest

        room = SimpleNamespace(id=room_id, livekit_room_name="stable-bip", name="bip")
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(room),
                _scalar_result(SimpleNamespace(id=_uuid())),  # membership
            ]
        )
        livekit = MagicMock()
        livekit.generate_token = MagicMock(return_value="lk-jwt")
        await tokens_api.generate_livekit_token(
            body=TokenRequest(room_name=str(room_id)),
            user=user,
            db=db,
            livekit=livekit,
            settings=_settings(**settings_over),
        )
        return livekit.generate_token.call_args.kwargs

    async def test_guest_is_refused_a_token_for_another_room(self) -> None:
        from app.api import tokens as tokens_api
        from app.schemas.auth import TokenRequest

        other = _uuid()
        room = SimpleNamespace(id=other, livekit_room_name="stable-other", name="other")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(room))
        livekit = MagicMock()
        with self.assertRaises(HTTPException) as ctx:
            await tokens_api.generate_livekit_token(
                body=TokenRequest(room_name=str(other)),
                user=_guest_user(room_id=_uuid()),
                db=db,
                livekit=livekit,
                settings=_settings(),
            )
        self.assertEqual(ctx.exception.status_code, 403)
        livekit.generate_token.assert_not_called()

    async def test_scope_is_checked_against_the_resolved_room_not_the_input(
        self,
    ) -> None:
        """The body takes a slug OR a livekit name OR a uuid, so the check has
        to happen after resolution or a slug could sidestep it."""
        import inspect

        from app.api.tokens import generate_livekit_token

        source = inspect.getsource(generate_livekit_token)
        self.assertLess(
            source.index("ensure_guest_room_scope(user, room.id)"),
            source.index("generate_token"),
        )

    async def test_guest_grant_allows_publish_when_the_invite_did(self) -> None:
        room = _uuid()
        kwargs = await self._mint(_guest_user(room_id=room, can_publish=True), room)
        grants = kwargs["grants"]
        self.assertTrue(grants.can_publish, "a guest is a guest ON the show")
        self.assertTrue(grants.can_subscribe)
        self.assertEqual(grants.room, "stable-bip")

    async def test_watch_only_invite_yields_a_non_publishing_grant(self) -> None:
        room = _uuid()
        kwargs = await self._mint(_guest_user(room_id=room, can_publish=False), room)
        self.assertFalse(kwargs["grants"].can_publish)
        self.assertFalse(kwargs["grants"].can_publish_data)

    async def test_guest_grant_carries_no_admin_powers(self) -> None:
        room = _uuid()
        grants = (await self._mint(_guest_user(room_id=room), room))["grants"]
        self.assertFalse(bool(getattr(grants, "room_admin", False)))
        self.assertFalse(bool(getattr(grants, "room_create", False)))
        self.assertFalse(bool(getattr(grants, "room_list", False)))

    async def test_livekit_token_never_outlives_the_guest_session(self) -> None:
        """Otherwise a revoked guest keeps publishing until LiveKit's own clock
        runs out."""
        room = _uuid()
        user = _guest_user(room_id=room, expires_at=_now() + timedelta(minutes=5))
        kwargs = await self._mint(user, room, livekit_token_ttl_seconds=86400)
        self.assertLessEqual(kwargs["ttl"], 300 + 5)

    async def test_member_path_is_unchanged(self) -> None:
        """No grants override for members — the service default still applies,
        so this change cannot regress ordinary calls."""
        room = _uuid()
        kwargs = await self._mint(_member_user(), room)
        self.assertIsNone(kwargs["grants"])


class GuestIdentityTests(unittest.TestCase):
    def test_synthetic_sub_and_username_agree(self) -> None:
        from app.auth.guest_auth import GUEST_SUB_PREFIX, new_guest_identity

        sub, username = new_guest_identity()
        self.assertTrue(sub.startswith(GUEST_SUB_PREFIX))
        self.assertTrue(username.startswith("guest-"))
        self.assertEqual(uuid.UUID(sub.split(":", 1)[1]).hex, username.split("-", 1)[1])

    def test_username_has_no_underscore(self) -> None:
        from app.auth.guest_auth import new_guest_identity

        for _ in range(20):
            _sub, username = new_guest_identity()
            self.assertNotIn("_", username)

    def test_webhook_parser_recovers_the_participant_from_a_guest_identity(
        self,
    ) -> None:
        """Guest presence and call-occupancy must attribute correctly, and the
        eviction path depends on rebuilding the identical string."""
        from app.api.tokens import livekit_identity
        from app.api.webhooks import _extract_participant_id
        from app.auth.guest_auth import new_guest_identity

        pid = _uuid()
        _sub, username = new_guest_identity()
        self.assertEqual(
            _extract_participant_id(livekit_identity(username, pid)), str(pid)
        )

    def test_identities_are_unique(self) -> None:
        from app.auth.guest_auth import new_guest_identity

        subs = {new_guest_identity()[0] for _ in range(50)}
        self.assertEqual(len(subs), 50)

    def test_guest_principal_carries_no_realm_identity_and_no_roles(self) -> None:
        """Every admin gate in the codebase reads user["roles"]."""
        user = _guest_user()
        self.assertEqual(user["roles"], [])
        self.assertIsNone(user["email"])
        self.assertEqual(user["participant_type"], "guest")
        self.assertTrue(str(user["sub"]).startswith("guest:"))


class TokenShapeTests(unittest.TestCase):
    def test_only_hashes_are_persisted(self) -> None:
        from app.models.guest_access import GuestInvite, GuestSession

        for model in (GuestInvite, GuestSession):
            with self.subTest(model=model.__name__):
                cols = set(model.__table__.columns.keys())
                self.assertIn("token_hash", cols)
                self.assertIn("token_prefix", cols)
                self.assertNotIn("token", cols, "the raw token must never be stored")
                self.assertIn("revoked_at", cols)
                self.assertIn("expires_at", cols)

    def test_passphrase_column_holds_a_hash_not_a_passphrase(self) -> None:
        from app.models.guest_access import GuestInvite

        cols = set(GuestInvite.__table__.columns.keys())
        self.assertIn("passphrase_hash", cols)
        self.assertNotIn("passphrase", cols)

    def test_session_room_is_denormalized_for_the_scope_check(self) -> None:
        from app.models.guest_access import GuestSession

        self.assertIn("room_id", GuestSession.__table__.columns.keys())

    def test_tokens_have_real_entropy_and_distinct_prefixes(self) -> None:
        from app.auth.guest_auth import (
            GUEST_INVITE_PREFIX,
            GUEST_SESSION_PREFIX,
            mint_invite_token,
            mint_session_token,
        )

        invite, session = mint_invite_token(), mint_session_token()
        self.assertTrue(invite.startswith(GUEST_INVITE_PREFIX))
        self.assertTrue(session.startswith(GUEST_SESSION_PREFIX))
        self.assertNotEqual(GUEST_INVITE_PREFIX, GUEST_SESSION_PREFIX)
        # 32 random bytes → 43 urlsafe-base64 chars.
        self.assertGreaterEqual(len(invite) - len(GUEST_INVITE_PREFIX), 40)
        self.assertNotEqual(mint_session_token(), mint_session_token())

    def test_guest_prefixes_do_not_collide_with_other_credential_kinds(self) -> None:
        from app.api.gateway import _KEY_PREFIXES
        from app.auth.guest_auth import GUEST_TOKEN_PREFIXES

        for guest_prefix in GUEST_TOKEN_PREFIXES:
            for gateway_prefix in _KEY_PREFIXES:
                self.assertFalse(guest_prefix.startswith(gateway_prefix))
                self.assertFalse(gateway_prefix.startswith(guest_prefix))
        # broadcast tokens are "sbt-"
        self.assertNotIn("sbt-", GUEST_TOKEN_PREFIXES)


class KillSwitchTests(IsolatedAsyncioTestCase):
    async def test_disabling_the_feature_kills_live_sessions_immediately(self) -> None:
        """Not just a hide: an existing session must stop authenticating on the
        very next request."""
        from app.deps import get_guest_or_member

        with self.assertRaises(HTTPException) as ctx:
            await get_guest_or_member(
                _request({"Authorization": "Bearer sgs-" + "a" * 43}),
                _settings(guest_access_enabled=False),
                AsyncMock(),
            )
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_members_are_unaffected_by_the_guest_kill_switch(self) -> None:
        from app import deps

        with patch.object(
            deps, "validate_token", AsyncMock(return_value={"sub": "kc-1"})
        ) as validate:
            with patch.object(
                deps, "extract_user_identity", MagicMock(return_value={"sub": "kc-1"})
            ):
                with patch.object(
                    deps,
                    "resolve_participant_for_identity",
                    AsyncMock(return_value=SimpleNamespace(id=_uuid())),
                ):
                    user = await deps.get_guest_or_member(
                        _request({"Authorization": "Bearer eyJ.x.y"}),
                        _settings(guest_access_enabled=False),
                        AsyncMock(),
                    )
        validate.assert_awaited_once()
        self.assertEqual(user["sub"], "kc-1")

    async def test_missing_authorization_header_is_a_401(self) -> None:
        from app.deps import get_guest_or_member

        with self.assertRaises(HTTPException) as ctx:
            await get_guest_or_member(_request(), _settings(), AsyncMock())
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_require_guest_refuses_a_member(self) -> None:
        from app.deps import require_guest

        with self.assertRaises(HTTPException) as ctx:
            await require_guest(_member_user())
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_require_guest_accepts_a_guest(self) -> None:
        from app.deps import require_guest

        user = _guest_user()
        self.assertIs(await require_guest(user), user)


# ---------------------------------------------------------------------------
# 10. HISTORY SCOPE — an invite to today's call is not access to last year's
# ---------------------------------------------------------------------------


class GuestHistoryScopeTests(IsolatedAsyncioTestCase):
    """A guest reads from the invite's floor forward, and cannot page past it.

    The load-bearing property is that the floor is applied in the QUERY. A
    guest holds an API credential and chooses their own cursor, so a client
    that merely declines to render older messages is not a boundary at all.
    """

    async def _get(self, user: dict, room_id: uuid.UUID, cursor=None):
        from app.api import messages as messages_api

        svc = MagicMock()
        svc.get_messages = AsyncMock(
            return_value={"messages": [], "cursor": None, "has_more": False}
        )
        with patch.object(messages_api, "_build_message_service", return_value=svc):
            await messages_api.get_messages(
                room_id=room_id,
                user=user,
                db=AsyncMock(),
                livekit=AsyncMock(),
                cursor=cursor,
                limit=50,
            )
        return svc.get_messages.await_args.kwargs

    async def test_a_guest_read_carries_the_invites_floor(self) -> None:
        room = _uuid()
        floor = _now() - timedelta(hours=2)
        kwargs = await self._get(
            _guest_user(room_id=room, guest_history_from=floor), room
        )
        self.assertEqual(kwargs["not_before"], floor)

    async def test_a_member_read_is_unbounded(self) -> None:
        """The floor is a guest control, not a new limit on everyone."""
        kwargs = await self._get(_member_user(), _uuid())
        self.assertIsNone(kwargs["not_before"])

    async def test_an_old_cursor_cannot_reach_past_the_floor(self) -> None:
        """Paging is the attack: the guest supplies the cursor, so the floor
        must ride on every call regardless of what they ask for."""
        room = _uuid()
        floor = _now() - timedelta(minutes=30)
        kwargs = await self._get(
            _guest_user(room_id=room, guest_history_from=floor),
            room,
            cursor=str(_uuid()),
        )
        self.assertEqual(kwargs["not_before"], floor)

    async def test_a_guest_with_no_floor_fails_closed(self) -> None:
        """A principal that somehow carries no boundary reads NOTHING older
        than now — an empty room is a visible bug, silently handing over
        months of history is not."""
        room = _uuid()
        before = _now()
        kwargs = await self._get(
            _guest_user(room_id=room, guest_history_from=None), room
        )
        self.assertIsNotNone(kwargs["not_before"])
        self.assertGreaterEqual(kwargs["not_before"], before - timedelta(seconds=5))

    async def test_the_floor_becomes_a_where_clause_not_a_python_filter(
        self,
    ) -> None:
        """Filtering after the fetch would still return a full page's worth of
        older rows to the caller (and would make has_more lie)."""
        from app.services.message_service import MessageService

        db = AsyncMock()
        captured: list = []

        async def _execute(stmt, *a, **kw):
            captured.append(stmt)
            res = MagicMock()
            res.scalars.return_value.all.return_value = []
            res.scalar.return_value = 0
            res.scalar_one_or_none.return_value = None
            return res

        db.execute = AsyncMock(side_effect=_execute)
        svc = MessageService(db=db, livekit=AsyncMock())
        floor = _now() - timedelta(hours=3)
        await svc.get_messages(room_id=_uuid(), limit=10, not_before=floor)

        compiled = str(
            captured[0].compile(
                dialect=__import__(
                    "sqlalchemy.dialects.postgresql", fromlist=["dialect"]
                ).dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertIn("messages.created_at >=", compiled)

    async def test_no_floor_leaves_the_member_query_untouched(self) -> None:
        from app.services.message_service import MessageService

        db = AsyncMock()
        captured: list = []

        async def _execute(stmt, *a, **kw):
            captured.append(stmt)
            res = MagicMock()
            res.scalars.return_value.all.return_value = []
            res.scalar.return_value = 0
            res.scalar_one_or_none.return_value = None
            return res

        db.execute = AsyncMock(side_effect=_execute)
        svc = MessageService(db=db, livekit=AsyncMock())
        await svc.get_messages(room_id=_uuid(), limit=10)
        compiled = str(
            captured[0].compile(
                dialect=__import__(
                    "sqlalchemy.dialects.postgresql", fromlist=["dialect"]
                ).dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertNotIn("created_at >=", compiled)

    async def test_the_floor_comes_off_the_invite_at_credential_check(self) -> None:
        from app.auth.gateway_auth import hash_key
        from app.auth.guest_auth import verify_guest_session

        raw = "sgs-" + "c" * 43
        floor = _now() - timedelta(days=3)
        session = SimpleNamespace(
            id=_uuid(), token_hash=hash_key(raw), invite_id=_uuid(),
            room_id=_uuid(), participant_id=_uuid(), display_name="T",
            can_publish=True, created_at=_now(),
            expires_at=_now() + timedelta(hours=1), revoked_at=None,
        )
        participant = SimpleNamespace(
            id=session.participant_id, keycloak_sub=f"guest:{_uuid()}",
            username="guest-x", display_name="T",
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(session),
                _scalar_result(_invite(history_from=floor)),
                _scalar_result(participant),
            ]
        )
        principal = await verify_guest_session(raw, db)
        self.assertEqual(principal.history_from, floor)

    def test_an_invite_row_without_a_floor_falls_back_restrictively(self) -> None:
        """Never to "the whole room": a row predating the column resolves to
        when the SESSION was redeemed, which a guest can always see anyway."""
        from app.auth.guest_auth import _effective_history_from

        redeemed = _now() - timedelta(minutes=10)
        session = SimpleNamespace(created_at=redeemed)
        self.assertEqual(
            _effective_history_from(SimpleNamespace(), session), redeemed
        )
        # And with nothing at all to go on, "now" — i.e. show nothing.
        resolved = _effective_history_from(SimpleNamespace(), SimpleNamespace())
        self.assertGreaterEqual(resolved, _now() - timedelta(seconds=5))

    def test_the_column_is_not_nullable(self) -> None:
        """A nullable "no limit" column fails OPEN for any writer that forgets
        it. This one is NOT NULL with a restrictive server default."""
        from app.models.guest_access import GuestInvite

        col = GuestInvite.__table__.columns["history_from"]
        self.assertFalse(col.nullable)
        self.assertIn("now()", str(col.server_default.arg).lower())


# ---------------------------------------------------------------------------
# 11. THE REAPER — expiry must be something the server DOES, not just checks
# ---------------------------------------------------------------------------


def _dead_session(**over):
    from app.models.guest_access import GuestSession

    fields = dict(
        id=_uuid(),
        token_hash="h" * 64,
        token_prefix="sgs-abc",
        invite_id=_uuid(),
        room_id=_uuid(),
        participant_id=_uuid(),
        display_name="Trudy",
        can_publish=True,
        expires_at=_now() - timedelta(minutes=5),
    )
    fields.update(over)
    return GuestSession(**fields)


class GuestSessionReaperTests(IsolatedAsyncioTestCase):
    """Nothing used to go LOOKING for expired guests.

    Expiry was enforced only when something asked, so an expired guest stopped
    being authorized on time but kept publishing to LiveKit (the media session
    outlives the join token that opened it) and kept their seat on the roster
    until they closed the tab.
    """

    async def _sweep(self, session, *, room=None, claimed=True):
        from app.services import guest_reaper

        room = room or SimpleNamespace(
            id=session.room_id, livekit_room_name="stable-bip", display_name="BIP"
        )
        participant = SimpleNamespace(
            id=session.participant_id, username="guest-deadbeef"
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalars_result([session.id] if claimed else []),  # the claim
                _scalars_result([session]),                        # sessions
                _scalars_result([room]),                           # rooms
                _scalars_result([]),                               # membership DELETE
                _scalars_result([]),                               # class_floor stamp (Nav v3 R2)
                _scalars_result([participant]),                    # participants
            ]
        )
        redis = AsyncMock()
        livekit = AsyncMock()
        with patch("app.api.rooms._broadcast_members_changed", AsyncMock()):
            count = await guest_reaper.sweep_expired_guest_sessions(
                _FakeSessionFactory(db), redis, livekit, batch=10
            )
        return count, db, redis, livekit

    async def test_an_expired_session_is_swept(self) -> None:
        session = _dead_session()
        count, _db, _redis, _lk = await self._sweep(session)
        self.assertEqual(count, 1)
        self.assertIsNotNone(session.revoked_at)

    async def test_nothing_to_do_is_one_statement(self) -> None:
        """The loop runs forever in every worker; the idle case must be cheap."""
        session = _dead_session()
        count, db, redis, livekit = await self._sweep(session, claimed=False)
        self.assertEqual(count, 0)
        self.assertEqual(db.execute.await_count, 1)
        redis.publish.assert_not_awaited()
        livekit.remove_participant.assert_not_awaited()

    async def test_the_live_socket_is_actually_hung_up(self) -> None:
        """The point of the whole exercise: not "marked dead in the DB" but
        "the browser is disconnected". A FORCE_DISCONNECT must be published on
        the swept guest's own channel."""
        from app.ws.handler import FORCE_DISCONNECT_EVENT

        session = _dead_session()
        _count, _db, redis, _lk = await self._sweep(session)
        published = [
            json.loads(c.args[1])
            for c in redis.publish.await_args_list
            if c.args[0] == f"user:{session.participant_id}"
        ]
        kinds = {p.get("type") for p in published}
        self.assertIn(FORCE_DISCONNECT_EVENT, kinds)
        forced = [p for p in published if p["type"] == FORCE_DISCONNECT_EVENT][0]
        self.assertEqual(forced["reason"], "guest_session_expired")

    async def test_the_hangup_actually_closes_the_socket_end_to_end(self) -> None:
        """Take the EXACT bytes the reaper published and feed them to the
        socket's forward loop: it must send session_ended and RETURN, which is
        what trips the endpoint's teardown and closes the connection. Asserting
        only that a message was published would leave the two halves free to
        stop agreeing."""
        from app.ws import handler as H

        session = _dead_session()
        _count, _db, redis, _lk = await self._sweep(session)
        payload = [
            c.args[1]
            for c in redis.publish.await_args_list
            if c.args[0] == f"user:{session.participant_id}"
            and json.loads(c.args[1]).get("type") == H.FORCE_DISCONNECT_EVENT
        ][0]

        frames = [{"type": "message", "data": payload}]

        class FakePubSub:
            def __init__(self):
                self.unsubscribed = False

            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                self.unsubscribed = True

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                return frames.pop(0) if frames else {"type": "none"}

        pubsub = FakePubSub()
        sub_redis = MagicMock()
        sub_redis.pubsub = MagicMock(return_value=pubsub)
        sent: list = []
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        ws.send_json = AsyncMock(side_effect=lambda d: sent.append(d))

        await asyncio.wait_for(
            H._subscribe_to_rooms(
                sub_redis, [str(session.room_id)], ws, str(session.participant_id), None
            ),
            timeout=5,
        )
        self.assertEqual(
            sent, [{"type": "session_ended", "reason": "guest_session_expired"}]
        )
        self.assertTrue(pubsub.unsubscribed)

    async def test_the_guest_is_evicted_from_livekit(self) -> None:
        """The reason this sweep exists at all: an established WebRTC session
        outlives the token that authorized it, so an expired guest keeps
        publishing camera and mic until something evicts them."""
        session = _dead_session()
        _count, _db, _redis, livekit = await self._sweep(session)
        livekit.remove_participant.assert_awaited_once()
        self.assertEqual(
            livekit.remove_participant.await_args.kwargs["room_name"], "stable-bip"
        )

    async def test_the_roster_seat_is_removed(self) -> None:
        session = _dead_session()
        _count, db, _redis, _lk = await self._sweep(session)
        statements = [str(c.args[0]) for c in db.execute.await_args_list]
        self.assertTrue(any("DELETE FROM room_members" in s for s in statements))

    async def test_a_deleted_room_still_counts_as_swept(self) -> None:
        """The revocation is already committed by the claim; there is just no
        socket scope or LiveKit room left to tear down."""
        from app.services import guest_reaper

        session = _dead_session()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalars_result([session.id]),
                _scalars_result([session]),
                _scalars_result([]),  # room is gone
            ]
        )
        count = await guest_reaper.sweep_expired_guest_sessions(
            _FakeSessionFactory(db), AsyncMock(), AsyncMock(), batch=10
        )
        self.assertEqual(count, 1)

    async def test_a_teardown_failure_does_not_abandon_the_batch(self) -> None:
        from app.services import guest_reaper

        session = _dead_session()
        room = SimpleNamespace(
            id=session.room_id, livekit_room_name="r", display_name="R"
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalars_result([session.id]),
                _scalars_result([session]),
                _scalars_result([room]),
            ]
        )
        with patch(
            "app.api.guests._terminate_sessions",
            AsyncMock(side_effect=RuntimeError("redis is gone")),
        ):
            count = await guest_reaper.sweep_expired_guest_sessions(
                _FakeSessionFactory(db), AsyncMock(), AsyncMock(), batch=10
            )
        # Nothing was torn down, but the sweep returned instead of exploding —
        # and the rows are already marked revoked by the claim.
        self.assertEqual(count, 0)

    def test_the_claim_catches_all_three_ways_of_being_dead(self) -> None:
        """A session outlives its usefulness three ways, and a sweep that only
        knew about its own expiry would leave the invite-cascade cases live."""
        from app.services.guest_reaper import _CLAIM_SQL

        sql = str(_CLAIM_SQL)
        self.assertIn("gs.expires_at <= now()", sql)
        self.assertIn("gi.expires_at <= now()", sql)
        self.assertIn("gi.revoked_at IS NOT NULL", sql)

    def test_the_claim_is_exactly_once_across_workers(self) -> None:
        """Every uvicorn worker runs this loop. The UPDATE re-checks
        revoked_at and RETURNs only rows it actually changed, so two workers
        cannot both tear down the same guest."""
        from app.services.guest_reaper import _CLAIM_SQL

        sql = str(_CLAIM_SQL)
        self.assertIn("s.revoked_at IS NULL", sql)
        self.assertIn("RETURNING", sql)
        self.assertIn("LIMIT :batch", sql)

    async def test_the_loop_survives_a_failed_pass(self) -> None:
        """A reaper that quietly died looks exactly like one with nothing to
        do — which is the failure mode this whole file exists to prevent."""
        from app.services import guest_reaper

        calls = {"n": 0}

        async def _boom(*a, **kw):
            calls["n"] += 1
            if calls["n"] >= 3:
                raise asyncio.CancelledError()
            raise RuntimeError("db blip")

        # Replace the module's `asyncio` REFERENCE, never asyncio.sleep itself —
        # patching that globally wedges the event loop the test runs on.
        fake_asyncio = SimpleNamespace(
            sleep=AsyncMock(), CancelledError=asyncio.CancelledError
        )
        with (
            patch.object(
                guest_reaper, "sweep_expired_guest_sessions", AsyncMock(side_effect=_boom)
            ),
            patch.object(guest_reaper, "asyncio", fake_asyncio),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await guest_reaper.run_guest_reaper(
                    _FakeSessionFactory(), AsyncMock(), AsyncMock(),
                    _settings(guest_reaper_interval_seconds=1, guest_reaper_batch=10),
                )
        self.assertEqual(calls["n"], 3)


# ---------------------------------------------------------------------------
# 11b. THE PARTICIPANT ROW — a guest identity has to END, not just stop working
# ---------------------------------------------------------------------------


class GuestParticipantLifecycleTests(IsolatedAsyncioTestCase):
    """One Participant row per redemption, and nothing ever closed it.

    The session died, the membership row went, the credential stopped working —
    and the identity stayed at ``status = 'online'`` forever, indistinguishable
    in the table from a guest who is on a call right now. Not a security hole
    (``== HUMAN`` keeps guests out of every directory) but a lifecycle nobody
    owned.
    """

    async def _sweep(self, *, retired=(), purged=(), **kw):
        from app.services import guest_reaper

        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[_scalars_result(list(retired)), _scalars_result(list(purged))]
        )
        counts = await guest_reaper.sweep_guest_participants(
            _FakeSessionFactory(db), **kw
        )
        return counts, db

    def _sql(self, name: str) -> str:
        from app.services import guest_reaper

        return str(getattr(guest_reaper, name))

    # -- the decision itself -------------------------------------------------

    def test_the_row_is_tombstoned_not_deleted(self) -> None:
        """``messages.sender_id`` is ON DELETE SET NULL and NULLABLE, so a
        delete would not remove the message — it would silently strip the
        sender off everything the guest said and leave the room's history
        showing anonymous holes. Stage one is an UPDATE, and it stamps a
        tombstone rather than removing anything."""
        sql = self._sql("_RETIRE_SQL")
        self.assertIn("UPDATE participants", sql)
        self.assertNotIn("DELETE", sql)
        self.assertIn("guest_retired_at", sql)
        self.assertIn("status = 'offline'", sql)

    def test_the_display_name_is_not_redacted(self) -> None:
        """It is what makes the room's own history readable, the guest chose it
        and typed it into a room, and guest_sessions keeps its own copy."""
        self.assertNotIn("display_name", self._sql("_RETIRE_SQL"))

    def test_the_fks_that_forced_the_decision_are_still_what_we_think(self) -> None:
        """If any of these ever became a plain CASCADE-and-forget, deleting a
        guest would start destroying things silently and this whole design
        would need revisiting. Pin them."""
        from app.models.guest_access import GuestSession
        from app.models.message import Message

        def _ondelete(col) -> str:
            return list(col.foreign_keys)[0].ondelete

        self.assertEqual(_ondelete(Message.__table__.c.sender_id), "SET NULL")
        self.assertTrue(Message.__table__.c.sender_id.nullable)
        self.assertEqual(
            _ondelete(GuestSession.__table__.c.participant_id), "CASCADE"
        )

    def test_the_message_index_the_purge_check_needs_exists(self) -> None:
        """Without it the NOT EXISTS is a sequential scan of the whole message
        table per candidate row — a GC that gets slower the more history you
        have is one an operator turns off."""
        from app.models.message import Message

        names = {ix.name for ix in Message.__table__.indexes}
        self.assertIn("ix_messages_sender_id", names)

    def test_the_participant_scan_index_exists(self) -> None:
        from app.models.participant import Participant

        names = {ix.name for ix in Participant.__table__.indexes}
        self.assertIn("ix_participants_type_created", names)

    def test_no_migration_casts_the_guest_label_into_ddl(self) -> None:
        """014 does ``ALTER TYPE participant_type_enum ADD VALUE 'guest'``, and
        PostgreSQL refuses to USE a new enum label in the transaction that
        added it. A later migration that names it — a partial index predicate
        is the tempting one — therefore fails on every FRESH database (which
        runs 014 and it in a single alembic run) while passing on every
        already-migrated one. That is the worst shape a migration bug comes in,
        so pin it here rather than discovering it on a new install."""
        import pathlib

        versions = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
        for path in sorted(versions.glob("*.py")):
            with self.subTest(migration=path.name):
                self.assertNotIn(
                    "'guest'::participant_type_enum", path.read_text()
                )

    # -- stage one: retire ---------------------------------------------------

    def test_retiring_needs_every_session_dead_not_just_one(self) -> None:
        """A guest may hold several sessions (two tabs, or two redemptions).
        Retiring on the first dead one closes an identity that is still live
        in another tab."""
        sql = self._sql("_RETIRE_SQL")
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("gs.revoked_at IS NULL", sql)

    def test_retiring_refuses_a_guest_row_with_no_session_at_all(self) -> None:
        """A positive EXISTS as well as the negative one: without it a vacuous
        NOT EXISTS would tombstone any guest-typed row that never had a
        session, including one mid-creation."""
        sql = self._sql("_RETIRE_SQL")
        self.assertEqual(sql.count("FROM guest_sessions gs"), 2)
        self.assertEqual(sql.count("NOT EXISTS"), 1)

    def test_retiring_waits_out_a_grace_window(self) -> None:
        """``_terminate_sessions`` commits the revocation FIRST and then closes
        sockets and evicts from LiveKit; this pass must not race that."""
        self.assertIn("make_interval(mins => :grace_minutes)", self._sql("_RETIRE_SQL"))

    def test_the_retire_claim_is_exactly_once_across_workers(self) -> None:
        sql = self._sql("_RETIRE_SQL")
        self.assertIn("(t.metadata ->> 'guest_retired_at') IS NULL", sql)
        self.assertIn("RETURNING", sql)
        self.assertIn("LIMIT :batch", sql)

    async def test_a_retired_guest_is_counted(self) -> None:
        counts, _db = await self._sweep(retired=[_uuid(), _uuid()], purged=[])
        self.assertEqual(counts, (2, 0))

    # -- stage two: the bounded delete --------------------------------------

    def test_the_purge_can_only_touch_a_guest_that_sent_nothing(self) -> None:
        """The whole safety argument, and it is re-checked INSIDE the DELETE so
        it cannot race a straggler."""
        sql = self._sql("_PURGE_SQL")
        self.assertEqual(sql.count("SELECT 1 FROM messages m WHERE m.sender_id"), 2)
        self.assertIn("DELETE FROM participants", sql)

    def test_the_purge_only_touches_guests_and_only_retired_ones(self) -> None:
        sql = self._sql("_PURGE_SQL")
        self.assertIn("t.participant_type = 'guest'", sql)
        self.assertIn("(t.metadata ->> 'guest_retired_at') IS NOT NULL", sql)

    def test_the_purge_waits_out_a_retention_window(self) -> None:
        self.assertIn(
            "make_interval(days => :purge_after_days)", self._sql("_PURGE_SQL")
        )

    async def test_purge_after_zero_days_disables_the_delete_entirely(self) -> None:
        """The escape hatch for a deployment that wants tombstones forever —
        and it must not even RUN the statement, or "disabled" would still be a
        write path one typo away from firing."""
        from app.services import guest_reaper

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_scalars_result([])])
        counts = await guest_reaper.sweep_guest_participants(
            _FakeSessionFactory(db), purge_after_days=0
        )
        self.assertEqual(counts, (0, 0))
        self.assertEqual(db.execute.await_count, 1)

    async def test_a_purged_guest_is_counted(self) -> None:
        counts, _db = await self._sweep(retired=[], purged=[_uuid()])
        self.assertEqual(counts, (0, 1))

    # -- the loop ------------------------------------------------------------

    def test_the_tombstone_key_the_sql_writes_is_the_one_it_reads(self) -> None:
        from app.services.guest_reaper import RETIRED_AT_KEY

        self.assertIn(RETIRED_AT_KEY, self._sql("_RETIRE_SQL"))
        self.assertIn(RETIRED_AT_KEY, self._sql("_PURGE_SQL"))

    async def test_the_session_sweep_runs_first_and_both_run_each_pass(self) -> None:
        """Hanging up on an expired stranger is the urgent half; bookkeeping is
        not. Order matters, and a broken tombstone pass must not be able to
        stop the sweep that evicts people."""
        from app.services import guest_reaper

        order: list[str] = []

        async def _sessions(*_a, **_kw):
            order.append("sessions")
            return 0

        async def _participants(*_a, **_kw):
            order.append("participants")
            raise asyncio.CancelledError()

        fake_asyncio = SimpleNamespace(
            sleep=AsyncMock(), CancelledError=asyncio.CancelledError
        )
        with (
            patch.object(
                guest_reaper,
                "sweep_expired_guest_sessions",
                AsyncMock(side_effect=_sessions),
            ),
            patch.object(
                guest_reaper,
                "sweep_guest_participants",
                AsyncMock(side_effect=_participants),
            ),
            patch.object(guest_reaper, "asyncio", fake_asyncio),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await guest_reaper.run_guest_reaper(
                    _FakeSessionFactory(),
                    AsyncMock(),
                    AsyncMock(),
                    _settings(
                        guest_reaper_interval_seconds=1,
                        guest_reaper_batch=10,
                        guest_participant_retire_after_minutes=60,
                        guest_participant_purge_after_days=30,
                    ),
                )
        self.assertEqual(order, ["sessions", "participants"])

    def test_the_settings_exist_with_conservative_defaults(self) -> None:
        from app.config import Settings

        fields = Settings.model_fields
        self.assertEqual(
            fields["guest_participant_retire_after_minutes"].default, 60
        )
        self.assertEqual(fields["guest_participant_purge_after_days"].default, 30)


# ---------------------------------------------------------------------------
# 11b. ROW RETENTION — the two guest tables themselves
# ---------------------------------------------------------------------------


class GuestRowRetentionTests(IsolatedAsyncioTestCase):
    """``guest_invites`` and ``guest_sessions`` were never reaped AT ALL.

    Revocation and expiry are stamps (``revoked_at``); no code path anywhere
    issues a DELETE against either table. So every link an owner ever minted,
    and every redemption of it, was kept forever — the participant lifecycle in
    section 11 bounded the identity rows and left the credential rows growing.

    The delete here is allowed to be a delete for one reason and one reason
    only, and the tests below are mostly assertions ABOUT that reason: an
    invite with no sessions and a session with no children reference nothing
    and nothing references them. The moment that stops being true —
    ``guest_sessions.invite_id`` is ON DELETE CASCADE — the delete becomes an
    audit-trail shredder, so the guard is checked twice in SQL and pinned here.
    """

    def _sql(self, name: str) -> str:
        from app.services import guest_reaper

        return str(getattr(guest_reaper, name))

    async def _sweep(self, *, sessions=(), invites=(), **kw):
        from app.services import guest_reaper

        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalars_result(list(sessions)),
                _scalars_result(list(invites)),
            ]
        )
        counts = await guest_reaper.sweep_guest_rows(_FakeSessionFactory(db), **kw)
        return counts, db

    # -- the guard that makes the invite delete legal -----------------------

    def test_an_invite_with_sessions_is_never_deleted(self) -> None:
        """THE test. ``guest_sessions.invite_id`` is ON DELETE CASCADE, so
        deleting an invite that still has sessions would take every session it
        minted with it — the record of who was let into the room, destroyed by
        the garbage collector. Checked in the CTE and AGAIN inside the DELETE,
        for the same reason the participant purge re-checks its message guard.
        """
        sql = self._sql("_PURGE_INVITES_SQL")
        self.assertEqual(
            sql.count("SELECT 1 FROM guest_sessions gs WHERE gs.invite_id"), 2
        )
        self.assertEqual(sql.count("NOT EXISTS"), 2)
        self.assertIn("DELETE FROM guest_invites", sql)

    def test_the_cascade_that_forces_the_guard_is_still_what_we_think(self) -> None:
        """If this FK ever became SET NULL the guard would be unnecessary; if
        it stayed CASCADE and the guard were dropped, deleting an invite would
        silently shred sessions. Pin the fact the design rests on."""
        from app.models.guest_access import GuestSession

        fk = list(GuestSession.__table__.c.invite_id.foreign_keys)[0]
        self.assertEqual(fk.ondelete, "CASCADE")

    def test_the_invite_claim_locks_before_it_deletes(self) -> None:
        """The double NOT EXISTS cannot see an UNCOMMITTED redemption. FOR
        UPDATE is the one row lock that conflicts with the FOR KEY SHARE
        PostgreSQL takes on the parent for a child INSERT's FK check, so the
        two serialize; MATERIALIZED is what guarantees the lock is taken
        before the DELETE is planned rather than inlined away."""
        sql = self._sql("_PURGE_INVITES_SQL")
        self.assertIn("AS MATERIALIZED", sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)

    # -- what a session delete may and may not touch ------------------------

    def test_the_session_purge_cannot_reach_messages_or_participants(self) -> None:
        """NEGATIVE CONTROL, in SQL. A session row is a leaf; deleting one must
        not be able to touch the identity a message is attributed to. If either
        table's name ever appears in this statement, someone has widened it."""
        sql = self._sql("_PURGE_SESSIONS_SQL")
        self.assertIn("DELETE FROM guest_sessions", sql)
        self.assertNotIn("messages", sql)
        self.assertNotIn("participants", sql)

    def test_no_retention_statement_deletes_a_message(self) -> None:
        """The whole point, asserted across every statement in the module: the
        reaper may delete guest credential rows and trace-free guest identity
        rows, and NOTHING else. ``messages`` appears in exactly one place — the
        NOT EXISTS that REFUSES to purge a participant who wrote one."""
        from app.services import guest_reaper

        deleting = [
            n
            for n in dir(guest_reaper)
            if n.endswith("_SQL") and "DELETE FROM" in str(getattr(guest_reaper, n))
        ]
        self.assertEqual(
            sorted(deleting),
            ["_PURGE_INVITES_SQL", "_PURGE_SESSIONS_SQL", "_PURGE_SQL"],
        )
        for name in deleting:
            with self.subTest(statement=name):
                sql = str(getattr(guest_reaper, name))
                target = sql.split("DELETE FROM", 1)[1].split()[0]
                self.assertIn(
                    target, {"guest_sessions", "guest_invites", "participants"}
                )
                self.assertNotIn("DELETE FROM messages", sql)

    # -- the retention clock ------------------------------------------------

    def test_both_stages_wait_out_a_retention_window(self) -> None:
        self.assertIn(
            "make_interval(days => :purge_after_days)",
            self._sql("_PURGE_SESSIONS_SQL"),
        )
        self.assertIn(
            "make_interval(days => :purge_after_days)",
            self._sql("_PURGE_INVITES_SQL"),
        )

    def test_the_clock_is_expiry_not_revocation(self) -> None:
        """``revoked_at`` moves both ways relative to expiry — earlier when an
        owner revokes, LATER when this reaper stamps a session it swept — so
        keying retention to it would sometimes shorten the window. expires_at
        is the conservative choice and the indexed one."""
        for name in ("_PURGE_SESSIONS_SQL", "_PURGE_INVITES_SQL"):
            with self.subTest(statement=name):
                sql = self._sql(name)
                self.assertIn("expires_at <= now() - make_interval", sql)
                self.assertNotIn("revoked_at <= now() - make_interval", sql)

    def test_both_stages_require_the_row_to_be_dead(self) -> None:
        for name in ("_PURGE_SESSIONS_SQL", "_PURGE_INVITES_SQL"):
            with self.subTest(statement=name):
                self.assertIn(
                    "revoked_at IS NOT NULL OR", self._sql(name)
                )

    def test_both_claims_are_bounded_and_re_check_inside_the_delete(self) -> None:
        for name in ("_PURGE_SESSIONS_SQL", "_PURGE_INVITES_SQL"):
            with self.subTest(statement=name):
                sql = self._sql(name)
                self.assertIn("LIMIT :batch", sql)
                self.assertIn("RETURNING", sql)
                # once to choose candidates, once inside the DELETE
                self.assertEqual(sql.count("make_interval(days => :purge_after_days)"), 2)

    # -- the off switches ---------------------------------------------------

    async def test_zero_days_disables_a_stage_without_running_it(self) -> None:
        """"Off" must not be a value passed to a DELETE that happens to match
        nothing — it must be a statement that never executes."""
        counts, db = await self._sweep(
            session_purge_after_days=0, invite_purge_after_days=0
        )
        self.assertEqual(counts, (0, 0))
        self.assertEqual(db.execute.await_count, 0)

    async def test_each_stage_can_be_disabled_independently(self) -> None:
        _counts, db = await self._sweep(
            sessions=[_uuid()], session_purge_after_days=365, invite_purge_after_days=0
        )
        self.assertEqual(db.execute.await_count, 1)
        self.assertIn("guest_sessions", str(db.execute.await_args_list[0].args[0]))

    async def test_purged_rows_are_counted(self) -> None:
        counts, _db = await self._sweep(
            sessions=[_uuid(), _uuid()], invites=[_uuid()]
        )
        self.assertEqual(counts, (2, 1))

    # -- ordering and wiring ------------------------------------------------

    async def test_sessions_are_purged_before_invites(self) -> None:
        """An invite is only deletable while NOT EXISTS a session pointing at
        it, so the leaf has to go first or the invite stage is permanently one
        window behind."""
        _counts, db = await self._sweep(sessions=[_uuid()], invites=[_uuid()])
        statements = [str(c.args[0]) for c in db.execute.await_args_list]
        self.assertIn("DELETE FROM guest_sessions", statements[0])
        self.assertIn("DELETE FROM guest_invites", statements[1])

    async def test_the_loop_actually_calls_it(self) -> None:
        """A reaper that exists but is never invoked is worse than none,
        because it looks done. Walk the real loop body."""
        from app.services import guest_reaper

        order: list[str] = []

        async def _sessions(*_a, **_kw):
            order.append("sessions")
            return 0

        async def _participants(*_a, **_kw):
            order.append("participants")
            return (0, 0)

        async def _rows(*_a, **kw):
            order.append("rows")
            order.append(f"session_days={kw['session_purge_after_days']}")
            order.append(f"invite_days={kw['invite_purge_after_days']}")
            raise asyncio.CancelledError()

        fake_asyncio = SimpleNamespace(
            sleep=AsyncMock(), CancelledError=asyncio.CancelledError
        )
        with (
            patch.object(
                guest_reaper,
                "sweep_expired_guest_sessions",
                AsyncMock(side_effect=_sessions),
            ),
            patch.object(
                guest_reaper,
                "sweep_guest_participants",
                AsyncMock(side_effect=_participants),
            ),
            patch.object(
                guest_reaper, "sweep_guest_rows", AsyncMock(side_effect=_rows)
            ),
            patch.object(guest_reaper, "asyncio", fake_asyncio),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await guest_reaper.run_guest_reaper(
                    _FakeSessionFactory(),
                    AsyncMock(),
                    AsyncMock(),
                    _settings(
                        guest_reaper_interval_seconds=1,
                        guest_reaper_batch=10,
                        guest_participant_retire_after_minutes=60,
                        guest_participant_purge_after_days=30,
                        guest_session_purge_after_days=365,
                        guest_invite_purge_after_days=90,
                    ),
                )
        self.assertEqual(
            order,
            [
                "sessions",
                "participants",
                "rows",
                "session_days=365",
                "invite_days=90",
            ],
        )

    def test_the_lifespan_starts_the_loop_that_contains_it(self) -> None:
        """The retention sweep has no scheduler of its own — it rides the guest
        reaper task started in main.lifespan. If that call ever goes away,
        every stage in this file silently stops running."""
        import inspect

        from app import main

        src = inspect.getsource(main.lifespan)
        self.assertIn("run_guest_reaper", src)
        self.assertIn("asyncio.create_task", src)
        self.assertIn("settings.guest_reaper_enabled", src)

    # -- settings and indexes -----------------------------------------------

    def test_the_settings_exist_with_conservative_defaults(self) -> None:
        """A session is the record of a PERSON who was in a room, so it gets a
        year. An invite that minted nobody records no person at all."""
        from app.config import Settings

        fields = Settings.model_fields
        self.assertEqual(fields["guest_session_purge_after_days"].default, 365)
        self.assertEqual(fields["guest_invite_purge_after_days"].default, 90)
        self.assertGreater(
            fields["guest_session_purge_after_days"].default,
            fields["guest_participant_purge_after_days"].default,
        )

    def test_the_indexes_both_scans_need_exist(self) -> None:
        """Both stages walk oldest-expiry-first and stop at the window. Without
        the index that is a full sort per pass, per worker, forever — the
        failure mode that gets a GC turned off."""
        from app.models.guest_access import GuestInvite, GuestSession

        self.assertIn(
            "ix_guest_sessions_expires_at",
            {ix.name for ix in GuestSession.__table__.indexes},
        )
        self.assertIn(
            "ix_guest_invites_expires_at",
            {ix.name for ix in GuestInvite.__table__.indexes},
        )

    def test_the_invite_guard_index_from_014_is_still_there(self) -> None:
        """The NOT EXISTS is per candidate row; unindexed it is a scan of every
        session ever created, per invite considered."""
        from app.models.guest_access import GuestSession

        self.assertTrue(GuestSession.__table__.c.invite_id.index)

    def test_the_revision_id_fits_the_version_column(self) -> None:
        """``alembic_version.version_num`` is varchar(32). A 33-char id once
        rolled back an entire migration at the version stamp."""
        import pathlib

        versions = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
        for path in sorted(versions.glob("*.py")):
            for line in path.read_text().splitlines():
                stripped = line.strip()
                if stripped.startswith("revision") and "=" in stripped:
                    value = stripped.split("=", 1)[1].strip().strip("\"'")
                    with self.subTest(migration=path.name):
                        self.assertLessEqual(len(value), 32)
                    break


# ---------------------------------------------------------------------------
# 12. PRESENCE SCOPE — a guest is present in ONE room, not on the instance
# ---------------------------------------------------------------------------


class GuestPresenceScopeTests(IsolatedAsyncioTestCase):
    """``presence:instance`` is subscribed by EVERY socket on the deployment.

    A guest announced there is announced to people who share no room with them,
    and a guest SUBSCRIBED there receives a live census of everyone on the
    server — which is the People directory the design says they may not have,
    arriving by another door.
    """

    async def test_guest_presence_is_not_published_instance_wide(self) -> None:
        from app.services.presence_service import PresenceService

        redis = AsyncMock()
        svc = PresenceService(redis)
        await svc.set_online("p-guest", "online", instance_wide=False)
        redis.publish.assert_not_awaited()
        # …but the presence KEY is still written, so the room roster's online
        # dot for this guest still resolves.
        redis.set.assert_awaited()

    async def test_member_presence_is_still_published_instance_wide(self) -> None:
        from app.services.presence_service import (
            INSTANCE_PRESENCE_CHANNEL,
            PresenceService,
        )

        redis = AsyncMock()
        await PresenceService(redis).set_online("p-member")
        redis.publish.assert_awaited_once()
        self.assertEqual(
            redis.publish.await_args.args[0], INSTANCE_PRESENCE_CHANNEL
        )

    async def test_offline_matches_online_so_there_is_no_phantom_event(
        self,
    ) -> None:
        """An instance-wide offline for someone never announced online is a
        phantom row appearing and vanishing in every client's directory."""
        from app.services.presence_service import PresenceService

        redis = AsyncMock()
        await PresenceService(redis).set_offline("p-guest", instance_wide=False)
        redis.publish.assert_not_awaited()
        redis.delete.assert_awaited()

    async def test_heartbeat_cannot_reopen_the_leak_later(self) -> None:
        """heartbeat RE-PUBLISHES online when the key has lapsed, so a fix
        applied only at connect time would leak the guest ~2 minutes in."""
        from app.services.presence_service import PresenceService

        redis = AsyncMock()
        redis.get = AsyncMock(return_value=None)  # TTL lapsed
        await PresenceService(redis).heartbeat("p-guest", instance_wide=False)
        redis.publish.assert_not_awaited()

        redis2 = AsyncMock()
        redis2.get = AsyncMock(return_value=None)
        await PresenceService(redis2).heartbeat("p-member")
        redis2.publish.assert_awaited_once()

    async def test_a_guest_socket_does_not_subscribe_to_the_instance_channel(
        self,
    ) -> None:
        from app.services.presence_service import INSTANCE_PRESENCE_CHANNEL

        subscribed = await self._channels(guest_session_id="session-1")
        self.assertNotIn(INSTANCE_PRESENCE_CHANNEL, subscribed)

    async def test_a_member_socket_still_subscribes_to_it(self) -> None:
        from app.services.presence_service import INSTANCE_PRESENCE_CHANNEL

        subscribed = await self._channels(guest_session_id=None)
        self.assertIn(INSTANCE_PRESENCE_CHANNEL, subscribed)

    async def _channels(self, *, guest_session_id):
        from app.ws import handler as H

        subscribed: list = []

        class FakePubSub:
            async def subscribe(self, *a):
                subscribed.extend(a)

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "guest_session_is_live", AsyncMock(return_value=True)),
            patch.object(H, "touch_guest_session", AsyncMock()),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(
                    redis, [room], ws, "p1", {room} if guest_session_id else None,
                    guest_session_id,
                )
        return subscribed

    async def _webhook_join(self, participant_type):
        """Drive the LiveKit participant-joined webhook for one participant."""
        from app.api import webhooks as W
        from app.api.tokens import livekit_identity

        pid = _uuid()
        participant = SimpleNamespace(id=pid, participant_type=participant_type)
        room = SimpleNamespace(id=_uuid(), livekit_room_name="stable-bip")
        event = SimpleNamespace(
            participant=SimpleNamespace(identity=livekit_identity("guest-abc", pid)),
            room=SimpleNamespace(name="stable-bip"),
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[_scalar_result(room), _scalar_result(participant)]
        )
        presence = AsyncMock()
        from app.config import Settings

        with patch.object(W, "_broadcast_call_occupancy", AsyncMock()):
            await W._handle_participant_joined(
                event, db, presence, AsyncMock(), AsyncMock(),
                Settings(call_recording_enabled=False),
            )
        return presence

    async def test_a_guest_on_camera_is_not_announced_instance_wide(self) -> None:
        """The SECOND door into the instance channel, and the one a guest
        actually walks through: going on camera fires this webhook. Scoping
        only the websocket would have looked correct and leaked anyway."""
        from app.models.participant import ParticipantType

        presence = await self._webhook_join(ParticipantType.GUEST)
        self.assertFalse(presence.set_online.await_args.kwargs["instance_wide"])

    async def test_a_member_on_camera_still_is(self) -> None:
        from app.models.participant import ParticipantType

        presence = await self._webhook_join(ParticipantType.HUMAN)
        self.assertTrue(presence.set_online.await_args.kwargs["instance_wide"])

    def test_the_webhook_leave_path_mirrors_the_join_path(self) -> None:
        import inspect

        from app.api import webhooks as W

        for fn in (W._handle_participant_joined, W._handle_participant_left):
            with self.subTest(fn=fn.__name__):
                self.assertIn(
                    "ParticipantType.GUEST", inspect.getsource(fn),
                    "presence scope must be decided on both edges, or an "
                    "offline is announced that no online preceded",
                )

    def test_the_endpoint_scopes_presence_by_the_same_flag(self) -> None:
        import inspect

        from app.ws import handler as H

        source = inspect.getsource(H.websocket_endpoint)
        self.assertIn("instance_wide=not is_guest_socket", source)
        # Both directions, or an offline is announced that no online preceded.
        self.assertEqual(source.count("instance_wide=not is_guest_socket"), 2)


class GuestLastSeenTests(IsolatedAsyncioTestCase):
    """``GuestSession.last_seen_at`` is on the owner's live-session view and
    NOTHING wrote it, so that column read NULL forever and the view was
    decorative. The socket liveness tick is the only periodic guest signal the
    server has, so it is what stamps it."""

    async def test_touch_writes_last_seen_at(self) -> None:
        from app.auth.guest_auth import touch_guest_session

        db = AsyncMock()
        await touch_guest_session(db, _uuid())
        db.execute.assert_awaited_once()
        self.assertIn("UPDATE guest_sessions", str(db.execute.await_args.args[0]))
        db.commit.assert_awaited()

    async def test_touch_never_raises(self) -> None:
        """Instrumentation must never be able to kill a live socket."""
        from app.auth.guest_auth import touch_guest_session

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=RuntimeError("db gone"))
        await touch_guest_session(db, _uuid())

    async def test_a_live_guest_socket_stamps_it(self) -> None:
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "guest_session_is_live", AsyncMock(return_value=True)),
            patch.object(H, "touch_guest_session", AsyncMock()) as touch,
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(
                    redis, [room], ws, "p1", {room}, "session-1"
                )
        touch.assert_awaited_once()

    async def test_a_member_socket_never_stamps_it(self) -> None:
        from app.ws import handler as H

        class FakePubSub:
            async def subscribe(self, *a):
                return None

            async def unsubscribe(self, *a):
                return None

            async def aclose(self):
                return None

            async def get_message(self, **kw):
                raise asyncio.CancelledError()

        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=FakePubSub())
        ws = MagicMock()
        ws.app.state.db_session_factory = _FakeSessionFactory()
        room = str(_uuid())
        with (
            patch.object(H, "_get_user_room_ids", AsyncMock(return_value=[room])),
            patch.object(H, "touch_guest_session", AsyncMock()) as touch,
            patch.object(H, "time", SimpleNamespace(monotonic=_stub_clock())),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await H._subscribe_to_rooms(redis, [room], ws, "p1", None, None)
        touch.assert_not_awaited()


# ---------------------------------------------------------------------------
# 13. REDIS OUTAGE — the door must get harder to open, not impossible
# ---------------------------------------------------------------------------


class RedeemRateLimitFallbackTests(IsolatedAsyncioTestCase):
    """A Redis blip used to 503 every would-be guest.

    Wrong shape of failure for this endpoint: the people it locks out are the
    invited guests of a live show, and the thing it protects against is not
    made meaningfully likelier by a few minutes of a coarser limiter. It now
    degrades to a per-process limiter — and NEVER to no limiter.
    """

    def setUp(self) -> None:
        from app import deps

        deps._LOCAL_WINDOWS.clear()

    def tearDown(self) -> None:
        from app import deps

        deps._LOCAL_WINDOWS.clear()

    def _broken_redis(self):
        redis = AsyncMock()
        redis.incr = AsyncMock(side_effect=RuntimeError("redis is gone"))
        return redis

    async def _hit(self, *, limit=3, ident="1.2.3.4", **over):
        from app.deps import _rate_limit_hit

        kwargs = dict(
            bucket="guest_redeem",
            identifier=ident,
            limit=limit,
            window_seconds=60,
            fail_open=False,
            local_fallback=True,
        )
        kwargs.update(over)
        await _rate_limit_hit(self._broken_redis(), **kwargs)

    async def test_the_first_calls_get_through_during_an_outage(self) -> None:
        for _ in range(3):
            await self._hit(limit=3)

    async def test_it_still_runs_out(self) -> None:
        """The whole point: degraded is not unlimited."""
        for _ in range(3):
            await self._hit(limit=3)
        with self.assertRaises(HTTPException) as ctx:
            await self._hit(limit=3)
        self.assertEqual(ctx.exception.status_code, 429)

    async def test_the_fallback_is_per_identifier(self) -> None:
        """One IP burning its budget must not lock out the next guest."""
        for _ in range(3):
            await self._hit(limit=3, ident="1.1.1.1")
        await self._hit(limit=3, ident="2.2.2.2")

    async def test_without_the_opt_in_it_still_fails_closed(self) -> None:
        """GPU/disk buckets keep the old behaviour — for those a 503 really is
        the right answer, so this change must not silently widen them."""
        with self.assertRaises(HTTPException) as ctx:
            await self._hit(local_fallback=False)
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_fail_open_buckets_are_untouched(self) -> None:
        await self._hit(fail_open=True, local_fallback=False, limit=1)
        await self._hit(fail_open=True, local_fallback=False, limit=1)

    async def test_a_full_local_table_refuses_rather_than_admits(self) -> None:
        """Running out of room to COUNT is a reason to say no. If this ever
        returned "allow" instead, an attacker could disable the limiter by
        filling it from rotated addresses — the exact thing it exists for."""
        from app import deps

        window = int(time.time()) // 60
        for i in range(deps._LOCAL_WINDOWS_MAX):
            deps._LOCAL_WINDOWS[("guest_redeem", f"ip-{i}")] = [window, 1]
        with self.assertRaises(HTTPException) as ctx:
            await self._hit(ident="brand-new-ip")
        self.assertEqual(ctx.exception.status_code, 503)

    def test_closed_windows_are_pruned_so_it_cannot_grow_forever(self) -> None:
        from app import deps

        window = int(time.time()) // 60
        deps._LOCAL_WINDOWS[("b", "old")] = [window - 5, 9]
        deps._LOCAL_WINDOWS[("b", "current")] = [window, 1]
        deps._prune_local_windows(window)
        self.assertNotIn(("b", "old"), deps._LOCAL_WINDOWS)
        self.assertIn(("b", "current"), deps._LOCAL_WINDOWS)

    def test_a_zero_limit_is_a_refusal_not_a_bypass(self) -> None:
        from app import deps

        self.assertEqual(
            deps._local_rate_limit_check("b", "ip", 0, 60), deps._LOCAL_LIMITED
        )

    async def test_redeem_opts_into_the_fallback_and_stays_fail_closed(
        self,
    ) -> None:
        """Both, not either: the fallback is an ADDITIONAL answer, never
        permission to skip the check."""
        from app.api import guests as guests_api

        seen: dict = {}

        async def _fake_hit(redis, **kw):
            seen.update(kw)

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        body = guests_api.RedeemBody(token="sgi-" + "a" * 40)
        with patch.object(
            guests_api, "_rate_limit_hit", AsyncMock(side_effect=_fake_hit)
        ):
            with self.assertRaises(HTTPException):
                await guests_api.redeem_guest_invite(
                    body=body,
                    request=_request(client_host="9.9.9.9"),
                    db=db,
                    settings=_settings(rate_limit_enabled=True),
                    redis=AsyncMock(),
                )
        self.assertFalse(seen["fail_open"])
        self.assertTrue(seen["local_fallback"])
        self.assertEqual(seen["identifier"], "9.9.9.9")


class GuestHardeningMigrationTests(unittest.TestCase):
    def test_015_is_stamped_correctly_and_fits_the_version_column(self) -> None:
        import importlib.util
        import pathlib

        path = (
            pathlib.Path(__file__).resolve().parent.parent
            / "alembic"
            / "versions"
            / "015_guest_hardening.py"
        )
        source = path.read_text()
        spec = importlib.util.spec_from_file_location("m015", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.down_revision, "014_guest_access")
        # alembic_version.version_num is varchar(32); a 33-char id once rolled
        # back an entire migration at the version stamp.
        self.assertLessEqual(len(module.revision), 32)
        # The two flags must land CLOSED on every existing row…
        self.assertEqual(source.count('server_default=sa.text("false")'), 2)
        # …and existing invites keep the boundary they would have been given,
        # rather than having the call they were minted for retroactively hidden.
        self.assertIn(
            "UPDATE guest_invites SET history_from = created_at", source
        )


if __name__ == "__main__":
    unittest.main()
