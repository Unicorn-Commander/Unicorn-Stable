"""Guest row retention against a REAL PostgreSQL — the SQL, not a mock of it.

Everything in ``tests/test_guest_access.py`` about the reaper asserts on the
SHAPE of these statements (a mock returns whatever you tell it to). That is
worth having, and it is not a proof that the ``NOT EXISTS`` guard binds, that
``make_interval`` counts the days you think, or — the one that actually
matters — that a guest's messages survive the sweep with their sender intact.

Those are database facts, so this file asks a database.

THE POINT OF THE WHOLE EXERCISE IS T7 AND T8.
``messages.sender_id`` is ``ON DELETE SET NULL``, so a reaper that deleted the
wrong participant would NOT fail loudly — the delete would succeed and the room
transcript would quietly start rendering messages from nobody. T7 checks every
message's sender before and after a full reaper pass and requires them
byte-identical. T8 is the NEGATIVE CONTROL for T7: it removes the guard the
production statement relies on, runs the same delete against the same fixture,
and asserts the damage DOES occur — because a test that cannot fail is not
evidence, and "the messages were fine" means nothing until you have watched
the same test detect a reaper that broke them.

Run inside the backend image against a THROWAWAY database (the script drops
and recreates all tables — never point it at a real one):

    docker exec stable-postgres createdb -U stable stable_guest_retention_test
    docker run --rm --network <stack-network> \
      -v <worktree>/server:/home/stable/server -w /home/stable/server \
      -e TEST_DATABASE_URL="postgresql+asyncpg://stable:<pw>@stable-postgres:5432/stable_guest_retention_test" \
      unicorn-stable-backend:latest python tests/test_guest_row_retention.py
    docker exec stable-postgres dropdb -U stable stable_guest_retention_test

No pytest dependency — the backend image does not ship one.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

sys.path.insert(0, "/home/stable/server")

from sqlalchemy import delete, func, select, text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.models.base import Base  # noqa: E402
from app.models.guest_access import GuestInvite, GuestSession  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.participant import (  # noqa: E402
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.models.room import Room, RoomType  # noqa: E402
from app.services import guest_reaper  # noqa: E402

FAILURES: list[str] = []


def check(name: str, got: Any, want: Any) -> None:
    if got != want:
        FAILURES.append(f"{name}: expected {want!r}, got {got!r}")


def now() -> datetime:
    return datetime.now(timezone.utc)


def days_ago(n: float) -> datetime:
    return now() - timedelta(days=n)


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


class Fixture:
    """One room, one owner, and the full cross-product of guest lifecycles.

    Every row is labelled by what it is SUPPOSED to prove, so a failure names
    the policy that broke rather than a UUID.
    """

    def __init__(self) -> None:
        self.room_id = uuid.uuid4()
        self.owner_id = uuid.uuid4()
        self.ids: dict[str, uuid.UUID] = {}

    def _pid(self, key: str) -> uuid.UUID:
        self.ids[key] = self.ids.get(key, uuid.uuid4())
        return self.ids[key]

    def guest(self, db, key: str, *, retired_days_ago: float | None) -> uuid.UUID:
        meta: dict[str, Any] = {}
        if retired_days_ago is not None:
            meta["guest_retired_at"] = days_ago(retired_days_ago).isoformat()
        pid = self._pid(key)
        db.add(
            Participant(
                id=pid,
                keycloak_sub=f"guest:{pid}",
                username=f"guest-{key}",
                display_name=f"Guest {key}",
                participant_type=ParticipantType.GUEST,
                status=ParticipantStatus.OFFLINE,
                metadata_=meta,
            )
        )
        return pid

    def invite(
        self,
        db,
        key: str,
        *,
        expires_days_ago: float,
        revoked: bool = False,
        use_count: int = 0,
    ) -> uuid.UUID:
        iid = self._pid(f"invite:{key}")
        db.add(
            GuestInvite(
                id=iid,
                token_hash=f"{key:>064}".replace(" ", "i")[:64],
                token_prefix=f"sgi-{key}"[:16],
                room_id=self.room_id,
                expires_at=days_ago(expires_days_ago),
                revoked_at=days_ago(expires_days_ago) if revoked else None,
                use_count=use_count,
                created_by=self.owner_id,
                history_from=days_ago(expires_days_ago + 1),
            )
        )
        return iid

    def session(
        self,
        db,
        key: str,
        *,
        invite_id: uuid.UUID,
        participant_id: uuid.UUID,
        expires_days_ago: float,
        revoked: bool = True,
    ) -> uuid.UUID:
        sid = self._pid(f"session:{key}")
        db.add(
            GuestSession(
                id=sid,
                token_hash=f"{key:>064}".replace(" ", "s")[:64],
                token_prefix=f"sgs-{key}"[:16],
                invite_id=invite_id,
                room_id=self.room_id,
                participant_id=participant_id,
                display_name=f"Guest {key}",
                expires_at=days_ago(expires_days_ago),
                revoked_at=days_ago(expires_days_ago) if revoked else None,
            )
        )
        return sid

    def message(self, db, key: str, *, sender_id: uuid.UUID) -> uuid.UUID:
        mid = self._pid(f"msg:{key}")
        db.add(
            Message(
                id=mid,
                room_id=self.room_id,
                sender_id=sender_id,
                content=f"message from {key}",
            )
        )
        return mid


async def build(session_factory) -> Fixture:
    """Wipe and re-seed. Called before every case so cases cannot leak."""
    fx = Fixture()
    async with session_factory() as db:
        for model in (GuestSession, GuestInvite, Message, Room, Participant):
            await db.execute(delete(model))
        await db.commit()

        db.add(
            Participant(
                id=fx.owner_id,
                keycloak_sub=str(uuid.uuid4()),
                username="owner",
                display_name="Room Owner",
                participant_type=ParticipantType.HUMAN,
                status=ParticipantStatus.OFFLINE,
            )
        )
        await db.commit()
        db.add(
            Room(
                id=fx.room_id,
                name="retention-room",
                display_name="Retention Room",
                room_type=RoomType.CHANNEL,
                livekit_room_name=f"stable-{fx.room_id}",
                created_by=fx.owner_id,
            )
        )
        await db.commit()

        # -- invites ---------------------------------------------------------
        # DEAD, NEVER REDEEMED, past the window -> the one safe hard delete.
        i_stale = fx.invite(db, "stale", expires_days_ago=200)
        # DEAD, never redeemed, but INSIDE the window -> survives.
        fx.invite(db, "recent", expires_days_ago=10)
        # STILL LIVE (expires in the future) -> survives.
        fx.invite(db, "live", expires_days_ago=-5)
        # DEAD past the window but STILL HAS A SESSION -> must survive, because
        # guest_sessions.invite_id is ON DELETE CASCADE.
        i_used = fx.invite(db, "used", expires_days_ago=200, use_count=1)
        # REVOKED long ago, never redeemed -> safe hard delete.
        fx.invite(db, "revoked", expires_days_ago=200, revoked=True)
        # DEAD past the window, was used, but its session is ALSO past the
        # session window -> the chain unwinds session-first, then invite.
        i_chain = fx.invite(db, "chain", expires_days_ago=400, use_count=1)
        # DEAD past the window; its only guest said nothing and is due for the
        # 016 participant purge, which CASCADEs the session away -> so the whole
        # participant -> session -> invite chain must unwind in one pass.
        i_solo = fx.invite(db, "solo", expires_days_ago=200, use_count=1)

        # -- guests ----------------------------------------------------------
        # Spoke in the room. Tombstoned forever: messages.sender_id is SET NULL
        # so deleting this row would anonymise their history.
        p_talker = fx.guest(db, "talker", retired_days_ago=400)
        # Said NOTHING. The 016 purge is allowed to delete it, and does.
        p_silent = fx.guest(db, "silent", retired_days_ago=400)
        # Spoke, and its session is old enough to be purged under it.
        p_chain = fx.guest(db, "chain", retired_days_ago=500)
        # NOT retired — still on a call. Nothing may touch this guest or its
        # live session, and its presence is what keeps i_used alive.
        p_active = fx.guest(db, "active", retired_days_ago=None)
        await db.commit()

        # -- sessions --------------------------------------------------------
        # Attached to i_used: dead but INSIDE the 365d session window, so it
        # survives -> and therefore i_used must survive too.
        fx.session(
            db,
            "held",
            invite_id=i_used,
            participant_id=p_talker,
            expires_days_ago=100,
        )
        # Past the session window -> purged.
        fx.session(
            db,
            "ancient",
            invite_id=i_chain,
            participant_id=p_chain,
            expires_days_ago=400,
        )
        # Still LIVE -> never purged, by any stage, ever.
        fx.session(
            db,
            "livesess",
            invite_id=i_used,
            participant_id=p_active,
            expires_days_ago=-1,
            revoked=False,
        )
        # Belongs to the trace-free guest: removed by CASCADE when the 016
        # participant purge deletes them, NOT by the session stage (it is only
        # 200 days dead, inside the 365-day session window).
        fx.session(
            db,
            "cascaded",
            invite_id=i_solo,
            participant_id=p_silent,
            expires_days_ago=200,
        )
        # -- messages --------------------------------------------------------
        # The talker spoke. Their participant row is tombstoned forever and
        # every one of these must keep its sender.
        fx.message(db, "t1", sender_id=p_talker)
        fx.message(db, "t2", sender_id=p_talker)
        fx.message(db, "c1", sender_id=p_chain)
        fx.message(db, "owner", sender_id=fx.owner_id)
        await db.commit()

    assert fx.ids["invite:stale"] == i_stale
    return fx


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------


async def exists(session_factory, model, row_id) -> bool:
    async with session_factory() as db:
        return (
            await db.execute(select(func.count()).select_from(model).where(model.id == row_id))
        ).scalar_one() > 0


async def sender_map(session_factory) -> dict[str, str | None]:
    async with session_factory() as db:
        rows = (await db.execute(select(Message.id, Message.sender_id))).all()
    return {str(mid): (str(sid) if sid is not None else None) for mid, sid in rows}


async def orphan_messages(session_factory) -> int:
    async with session_factory() as db:
        return (
            await db.execute(
                select(func.count()).select_from(Message).where(Message.sender_id.is_(None))
            )
        ).scalar_one()


async def full_pass(session_factory, **over) -> dict[str, tuple[int, int]]:
    """Everything the production loop body does, minus the LiveKit/socket half
    (which needs Redis and is covered by the mocked tests)."""
    kw = dict(
        batch=200,
        retire_after_minutes=60,
        purge_after_days=30,
    )
    kw.update({k: v for k, v in over.items() if k in kw})
    participants = await guest_reaper.sweep_guest_participants(session_factory, **kw)
    rows = await guest_reaper.sweep_guest_rows(
        session_factory,
        batch=200,
        session_purge_after_days=over.get("session_purge_after_days", 365),
        invite_purge_after_days=over.get("invite_purge_after_days", 90),
    )
    return {"participants": participants, "rows": rows}


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


async def t1_expired_unredeemed_invite_is_deleted(sf) -> None:
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T1 dead never-redeemed invite deleted",
        await exists(sf, GuestInvite, fx.ids["invite:stale"]),
        False,
    )
    check(
        "T1 revoked never-redeemed invite deleted",
        await exists(sf, GuestInvite, fx.ids["invite:revoked"]),
        False,
    )


async def t2_invite_inside_the_window_survives(sf) -> None:
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T2 dead-but-recent invite survives",
        await exists(sf, GuestInvite, fx.ids["invite:recent"]),
        True,
    )
    check(
        "T2 live invite survives",
        await exists(sf, GuestInvite, fx.ids["invite:live"]),
        True,
    )


async def t3_invite_with_a_session_survives(sf) -> None:
    """The guard. ON DELETE CASCADE means deleting this invite would take the
    audit trail of who joined through it with it."""
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T3 invite with a surviving session is NOT deleted",
        await exists(sf, GuestInvite, fx.ids["invite:used"]),
        True,
    )
    check(
        "T3 that session still exists",
        await exists(sf, GuestSession, fx.ids["session:held"]),
        True,
    )


async def t4_dead_session_past_the_window_is_deleted(sf) -> None:
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T4 session past the retention window deleted",
        await exists(sf, GuestSession, fx.ids["session:ancient"]),
        False,
    )
    check(
        "T4 session inside the window survives",
        await exists(sf, GuestSession, fx.ids["session:held"]),
        True,
    )
    check(
        "T4 LIVE session survives",
        await exists(sf, GuestSession, fx.ids["session:livesess"]),
        True,
    )


async def t5_the_chain_unwinds_leaf_first(sf) -> None:
    """Session purged this pass -> the invite behind it becomes eligible in the
    SAME pass, because sweep_guest_rows runs sessions before invites."""
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T5 session purged",
        await exists(sf, GuestSession, fx.ids["session:ancient"]),
        False,
    )
    check(
        "T5 the invite behind it purged in the same pass",
        await exists(sf, GuestInvite, fx.ids["invite:chain"]),
        False,
    )
    # The other unwind order: 016 deletes the trace-free PARTICIPANT, which
    # CASCADEs its session, which frees the invite — three tables, one pass,
    # only because participants -> sessions -> invites is the order the loop
    # runs them in.
    check(
        "T5 trace-free guest purged",
        await exists(sf, Participant, fx.ids["silent"]),
        False,
    )
    check(
        "T5 their session went with them by CASCADE",
        await exists(sf, GuestSession, fx.ids["session:cascaded"]),
        False,
    )
    check(
        "T5 and the invite that minted only them is now free to go",
        await exists(sf, GuestInvite, fx.ids["invite:solo"]),
        False,
    )


async def t6_zero_disables_each_stage(sf) -> None:
    fx = await build(sf)
    await full_pass(sf, session_purge_after_days=0, invite_purge_after_days=0)
    check(
        "T6 sessions kept when disabled",
        await exists(sf, GuestSession, fx.ids["session:ancient"]),
        True,
    )
    check(
        "T6 invites kept when disabled",
        await exists(sf, GuestInvite, fx.ids["invite:stale"]),
        True,
    )


async def t7_message_history_is_not_damaged(sf) -> None:
    """THE ONE THAT MATTERS.

    messages.sender_id is ON DELETE SET NULL, so a reaper that deleted a
    participant it should not have would not raise — it would silently
    un-attribute every message that guest ever sent. Compare the whole
    sender map before and after.
    """
    fx = await build(sf)
    before = await sender_map(sf)
    orphans_before = await orphan_messages(sf)
    await full_pass(sf)
    after = await sender_map(sf)

    check("T7 no message was deleted", len(after), len(before))
    check("T7 every sender is unchanged", after, before)
    check("T7 no new anonymous holes", await orphan_messages(sf), orphans_before)
    check("T7 orphan count is zero to begin with", orphans_before, 0)
    check(
        "T7 the talking guest is TOMBSTONED, not deleted",
        await exists(sf, Participant, fx.ids["talker"]),
        True,
    )
    check(
        "T7 the guest who chained is also kept (they spoke)",
        await exists(sf, Participant, fx.ids["chain"]),
        True,
    )
    check(
        "T7 the guest still on a call is untouched",
        await exists(sf, Participant, fx.ids["active"]),
        True,
    )
    check(
        "T7 the trace-free guest IS purged (that stage still works)",
        await exists(sf, Participant, fx.ids["silent"]),
        False,
    )


async def t8_negative_control_the_check_can_actually_fail(sf) -> None:
    """NEGATIVE CONTROL for T7.

    Run the participant purge with its message guard REMOVED — the mistake a
    future refactor could plausibly make — against the same fixture, and
    require that T7's assertions now FAIL. If they still pass, T7 is not
    measuring anything and every green run above is worthless.
    """
    fx = await build(sf)
    before = await sender_map(sf)

    broken = text(
        """
        DELETE FROM participants AS t
         WHERE t.participant_type = 'guest'
           AND (t.metadata ->> 'guest_retired_at') IS NOT NULL
        RETURNING t.id
        """
    )
    async with sf() as db:
        deleted = list((await db.execute(broken)).scalars().all())
        await db.commit()

    after = await sender_map(sf)
    orphans = await orphan_messages(sf)

    check("T8 the unguarded delete removed rows", len(deleted) > 0, True)
    check(
        "T8 the talking guest IS gone without the guard",
        await exists(sf, Participant, fx.ids["talker"]),
        False,
    )
    check("T8 the same messages are still present", len(after), len(before))
    check("T8 but their senders are now NULL", after == before, False)
    check("T8 anonymous holes appeared", orphans > 0, True)
    check(
        "T8 the holes are exactly the guest's messages",
        orphans,
        sum(1 for v in before.values() if v in {str(fx.ids["talker"]), str(fx.ids["chain"])}),
    )


async def t9_a_purged_session_does_not_take_its_participant(sf) -> None:
    """The FK points the other way (session -> participant), so deleting a
    session must leave the identity, its tombstone and its messages alone."""
    fx = await build(sf)
    await full_pass(sf)
    check(
        "T9 session gone",
        await exists(sf, GuestSession, fx.ids["session:ancient"]),
        False,
    )
    check(
        "T9 participant kept",
        await exists(sf, Participant, fx.ids["chain"]),
        True,
    )
    check(
        "T9 their message kept",
        await exists(sf, Message, fx.ids["msg:c1"]),
        True,
    )


async def t10_the_indexes_the_scans_need_are_really_there(sf) -> None:
    async with sf() as db:
        names = set(
            (
                await db.execute(
                    text(
                        "SELECT indexname FROM pg_indexes "
                        "WHERE tablename IN ('guest_invites','guest_sessions')"
                    )
                )
            )
            .scalars()
            .all()
        )
    for want in ("ix_guest_sessions_expires_at", "ix_guest_invites_expires_at"):
        check(f"T10 {want} exists", want in names, True)


async def t11_an_idle_pass_uses_the_index(sf) -> None:
    """A GC that seq-scans gets slower the more history you have, which is how
    it ends up switched off. Ask the planner, not the docstring."""
    await build(sf)
    async with sf() as db:
        await db.execute(text("ANALYZE guest_sessions"))
        await db.execute(text("ANALYZE guest_invites"))
        # Force the planner to prefer indexes over a seq scan of a tiny table;
        # the SHAPE (an ordered index read, not a sort) is what is under test.
        await db.execute(text("SET LOCAL enable_seqscan = off"))
        for table in ("guest_sessions", "guest_invites"):
            plan = "\n".join(
                (
                    await db.execute(
                        text(
                            f"EXPLAIN SELECT id FROM {table} "
                            "WHERE expires_at <= now() - make_interval(days => 365) "
                            "ORDER BY expires_at LIMIT 200"
                        )
                    )
                )
                .scalars()
                .all()
            )
            check(f"T11 {table} scan is index-ordered", "Index" in plan, True)
            check(f"T11 {table} scan needs no sort", "Sort" in plan, False)


# ---------------------------------------------------------------------------


CASES = [
    ("T1", t1_expired_unredeemed_invite_is_deleted),
    ("T2", t2_invite_inside_the_window_survives),
    ("T3", t3_invite_with_a_session_survives),
    ("T4", t4_dead_session_past_the_window_is_deleted),
    ("T5", t5_the_chain_unwinds_leaf_first),
    ("T6", t6_zero_disables_each_stage),
    ("T7", t7_message_history_is_not_damaged),
    ("T8", t8_negative_control_the_check_can_actually_fail),
    ("T9", t9_a_purged_session_does_not_take_its_participant),
    ("T10", t10_the_indexes_the_scans_need_are_really_there),
    ("T11", t11_an_idle_pass_uses_the_index),
]


async def main() -> None:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        print("TEST_DATABASE_URL is required (a THROWAWAY database).")
        sys.exit(2)
    if url.rsplit("/", 1)[-1] in ("stable", "postgres"):
        print("Refusing to run against a non-throwaway database name.")
        sys.exit(2)

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    for name, fn in CASES:
        try:
            await fn(session_factory)
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"{name}: raised {exc.__class__.__name__}: {exc}")

    await engine.dispose()

    if FAILURES:
        print("FAIL")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print(f"PASS — {len(CASES)} guest row-retention cases green")


if __name__ == "__main__":
    asyncio.run(main())
