from __future__ import annotations

import structlog
from redis.asyncio import Redis

logger = structlog.get_logger(__name__)

PRESENCE_TTL: int = 120  # seconds
TYPING_TTL: int = 5  # seconds


class PresenceService:
    """Redis-backed presence and typing indicator service."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def set_online(self, participant_id: str, status: str = "online") -> None:
        """Mark a participant as online with a TTL."""
        key = f"presence:{participant_id}"
        await self._redis.set(key, status, ex=PRESENCE_TTL)
        logger.debug("presence_set_online", participant_id=participant_id, status=status)

    async def set_offline(self, participant_id: str) -> None:
        """Mark a participant as offline by removing their presence key."""
        key = f"presence:{participant_id}"
        await self._redis.delete(key)
        logger.debug("presence_set_offline", participant_id=participant_id)

    async def get_status(self, participant_id: str) -> str:
        """Get the current status of a participant."""
        key = f"presence:{participant_id}"
        val = await self._redis.get(key)
        if val is None:
            return "offline"
        if isinstance(val, bytes):
            return val.decode("utf-8")
        return str(val)

    async def get_online_in_room(self, room_id: str) -> set[str]:
        """Get the set of online participant IDs in a room."""
        key = f"room_presence:{room_id}"
        members = await self._redis.smembers(key)
        result: set[str] = set()
        for m in members:
            pid = m.decode("utf-8") if isinstance(m, bytes) else str(m)
            # Verify the participant is still actually online
            status_key = f"presence:{pid}"
            if await self._redis.exists(status_key):
                result.add(pid)
            else:
                # Stale entry, clean it up
                await self._redis.srem(key, pid)
        return result

    async def join_room_presence(self, participant_id: str, room_id: str) -> None:
        """Add a participant to a room's presence set."""
        key = f"room_presence:{room_id}"
        await self._redis.sadd(key, participant_id)
        logger.debug(
            "presence_joined_room",
            participant_id=participant_id,
            room_id=room_id,
        )

    async def leave_room_presence(self, participant_id: str, room_id: str) -> None:
        """Remove a participant from a room's presence set."""
        key = f"room_presence:{room_id}"
        await self._redis.srem(key, participant_id)
        logger.debug(
            "presence_left_room",
            participant_id=participant_id,
            room_id=room_id,
        )

    async def set_typing(self, participant_id: str, room_id: str) -> None:
        """Set a typing indicator with a short TTL."""
        key = f"typing:{room_id}:{participant_id}"
        await self._redis.set(key, "1", ex=TYPING_TTL)
        # Also add to the room's typing set
        set_key = f"typing_set:{room_id}"
        await self._redis.sadd(set_key, participant_id)
        await self._redis.expire(set_key, TYPING_TTL + 2)
        logger.debug(
            "typing_set",
            participant_id=participant_id,
            room_id=room_id,
        )

    async def clear_typing(self, participant_id: str, room_id: str) -> None:
        """Clear a typing indicator."""
        key = f"typing:{room_id}:{participant_id}"
        await self._redis.delete(key)
        set_key = f"typing_set:{room_id}"
        await self._redis.srem(set_key, participant_id)

    async def get_typing_in_room(self, room_id: str) -> set[str]:
        """Get the set of currently-typing participant IDs in a room."""
        set_key = f"typing_set:{room_id}"
        members = await self._redis.smembers(set_key)
        result: set[str] = set()
        for m in members:
            pid = m.decode("utf-8") if isinstance(m, bytes) else str(m)
            # Verify the typing indicator key still exists (TTL not expired)
            typing_key = f"typing:{room_id}:{pid}"
            if await self._redis.exists(typing_key):
                result.add(pid)
            else:
                await self._redis.srem(set_key, pid)
        return result

    async def heartbeat(self, participant_id: str) -> None:
        """Refresh the presence TTL for a participant."""
        key = f"presence:{participant_id}"
        current = await self._redis.get(key)
        if current is None:
            await self._redis.set(key, "online", ex=PRESENCE_TTL)
        else:
            await self._redis.expire(key, PRESENCE_TTL)
        logger.debug("presence_heartbeat", participant_id=participant_id)
