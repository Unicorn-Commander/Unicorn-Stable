"""L4 — POST /rooms/{id}/context/summarize: owner/admin only, 503 when the
feature is off (naming the switch, never a value), 409 when leased, 200
with the stored summary otherwise. Mounted under /api/v1."""

from __future__ import annotations

import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api import context as context_api
from app.deps import get_current_user, get_db, get_settings_dep
from app.models.room import MemberRole


def _result(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _app(membership, settings):
    app = FastAPI()
    app.include_router(context_api.router, prefix="/api/v1")
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_result(membership))
    app.dependency_overrides[get_current_user] = lambda: {"participant_id": uuid.uuid4()}
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_settings_dep] = lambda: settings
    app.state.db_session_factory = MagicMock()
    app.state.redis = MagicMock()
    return app


ENABLED = SimpleNamespace(
    context_summary_enabled=True,
    context_summary_base_url="http://fake-gateway/v1",
    context_summary_api_key="sk-fake",
    context_summary_model="lane",
)
DISABLED = SimpleNamespace(context_summary_enabled=False)


async def _post(app, room_id):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(f"/api/v1/rooms/{room_id}/context/summarize")


@pytest.mark.asyncio
async def test_owner_gets_the_stored_summary():
    room_id = uuid.uuid4()
    stored = {
        "text": "Venue = sunroom.",
        "watermark": "m9",
        "watermark_ts": "2026-09-21T12:00:00+00:00",
        "updated_at": "2026-09-21T12:01:00+00:00",
        "message_count": 51,
        "model": "lane",
    }
    app = _app(SimpleNamespace(role=MemberRole.OWNER), ENABLED)
    with patch.object(context_api, "summarize_room", new=AsyncMock(return_value=stored)) as run:
        resp = await _post(app, room_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["room_id"] == str(room_id)
    assert body["unchanged"] is False
    assert body["summary"] == {k: stored[k] for k in ("text", "watermark", "watermark_ts", "updated_at", "message_count")}
    assert "model" not in body["summary"]
    assert run.await_args.kwargs["force"] is True
    assert run.await_args.args[2] == room_id


@pytest.mark.asyncio
@pytest.mark.parametrize("membership", [None, SimpleNamespace(role=MemberRole.MEMBER), SimpleNamespace(role=MemberRole.GUEST)])
async def test_non_admin_members_and_outsiders_are_refused(membership):
    app = _app(membership, ENABLED)
    with patch.object(context_api, "summarize_room", new=AsyncMock()) as run:
        resp = await _post(app, uuid.uuid4())
    assert resp.status_code == 403
    run.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_feature_is_503_naming_the_switch_not_a_value():
    app = _app(SimpleNamespace(role=MemberRole.ADMIN), DISABLED)
    with patch.object(context_api, "summarize_room", new=AsyncMock()) as run:
        resp = await _post(app, uuid.uuid4())
    assert resp.status_code == 503
    assert "CONTEXT_SUMMARY_ENABLED" in resp.json()["detail"]
    run.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_key_is_503_without_leaking_anything():
    settings = SimpleNamespace(
        context_summary_enabled=True,
        context_summary_base_url="http://fake-gateway/v1",
        context_summary_api_key="",
        context_summary_model="lane",
    )
    app = _app(SimpleNamespace(role=MemberRole.ADMIN), settings)
    resp = await _post(app, uuid.uuid4())
    assert resp.status_code == 503
    assert "CONTEXT_SUMMARY_API_KEY" in resp.json()["detail"]
    assert "fake-gateway" not in resp.json()["detail"]


@pytest.mark.asyncio
async def test_lease_busy_is_409_and_gateway_failure_is_502():
    from app.services.context_summary import SummaryError

    app = _app(SimpleNamespace(role=MemberRole.ADMIN), ENABLED)
    with patch.object(context_api, "summarize_room", new=AsyncMock(return_value=None)):
        assert (await _post(app, uuid.uuid4())).status_code == 409
    with patch.object(context_api, "summarize_room", new=AsyncMock(side_effect=SummaryError("summary gateway HTTP 500"))):
        resp = await _post(app, uuid.uuid4())
    assert resp.status_code == 502
    assert "HTTP 500" in resp.json()["detail"]


class Mounted(unittest.TestCase):
    def test_route_is_mounted_under_v1_and_member_only(self) -> None:
        """Reads what FastAPI actually wired (the guest-access audit's view),
        not the source: the route exists under /api/v1 and sits behind the
        guest-refusing principal dependency."""
        from app.main import create_app

        app = create_app()
        paths = app.openapi().get("paths") or {}
        self.assertIn("post", paths.get("/api/v1/rooms/{room_id}/context/summarize", {}))
        deps = _wired_dependency_names(app, "/api/v1/rooms/{room_id}/context/summarize")
        self.assertIn("get_current_user", deps)
        self.assertNotIn("get_guest_or_member", deps)


def _wired_dependency_names(app, path: str) -> set[str]:
    from fastapi.routing import APIRoute

    def walk(routes, prefix=""):
        for route in routes:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                ctx = getattr(route, "include_context", None)
                yield from walk(inner.routes, prefix + (getattr(ctx, "prefix", "") or ""))
            elif isinstance(route, APIRoute):
                yield prefix + route.path, route

    def names(dependant, acc):
        for sub in dependant.dependencies:
            if sub.call is not None:
                acc.add(getattr(sub.call, "__name__", str(sub.call)))
            names(sub, acc)
        return acc

    for full_path, route in walk(app.routes):
        if full_path == path:
            return names(route.dependant, set())
    raise AssertionError(f"route not wired: {path}")
