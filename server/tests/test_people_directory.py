"""Focused invariants for enterprise people preferences and batched presence."""

import asyncio
import uuid

from app.api.users import _favorite_people
from app.services.presence_service import PresenceService


class FakeRedis:
    def __init__(self) -> None:
        self.keys: list[str] = []

    async def mget(self, keys: list[str]):
        self.keys = keys
        return [b"online", None]


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
