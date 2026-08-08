import pytest

from app.services.call_service import CallService


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.published = []

    async def get(self, key):
        return self.values.get(key)

    async def exists(self, key):
        return key in self.values

    async def set(self, key, value, **_kwargs):
        self.values[key] = value

    async def publish(self, channel, payload):
        self.published.append((channel, payload))


@pytest.mark.asyncio
async def test_offline_push_subscriber_is_a_reachable_callee():
    redis = FakeRedis()
    call = await CallService(redis).ring(
        room_id="room-1", room_type="dm", room_name="Direct message",
        caller_id="caller", caller_name="Caller", caller_avatar_url=None,
        callees=[{"id": "offline-phone", "display_name": "Phone", "push_reachable": True}],
    )

    assert call["state"] == "ringing"
    assert call["targets"][0]["state"] == "ringing"
    assert any(key.startswith("call:") for key in redis.values)


@pytest.mark.asyncio
async def test_offline_callee_without_push_remains_unreachable():
    call = await CallService(FakeRedis()).ring(
        room_id="room-1", room_type="dm", room_name="Direct message",
        caller_id="caller", caller_name="Caller", caller_avatar_url=None,
        callees=[{"id": "offline", "display_name": "Away", "push_reachable": False}],
    )

    assert call["state"] == "unreachable"
    assert call["targets"][0]["state"] == "offline"
