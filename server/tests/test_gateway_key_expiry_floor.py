"""Gateway keys expire, and a history floor is not optional on a read.

Pins: an expired key is 401 "Gateway key expired"; a live key and a NULL
expiry still verify; a revoked key keeps the old message even when it is
also expired; mint refuses none / two / a past expires_at / a future
history; PATCH can extend and clear and cannot un-revoke; GET /keys
returns the lifetime fields and never the key or its hash; messages and
context receive not_before; a cursor older than the floor is an empty page.
"""

from __future__ import annotations

import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.auth.gateway_auth import GatewayAuthError, GatewayPrincipal, hash_key, verify_gateway_key
from app.deps import get_db
from app.services.room_class import RoomClassFacts

TOKEN = "sbk-unit-expiry-floor-not-a-real-secret"
FLOOR = datetime(2026, 6, 1, tzinfo=timezone.utc)
FACTS = RoomClassFacts(room_class="private", humans=1, own_seats=0, foreign_seats=0, guests=0)


def _res(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _row(**overrides):
    base = dict(
        id=uuid.uuid4(),
        key_hash=hash_key(TOKEN),
        agent_id="persephone",
        allowed_rooms=["*"],
        rate_limit_rpm=30,
        can_manage_voice_settings=False,
        revoked_at=None,
        expires_at=None,
        history_from=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


async def _verify(row):
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_res(row))
    return await verify_gateway_key(TOKEN, db)


def _compile(stmt) -> str:
    return str(
        stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    )


def test_migration_revision_and_nullable_columns():
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "025_gateway_key_expiry_floor.py"
    )
    spec = importlib.util.spec_from_file_location("mig_025_gateway_key_expiry_floor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "025_gateway_key_expiry_floor"
    assert module.down_revision == "024_crew_seat_flags"
    assert len(module.revision) <= 32
    source = path.read_text()
    assert "def downgrade" in source
    assert source.count("drop_column") >= 2
    from app.models.agent_gateway_key import AgentGatewayKey

    for column in (AgentGatewayKey.expires_at, AgentGatewayKey.history_from):
        assert column.nullable is True
        assert column.type.timezone is True


def test_jwt_principal_defaults_the_floor_and_expiry_to_none():
    principal = GatewayPrincipal(
        auth_kind="jwt",
        agent_id="dev-aaron",
        allowed_rooms=None,
        rate_key="gwjwt:sub",
        rate_limit_rpm=30,
        human_sub="sub",
    )
    assert principal.history_from is None
    assert principal.expires_at is None


async def test_expired_key_is_401_with_the_distinct_message():
    with pytest.raises(GatewayAuthError) as ctx:
        await _verify(_row(expires_at=datetime.now(timezone.utc) - timedelta(seconds=5)))
    assert ctx.value.status_code == 401
    assert ctx.value.detail == "Gateway key expired"


async def test_unexpired_key_passes_and_carries_the_floor():
    expires = datetime.now(timezone.utc) + timedelta(days=3)
    principal = await _verify(_row(expires_at=expires, history_from=FLOOR))
    assert principal.auth_kind == "key"
    assert principal.agent_id == "persephone"
    assert principal.history_from == FLOOR
    assert principal.expires_at == expires


async def test_null_expiry_passes():
    principal = await _verify(_row())
    assert principal.expires_at is None
    assert principal.history_from is None
    # A double that predates the columns is the same as NULL.
    bare = SimpleNamespace(
        id=uuid.uuid4(),
        key_hash=hash_key(TOKEN),
        agent_id="persephone",
        allowed_rooms=["*"],
        rate_limit_rpm=30,
        can_manage_voice_settings=False,
        revoked_at=None,
    )
    principal = await _verify(bare)
    assert principal.expires_at is None
    assert principal.history_from is None


async def test_revoked_still_wins_and_keeps_the_old_message():
    with pytest.raises(GatewayAuthError) as ctx:
        await _verify(
            _row(
                revoked_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
                expires_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
            )
        )
    assert ctx.value.status_code == 401
    assert ctx.value.detail == "Invalid or revoked gateway key"

    db = AsyncMock()
    db.execute = AsyncMock(return_value=_res(None))
    with pytest.raises(GatewayAuthError) as missing:
        await verify_gateway_key(TOKEN, db)
    assert missing.value.detail == "Invalid or revoked gateway key"
    assert "revoked_at is null" in str(db.execute.await_args.args[0]).lower()


def test_mint_validation_matrix():
    with pytest.raises(ValidationError) as none:
        G.MintKeyBody(agent_id="probe")
    text = str(none.value)
    assert "expires_in_days" in text
    assert "expires_at" in text
    assert "no_expiry" in text

    with pytest.raises(ValidationError) as two:
        G.MintKeyBody(agent_id="probe", expires_in_days=10, no_expiry=True)
    assert "expires_in_days" in str(two.value)
    assert "no_expiry" in str(two.value)

    with pytest.raises(ValidationError) as past:
        G.MintKeyBody(
            agent_id="probe",
            expires_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
        )
    assert "past" in str(past.value)

    with pytest.raises(ValidationError) as future:
        G.MintKeyBody(agent_id="probe", no_expiry=True, history="2099-01-01T00:00:00Z")
    assert "future" in str(future.value)

    ok = G.MintKeyBody(agent_id="probe", expires_in_days=30, history="from_mint")
    assert ok.expires_in_days == 30
    assert ok.history == "from_mint"
    assert G.MintKeyBody(agent_id="probe", no_expiry=True).history == "full"


async def test_mint_matrix_is_http_422():
    app = FastAPI()
    app.include_router(G.router, prefix="/api/v1")
    # Body validation is what we are pinning. This FastAPI resolves get_db
    # before it answers 422, and a bare app has no session factory.
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        none = await client.post("/api/v1/gateway/keys", json={"agent_id": "probe"})
        two = await client.post(
            "/api/v1/gateway/keys",
            json={
                "agent_id": "probe",
                "expires_in_days": 10,
                "expires_at": "2030-01-01T00:00:00Z",
            },
        )
        past = await client.post(
            "/api/v1/gateway/keys",
            json={"agent_id": "probe", "expires_at": "2020-01-01T00:00:00Z"},
        )
        future = await client.post(
            "/api/v1/gateway/keys",
            json={"agent_id": "probe", "no_expiry": True, "history": "2099-01-01T00:00:00+00:00"},
        )
    for response in (none, two, past, future):
        assert response.status_code == 422, response.text
    assert "expires_in_days" in none.text and "expires_at" in none.text and "no_expiry" in none.text
    assert "past" in past.text
    assert "future" in future.text


async def test_mint_stores_the_choice_and_does_not_return_the_hash():
    db = AsyncMock()
    db.add = MagicMock()
    db.commit = AsyncMock()

    async def refresh(row):
        row.id = row.id or uuid.uuid4()

    db.refresh = AsyncMock(side_effect=refresh)
    before = datetime.now(timezone.utc)
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        out = await G.mint_gateway_key(
            G.MintKeyBody(agent_id="probe", expires_in_days=7, history="from_mint"),
            SimpleNamespace(headers={}),
            db,
        )
    row = db.add.call_args.args[0]
    assert before + timedelta(days=6) < row.expires_at < before + timedelta(days=8)
    assert before - timedelta(seconds=5) <= row.history_from <= datetime.now(timezone.utc)
    assert row.key_hash == hash_key(out["key"])
    assert "key_hash" not in out
    assert out["expired"] is False
    assert out["days_left"] == 7
    assert out["history_from"] == row.history_from


def _patch_row():
    return SimpleNamespace(
        id=uuid.uuid4(),
        agent_id="persephone",
        key_prefix="sbk-abcd",
        label="seat",
        allowed_rooms=["*"],
        rate_limit_rpm=30,
        can_manage_voice_settings=False,
        revoked_at=None,
        expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        history_from=None,
        created_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
    )


def _patch_db(row):
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_res(row))
    db.commit = AsyncMock()
    return db


async def test_patch_extends_and_clears_expiry_and_sets_history():
    row = _patch_row()
    later = datetime.now(timezone.utc) + timedelta(days=40)
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        extended = await G.patch_gateway_key(
            row.id, G.PatchKeyBody(expires_at=later), SimpleNamespace(headers={}), _patch_db(row)
        )
    assert row.expires_at == later
    assert extended["expired"] is False
    assert extended["days_left"] >= 39
    assert "key" not in extended and "key_hash" not in extended

    before = datetime.now(timezone.utc)
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        await G.patch_gateway_key(
            row.id,
            G.PatchKeyBody(expires_in_days=20),
            SimpleNamespace(headers={}),
            _patch_db(row),
        )
    assert before + timedelta(days=19) < row.expires_at < before + timedelta(days=21)

    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        cleared = await G.patch_gateway_key(
            row.id, G.PatchKeyBody(no_expiry=True), SimpleNamespace(headers={}), _patch_db(row)
        )
    assert row.expires_at is None
    assert cleared["expires_at"] is None
    assert cleared["days_left"] is None
    assert cleared["expired"] is False

    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        minted = await G.patch_gateway_key(
            row.id, G.PatchKeyBody(history="from_mint"), SimpleNamespace(headers={}), _patch_db(row)
        )
    assert row.history_from == row.created_at
    assert minted["history_from"] == row.created_at

    iso = datetime(2026, 5, 1, tzinfo=timezone.utc)
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        await G.patch_gateway_key(
            row.id,
            G.PatchKeyBody(history=iso.isoformat()),
            SimpleNamespace(headers={}),
            _patch_db(row),
        )
    assert row.history_from == iso

    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        await G.patch_gateway_key(
            row.id, G.PatchKeyBody(history="full"), SimpleNamespace(headers={}), _patch_db(row)
        )
    assert row.history_from is None
    assert row.revoked_at is None


def test_patch_refuses_two_expiry_choices_a_past_time_and_a_future_history():
    with pytest.raises(ValidationError) as two:
        G.PatchKeyBody(expires_in_days=5, no_expiry=True)
    assert "expires_in_days" in str(two.value) and "no_expiry" in str(two.value)
    with pytest.raises(ValidationError) as past:
        G.PatchKeyBody(expires_at=datetime(2020, 1, 1, tzinfo=timezone.utc))
    assert "past" in str(past.value)
    with pytest.raises(ValidationError) as future:
        G.PatchKeyBody(history="2099-01-01T00:00:00Z")
    assert "future" in str(future.value)
    assert "revoked_at" not in G.PatchKeyBody.model_fields
    # A label-only PATCH is still a PATCH: expiry is unchanged.
    body = G.PatchKeyBody(label="renamed")
    assert body.expires_at is None and body.no_expiry is False and body.history is None


async def test_patch_cannot_unrevoke():
    row = _patch_row()
    revoked_at = datetime(2026, 1, 2, tzinfo=timezone.utc)
    row.revoked_at = revoked_at
    body = G.PatchKeyBody.model_validate(
        {"no_expiry": True, "history": "full", "revoked_at": None, "revoked": False}
    )
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        with pytest.raises(HTTPException) as ctx:
            await G.patch_gateway_key(row.id, body, SimpleNamespace(headers={}), _patch_db(row))
    assert ctx.value.status_code == 409
    assert row.revoked_at == revoked_at
    assert row.expires_at is not None  # the clear never ran


def test_days_left_is_never_zero_or_negative():
    now = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
    soon = G.key_lifetime_view(now + timedelta(hours=12), FLOOR, now=now)
    assert soon["days_left"] == 1
    assert soon["expired"] is False
    exact = G.key_lifetime_view(now + timedelta(days=10), None, now=now)
    assert exact["days_left"] == 10
    lapsed = G.key_lifetime_view(now - timedelta(seconds=1), None, now=now)
    assert lapsed["expired"] is True
    assert lapsed["days_left"] is None
    due = G.key_lifetime_view(now, None, now=now)
    assert due["expired"] is True and due["days_left"] is None
    open_ended = G.key_lifetime_view(None, None, now=now)
    assert open_ended == {
        "expires_at": None,
        "history_from": None,
        "days_left": None,
        "expired": False,
    }


async def test_list_shape_hides_the_key_and_its_hash():
    future = datetime.now(timezone.utc) + timedelta(days=10)
    past = datetime.now(timezone.utc) - timedelta(days=2)
    rows = [
        SimpleNamespace(
            id=uuid.uuid4(),
            agent_id="persephone",
            key_prefix="sbk-live",
            label="live",
            allowed_rooms=["*"],
            rate_limit_rpm=30,
            can_manage_voice_settings=False,
            revoked_at=None,
            expires_at=future,
            history_from=FLOOR,
            key_hash="do-not-return",
            key=TOKEN,
        ),
        SimpleNamespace(
            id=uuid.uuid4(),
            agent_id="old",
            key_prefix="sbk-dead",
            label=None,
            allowed_rooms=["*"],
            rate_limit_rpm=30,
            can_manage_voice_settings=False,
            revoked_at=None,
            expires_at=past,
            history_from=None,
            key_hash="do-not-return",
        ),
        SimpleNamespace(
            id=uuid.uuid4(),
            agent_id="open",
            key_prefix="sbk-open",
            label=None,
            allowed_rooms=["*"],
            rate_limit_rpm=30,
            can_manage_voice_settings=False,
            revoked_at=None,
            expires_at=None,
            history_from=None,
        ),
    ]
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)
    with patch.object(G, "verify_key_admin_bearer", lambda _request: None):
        out = await G.list_gateway_keys(SimpleNamespace(headers={}), db)
    live, dead, open_ended = out["keys"]
    assert live["days_left"] == 10
    assert live["expired"] is False
    assert live["history_from"] == FLOOR
    assert dead["expired"] is True
    assert dead["days_left"] is None
    assert open_ended["expires_at"] is None
    assert open_ended["days_left"] is None
    assert open_ended["expired"] is False
    for item in out["keys"]:
        assert "key" not in item
        assert "key_hash" not in item
        blob = repr(item)
        assert TOKEN not in blob
        assert "do-not-return" not in blob


async def test_floor_is_passed_on_messages_and_on_context():
    room = SimpleNamespace(
        id=uuid.uuid4(), room_type=None, parent_room_id=None, metadata_=None
    )
    principal = SimpleNamespace(agent_id="persephone", history_from=FLOOR)
    svc = SimpleNamespace(
        get_messages=AsyncMock(return_value={"messages": [], "cursor": None, "has_more": False})
    )
    with (
        patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
        patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)),
        patch.object(G, "_enforce_scope", new=AsyncMock()),
        patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")),
        patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=None)),
        patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=FACTS)),
        patch.object(G, "touch_bridge_seen", new=AsyncMock()),
        patch.object(G, "clear_relay_pending", new=AsyncMock()),
        patch.object(G, "_build_message_service", return_value=svc),
    ):
        page = await G.gateway_get_messages(
            room="hub",
            principal=principal,
            db=AsyncMock(),
            livekit=AsyncMock(),
            redis=AsyncMock(),
            cursor="cursor-1",
            limit=50,
        )
    assert svc.get_messages.await_args.kwargs["not_before"] == FLOOR
    assert svc.get_messages.await_args.kwargs["cursor"] == "cursor-1"
    assert page.messages == []

    build = AsyncMock(
        return_value={
            "room_id": room.id,
            "budget_tokens": 6000,
            "used_tokens": 0,
            "truncated": False,
            "watermark": None,
            "summary": None,
            "entries": [],
        }
    )
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_res(None))
    with (
        patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
        patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)),
        patch.object(G, "_enforce_scope", new=AsyncMock()),
        patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=FACTS)),
        patch("app.services.context_builder.build_context", new=build),
    ):
        await G.gateway_get_context(
            room="hub",
            principal=principal,
            db=db,
            redis=AsyncMock(),
            budget_tokens=6000,
            since=None,
        )
    assert build.await_args.kwargs["not_before"] == FLOOR

    # No attribute (a JWT-shaped double) is full history, not an empty room.
    bare = SimpleNamespace(agent_id="persephone")
    with (
        patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
        patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)),
        patch.object(G, "_enforce_scope", new=AsyncMock()),
        patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")),
        patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=None)),
        patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=FACTS)),
        patch.object(G, "touch_bridge_seen", new=AsyncMock()),
        patch.object(G, "clear_relay_pending", new=AsyncMock()),
        patch.object(G, "_build_message_service", return_value=svc),
    ):
        await G.gateway_get_messages(
            room="hub",
            principal=bare,
            db=AsyncMock(),
            livekit=AsyncMock(),
            redis=AsyncMock(),
            cursor=None,
            limit=50,
        )
    assert svc.get_messages.await_args.kwargs["not_before"] is None


async def test_a_pre_floor_cursor_yields_an_empty_page():
    from app.services.message_service import MessageService

    cursor_ts = datetime(2026, 5, 1, tzinfo=timezone.utc)
    captured: list = []

    async def _execute(stmt, *args, **kwargs):
        captured.append(stmt)
        res = MagicMock()
        if len(captured) == 1:
            res.scalar_one_or_none.return_value = cursor_ts
        else:
            res.scalars.return_value.all.return_value = []
            res.scalar.return_value = 0
            res.scalar_one_or_none.return_value = None
        return res

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    result = await MessageService(db=db, livekit=AsyncMock()).get_messages(
        room_id=uuid.uuid4(), cursor=str(uuid.uuid4()), limit=10, not_before=FLOOR
    )
    assert result["messages"] == []
    assert result["has_more"] is False
    assert result["cursor"] is None
    compiled = _compile(captured[1])
    assert "messages.created_at >=" in compiled
    assert "2026-06-01" in compiled
    assert "2026-05-01" in compiled
    # The cursor bound is strictly older than the floor, so the two
    # predicates cannot both match a row.
    without_floor = compiled.replace("messages.created_at >=", "")
    assert "messages.created_at <" in without_floor


async def test_since_before_the_floor_still_hides_pre_floor_lines():
    from app.services.context_builder import build_context

    since_ts = datetime(2026, 5, 1, tzinfo=timezone.utc)
    captured: list = []

    async def _execute(stmt, *args, **kwargs):
        captured.append(stmt)
        res = MagicMock()
        if len(captured) == 1:
            res.scalar_one_or_none.return_value = since_ts
        elif len(captured) == 2:
            res.scalars.return_value.all.return_value = []
        else:
            res.scalar_one_or_none.return_value = {
                "context_summary": {
                    "text": "PRE-FLOOR secret venue",
                    "watermark_ts": "2020-01-01T00:00:00+00:00",
                }
            }
        return res

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    out = await build_context(
        db, room_id=uuid.uuid4(), since_message_id=uuid.uuid4(), not_before=FLOOR
    )
    compiled = _compile(captured[1])
    assert "messages.created_at >=" in compiled
    assert "2026-06-01" in compiled
    assert "2026-05-01" in compiled
    without_floor = compiled.replace("messages.created_at >=", "")
    assert "messages.created_at >" in without_floor
    assert out["entries"] == []
    assert out["summary"] is None
    assert "PRE-FLOOR" not in repr(out)
