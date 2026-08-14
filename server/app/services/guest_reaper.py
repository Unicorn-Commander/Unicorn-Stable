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

...AND THE TWO CREDENTIAL TABLES THEMSELVES
-------------------------------------------
Everything above is about the ``participants`` row a redemption mints. The two
tables the feature actually ADDED — ``guest_invites`` and ``guest_sessions`` —
were never reaped at all. Revocation and expiry are STAMPS on those rows
(``revoked_at``), never deletes; no code path anywhere issues a DELETE against
either table. So every link an owner ever minted, and every redemption of it,
was kept forever. ``sweep_guest_rows`` is the bound, and it unwinds the chain
leaf-first because the foreign keys leave no other safe order:

* ``guest_sessions`` has NO children — nothing in the schema references it — so
  a dead one can be deleted without orphaning anything. What it costs is the
  record of a PERSON who was in a room (which link they walked through, the
  name they typed, when they were last seen), so it gets a full year by
  default: far beyond any plausible incident-response window.
* ``guest_invites`` is deleted ONLY when ``NOT EXISTS`` a session referencing
  it. That is not a nicety — ``guest_sessions.invite_id`` is ``ON DELETE
  CASCADE``, so deleting a used invite would take every session it minted with
  it and silently destroy exactly the audit trail the paragraph above is
  protecting. An invite with no sessions is a link NOBODY EVER WALKED THROUGH
  (or one whose guests are already fully reaped): it records nothing about any
  person, and nothing in the schema points at it, so 90 days is enough.

Ordering therefore matters and is deliberate: participants purge (cascading
their sessions) -> sessions purge -> invites purge. Each stage can only widen
what the next one is allowed to touch, never narrow it.

Neither stage can reach ``messages``. Not by policy — by construction: no
statement in this module names that table except the ``NOT EXISTS`` guard that
REFUSES to delete a participant who wrote one.

CONCURRENCY
-----------
Every uvicorn worker may run this loop. Each of the claims is a single
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


# STAGE THREE — delete a long-dead guest SESSION row.
#
# Nothing in the schema references guest_sessions (verified against the live
# information_schema: it is a leaf), so this delete cannot orphan anything and
# cannot un-attribute a single message — messages point at the PARTICIPANT, and
# that row is tombstoned and kept. What it does cost is the audit record of one
# person's visit, so the default window is a year rather than the thirty days
# the trace-free participant purge uses. 0 keeps them forever.
#
# THE CLOCK IS ``expires_at``, NOT ``revoked_at``, on purpose. revoked_at moves
# in both directions relative to expiry: an owner revoking early makes it
# EARLIER, and this reaper stamping a session it swept makes it LATER. Keying
# retention to expires_at is the strictly more conservative of the two (a
# session revoked on day 1 of a 12-hour link is still kept a full year from its
# scheduled expiry, not from the revoke), and it makes the whole predicate a
# plain range on an indexed column, so an idle pass is one index probe instead
# of a sort of the table. Migration 017 adds that index.
#
# ``expires_at <= now() - <days>`` with days >= 1 already implies "expired";
# the explicit death clause is kept anyway so the invariant is readable at the
# site that depends on it rather than inferred from arithmetic.
_PURGE_SESSIONS_SQL = text(
    """
    WITH purgeable AS (
        SELECT gs.id
          FROM guest_sessions gs
         WHERE gs.expires_at <= now() - make_interval(days => :purge_after_days)
           AND (gs.revoked_at IS NOT NULL OR gs.expires_at <= now())
         ORDER BY gs.expires_at
         LIMIT :batch
    )
    DELETE FROM guest_sessions AS t
     USING purgeable
     WHERE t.id = purgeable.id
       AND t.expires_at <= now() - make_interval(days => :purge_after_days)
       AND (t.revoked_at IS NOT NULL OR t.expires_at <= now())
    RETURNING t.id
    """
)

# STAGE FOUR — delete a long-dead guest INVITE that minted nobody.
#
# ``NOT EXISTS (SELECT 1 FROM guest_sessions ...)`` is the entire safety
# argument and it is not optional: guest_sessions.invite_id is ON DELETE
# CASCADE, so deleting an invite that still has sessions would take them with
# it — a garbage collector destroying the record of who was let into a room.
# It is evaluated twice, once to choose candidates and again INSIDE the DELETE,
# for the same reason the participant purge re-checks its message guard.
#
# ``FOR UPDATE`` (and ``MATERIALIZED``, so the lock is actually taken before
# the DELETE plans) closes the one window the double NOT EXISTS cannot: a
# redemption whose session INSERT has not committed yet is invisible to both
# checks. PostgreSQL's FK enforcement takes FOR KEY SHARE on the parent invite
# row for that INSERT, and FOR UPDATE is the one row lock that conflicts with
# it, so the two serialize instead of racing. In practice a redemption cannot
# reach a 90-day-dead invite at all (api/guests.py claims the seat with a
# conditional UPDATE that re-checks expiry and revocation), which makes this
# belt on top of braces — appropriate for the only statement here whose
# mistake would be silent and unrecoverable.
#
# SKIP LOCKED so a second uvicorn worker sweeps different rows rather than
# queueing behind the first.
_PURGE_INVITES_SQL = text(
    """
    WITH purgeable AS MATERIALIZED (
        SELECT gi.id
          FROM guest_invites gi
         WHERE gi.expires_at <= now() - make_interval(days => :purge_after_days)
           AND (gi.revoked_at IS NOT NULL OR gi.expires_at <= now())
           AND NOT EXISTS (
                 SELECT 1 FROM guest_sessions gs WHERE gs.invite_id = gi.id
               )
         ORDER BY gi.expires_at
         LIMIT :batch
           FOR UPDATE SKIP LOCKED
    )
    DELETE FROM guest_invites AS t
     USING purgeable
     WHERE t.id = purgeable.id
       AND t.expires_at <= now() - make_interval(days => :purge_after_days)
       AND (t.revoked_at IS NOT NULL OR t.expires_at <= now())
       AND NOT EXISTS (
             SELECT 1 FROM guest_sessions gs WHERE gs.invite_id = t.id
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


async def sweep_guest_rows(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    batch: int = 200,
    session_purge_after_days: int = 365,
    invite_purge_after_days: int = 90,
) -> tuple[int, int]:
    """Delete long-dead ``guest_sessions``, then the invites that minted nobody.

    Returns ``(sessions_purged, invites_purged)``. Either window at 0 disables
    that stage — and disables it by not RUNNING the statement at all, not by
    passing it a value that happens to match nothing, so "off" is not one typo
    away from a delete.

    THE ORDER IS THE DESIGN. Sessions first: an invite is only deletable while
    ``NOT EXISTS`` a session pointing at it, so purging sessions is what makes
    the invite behind them eligible on this pass instead of the next one. Run
    the other way round and the invite stage would be permanently one window
    behind for no reason.

    Both stages are safe to call concurrently (each re-checks its guard inside
    the DELETE) and cheap when there is nothing to do: with the migration-017
    indexes each is an index probe against the oldest expiry, not a sort.
    """
    sessions_purged: list[uuid.UUID] = []
    invites_purged: list[uuid.UUID] = []
    async with session_factory() as db:
        if int(session_purge_after_days) > 0:
            sessions_purged = list(
                (
                    await db.execute(
                        _PURGE_SESSIONS_SQL,
                        {
                            "batch": int(batch),
                            "purge_after_days": int(session_purge_after_days),
                        },
                    )
                )
                .scalars()
                .all()
            )
            await db.commit()

        if int(invite_purge_after_days) > 0:
            invites_purged = list(
                (
                    await db.execute(
                        _PURGE_INVITES_SQL,
                        {
                            "batch": int(batch),
                            "purge_after_days": int(invite_purge_after_days),
                        },
                    )
                )
                .scalars()
                .all()
            )
            await db.commit()

    if sessions_purged:
        logger.info("guest_sessions_purged", count=len(sessions_purged))
    if invites_purged:
        logger.info("guest_invites_purged", count=len(invites_purged))
    return len(sessions_purged), len(invites_purged)


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

    ONE loop, three sweeps, in this order. The session sweep is what makes an
    expired stranger stop publishing; the participant sweep is bookkeeping that
    can wait; the row sweep is retention, which can wait longer still. Running
    them after the first — and letting their failure be caught by the same
    handler — means a broken tombstone or retention pass can never stop the
    sweep that hangs up on people.

    The order is also the FK unwind order. The participant purge cascades a
    trace-free guest's session away; the session purge then removes what is
    left; only then can an invite pass its ``NOT EXISTS`` guard. Leaf first,
    root last, because ``guest_sessions.invite_id`` is ON DELETE CASCADE and
    any other order would mean deleting a parent that still had children.
    """
    interval = max(5.0, float(getattr(settings, "guest_reaper_interval_seconds", 60)))
    batch = int(getattr(settings, "guest_reaper_batch", 200) or 200)
    retire_after = int(
        getattr(settings, "guest_participant_retire_after_minutes", 60) or 0
    )
    purge_after = int(getattr(settings, "guest_participant_purge_after_days", 30) or 0)
    session_purge_after = int(
        getattr(settings, "guest_session_purge_after_days", 365) or 0
    )
    invite_purge_after = int(
        getattr(settings, "guest_invite_purge_after_days", 90) or 0
    )
    logger.info(
        "guest_reaper_loop_started",
        interval_seconds=interval,
        batch=batch,
        retire_after_minutes=retire_after,
        purge_after_days=purge_after,
        session_purge_after_days=session_purge_after,
        invite_purge_after_days=invite_purge_after,
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
            await sweep_guest_rows(
                session_factory,
                batch=batch,
                session_purge_after_days=session_purge_after,
                invite_purge_after_days=invite_purge_after,
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
    "sweep_guest_rows",
]
