"""Hanging up while it is still ringing must END the ring.

Measured on dogfood (stable-backend, room 3878dd2f "Build In Public — E04",
2026-09-01 22:17 and 2026-09-02 22:59): every ring Aaron started in that room
he had to cancel by hand (+21 s, +10 s) — the ring was sent BEFORE he was in
the call, and nothing but the Cancel button or the 45 s deadline stopped it.
The client now rings only once connected and cancels on hang-up; this is the
server-side backstop for the crashed tab / quit native wrapper: the LiveKit
``participant_left`` webhook cancels the leaver's own still-ringing offer.

Contract:
  * the CALLER leaving the media room cancels their ringing offer, and both
    sides are told (call_ring_state + call_resolved to the caller,
    call_resolved to each callee);
  * a CALLEE leaving some room never cancels an offer aimed at them;
  * a call that is no longer ringing is left alone;
  * a device handoff — the identity is still in the LiveKit room when the
    old leg's participant_left arrives — does not cancel.
"""

import json
import uuid
from types import SimpleNamespace

import pytest

from app.api.webhooks import _cancel_ring_on_leave
from app.services.call_service import CallService


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.published = []

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **_kwargs):
        self.values[key] = value

    async def delete(self, key):
        self.values.pop(key, None)

    async def publish(self, channel, payload):
        self.published.append((channel, json.loads(payload)))


class FakeLiveKit:
    def __init__(self, identities=None, *, raises=False):
        self.identities = identities or []
        self.raises = raises

    async def get_room(self, _name):
        if self.raises:
            raise RuntimeError("livekit down")
        return {
            "room": None,
            "participants": [SimpleNamespace(identity=i) for i in self.identities],
        }


def _room(room_id: str):
    return SimpleNamespace(
        id=uuid.UUID(room_id),
        livekit_room_name="stable-e04",
        room_type=SimpleNamespace(value="group_dm"),
        display_name="Build In Public — E04",
    )


async def _ring(redis: FakeRedis, *, caller: str, callee: str, room: str):
    redis.values[f"presence:{callee}"] = "online"
    svc = CallService(redis)
    call = await svc.ring(
        room_id=room,
        room_type="group_dm",
        room_name="Build In Public — E04",
        caller_id=caller,
        caller_name="aaron",
        caller_avatar_url=None,
        callees=[{"id": callee, "display_name": "Shafen"}],
    )
    assert call["state"] == "ringing"
    redis.published.clear()
    return svc, call


CALLER = str(uuid.uuid4())
CALLEE = str(uuid.uuid4())
ROOM = str(uuid.uuid4())


@pytest.mark.asyncio
async def test_caller_leaving_the_media_room_cancels_their_ring():
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)

    await _cancel_ring_on_leave(redis, FakeLiveKit([]), _room(ROOM), CALLER)

    stored = await svc.get_call(call["call_id"])
    assert stored["state"] == "canceled"
    assert stored["resolved_by"] == CALLER
    # Busy latches released for both parties — the next call must not read
    # either of them as "busy".
    assert f"callring:{CALLER}" not in redis.values
    assert f"callring:{CALLEE}" not in redis.values
    # Both sides told, on the user channels every device subscribes to.
    frames = {(ch, p["type"], p.get("reason") or p.get("state")) for ch, p in redis.published}
    assert (f"user:{CALLER}", "call_ring_state", "canceled") in frames
    assert (f"user:{CALLER}", "call_resolved", "canceled") in frames
    assert (f"user:{CALLEE}", "call_resolved", "canceled") in frames


@pytest.mark.asyncio
async def test_callee_leaving_does_not_cancel_an_offer_aimed_at_them():
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)

    await _cancel_ring_on_leave(redis, FakeLiveKit([]), _room(ROOM), CALLEE)

    assert (await svc.get_call(call["call_id"]))["state"] == "ringing"
    assert redis.published == []


@pytest.mark.asyncio
async def test_device_handoff_keeps_the_ring_alive():
    """participant_left for the OLD leg while the identity is still on the line."""
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)

    still_there = FakeLiveKit([f"aaron_{CALLER}", "agent-majik"])
    await _cancel_ring_on_leave(redis, still_there, _room(ROOM), CALLER)

    assert (await svc.get_call(call["call_id"]))["state"] == "ringing"
    assert redis.published == []


@pytest.mark.asyncio
async def test_leaving_a_different_room_leaves_the_ring_alone():
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)

    await _cancel_ring_on_leave(redis, FakeLiveKit([]), _room(str(uuid.uuid4())), CALLER)

    assert (await svc.get_call(call["call_id"]))["state"] == "ringing"


@pytest.mark.asyncio
async def test_already_resolved_call_is_not_re_resolved():
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)
    await svc.accept(call, participant_id=CALLEE, display_name="Shafen")
    redis.published.clear()

    await _cancel_ring_on_leave(redis, FakeLiveKit([]), _room(ROOM), CALLER)

    assert (await svc.get_call(call["call_id"]))["state"] == "accepted"
    assert redis.published == []


@pytest.mark.asyncio
async def test_probe_failure_counts_as_still_there():
    """A LiveKit outage must not end a ring the caller may still be waiting on."""
    redis = FakeRedis()
    svc, call = await _ring(redis, caller=CALLER, callee=CALLEE, room=ROOM)

    with pytest.raises(RuntimeError):
        await _cancel_ring_on_leave(redis, FakeLiveKit(raises=True), _room(ROOM), CALLER)

    assert (await svc.get_call(call["call_id"]))["state"] == "ringing"


@pytest.mark.asyncio
async def test_service_cancel_by_caller_returns_none_when_nothing_rings():
    redis = FakeRedis()
    assert await CallService(redis).cancel_ringing_by_caller(CALLER) is None
