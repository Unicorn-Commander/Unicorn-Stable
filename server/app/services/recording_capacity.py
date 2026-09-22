"""Concurrent-composite cap — a Redis semaphore shared by every worker.

A composite (video) egress runs a headless Chrome on the egress host; two of
them is the measured-safe default (design §8: "cap concurrent composites at
2, measure CPU per stream on the first real call"). With ``uvicorn --workers
4`` an in-process counter guards nothing, so the slots live in Redis.

Shape: one sorted set, member = the ``call_egresses`` row id, score = the
acquisition time. Acquire is the classic optimistic semaphore:

    ZREMRANGEBYSCORE  (drop slots older than the max egress duration)
    ZADD              (claim)
    ZRANK             (< limit → ours; otherwise ZREM and refuse)

Two workers racing for the last slot can BOTH be refused (each sees the
other's claim ahead of it) — never both admitted. That is the right side to
err on. Slots expire with the egress' maximum duration so a worker that dies
between claim and release cannot leak a slot forever, and the 2-minute sweep
in services/call_recording.py reconciles the set against the rows that are
actually still recording.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

import structlog

logger = structlog.get_logger(__name__)

SLOTS_KEY = "stable:recording:composite_slots"


class CapacityUnavailable(RuntimeError):
    """Redis could not answer; the caller decides whether to fail open."""


def _member(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


async def acquire_composite_slot(
    redis: Any,
    *,
    member: str,
    limit: int,
    ttl_seconds: int,
    now: float | None = None,
) -> bool:
    """Claim one composite slot for ``member``. True if admitted."""
    if limit <= 0:
        return False
    stamp = time.time() if now is None else now
    try:
        await redis.zremrangebyscore(SLOTS_KEY, "-inf", stamp - max(1, ttl_seconds))
        await redis.zadd(SLOTS_KEY, {member: stamp})
        rank = await redis.zrank(SLOTS_KEY, member)
        if rank is None or int(rank) >= limit:
            await redis.zrem(SLOTS_KEY, member)
            logger.warning(
                "recording_composite_capacity_full",
                member=member,
                limit=limit,
            )
            return False
        return True
    except Exception as exc:  # network / redis down
        raise CapacityUnavailable(str(exc)) from exc


async def release_composite_slot(redis: Any, member: str) -> None:
    """Free ``member``'s slot. Idempotent; never raises."""
    try:
        await redis.zrem(SLOTS_KEY, member)
    except Exception:
        logger.warning("recording_composite_slot_release_failed", member=member)


async def active_composite_slots(
    redis: Any, *, ttl_seconds: int, now: float | None = None
) -> int:
    """How many live slots exist right now (expired ones dropped first)."""
    stamp = time.time() if now is None else now
    try:
        await redis.zremrangebyscore(SLOTS_KEY, "-inf", stamp - max(1, ttl_seconds))
        return int(await redis.zcard(SLOTS_KEY))
    except Exception as exc:
        raise CapacityUnavailable(str(exc)) from exc


async def reconcile_composite_slots(redis: Any, live_members: Iterable[str]) -> int:
    """Drop slots whose recording is no longer in flight. Returns the count."""
    live = {str(m) for m in live_members}
    try:
        members = await redis.zrange(SLOTS_KEY, 0, -1)
    except Exception:
        logger.warning("recording_composite_slot_reconcile_failed")
        return 0
    stale = [_member(m) for m in (members or []) if _member(m) not in live]
    removed = 0
    for m in stale:
        try:
            await redis.zrem(SLOTS_KEY, m)
            removed += 1
        except Exception:
            logger.warning("recording_composite_slot_reconcile_failed", member=m)
    if removed:
        logger.info("recording_composite_slots_reconciled", removed=removed)
    return removed


__all__ = [
    "SLOTS_KEY",
    "CapacityUnavailable",
    "acquire_composite_slot",
    "release_composite_slot",
    "active_composite_slots",
    "reconcile_composite_slots",
]
