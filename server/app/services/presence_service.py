from __future__ import annotations

import json

import structlog
from redis.asyncio import Redis

logger = structlog.get_logger(__name__)

PRESENCE_TTL: int = 120  # seconds
TYPING_TTL: int = 5  # seconds

# Instance-local fanout for the People directory / global presence UI.
# Every WebSocket on THIS Stable deployment subscribes; Redis is per-instance
# so the channel never crosses federated peers. Do not rename without updating
# server/app/ws/handler.py subscription list.
INSTANCE_PRESENCE_CHANNEL: str = "presence:instance"


class PresenceService:
    """Redis-backed presence and typing indicator service."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    @property
    def redis(self) -> Redis:
        """The underlying client, for callers that need a Redis fact this
        service does not model — e.g. agent availability, which is a different
        question from participant presence and deliberately does not ride on
        the ``presence:*`` keys (see services/agent_availability.py)."""
        return self._redis

    async def publish_instance_presence(
        self, participant_id: str, *, online: bool
    ) -> None:
        """Publish a presence delta to every connected client on this instance.

        Payload is identity-minimal on purpose: Participant UUID + online flag
        only. Never email, Keycloak sub, or display name — directory REST is
        the snapshot for those facts; live events only patch the online bit.
        """
        payload = {
            "type": "presence",
            "participant_id": participant_id,
            # Mirror id under user_id so older FE handlers that only read
            # user_id still reconcile (same convention as room presence).
            "user_id": participant_id,
            "is_online": online,
            "status": "online" if online else "offline",
        }
        await self._redis.publish(
            INSTANCE_PRESENCE_CHANNEL, json.dumps(payload)
        )
        logger.debug(
            "presence_instance_published",
            participant_id=participant_id,
            online=online,
            channel=INSTANCE_PRESENCE_CHANNEL,
        )

    async def set_online(self, participant_id: str, status: str = "online") -> None:
        """Mark a participant as online with a TTL and fan out instance-wide."""
        key = f"presence:{participant_id}"
        await self._redis.set(key, status, ex=PRESENCE_TTL)
        logger.debug("presence_set_online", participant_id=participant_id, status=status)
        await self.publish_instance_presence(participant_id, online=True)

    async def set_offline(self, participant_id: str) -> None:
        """Mark a participant as offline and fan out instance-wide."""
        key = f"presence:{participant_id}"
        await self._redis.delete(key)
        logger.debug("presence_set_offline", participant_id=participant_id)
        await self.publish_instance_presence(participant_id, online=False)

    async def get_status(self, participant_id: str) -> str:
        """Get the current status of a participant."""
        key = f"presence:{participant_id}"
        val = await self._redis.get(key)
        if val is None:
            return "offline"
        if isinstance(val, bytes):
            return val.decode("utf-8")
        return str(val)

    async def get_statuses(self, participant_ids: list[str]) -> dict[str, str]:
        """Batch presence lookup for directory-sized rosters.

        The people directory is server-wide rather than room-scoped. Reading
        one Redis key at a time would turn a 50-person panel refresh into 50
        network round trips, so resolve the whole page with one MGET.
        """
        if not participant_ids:
            return {}
        values = await self._redis.mget(
            [f"presence:{participant_id}" for participant_id in participant_ids]
        )
        result: dict[str, str] = {}
        for participant_id, value in zip(participant_ids, values, strict=True):
            if value is None:
                result[participant_id] = "offline"
            elif isinstance(value, bytes):
                result[participant_id] = value.decode("utf-8")
            else:
                result[participant_id] = str(value)
        return result

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
        set_key = f"typing_set:{room_id}"
        # One round-trip, not three. This runs on the keepalive path of every
        # person typing in every room, so the three separate awaits it replaces
        # were three network hops per keystroke-window per user.
        pipe = self._redis.pipeline(transaction=False)
        pipe.set(key, "1", ex=TYPING_TTL)
        pipe.sadd(set_key, participant_id)
        # The membership set outlives the individual key by a couple of seconds
        # so `get_typing_in_room` still has a row to reconcile and evict rather
        # than the set vanishing wholesale mid-sweep.
        pipe.expire(set_key, TYPING_TTL + 2)
        await pipe.execute()
        logger.debug(
            "typing_set",
            participant_id=participant_id,
            room_id=room_id,
        )

    async def clear_typing(self, participant_id: str, room_id: str) -> None:
        """Clear a typing indicator.

        Idempotent and safe to call for a participant who is not typing, which
        is what lets every clearing path (send, blur, idle timeout, disconnect,
        error teardown) fire unconditionally without first checking state.
        """
        key = f"typing:{room_id}:{participant_id}"
        set_key = f"typing_set:{room_id}"
        pipe = self._redis.pipeline(transaction=False)
        pipe.delete(key)
        pipe.srem(set_key, participant_id)
        await pipe.execute()

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
        """Refresh the presence TTL for a participant.

        If the key already expired (TTL lapsed without a disconnect path),
        recreate it and re-publish online so directory UIs recover without
        waiting for the next snapshot poll.
        """
        key = f"presence:{participant_id}"
        current = await self._redis.get(key)
        if current is None:
            await self._redis.set(key, "online", ex=PRESENCE_TTL)
            await self.publish_instance_presence(participant_id, online=True)
        else:
            await self._redis.expire(key, PRESENCE_TTL)
        logger.debug("presence_heartbeat", participant_id=participant_id)
