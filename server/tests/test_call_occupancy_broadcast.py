"""Room-scoped ``call_occupancy`` broadcasts from the LiveKit webhook.

The client's ongoing-call awareness (sidebar live badges, the in-room
"Call in progress — Join" banner, the cross-room call-started toast) rides ONE
source of truth: the live-calls list, polled from /home/summary and nudged in
real time by these frames. The webhook is the seam because it is where the
server already learns occupancy changed (participant_joined/participant_left
drive presence today); ringing can't be the seam — it exists only for DMs, and
nothing at all signalled call ENDS.

Contract under test (helper level — the handlers just call it):

  * frames go to the ``room:{id}`` channel every member socket subscribes to,
    flat with ``type: call_occupancy`` (the typing/presence wire idiom);
  * the count is RE-PROBED from LiveKit (api/calls.py's honest source), never
    counted incrementally, so a lost webhook cannot make it drift;
  * agents count and are flagged (``has_agent``), matching /home/summary;
  * ``by`` names the joiner — participant UUID for humans (what the client
    compares against itself), name-only for agents;
  * ``count_override`` asserts the answer without a probe (room_finished ⇒ 0);
  * best-effort: neither a LiveKit probe failure nor a Redis publish failure
    may escape — awareness must never break presence bookkeeping or the
    webhook's 200.
"""

import json
import uuid
from types import SimpleNamespace

import pytest

from app.api.webhooks import _broadcast_call_occupancy, _joined_by


class FakeRedis:
    def __init__(self, *, raises: bool = False):
        self.published: list[tuple[str, str]] = []
        self._raises = raises

    async def publish(self, channel: str, payload: str) -> None:
        if self._raises:
            raise RuntimeError("redis down")
        self.published.append((channel, payload))


class FakeLiveKit:
    def __init__(self, identities: list[str] | None = None, *, raises: bool = False):
        self._identities = identities or []
        self._raises = raises
        self.probes: list[str] = []

    async def get_room(self, name: str):
        self.probes.append(name)
        if self._raises:
            raise RuntimeError("livekit down")
        return {
            "room": SimpleNamespace(name=name) if self._identities else None,
            "participants": [
                SimpleNamespace(identity=i) for i in self._identities
            ],
        }


ROOM_ID = uuid.uuid4()


def _room():
    return SimpleNamespace(
        id=ROOM_ID,
        room_type=SimpleNamespace(value="channel"),
        display_name="Design",
        livekit_room_name="room_design",
    )


def _frames(redis: FakeRedis) -> list[dict]:
    return [json.loads(payload) for _, payload in redis.published]


@pytest.mark.asyncio
async def test_join_broadcasts_probed_occupancy_to_the_room_channel():
    redis = FakeRedis()
    livekit = FakeLiveKit(identities=["aaron_" + str(uuid.uuid4())])

    await _broadcast_call_occupancy(
        redis, livekit, _room(), by={"id": "p-1", "display_name": "Aaron"}
    )

    assert livekit.probes == ["room_design"]
    assert [c for c, _ in redis.published] == [f"room:{ROOM_ID}"]
    (frame,) = _frames(redis)
    assert frame == {
        "type": "call_occupancy",
        "room_id": str(ROOM_ID),
        "room_type": "channel",
        "room_name": "Design",
        "participant_count": 1,
        "has_agent": False,
        "by": {"id": "p-1", "display_name": "Aaron"},
    }


@pytest.mark.asyncio
async def test_agents_count_and_are_flagged():
    redis = FakeRedis()
    livekit = FakeLiveKit(
        identities=["aaron_" + str(uuid.uuid4()), "agent-majik"]
    )

    await _broadcast_call_occupancy(redis, livekit, _room())

    (frame,) = _frames(redis)
    assert frame["participant_count"] == 2
    assert frame["has_agent"] is True
    assert frame["by"] is None


@pytest.mark.asyncio
async def test_empty_room_probe_broadcasts_zero_meaning_call_ended():
    """LiveKit reports no room once the last participant is gone — the probe
    answer is 0 and 0 must still be BROADCAST (it IS the ended signal), never
    treated as nothing-to-say."""
    redis = FakeRedis()
    livekit = FakeLiveKit(identities=[])

    await _broadcast_call_occupancy(redis, livekit, _room())

    (frame,) = _frames(redis)
    assert frame["participant_count"] == 0


@pytest.mark.asyncio
async def test_count_override_skips_the_probe_entirely():
    """room_finished already asserts the answer; probing a destroyed room
    would be a race against LiveKit's teardown. `livekit=None` proves the
    probe cannot be reached on this path."""
    redis = FakeRedis()

    await _broadcast_call_occupancy(redis, None, _room(), count_override=0)

    (frame,) = _frames(redis)
    assert frame["participant_count"] == 0
    assert frame["has_agent"] is False


@pytest.mark.asyncio
async def test_probe_failure_is_swallowed_and_publishes_nothing():
    """Guessing a count would be worse than staying quiet — the 30s summary
    poll reconciles. The webhook must still return 200, so no raise."""
    redis = FakeRedis()
    livekit = FakeLiveKit(raises=True)

    await _broadcast_call_occupancy(redis, livekit, _room())

    assert redis.published == []


@pytest.mark.asyncio
async def test_publish_failure_is_swallowed():
    redis = FakeRedis(raises=True)
    livekit = FakeLiveKit(identities=["aaron_" + str(uuid.uuid4())])

    # Must not raise — presence bookkeeping and the webhook 200 come first.
    await _broadcast_call_occupancy(redis, livekit, _room())


def test_joined_by_names_a_human_with_their_participant_uuid():
    pid = str(uuid.uuid4())
    event = SimpleNamespace(
        participant=SimpleNamespace(identity=f"aaron_{pid}", name="Aaron S")
    )
    assert _joined_by(event, pid) == {"id": pid, "display_name": "Aaron S"}


def test_joined_by_falls_back_to_identity_username_when_unnamed():
    pid = str(uuid.uuid4())
    event = SimpleNamespace(
        participant=SimpleNamespace(identity=f"aaron_{pid}", name="")
    )
    assert _joined_by(event, pid) == {"id": pid, "display_name": "aaron"}


def test_joined_by_keeps_agents_nameable_but_id_less():
    event = SimpleNamespace(
        participant=SimpleNamespace(identity="agent-majik", name="Majik")
    )
    assert _joined_by(event, None) == {"id": None, "display_name": "Majik"}
