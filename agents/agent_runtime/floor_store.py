"""Shared voice floor: sticky claims and the one-hot speaking lease.

``RoomFloor`` in ``voice_dispatch`` is the in-process shape. Two agent
containers do not share a process, so the lease has to live somewhere both
they and the relay can see. ``InMemoryFloorStore`` is that shape for tests
(pass one backing dict to two stores and they are two clients of one floor).
``RedisFloorStore`` is the production backend: ``SET key value NX EX`` for
the lease, ``SET key value EX`` for a speaker's sticky claim.

Unset ``VOICE_FLOOR_BACKEND`` and ``VOICE_FLOOR_REDIS_URL`` keeps the
in-memory store, which is what the unit tests and a single container use.
``VOICE_FLOOR_BACKEND=redis`` (or a redis URL) is the shared floor.
"""

from __future__ import annotations

import os
from typing import Any, Protocol

import structlog

from agent_runtime.voice_dispatch import (
    FLOOR_LEASE_S,
    STICKY_WINDOW_S,
    RoomFloor,
)

logger = structlog.get_logger(__name__)

_FLOOR_PREFIX = "stable:voice:floor:"
_STICKY_PREFIX = "stable:voice:sticky:"

_RELEASE_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


class FloorStore(Protocol):
    """One room's sticky map and speaking lease, shared by every client."""

    def claim(self, room: str, speaker: str, agent: str, *, now: float) -> None: ...

    def sticky_agent(self, room: str, speaker: str, *, now: float) -> str | None: ...

    def release_speaker(self, room: str, speaker: str) -> None: ...

    def floor_holder(self, room: str, *, now: float) -> str | None: ...

    def take_floor(self, room: str, agent: str, *, now: float) -> bool: ...

    def release_floor(self, room: str, agent: str) -> None: ...

    def forget(self, room: str) -> None: ...


class BoundFloor:
    """A ``RoomFloor``-shaped view of one room inside a ``FloorStore``.

    ``decide()`` talks to this. Two ``BoundFloor`` objects on two stores that
    share a backend are the cross-process mutex.
    """

    def __init__(self, store: FloorStore, room: str) -> None:
        self.store = store
        self.room = room

    def claim(self, speaker: str, agent: str, *, now: float) -> None:
        self.store.claim(self.room, speaker, agent, now=now)

    def sticky_agent(self, speaker: str, *, now: float) -> str | None:
        return self.store.sticky_agent(self.room, speaker, now=now)

    def release_speaker(self, speaker: str) -> None:
        self.store.release_speaker(self.room, speaker)

    def floor_holder(self, *, now: float) -> str | None:
        return self.store.floor_holder(self.room, now=now)

    def take_floor(self, agent: str, *, now: float) -> bool:
        return self.store.take_floor(self.room, agent, now=now)

    def release_floor(self, agent: str) -> None:
        self.store.release_floor(self.room, agent)


class InMemoryFloorStore:
    """Process-local rooms. Share ``rooms`` between two instances to test
    the mutex the way two containers share Redis."""

    def __init__(self, rooms: dict[str, RoomFloor] | None = None) -> None:
        self._rooms: dict[str, RoomFloor] = rooms if rooms is not None else {}

    def _room(self, room: str) -> RoomFloor:
        state = self._rooms.get(room)
        if state is None:
            state = RoomFloor()
            self._rooms[room] = state
        return state

    def claim(self, room: str, speaker: str, agent: str, *, now: float) -> None:
        self._room(room).claim(speaker, agent, now=now)

    def sticky_agent(self, room: str, speaker: str, *, now: float) -> str | None:
        return self._room(room).sticky_agent(speaker, now=now)

    def release_speaker(self, room: str, speaker: str) -> None:
        self._room(room).release_speaker(speaker)

    def floor_holder(self, room: str, *, now: float) -> str | None:
        return self._room(room).floor_holder(now=now)

    def take_floor(self, room: str, agent: str, *, now: float) -> bool:
        return self._room(room).take_floor(agent, now=now)

    def release_floor(self, room: str, agent: str) -> None:
        self._room(room).release_floor(agent)

    def forget(self, room: str) -> None:
        self._rooms.pop(room, None)


class RedisFloorStore:
    """Redis-backed floor. ``now`` is accepted so the call shape matches
    ``InMemoryFloorStore``; expiry is the key TTL (lease 120s, sticky 30s),
    which is the wall clock every container shares.

    A Redis error falls open to a process-local floor for that one call and
    is logged. Silence for the whole room is worse than a rare double reply
    during a blip; the log is how you see it happened.
    """

    def __init__(self, url: str = "", *, client: Any = None) -> None:
        if client is not None:
            self._redis = client
        else:
            import redis

            self._redis = redis.Redis.from_url(
                url,
                socket_timeout=0.4,
                socket_connect_timeout=0.4,
                decode_responses=True,
            )
        self._local = InMemoryFloorStore()

    def _floor_key(self, room: str) -> str:
        return f"{_FLOOR_PREFIX}{room}"

    def _sticky_key(self, room: str, speaker: str) -> str:
        return f"{_STICKY_PREFIX}{room}:{speaker}"

    def _fallback(self, op: str, room: str, *args: Any, **kwargs: Any) -> Any:
        logger.warning("voice_floor_redis_failed", op=op, room=room)
        return getattr(self._local, op)(room, *args, **kwargs)

    def claim(self, room: str, speaker: str, agent: str, *, now: float) -> None:
        if not speaker:
            return
        try:
            self._redis.set(
                self._sticky_key(room, speaker),
                agent,
                ex=max(1, int(STICKY_WINDOW_S)),
            )
        except Exception:
            self._fallback("claim", room, speaker, agent, now=now)

    def sticky_agent(self, room: str, speaker: str, *, now: float) -> str | None:
        if not speaker:
            return None
        try:
            value = self._redis.get(self._sticky_key(room, speaker))
        except Exception:
            return self._fallback("sticky_agent", room, speaker, now=now)
        return str(value) if value else None

    def release_speaker(self, room: str, speaker: str) -> None:
        if not speaker:
            return
        try:
            self._redis.delete(self._sticky_key(room, speaker))
        except Exception:
            self._fallback("release_speaker", room, speaker)

    def floor_holder(self, room: str, *, now: float) -> str | None:
        try:
            value = self._redis.get(self._floor_key(room))
        except Exception:
            return self._fallback("floor_holder", room, now=now)
        return str(value) if value else None

    def take_floor(self, room: str, agent: str, *, now: float) -> bool:
        key = self._floor_key(room)
        lease = max(1, int(FLOOR_LEASE_S))
        try:
            if self._redis.set(key, agent, nx=True, ex=lease):
                return True
            current = self._redis.get(key)
            if current == agent:
                self._redis.expire(key, lease)
                return True
            return False
        except Exception:
            return bool(self._fallback("take_floor", room, agent, now=now))

    def release_floor(self, room: str, agent: str) -> None:
        try:
            self._redis.eval(_RELEASE_LUA, 1, self._floor_key(room), agent)
        except Exception:
            self._fallback("release_floor", room, agent)

    def forget(self, room: str) -> None:
        try:
            self._redis.delete(self._floor_key(room))
        except Exception:
            logger.debug("voice_floor_redis_forget_failed", room=room, exc_info=True)
        self._local.forget(room)


_store: FloorStore | None = None
_bindings: dict[str, BoundFloor] = {}


def build_floor_store() -> FloorStore:
    """The store this process should use.

    Memory unless a redis backend is asked for by name or URL. Tests never
    set those, so they never open a socket.
    """
    backend = os.getenv("VOICE_FLOOR_BACKEND", "").strip().lower()
    url = os.getenv("VOICE_FLOOR_REDIS_URL", "").strip()
    if backend in ("memory", "inmemory", "local"):
        return InMemoryFloorStore()
    if backend == "redis" or url:
        if not url:
            try:
                from agent_runtime.config import get_agent_settings

                url = (get_agent_settings().redis_url or "").strip()
            except Exception:
                url = ""
        if url:
            return RedisFloorStore(url)
        logger.warning("voice_floor_redis_unconfigured")
    return InMemoryFloorStore()


def get_floor_store() -> FloorStore:
    global _store
    if _store is None:
        _store = build_floor_store()
        logger.info("voice_floor_backend", backend=type(_store).__name__)
    return _store


def configure_floor_store(store: FloorStore | None = None) -> FloorStore:
    """Install a store (tests) or rebuild from the environment."""
    global _store, _bindings
    _store = store if store is not None else build_floor_store()
    _bindings = {}
    logger.info("voice_floor_backend", backend=type(_store).__name__)
    return _store


def bind_room(room_key: str) -> BoundFloor:
    key = (room_key or "").strip() or "unknown-room"
    found = _bindings.get(key)
    if found is None:
        found = BoundFloor(get_floor_store(), key)
        _bindings[key] = found
    return found


def forget_room(room_key: str) -> None:
    key = (room_key or "").strip() or "unknown-room"
    _bindings.pop(key, None)
    try:
        get_floor_store().forget(key)
    except Exception:
        logger.debug("voice_floor_forget_failed", room=key, exc_info=True)
