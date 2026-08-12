"""Sweep guest sessions that DIED without anyone revoking them.

THE GAP THIS CLOSES
-------------------
Expiry was enforced only at the moments something asked. HTTP re-checks the
credential on every request, and the websocket re-checks liveness every four
seconds, so an expired guest stops being *authorized* on time. But nothing ever
went looking for them, and three things therefore outlived the session:

* **LiveKit.** A guest's join token is capped to their session expiry, but the
  media session outlives the token that established it — LiveKit does not
  re-authorize an in-progress publisher. An expired guest kept publishing
  camera and microphone into the room until they closed the tab. This is the
  one that matters: it is the difference between "their credential stopped
  working" and "the stranger is off the air".
* **The roster.** Their ``room_members`` row stayed, so the member list kept
  showing an outsider who no longer had access.
* **The row itself.** ``revoked_at`` stayed NULL forever, so the owner's
  session list showed expired guests as live and no audit trail recorded when
  they actually went away.

WHY IT REUSES ``_terminate_sessions``
-------------------------------------
That function is the four-layer teardown revocation already goes through:
mark the row, delete the membership, force-close the live socket, evict from
LiveKit. Expiry deserves exactly the same treatment as revocation — a session
that ran out of time is no more entitled to a live socket than one an owner
killed — and writing a second, thinner teardown here is how the two paths
would drift until only one of them actually hung up.

CONCURRENCY
-----------
Every uvicorn worker may run this loop. The claim is a single UPDATE that
re-checks ``revoked_at IS NULL`` and RETURNs the rows it changed, so two
workers sweeping simultaneously cannot both claim the same session: the second
blocks on the row lock, re-evaluates against the committed version, and matches
nothing. Whoever wins the row does the teardown for it.
"""

from __future__ import annotations

import asyncio
import uuid

import structlog
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models.guest_access import GuestSession
from app.models.room import Room
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

# Why a session gets swept. Recorded on the force-disconnect frame the guest's
# browser receives, so a client can tell "your time ran out" apart from "you
# were thrown out" if it ever wants to say something kinder than either.
REAP_REASON = "guest_session_expired"

# One statement, three ways to be dead:
#   * the session's own clock ran out,
#   * its invite's clock ran out (a session must never outlive its link), or
#   * the invite was revoked but this session was somehow missed by the
#     revocation fan-out (a crashed worker mid-revoke, say).
# ORDER BY + LIMIT bounds the work per pass; the outer re-check of
# ``revoked_at IS NULL`` is what makes the claim exactly-once across workers.
_CLAIM_SQL = text(
    """
    WITH doomed AS (
        SELECT gs.id
          FROM guest_sessions gs
          JOIN guest_invites gi ON gi.id = gs.invite_id
         WHERE gs.revoked_at IS NULL
           AND (
                gs.expires_at <= now()
             OR gi.expires_at <= now()
             OR gi.revoked_at IS NOT NULL
           )
         ORDER BY gs.expires_at
         LIMIT :batch
    )
    UPDATE guest_sessions AS s
       SET revoked_at = now()
      FROM doomed
     WHERE s.id = doomed.id
       AND s.revoked_at IS NULL
    RETURNING s.id
    """
)


async def _claim_expired(db: AsyncSession, batch: int) -> list[uuid.UUID]:
    """Atomically mark a batch of dead sessions revoked and return their ids."""
    rows = (await db.execute(_CLAIM_SQL, {"batch": int(batch)})).scalars().all()
    await db.commit()
    return list(rows)


async def sweep_expired_guest_sessions(
    session_factory: async_sessionmaker[AsyncSession],
    redis: Redis,
    livekit: LiveKitService,
    *,
    batch: int = 200,
) -> int:
    """Claim and fully tear down every expired-but-unrevoked guest session.

    Returns how many were swept. Safe to call concurrently and safe to call
    when there is nothing to do (one indexed SELECT, no writes).
    """
    # Imported here, not at module import time: api/guests.py imports the ws
    # handler and the tokens API, and this module is imported from main.py's
    # lifespan alongside them. A local import keeps the dependency one-way at
    # module scope, which is the same trick guests.py itself uses for
    # ``rooms._broadcast_members_changed``.
    from app.api.guests import _terminate_sessions

    swept = 0
    async with session_factory() as db:
        claimed = await _claim_expired(db, batch)
        if not claimed:
            return 0

        sessions = (
            (
                await db.execute(
                    select(GuestSession).where(GuestSession.id.in_(claimed))
                )
            )
            .scalars()
            .all()
        )
        by_room: dict[str, list[GuestSession]] = {}
        for s in sessions:
            by_room.setdefault(str(s.room_id), []).append(s)

        rooms = (
            (
                await db.execute(
                    select(Room).where(Room.id.in_([s.room_id for s in sessions]))
                )
            )
            .scalars()
            .all()
        )
        rooms_by_id = {str(r.id): r for r in rooms}

        for room_id, room_sessions in by_room.items():
            room = rooms_by_id.get(room_id)
            if room is None:
                # The room was deleted out from under the session. The rows are
                # already marked revoked by the claim above, which is the part
                # that matters; there is no socket scope or LiveKit room left
                # to tear down.
                logger.info(
                    "guest_reaper_room_missing",
                    room_id=room_id,
                    sessions=len(room_sessions),
                )
                swept += len(room_sessions)
                continue
            try:
                swept += await _terminate_sessions(
                    db, redis, livekit, room, list(room_sessions), reason=REAP_REASON
                )
            except Exception:
                # The revocation itself is already committed. A failure in the
                # best-effort layers (socket close, LiveKit eviction) must not
                # abandon the OTHER rooms in this batch.
                logger.warning(
                    "guest_reaper_teardown_failed", room_id=room_id, exc_info=True
                )

    if swept:
        logger.info("guest_sessions_reaped", count=swept)
    return swept


async def run_guest_reaper(
    session_factory: async_sessionmaker[AsyncSession],
    redis: Redis,
    livekit: LiveKitService,
    settings: Settings,
) -> None:
    """Run the sweep forever. Started from the app lifespan.

    Deliberately NOT gated on ``guest_access_enabled``: turning the feature off
    stops guests authenticating, but a guest already publishing to LiveKit is
    exactly who most needs evicting at that moment. The kill switch for this
    loop is its own setting.
    """
    interval = max(5.0, float(getattr(settings, "guest_reaper_interval_seconds", 60)))
    batch = int(getattr(settings, "guest_reaper_batch", 200) or 200)
    logger.info("guest_reaper_loop_started", interval_seconds=interval, batch=batch)
    while True:
        try:
            await sweep_expired_guest_sessions(
                session_factory, redis, livekit, batch=batch
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # One bad pass (DB blip, Redis blip) must never end the worker —
            # a reaper that quietly died is indistinguishable from one with
            # nothing to do, which is the failure mode this whole file exists
            # to prevent.
            logger.exception("guest_reaper_pass_failed")
        await asyncio.sleep(interval)


__all__ = [
    "REAP_REASON",
    "run_guest_reaper",
    "sweep_expired_guest_sessions",
]
