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

    def test_rate_limit_principal_keys_on_participant_not_secret(self) -> None:
        import inspect

        from app.deps import rate_limit_principal

        source = inspect.getsource(rate_limit_principal)
        self.assertIn('identifier=str(user["participant_id"])', source)
        self.assertNotIn("token", source.split('"""')[-1])


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


if __name__ == "__main__":
    unittest.main()
