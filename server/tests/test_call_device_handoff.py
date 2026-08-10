"""Device handoff: joining YOUR OWN live call from another device.

The live repro (PO task f8467962): Aaron, mid-DM-call on his desktop, joined
the same call from his phone. Two failures followed:

  1. His desktop leg died silently — LiveKit identity is minted per PERSON
     (``username_<uuid>``, api/tokens.py), so a second device is a duplicate
     identity and LiveKit hands the call to the newest connection. That part
     is the intended handoff mechanism; the client now names it.
  2. Moving BACK to the desktop was refused with "<peer> is busy" — the
     phone's "join" was really a fresh ring, which latched both parties busy
     for the 45s window, and the busy check counted the caller's OWN call as
     making his peer unavailable.

The contract under test: a participant already party to a call may always
(re)join that call from any device. Concretely —

  * a callee who is ON the room's call is answered with ``in_call`` (client
    just joins), never rung, never latched, never pushed;
  * the busy verdict means "engaged with someone who is NOT you" — a latch
    pointing at a call the caller is party to does not count;
  * re-ringing your own still-live offer hands the SAME offer back instead of
    stacking a second ring on the callee's devices.
"""

import uuid
from types import SimpleNamespace

import pytest

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
        self.published.append((channel, payload))


def _online(redis: FakeRedis, *participant_ids: str) -> None:
    for pid in participant_ids:
        redis.values[f"presence:{pid}"] = "online"


async def _ring(svc: CallService, *, caller: str, callee: str, room: str, **kwargs):
    return await svc.ring(
        room_id=room,
        room_type="dm",
        room_name="Direct message",
        caller_id=caller,
        caller_name=caller.title(),
        caller_avatar_url=None,
        callees=[{"id": callee, "display_name": callee.title(), "push_reachable": False}],
        **kwargs,
    )


def _call_started_frames(redis: FakeRedis, participant_id: str) -> list[str]:
    return [
        payload
        for channel, payload in redis.published
        if channel == f"user:{participant_id}" and '"call_started"' in payload
    ]


# ---------------------------------------------------------------------------
# Busy-check exclusion: "busy" must mean "engaged with someone else"
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_peer_engaged_with_caller_is_not_busy():
    """A latch pointing at the CALLER's own call must not read as busy."""
    redis = FakeRedis()
    _online(redis, "peer")
    svc = CallService(redis)

    first = await _ring(svc, caller="aaron", callee="peer", room="room-1")
    assert first["state"] == "ringing"  # latches callring:aaron / callring:peer

    # Same caller reaches for the same peer from another room while his own
    # offer is still live. The peer's engagement IS with him — not busy.
    second = await _ring(svc, caller="aaron", callee="peer", room="room-2")
    assert second["state"] == "ringing"
    assert second["targets"][0]["state"] == "ringing"


@pytest.mark.asyncio
async def test_peer_engaged_with_third_party_is_still_busy():
    """The exclusion is surgical: engagement with ANYONE ELSE stays busy."""
    redis = FakeRedis()
    _online(redis, "peer")
    svc = CallService(redis)

    first = await _ring(svc, caller="aaron", callee="peer", room="room-1")
    assert first["state"] == "ringing"

    third = await _ring(svc, caller="chris", callee="peer", room="room-3")
    assert third["state"] == "unreachable"
    assert third["targets"][0]["state"] == "busy"


@pytest.mark.asyncio
async def test_unreadable_engagement_record_keeps_busy_verdict():
    """Latch present but call record unreadable → cannot prove the engagement
    involves the caller → the protective busy default stands."""
    redis = FakeRedis()
    _online(redis, "peer")
    redis.values["callring:peer"] = "ghost-call-id"  # no call:ghost-call-id

    call = await _ring(CallService(redis), caller="aaron", callee="peer", room="room-1")
    assert call["state"] == "unreachable"
    assert call["targets"][0]["state"] == "busy"


# ---------------------------------------------------------------------------
# Join-own-call: a callee already ON the call is joined, not rung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callee_already_on_the_call_is_joined_not_rung():
    redis = FakeRedis()
    _online(redis, "peer")

    call = await _ring(
        CallService(redis),
        caller="aaron",
        callee="peer",
        room="room-1",
        in_call_participant_ids={"peer"},
    )

    assert call["state"] == "in_call"
    assert call["targets"][0]["state"] == "in_call"
    # A join is not an offer: nothing stored, nothing latched, nobody told.
    assert not any(key.startswith("call:") for key in redis.values)
    assert not any(key.startswith("callring:") for key in redis.values)
    assert redis.published == []


@pytest.mark.asyncio
async def test_device_switch_and_move_back_never_read_busy():
    """The full repro at service level: call, switch device, move back."""
    redis = FakeRedis()
    _online(redis, "aaron", "peer")
    svc = CallService(redis)

    # Desktop rings; peer answers. Answering releases both busy latches.
    offer = await _ring(svc, caller="aaron", callee="peer", room="room-1")
    assert offer["state"] == "ringing"
    await svc.accept(offer, participant_id="peer", display_name="Peer")
    assert "callring:aaron" not in redis.values
    assert "callring:peer" not in redis.values

    # Phone joins the live call: peer is on the line → join, not a ring.
    phone = await _ring(
        svc, caller="aaron", callee="peer", room="room-1",
        in_call_participant_ids={"peer"},
    )
    assert phone["state"] == "in_call"

    # Desktop moves the call back: still a join. Never "<peer> is busy".
    back = await _ring(
        svc, caller="aaron", callee="peer", room="room-1",
        in_call_participant_ids={"peer"},
    )
    assert back["state"] == "in_call"
    assert all(t["state"] != "busy" for t in back["targets"])


# ---------------------------------------------------------------------------
# Idempotent re-ring: one live offer per (caller, room)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reringing_own_live_offer_returns_it_instead_of_stacking():
    redis = FakeRedis()
    _online(redis, "peer")
    svc = CallService(redis)

    first = await _ring(svc, caller="aaron", callee="peer", room="room-1")
    assert first["state"] == "ringing"

    second = await _ring(svc, caller="aaron", callee="peer", room="room-1")
    assert second["call_id"] == first["call_id"]
    assert second["state"] == "ringing"
    # Marked so the route neither re-arms the no-answer clock nor re-pushes.
    assert second.get("resumed") is True
    # The peer's devices were rung exactly once for this one conversation.
    assert len(_call_started_frames(redis, "peer")) == 1


# ---------------------------------------------------------------------------
# Route-side LiveKit occupancy probe (who is on the line RIGHT NOW)
# ---------------------------------------------------------------------------


class _FakeLiveKit:
    def __init__(self, participants=None, error: Exception | None = None):
        self._participants = participants or []
        self._error = error

    async def get_room(self, _name: str):
        if self._error is not None:
            raise self._error
        return {"room": object(), "participants": self._participants}


@pytest.mark.asyncio
async def test_in_call_probe_maps_identities_to_participant_ids():
    from app.api.calls import _in_call_participant_ids

    pid = str(uuid.uuid4())
    livekit = _FakeLiveKit(
        participants=[
            SimpleNamespace(identity=f"aaron_{pid}"),
            # Agent workers and malformed identities carry no participant
            # UUID suffix — they must not poison the set.
            SimpleNamespace(identity="stable-brigade"),
            SimpleNamespace(identity=""),
        ]
    )
    room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name="lk-room")

    assert await _in_call_participant_ids(livekit, room) == {pid}


@pytest.mark.asyncio
async def test_in_call_probe_degrades_to_nobody_on_livekit_failure():
    """Ringing must not depend on the LiveKit admin API being reachable."""
    from app.api.calls import _in_call_participant_ids

    room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name="lk-room")
    result = await _in_call_participant_ids(
        _FakeLiveKit(error=RuntimeError("livekit down")), room
    )
    assert result == set()
