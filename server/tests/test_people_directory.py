"""Focused invariants for enterprise people preferences and batched presence."""

import asyncio
import json
import uuid

from app.api.users import _favorite_people
from app.services.presence_service import (
    INSTANCE_PRESENCE_CHANNEL,
    PresenceService,
)


class FakeRedis:
    def __init__(self) -> None:
        self.keys: list[str] = []
        self.published: list[tuple[str, str]] = []
        self.store: dict[str, str] = {}

    async def mget(self, keys: list[str]):
        self.keys = keys
        return [b"online", None]

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = value

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0

    async def get(self, key: str):
        val = self.store.get(key)
        return val.encode("utf-8") if val is not None else None

    async def expire(self, key: str, ttl: int) -> bool:
        return key in self.store

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1


def test_favorites_are_uuid_only_deduplicated_and_bounded() -> None:
    first = uuid.uuid4()
    result = _favorite_people(
        {
            "favorite_people_ids": [
                str(first),
                "not-a-uuid",
                str(first),
                *[str(uuid.uuid4()) for _ in range(110)],
            ]
        }
    )
    assert result[0] == first
    assert len(result) == 98  # the first 100 raw entries are considered
    assert len(result) == len(set(result))


def test_directory_presence_uses_one_batch_lookup() -> None:
    redis = FakeRedis()
    service = PresenceService(redis)  # type: ignore[arg-type]
    result = asyncio.run(service.get_statuses(["person-1", "person-2"]))
    assert redis.keys == ["presence:person-1", "presence:person-2"]
    assert result == {"person-1": "online", "person-2": "offline"}


def test_set_online_publishes_instance_presence_channel() -> None:
    """Online transitions fan out on presence:instance — never a federated rail."""
    redis = FakeRedis()
    service = PresenceService(redis)  # type: ignore[arg-type]
    asyncio.run(service.set_online("person-42", "online"))

    assert redis.store["presence:person-42"] == "online"
    assert len(redis.published) == 1
    channel, raw = redis.published[0]
    assert channel == INSTANCE_PRESENCE_CHANNEL
    assert channel == "presence:instance"
    payload = json.loads(raw)
    assert payload["type"] == "presence"
    assert payload["participant_id"] == "person-42"
    assert payload["user_id"] == "person-42"
    assert payload["is_online"] is True
    assert payload["status"] == "online"
    # Identity-minimal: no realm export fields.
    assert "email" not in payload
    assert "keycloak_sub" not in payload
    assert "display_name" not in payload


def test_set_offline_publishes_instance_presence_channel() -> None:
    redis = FakeRedis()
    service = PresenceService(redis)  # type: ignore[arg-type]
    asyncio.run(service.set_offline("person-42"))

    assert "presence:person-42" not in redis.store
    assert len(redis.published) == 1
    channel, raw = redis.published[0]
    assert channel == INSTANCE_PRESENCE_CHANNEL
    payload = json.loads(raw)
    assert payload["type"] == "presence"
    assert payload["participant_id"] == "person-42"
    assert payload["is_online"] is False
    assert payload["status"] == "offline"
    assert "email" not in payload
    assert "keycloak_sub" not in payload


def test_heartbeat_republishes_when_key_was_expired() -> None:
    redis = FakeRedis()
    service = PresenceService(redis)  # type: ignore[arg-type]
    # No prior key → recreates + publishes (TTL-lapse recovery path).
    asyncio.run(service.heartbeat("person-7"))
    assert redis.store["presence:person-7"] == "online"
    assert len(redis.published) == 1
    payload = json.loads(redis.published[0][1])
    assert payload["is_online"] is True

    # Key present → only refreshes TTL, no re-broadcast.
    redis.published.clear()
    asyncio.run(service.heartbeat("person-7"))
    assert redis.published == []
