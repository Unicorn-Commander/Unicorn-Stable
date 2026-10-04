"""GET /users/search scope: members by default, realm only when configured.

Members scope must not browse the sign-in realm. A substring query is local
humans only. The admin substring search is not called. At most one realm user
is added, and only on an exact username or email match. Realm scope keeps the
previous whole-realm substring behaviour for a deployment that owns its realm.
"""

from __future__ import annotations

import inspect
import unittest
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import HTTPException
from fastapi.routing import APIRoute
from sqlalchemy.dialects import postgresql

from app.api.users import UserResult
from app.config import Settings
from app.models.participant import ParticipantType


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _user(**over) -> dict:
    user = {
        "sub": "caller-sub",
        "email": "caller@example.com",
        "username": "caller",
        "display_name": "Caller",
        "roles": [],
        "participant_type": "human",
        "participant_id": _uuid(),
    }
    user.update(over)
    return user


def _person(
    display_name: str,
    username: str,
    sub: str,
    *,
    pid: uuid.UUID | None = None,
    ptype: ParticipantType = ParticipantType.HUMAN,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=pid or _uuid(),
        keycloak_sub=sub,
        username=username,
        display_name=display_name,
        avatar_url=None,
        participant_type=ptype,
    )


def _kc(
    sub: str,
    username: str,
    first: str = "",
    last: str = "",
    *,
    email: str = "hidden@example.com",
    enabled: bool = True,
) -> dict:
    return {
        "id": sub,
        "username": username,
        "firstName": first,
        "lastName": last,
        "email": email,
        "enabled": enabled,
    }


def _rows(rows: list[object]) -> MagicMock:
    res = MagicMock()
    res.scalars.return_value.all.return_value = list(rows)
    return res


def _scalar(value: object) -> MagicMock:
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _sql(stmt) -> str:
    return str(
        stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).replace("\n", " ")


def _dep_names(route: APIRoute) -> set[str]:
    names: set[str] = set()

    def walk(dependant) -> None:
        for sub in dependant.dependencies:
            if sub.call is not None:
                names.add(getattr(sub.call, "__qualname__", sub.call.__name__))
            walk(sub)

    walk(route.dependant)
    return names


class UserSearchScopeSettingsTests(unittest.TestCase):
    def test_default_is_members_and_the_search_cap_is_60(self) -> None:
        self.assertEqual(Settings.model_fields["user_search_scope"].default, "members")
        self.assertEqual(
            Settings.model_fields["rate_limit_user_search_per_min"].default, 60
        )

    def test_known_values_are_normalised(self) -> None:
        self.assertEqual(Settings(user_search_scope="members").user_search_scope, "members")
        self.assertEqual(Settings(user_search_scope="REALM").user_search_scope, "realm")
        self.assertEqual(Settings(user_search_scope=" realm ").user_search_scope, "realm")

    def test_unknown_scope_fails_closed_to_members(self) -> None:
        for raw in ("nope", "", "   ", "browse", None, 1):
            with self.subTest(raw=raw):
                self.assertEqual(
                    Settings(user_search_scope=raw).user_search_scope, "members"
                )


class KeycloakExactLookupTests(IsolatedAsyncioTestCase):
    def _admin(self) -> object:
        from app.services.keycloak_admin import KeycloakAdmin

        admin = KeycloakAdmin(
            Settings(
                keycloak_url="http://localhost:8080",
                keycloak_realm="stable",
                keycloak_client_id="stable-backend",
                keycloak_client_secret="test-secret",
            )
        )
        admin._get_token = AsyncMock(return_value="tok")  # type: ignore[method-assign]
        return admin

    def _client(self, handler):
        transport = httpx.MockTransport(handler)
        real = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = transport
            return real(*args, **kwargs)

        return patch("app.services.keycloak_admin.httpx.AsyncClient", factory)

    async def test_username_match_is_exact_and_not_a_substring_search(self) -> None:
        seen: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.url.params))
            return httpx.Response(
                200,
                json=[_kc("sub-ada", "Ada", "Ada", "Lovelace", email="ada@example.com")],
            )

        admin = self._admin()
        with self._client(handler):
            found = await admin.find_user_exact("Ada")  # type: ignore[attr-defined]

        self.assertEqual(found["id"], "sub-ada")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["username"], "Ada")
        self.assertEqual(seen[0]["exact"], "true")
        self.assertEqual(seen[0]["enabled"], "true")
        self.assertNotIn("search", seen[0])
        self.assertNotIn("email", seen[0])

    async def test_email_is_queried_only_when_the_text_contains_at(self) -> None:
        seen: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            seen.append(params)
            if "email" in params:
                return httpx.Response(
                    200,
                    json=[_kc("sub-ada", "ada", "Ada", "Lovelace")],
                )
            return httpx.Response(200, json=[])

        admin = self._admin()
        with self._client(handler):
            missed = await admin.find_user_exact("ada")  # type: ignore[attr-defined]
            found = await admin.find_user_exact("Ada@Example.com")  # type: ignore[attr-defined]

        self.assertIsNone(missed)
        self.assertEqual(found["id"], "sub-ada")
        self.assertEqual(seen[0]["username"], "ada")
        self.assertNotIn("email", seen[0])
        self.assertNotIn("search", seen[0])
        self.assertEqual(seen[1]["username"], "Ada@Example.com")
        self.assertNotIn("search", seen[1])
        self.assertEqual(seen[2]["email"], "Ada@Example.com")
        self.assertEqual(seen[2]["exact"], "true")
        self.assertNotIn("search", seen[2])
        self.assertNotIn("username", seen[2])

    async def test_disabled_user_is_skipped(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json=[
                    _kc("sub-off", "ada", enabled=False),
                    _kc("sub-on", "ada", "Ada", "On"),
                ],
            )

        admin = self._admin()
        with self._client(handler):
            found = await admin.find_user_exact("ada")  # type: ignore[attr-defined]
        self.assertEqual(found["id"], "sub-on")

    async def test_forbidden_is_no_match_and_stops(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(403, json={"error": "forbidden"})

        admin = self._admin()
        with self._client(handler), patch("app.services.keycloak_admin.logger") as log:
            found = await admin.find_user_exact("ada@example.com")  # type: ignore[attr-defined]
        self.assertIsNone(found)
        self.assertEqual(len(seen), 1)
        log.warning.assert_called()
        logged = " ".join(str(part) for part in log.warning.call_args.args)
        logged += " " + " ".join(f"{k}={v}" for k, v in log.warning.call_args.kwargs.items())
        self.assertNotIn("ada@example.com", logged)

    async def test_blank_query_does_not_call_keycloak(self) -> None:
        admin = self._admin()
        self.assertIsNone(await admin.find_user_exact("   "))  # type: ignore[attr-defined]
        admin._get_token.assert_not_awaited()  # type: ignore[attr-defined]


class MembersScopeSearchTests(IsolatedAsyncioTestCase):
    async def _search(
        self,
        q: str,
        *,
        limit: int = 20,
        scope: str = "members",
        rows: list[object] | None = None,
        exact: dict | None = None,
        exact_error: BaseException | None = None,
        scalar: object = None,
        user: dict | None = None,
        realm_hits: list[dict] | None = None,
    ):
        from app.api.users import search_users

        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[_rows(rows or []), _scalar(scalar), _scalar(None)]
        )
        admin = AsyncMock()
        if exact_error is not None:
            admin.find_user_exact = AsyncMock(side_effect=exact_error)
        else:
            admin.find_user_exact = AsyncMock(return_value=exact)
        admin.search_users = AsyncMock(return_value=list(realm_hits or []))
        settings = Settings(user_search_scope=scope)
        with patch("app.api.users.KeycloakAdmin", return_value=admin):
            result = await search_users(
                user=user or _user(),
                db=db,
                settings=settings,
                _rl=None,
                q=q,
                limit=limit,
            )
        return result, admin, db

    async def test_substring_returns_only_local_people(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        result, admin, db = await self._search("ada", rows=[ada], exact=None)
        self.assertEqual([row.username for row in result], ["ada"])
        self.assertTrue(result[0].signed_in)
        self.assertEqual(result[0].id, ada.id)
        self.assertIsNone(result[0].email)
        admin.search_users.assert_not_called()
        admin.find_user_exact.assert_awaited_once_with("ada")
        compiled = _sql(db.execute.await_args_list[0].args[0])
        self.assertIn("'human'", compiled)
        self.assertIn("ILIKE", compiled)
        self.assertIn("%ada%", compiled)
        self.assertIn("display_name", compiled)

    async def test_realm_only_user_is_not_returned_for_a_substring(self) -> None:
        """A substring of a realm user's name must not list them.

        The admin mock is armed with that user on the substring search. Members
        scope must not call it, and the exact lookup misses, so the user is absent.
        """
        jordan = _kc("sub-jordan", "jordan", "Jordan", "Lee", email="jordan@example.com")
        local = _person("Jo Local", "jolocal", "sub-jo")
        result, admin, _db = await self._search(
            "jo", rows=[local], exact=None, realm_hits=[jordan]
        )
        self.assertEqual([row.keycloak_sub for row in result], ["sub-jo"])
        admin.search_users.assert_not_called()
        self.assertNotIn("jordan@example.com", [row.email for row in result])

    async def test_exact_username_returns_that_one_realm_user(self) -> None:
        exact = _kc("sub-ada", "ada", "Ada", "Lovelace", email="ada@example.com")
        result, admin, _db = await self._search("ada", rows=[], exact=exact)
        self.assertEqual(len(result), 1)
        row = result[0]
        self.assertIsNone(row.id)
        self.assertEqual(row.keycloak_sub, "sub-ada")
        self.assertEqual(row.username, "ada")
        self.assertEqual(row.display_name, "Ada Lovelace")
        self.assertIsNone(row.email)
        self.assertFalse(row.signed_in)
        admin.search_users.assert_not_called()
        admin.find_user_exact.assert_awaited_once_with("ada")

    async def test_exact_email_returns_that_user(self) -> None:
        exact = _kc("sub-ada", "ada", "Ada", "Lovelace", email="ada@example.com")
        result, admin, _db = await self._search(
            "ada@example.com", rows=[], exact=exact
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].keycloak_sub, "sub-ada")
        self.assertIsNone(result[0].email)
        self.assertFalse(result[0].signed_in)
        admin.find_user_exact.assert_awaited_once_with("ada@example.com")
        admin.search_users.assert_not_called()

    async def test_exact_email_of_a_local_person_is_signed_in_once(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        exact = _kc("sub-ada", "ada", "Ada", "Lovelace", email="ada@example.com")
        result, admin, _db = await self._search(
            "ada@example.com", rows=[], exact=exact, scalar=ada
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].id, ada.id)
        self.assertTrue(result[0].signed_in)
        self.assertEqual(result[0].display_name, "Ada Lovelace")
        self.assertIsNone(result[0].email)
        admin.search_users.assert_not_called()

    async def test_caller_is_never_returned(self) -> None:
        caller_id = _uuid()
        caller = _user(participant_id=caller_id, sub="caller-sub")
        me = _person("Caller", "caller", "caller-sub", pid=caller_id)
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        result, _admin, db = await self._search(
            "a",
            rows=[me, ada],
            exact=_kc("caller-sub", "caller", "Caller", "Self", email="caller@example.com"),
            user=caller,
        )
        self.assertEqual([row.username for row in result], ["ada"])
        self.assertNotIn(caller_id, [row.id for row in result])
        compiled = _sql(db.execute.await_args_list[0].args[0])
        self.assertIn(str(caller_id), compiled)

    async def test_local_person_who_also_matches_exactly_appears_once(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        exact = _kc("sub-ada", "ada", "Ada", "Lovelace", email="ada@example.com")
        result, admin, db = await self._search("ada", rows=[ada], exact=exact)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].id, ada.id)
        self.assertTrue(result[0].signed_in)
        self.assertIsNone(result[0].email)
        admin.search_users.assert_not_called()
        self.assertEqual(db.execute.await_count, 1)

    async def test_limit_holds(self) -> None:
        people = [
            _person(f"Person {i:02d}", f"p{i}", f"sub-{i}") for i in range(5)
        ]
        capped, admin, db = await self._search("person", limit=2, rows=people, exact=None)
        self.assertEqual([row.display_name for row in capped], ["Person 00", "Person 01"])
        self.assertLessEqual(len(capped), 2)
        compiled = _sql(db.execute.await_args_list[0].args[0])
        self.assertIn("LIMIT 2", compiled)
        self.assertIn("ORDER BY", compiled)
        self.assertIn("display_name", compiled)
        admin.search_users.assert_not_called()

        extra = _kc("sub-exact", "person", "Exact", "Person", email="person@example.com")
        with_extra, _admin2, _db2 = await self._search(
            "person", limit=2, rows=people, exact=extra
        )
        # Local rows stay capped. The one exact realm user is the only extra.
        self.assertEqual(len(with_extra), 3)
        self.assertEqual(with_extra[-1].keycloak_sub, "sub-exact")
        self.assertIsNone(with_extra[-1].email)
        self.assertFalse(with_extra[-1].signed_in)

    async def test_empty_query_is_local_only_and_skips_keycloak(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        bo = _person("Bo", "bo", "sub-bo")
        result, admin, _db = await self._search("", rows=[ada, bo])
        self.assertEqual([row.display_name for row in result], ["Ada Lovelace", "Bo"])
        self.assertTrue(all(row.signed_in and row.id is not None for row in result))
        admin.find_user_exact.assert_not_called()
        admin.search_users.assert_not_called()

        blank, admin2, _db2 = await self._search("   ", rows=[ada])
        self.assertEqual(len(blank), 1)
        admin2.find_user_exact.assert_not_called()
        admin2.search_users.assert_not_called()

    async def test_keycloak_failure_returns_the_local_rows(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        result, admin, _db = await self._search(
            "ada", rows=[ada], exact_error=RuntimeError("keycloak down")
        )
        self.assertEqual([row.username for row in result], ["ada"])
        self.assertIsNone(result[0].email)
        admin.search_users.assert_not_called()

    async def test_unknown_scope_behaves_as_members(self) -> None:
        ada = _person("Ada Lovelace", "ada", "sub-ada")
        jordan = _kc("sub-jordan", "jordan", "Jordan", "Lee")
        result, admin, _db = await self._search(
            "ada",
            scope="not-a-scope",
            rows=[ada],
            exact=None,
            realm_hits=[jordan],
        )
        self.assertEqual(Settings(user_search_scope="not-a-scope").user_search_scope, "members")
        self.assertEqual([row.username for row in result], ["ada"])
        admin.search_users.assert_not_called()

    async def test_members_source_never_calls_the_substring_search(self) -> None:
        from app.api import users as users_api

        source = inspect.getsource(users_api._search_users_members)
        self.assertNotIn(".search_users", source)
        self.assertNotIn("search_users(", source)
        self.assertIn("find_user_exact", source)


class RealmScopeSearchTests(IsolatedAsyncioTestCase):
    async def test_realm_scope_returns_what_it_returns_today(self) -> None:
        from app.api.users import search_users

        caller = _user()
        ada = _person("Local Ada", "ada", "sub-ada")
        hits = [
            _kc(caller["sub"], "caller", "Caller", "Self", email="caller@example.com"),
            _kc("sub-ada", "ada", "Ada", "Lovelace", email="ada@example.com"),
            _kc("sub-new", "newperson", "New", "Person", email="new@example.com"),
            {"username": "noid", "email": "noid@example.com"},
        ]
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_rows([ada]))
        admin = AsyncMock()
        admin.search_users = AsyncMock(return_value=hits)
        admin.find_user_exact = AsyncMock(return_value={"id": "should-not-be-used"})
        with patch("app.api.users.KeycloakAdmin", return_value=admin):
            result = await search_users(
                user=caller,
                db=db,
                settings=Settings(user_search_scope="realm"),
                _rl=None,
                q="a",
                limit=20,
            )
        admin.search_users.assert_awaited_once_with("a", limit=20)
        admin.find_user_exact.assert_not_called()
        by_sub = {row.keycloak_sub: row for row in result}
        self.assertNotIn(caller["sub"], by_sub)
        self.assertNotIn("noid", [row.username for row in result])
        self.assertEqual(by_sub["sub-ada"].id, ada.id)
        self.assertTrue(by_sub["sub-ada"].signed_in)
        # Realm results keep today's name: the sign-in profile, not the local row.
        self.assertEqual(by_sub["sub-ada"].display_name, "Ada Lovelace")
        self.assertIsNone(by_sub["sub-ada"].email)
        self.assertIsNone(by_sub["sub-new"].id)
        self.assertFalse(by_sub["sub-new"].signed_in)
        self.assertEqual(by_sub["sub-new"].display_name, "New Person")
        self.assertIsNone(by_sub["sub-new"].email)
        self.assertTrue(all(row.email is None for row in result))

    async def test_realm_keycloak_failure_is_an_empty_list(self) -> None:
        from app.api.users import search_users

        db = AsyncMock()
        admin = AsyncMock()
        admin.search_users = AsyncMock(side_effect=RuntimeError("down"))
        admin.find_user_exact = AsyncMock()
        with patch("app.api.users.KeycloakAdmin", return_value=admin):
            result = await search_users(
                user=_user(),
                db=db,
                settings=Settings(user_search_scope="realm"),
                _rl=None,
                q="a",
                limit=20,
            )
        self.assertEqual(result, [])
        admin.find_user_exact.assert_not_called()


class SearchRouteGuardTests(unittest.TestCase):
    def test_response_gains_no_realm_field(self) -> None:
        self.assertEqual(
            set(UserResult.model_fields),
            {
                "id",
                "keycloak_sub",
                "username",
                "display_name",
                "email",
                "avatar_url",
                "signed_in",
            },
        )

    def test_route_is_member_only_and_rate_limited(self) -> None:
        from app.api.users import router

        route = next(
            r
            for r in router.routes
            if isinstance(r, APIRoute) and r.path == "/users/search" and "GET" in r.methods
        )
        names = _dep_names(route)
        self.assertIn("get_current_user", names)
        self.assertNotIn("get_guest_or_member", names)
        self.assertNotIn("get_room_controller", names)
        self.assertTrue(
            any(name.startswith("rate_limit.") for name in names),
            names,
        )
        source = inspect.getsource(route.endpoint)
        self.assertIn(
            'rate_limit("user_search", "rate_limit_user_search_per_min")',
            source,
        )


class SearchRejectsGuestsAndGatewayKeysTests(IsolatedAsyncioTestCase):
    """Already true via get_current_user. Pinned here so the search route
    cannot grow a second principal that accepts either credential."""

    async def _call(self, token: str):
        from app.deps import get_current_user

        return await get_current_user(
            _request({"Authorization": f"Bearer {token}"}),
            Settings(keycloak_url="http://localhost:8080", keycloak_realm="stable"),
            AsyncMock(),
        )

    async def test_guest_session_cannot_search(self) -> None:
        from app.auth.guest_auth import mint_session_token
        from app import deps

        with patch.object(deps, "validate_token", AsyncMock()) as validate:
            with self.assertRaises(HTTPException) as ctx:
                await self._call(mint_session_token())
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Guest credentials are not accepted", ctx.exception.detail)
        validate.assert_not_awaited()

    async def test_gateway_key_cannot_search(self) -> None:
        from app import deps
        from app.auth.gateway_auth import is_gateway_key
        from jose import JWTError

        token = "sbk-example"
        self.assertTrue(is_gateway_key(token))
        with patch.object(
            deps, "validate_token", AsyncMock(side_effect=JWTError("not a jwt"))
        ), patch.object(deps, "verify_gateway_key", AsyncMock()) as verify:
            with self.assertRaises(HTTPException) as ctx:
                await self._call(token)
        self.assertEqual(ctx.exception.status_code, 401)
        verify.assert_not_awaited()
        self.assertNotIn("Guest credentials", ctx.exception.detail)


def _request(headers: dict[str, str]):
    from starlette.requests import Request

    raw = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in headers.items()
    ]
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "path": "/api/v1/users/search",
            "raw_path": b"/api/v1/users/search",
            "query_string": b"",
            "headers": raw,
            "client": ("127.0.0.1", 12345),
            "scheme": "http",
            "server": ("test", 80),
        }
    )
