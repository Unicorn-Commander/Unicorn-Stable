"""Sweep guest sessions that DIED without anyone revoking them — and then
retire the ephemeral Participant rows those sessions left behind.

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

THE SECOND GAP: THE PARTICIPANT ROW
-----------------------------------
Every redemption mints a Participant (``participant_type = 'guest'``), and
NOTHING ever closed it. The session died, the membership row went, the
credential stopped working — and the identity row stayed, ``status = 'online'``,
forever. Not a security problem (``== HUMAN`` keeps guests out of every
directory, search, mention target and push audience; see models/participant.py)
but a row per redemption that nobody owned and nothing could tell apart from a
guest who is on a call right now.

TOMBSTONE, NOT DELETE — and the reason is the foreign keys
----------------------------------------------------------
A guest's Participant is referenced by things that must survive them:

* ``messages.sender_id`` is ``ON DELETE SET NULL`` and nullable. Deleting the
  participant does not delete the message — it silently strips the SENDER off
  everything the guest said. ``message_service`` then serialises ``sender:
  null``, and a room's history renders anonymous holes. That is erasing the
  record, not garbage-collecting it.
* ``guest_sessions.participant_id`` is ``ON DELETE CASCADE``. Deleting the
  participant takes the session row with it — the audit trail of who redeemed
  which link, under what name, when they were last seen and when they were
  revoked. A GC job must not be the thing that destroys the evidence.
* ``activity_events.participant_id`` is ``ON DELETE CASCADE`` for the same
  reason and with the same consequence.

So the rule is **retire in place**: stamp ``metadata->>'guest_retired_at'`` and
put ``status`` to OFFLINE. The row stays, the history stays attributed, the
audit trail stays whole, and the lifecycle is finally legible in SQL.

The display name is deliberately NOT redacted. It is what makes the room's own
history readable ("Dana said this"), the guest chose it and typed it into a
room, and ``guest_sessions.display_name`` already keeps an independent copy for
audit if the participant is ever renamed.

...AND ONE BOUNDED DELETE, WHERE THERE IS PROVABLY NOTHING TO ORPHAN
--------------------------------------------------------------------
Tombstoning alone answers "the lifecycle is undefined" but not "the table grows
forever". The overwhelmingly common guest joins a call, talks over LiveKit,
and leaves without sending a single message — that row references nothing and
nothing references it. So a SECOND, much later stage hard-deletes retired
guests **only when ``NOT EXISTS`` any message they sent**, re-checked inside the
DELETE itself so it cannot race a straggler. Every objection above is about
losing something; this stage only fires where there is demonstrably nothing to
lose. Set ``guest_participant_purge_after_days = 0`` to keep every row forever.

CONCURRENCY
-----------
Every uvicorn worker may run this loop. Each of the three claims is a single
statement that re-checks the state it is transitioning FROM and RETURNs only
the rows it actually changed, so two workers sweeping simultaneously cannot
both claim the same row: the second blocks on the row lock, re-evaluates
against the committed version, and matches nothing. Whoever wins the row does
the work for it.
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


# The JSONB key that IS the tombstone. A key rather than a column on purpose:
# ``Participant.metadata_`` is where this model already carries Stable-local
# facts that Keycloak knows nothing about (see AVATAR_OVERRIDE_KEY), a guest's
# retirement is exactly that kind of fact, and the alternative is a NOT NULL
# migration on the busiest identity table in the schema for a flag only guests
# will ever carry. Migration 016 indexes it, which is the part that matters.
RETIRED_AT_KEY = "guest_retired_at"

# STAGE ONE — retire (tombstone) a guest whose sessions are all dead.
#
# "All dead" is the whole condition: a guest may hold several sessions (they
# redeemed twice, or the link was shared to one person who opened two tabs),
# and retiring on the first dead one would close an identity that is still
# live in another tab. NOT EXISTS over their sessions is what makes it "every
# one of them", and the grace interval keeps this pass from racing the
# teardown fan-out in ``_terminate_sessions`` (which commits the revocation
# FIRST and then closes sockets and evicts from LiveKit).
#
# The inner EXISTS is deliberate too: it refuses to retire a guest-typed
# Participant that has no session at all, so a row mid-creation by some future
# path — or one written by hand — is left alone rather than tombstoned by a
# vacuous NOT EXISTS.
#
# The outer re-check of ``guest_retired_at IS NULL`` is what makes the claim
# exactly-once across workers.
_RETIRE_SQL = text(
    """
    WITH retirable AS (
        SELECT p.id
          FROM participants p
         WHERE p.participant_type = 'guest'
           AND (p.metadata ->> 'guest_retired_at') IS NULL
           AND EXISTS (
                 SELECT 1 FROM guest_sessions gs
                  WHERE gs.participant_id = p.id
               )
           AND NOT EXISTS (
                 SELECT 1 FROM guest_sessions gs
                  WHERE gs.participant_id = p.id
                    AND (
                         gs.revoked_at IS NULL
                      OR gs.revoked_at > now() - make_interval(mins => :grace_minutes)
                    )
               )
         ORDER BY p.created_at
         LIMIT :batch
    )
    UPDATE participants AS t
       SET status = 'offline',
           metadata = COALESCE(t.metadata, '{}'::jsonb)
                      || jsonb_build_object('guest_retired_at', now())
      FROM retirable
     WHERE t.id = retirable.id
       AND (t.metadata ->> 'guest_retired_at') IS NULL
    RETURNING t.id
    """
)

# STAGE TWO — delete a long-retired guest that left NOTHING behind.
#
# ``NOT EXISTS`` over ``messages.sender_id`` is the entire safety argument: the
# only reference whose loss would be silent (the FK is SET NULL, so the delete
# would succeed and quietly un-attribute the history). It is re-evaluated
# INSIDE the DELETE, not just in the CTE, so a message that lands between the
# two — which a retired guest cannot actually send, every one of their sessions
# being revoked — still saves the row.
#
# Everything else that cascades from here (their guest_sessions row, their
# activity_events) is the audit trail of a guest who said nothing, kept for
# ``guest_participant_purge_after_days`` after they were retired. That window
# is the knob; 0 disables this stage entirely and leaves pure tombstoning.
_PURGE_SQL = text(
    """
    WITH purgeable AS (
        SELECT p.id
          FROM participants p
         WHERE p.participant_type = 'guest'
           AND (p.metadata ->> 'guest_retired_at') IS NOT NULL
           AND (p.metadata ->> 'guest_retired_at')::timestamptz
               <= now() - make_interval(days => :purge_after_days)
           AND NOT EXISTS (
                 SELECT 1 FROM messages m WHERE m.sender_id = p.id
               )
         ORDER BY p.created_at
         LIMIT :batch
    )
    DELETE FROM participants AS t
     USING purgeable
     WHERE t.id = purgeable.id
       AND t.participant_type = 'guest'
       AND (t.metadata ->> 'guest_retired_at') IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM messages m WHERE m.sender_id = t.id
           )
    RETURNING t.id
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


async def sweep_guest_participants(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    batch: int = 200,
    retire_after_minutes: int = 60,
    purge_after_days: int = 30,
) -> tuple[int, int]:
    """Retire guests whose sessions are all dead, then purge the trace-free ones.

    Returns ``(retired, purged)``. Safe to call concurrently (both statements
    re-check the state they transition FROM) and cheap when there is nothing to
    do — two indexed SELECTs against ``participant_type = 'guest'`` and no
    writes. Runs in the SAME loop as the session sweep, one pass behind it, so
    a guest is retired on the pass after the one that killed their session.

    Deliberately NOT part of ``_terminate_sessions``: teardown is about making
    a live credential stop working RIGHT NOW, and a lifecycle transition that
    can wait an hour has no business on that path — nor should the tombstone
    depend on the fan-out succeeding, which is exactly the coupling that left
    ``last_seen_at`` NULL forever the first time round.
    """
    retired: list[uuid.UUID] = []
    purged: list[uuid.UUID] = []
    async with session_factory() as db:
        retired = list(
            (
                await db.execute(
                    _RETIRE_SQL,
                    {
                        "batch": int(batch),
                        "grace_minutes": max(0, int(retire_after_minutes)),
                    },
                )
            )
            .scalars()
            .all()
        )
        await db.commit()

        # 0 disables the delete stage: tombstones only, kept forever.
        if int(purge_after_days) > 0:
            purged = list(
                (
                    await db.execute(
                        _PURGE_SQL,
                        {
                            "batch": int(batch),
                            "purge_after_days": int(purge_after_days),
                        },
                    )
                )
                .scalars()
                .all()
            )
            await db.commit()

    if retired:
        logger.info("guest_participants_retired", count=len(retired))
    if purged:
        logger.info("guest_participants_purged", count=len(purged))
    return len(retired), len(purged)


async def run_guest_reaper(
    session_factory: async_sessionmaker[AsyncSession],
    redis: Redis,
    livekit: LiveKitService,
    settings: Settings,
) -> None:
    """Run the sweeps forever. Started from the app lifespan.

    Deliberately NOT gated on ``guest_access_enabled``: turning the feature off
    stops guests authenticating, but a guest already publishing to LiveKit is
    exactly who most needs evicting at that moment. The kill switch for this
    loop is its own setting.

    ONE loop, two sweeps, in this order. The session sweep is what makes an
    expired stranger stop publishing; the participant sweep is bookkeeping that
    can wait. Running the second one after the first — and letting its failure
    be caught by the same handler — means a broken tombstone pass can never
    stop the sweep that hangs up on people.
    """
    interval = max(5.0, float(getattr(settings, "guest_reaper_interval_seconds", 60)))
    batch = int(getattr(settings, "guest_reaper_batch", 200) or 200)
    retire_after = int(
        getattr(settings, "guest_participant_retire_after_minutes", 60) or 0
    )
    purge_after = int(getattr(settings, "guest_participant_purge_after_days", 30) or 0)
    logger.info(
        "guest_reaper_loop_started",
        interval_seconds=interval,
        batch=batch,
        retire_after_minutes=retire_after,
        purge_after_days=purge_after,
    )
    while True:
        try:
            await sweep_expired_guest_sessions(
                session_factory, redis, livekit, batch=batch
            )
            await sweep_guest_participants(
                session_factory,
                batch=batch,
                retire_after_minutes=retire_after,
                purge_after_days=purge_after,
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
    "RETIRED_AT_KEY",
    "run_guest_reaper",
    "sweep_expired_guest_sessions",
    "sweep_guest_participants",
]
