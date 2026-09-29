"""L4 — the gateway context mirror tells a seat its own standing: the
seat's participant id (so it can tell its own lines apart) and its
agent_mode / context_depth in this room. Additive to the L0 payload."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api import gateway as G
from app.services.room_class import RoomClassFacts

# Nav v3: the mirror also computes the room's class (history-aware, with
# its own queries); pinned in tests/test_nav_v3_fix_class.py. Patched here so
# these L4 assertions stay about seat id / mode / depth.
FACTS = RoomClassFacts(room_class="private", humans=1, own_seats=0, foreign_seats=0, guests=0)


def _result(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _payload(room_id, seat_id):
    ts = datetime(2026, 9, 21, tzinfo=timezone.utc)
    mid = uuid.uuid4()
    return {
        "room_id": room_id,
        "budget_tokens": 6000,
        "used_tokens": 12,
        "truncated": False,
        "watermark": mid,
        "summary": "Earlier: venue = sunroom.",
        "entries": [
            {"id": mid, "ts": ts, "sender": {"id": seat_id, "name": "Persephone", "kind": "agent"}, "kind": "message", "text": "hi", "parent_id": None}
        ],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["listening", "when_named", None])
async def test_mirror_carries_seat_id_mode_and_depth(mode):
    room = SimpleNamespace(id=uuid.uuid4())
    seat = SimpleNamespace(id=uuid.uuid4())
    membership = SimpleNamespace(agent_mode=mode, context_depth=80)
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_result(seat), _result(membership)])
    principal = SimpleNamespace(agent_id="persephone")
    build = AsyncMock(return_value=_payload(room.id, seat.id))
    with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), patch.object(
        G, "_resolve_room", new=AsyncMock(return_value=room)
    ), patch.object(G, "_enforce_scope", new=AsyncMock()), patch.object(
        G, "_classify_for_seat", new=AsyncMock(return_value=FACTS)
    ), patch("app.services.context_builder.build_context", new=build):
        out = await G.gateway_get_context(
            room="persephone", principal=principal, db=db, redis=AsyncMock(), budget_tokens=4000, since=None
        )
    assert out["seat_participant_id"] == str(seat.id)
    assert out["agent_mode"] == mode
    assert out["context_depth"] == 80
    assert out["summary"] == "Earlier: venue = sunroom."
    assert out["entries"][0]["sender"]["id"] == str(seat.id)
    assert out["entries"][0]["kind"] == "message"
    kwargs = build.await_args.kwargs
    assert kwargs["for_participant_id"] == seat.id
    assert kwargs["budget_tokens"] == 4000


@pytest.mark.asyncio
async def test_mirror_without_a_seat_participant_degrades_to_nulls():
    room = SimpleNamespace(id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_result(None)])
    principal = SimpleNamespace(agent_id="ghost")
    build = AsyncMock(return_value=_payload(room.id, None))
    with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), patch.object(
        G, "_resolve_room", new=AsyncMock(return_value=room)
    ), patch.object(G, "_enforce_scope", new=AsyncMock()), patch.object(
        G, "_classify_for_seat", new=AsyncMock(return_value=FACTS)
    ), patch("app.services.context_builder.build_context", new=build):
        out = await G.gateway_get_context(
            room="x", principal=principal, db=db, redis=AsyncMock(), budget_tokens=6000, since=None
        )
    assert out["seat_participant_id"] is None
    assert out["agent_mode"] is None
    assert out["context_depth"] is None
    assert build.await_args.kwargs["for_participant_id"] is None
    # No membership lookup without a seat: exactly one execute.
    assert db.execute.await_count == 1
