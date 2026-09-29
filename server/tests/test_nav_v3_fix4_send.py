"""Nav v3 fix lane 4 — a failed insert-time floor never fails the send
(REVIEW-4.md P2-1).

e20c618 answered a failed floor stamp with ``session.rollback()``. A
rollback expires every row the session holds, so the very next line —
``str(message.id)`` for the broadcast — lazy-loaded outside SQLAlchemy's
greenlet and raised ``MissingGreenlet``: a 500 for a message that was
already committed, with no broadcast, no echo and no triggers.

These tests run the REAL ``MessageService`` and the real route function on a
REAL SQLAlchemy session (sqlite, in memory). The earlier test of this path
used an ``AsyncMock`` session, which expires nothing and so could not see
the failure. The one thing sqlite's driver does not do by itself is enforce
the async rule, so the harness enforces it the way asyncpg does: a statement
that runs outside SQLAlchemy's greenlet raises ``MissingGreenlet``.

Every test here FAILED on e20c618 unless its docstring says it is a pin.
"""

from __future__ import annotations

import uuid
from contextlib import ExitStack
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import sqlalchemy as sa
from greenlet import getcurrent
from sqlalchemy import event
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import MissingGreenlet
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool

from app.api import messages as M
from app.models.base import Base
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.schemas.message import MessageCreate, MessageResponse
from app.services import message_service as MS
from app.services import room_class as RC


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(element, compiler, **kw):  # pragma: no cover - DDL only
    return "JSON"


#: The tables one send touches (the ORM's eager loads included).
TABLES = ("participants", "agent_configs", "rooms", "room_members", "messages", "activity_events")


def real_engine():
    """An in-memory sqlite with the app's own tables, SAVEPOINT support, and
    the async driver's one rule enforced."""
    engine = sa.create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection, _record):
        # pysqlite must not manage transactions itself, or SAVEPOINT breaks.
        dbapi_connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    metadata = sa.MetaData()
    for name in TABLES:
        table = Base.metadata.tables[name].to_metadata(metadata)
        for column in table.columns:
            if column.server_default is not None:
                is_now = "now()" in str(getattr(column.server_default, "arg", ""))
                column.server_default = sa.DefaultClause(sa.text("CURRENT_TIMESTAMP")) if is_now else None
        for index in list(table.indexes):
            table.indexes.discard(index)                  # Postgres-only index options
    metadata.create_all(engine)

    @event.listens_for(engine, "before_cursor_execute")
    def _only_inside_the_greenlet(conn, cursor, statement, parameters, context, executemany):
        if not getattr(getcurrent(), "__sqlalchemy_greenlet_provider__", False):
            raise MissingGreenlet(f"a statement ran outside the greenlet: {statement[:50]!r}")

    return engine


def real_session(engine) -> AsyncSession:
    session = AsyncSession(expire_on_commit=False)        # as app/main.py builds it
    session.sync_session.bind = engine
    return session


async def _failing_stamp(session, room_ids):
    """The floor UPDATE, failing in the database the way a lock timeout or a
    lost connection would (REVIEW-4's probe did the same)."""
    await session.execute(sa.text("UPDATE no_such_table SET x = 1"))


class P2_1_AFailedFloorNeverFailsTheSend(IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.engine = real_engine()
        self.db = real_session(self.engine)
        self.guest = Participant(id=uuid.uuid4(), keycloak_sub="guest:7f3a", username="guest-7f3a", display_name="Jordan (guest)",
                                 participant_type=ParticipantType.GUEST, status=ParticipantStatus.ONLINE, metadata_={})
        self.aaron = Participant(id=uuid.uuid4(), keycloak_sub="kc-aaron", username="aaron", display_name="Aaron",
                                 participant_type=ParticipantType.HUMAN, status=ParticipantStatus.ONLINE, metadata_={})
        self.room = Room(id=uuid.uuid4(), name="hub-1", display_name="Persephone", room_type=RoomType.AGENT_HUB,
                         livekit_room_name="stable-hub-1", metadata_={"seats": {"persephone": {"effort": "max"}}})
        self.db.add_all([self.guest, self.aaron, self.room])
        await self.db.flush()
        for participant in (self.guest, self.aaron):
            self.db.add(RoomMember(id=uuid.uuid4(), room_id=self.room.id, participant_id=participant.id, role=MemberRole.MEMBER))
        await self.db.commit()
        self.livekit = AsyncMock()
        self.echo = AsyncMock()
        self.warnings: list[str] = []

    async def asyncTearDown(self) -> None:
        await self.db.close()
        self.engine.dispose()

    def _stand_ins(self, *, stamp=None) -> ExitStack:
        """LiveKit, the WebSocket publish, mail, push and the responder are
        stand-ins. The session, the service and the route function are real."""
        stack = ExitStack()
        stack.enter_context(patch.object(M, "_ws_broadcast_room", new=self.echo))
        stack.enter_context(patch.object(M, "_maybe_dispatch_mention_emails", new=AsyncMock()))
        stack.enter_context(patch("app.services.push_service.dispatch_message_pushes", new=AsyncMock()))
        stack.enter_context(patch("app.services.agent_status.mark_relay_pending_for_room", new=AsyncMock()))
        stack.enter_context(patch.object(M, "_agent_chat_within_budget", new=AsyncMock(return_value=False)))
        real_warning = MS.logger.warning

        def warning(event_name, *args, **kw):
            self.warnings.append(event_name)
            kw.pop("exc_info", None)
            return real_warning(event_name, *args, **kw)

        stack.enter_context(patch.object(MS.logger, "warning", new=warning))
        if stamp is not None:
            stack.enter_context(patch.object(MS, "stamp_class_floor_shared", new=stamp))
        return stack

    async def _rows(self) -> list[tuple]:
        return await self.db.run_sync(
            lambda s: [tuple(r) for r in s.execute(sa.text("select content, sender_id from messages order by created_at")).all()]
        )

    async def test_the_message_is_returned_broadcast_and_echoed(self) -> None:
        """A guest posts (an author that floors at insert) and the floor
        stamp fails in the database. Through the route function."""
        user = {"participant_id": self.guest.id, "participant_type": "guest", "sub": "guest:7f3a", "is_guest": True,
                "guest_room_id": str(self.room.id), "username": "guest-7f3a", "display_name": "Jordan (guest)"}
        with self._stand_ins(stamp=_failing_stamp):
            response = await M.send_message(room_id=self.room.id, body=MessageCreate(content="hello from outside"),
                                            user=user, db=self.db, livekit=self.livekit, request=None)
        # 201's body: the message that was stored.
        self.assertIsInstance(response, MessageResponse)
        self.assertEqual((response.content, response.sender_id, response.sender_type), ("hello from outside", self.guest.id, "guest"))
        self.assertEqual(response.sender_name, "Jordan (guest)")
        # It is committed, once.
        self.assertEqual([r[0] for r in await self._rows()], ["hello from outside"])
        # The LiveKit broadcast ran, with the whole payload.
        self.livekit.send_data.assert_awaited_once()
        room_name, data = self.livekit.send_data.await_args.args
        self.assertEqual((room_name, data["type"], data["room_type"]), ("stable-hub-1", "new_message", "agent_hub"))
        self.assertEqual(data["message"]["id"], str(response.id))
        self.assertEqual(data["message"]["content"], "hello from outside")
        self.assertEqual(data["message"]["sender"]["username"], "guest-7f3a")
        self.assertEqual(data["message"]["sender"]["participant_type"], "guest")
        # The WebSocket echo ran.
        self.echo.assert_awaited_once()
        envelope = self.echo.await_args.args[2]
        self.assertEqual((envelope["type"], envelope["payload"]["message"]["id"]), ("message", str(response.id)))
        # The failure was logged under its own name, and nothing else was.
        self.assertEqual(self.warnings, ["class_floor_on_insert_failed"])

    async def test_nothing_the_session_holds_is_expired_and_it_stays_usable(self) -> None:
        with self._stand_ins(stamp=_failing_stamp):
            service = MS.MessageService(db=self.db, livekit=self.livekit)
            message = await service.send_message(room_id=self.room.id, sender_id=self.guest.id, content="x", content_type="text")
            # Plain attribute reads, in a coroutine: each would raise
            # MissingGreenlet if the row had been expired.
            self.assertEqual((message.content, message.sender.username, message.room.name), ("x", "guest-7f3a", "hub-1"))
            self.assertEqual(sa_inspect(message).expired_attributes, set())
            self.assertEqual(sa_inspect(self.room).expired_attributes, set())
            self.assertEqual(self.room.metadata_, {"seats": {"persephone": {"effort": "max"}}})
            # The session carries on: the next send works, and is committed.
            again = await service.send_message(room_id=self.room.id, sender_id=self.aaron.id, content="y", content_type="text")
        self.assertEqual(again.content, "y")
        self.assertEqual([r[0] for r in await self._rows()], ["x", "y"])
        self.assertEqual(self.livekit.send_data.await_count, 2)
        self.assertEqual(self.warnings, ["class_floor_on_insert_failed"])    # the guest's line only

    async def test_the_stamp_runs_in_a_savepoint(self) -> None:
        statements: list[str] = []

        @event.listens_for(self.engine, "before_cursor_execute")
        def _record(conn, cursor, statement, parameters, context, executemany):
            statements.append(" ".join(statement.split()))

        with self._stand_ins(stamp=_failing_stamp):
            await MS.MessageService(db=self.db, livekit=self.livekit).send_message(
                room_id=self.room.id, sender_id=self.guest.id, content="x", content_type="text")
        stamp = statements.index("UPDATE no_such_table SET x = 1")
        self.assertTrue(statements[stamp - 1].startswith("SAVEPOINT "), statements[stamp - 1])
        self.assertTrue(statements[stamp + 1].startswith("ROLLBACK TO SAVEPOINT "), statements[stamp + 1])
        self.assertNotIn("ROLLBACK", statements[stamp + 2:])          # never the whole transaction

    async def test_the_broadcast_is_built_from_a_snapshot_taken_before_the_stamp(self) -> None:
        """Belt and braces: even a failure that DOES expire every row the
        session holds (a lost connection, a rollback somewhere below) cannot
        reach the broadcast, because nothing in it is read after the stamp."""

        async def stamp_that_expires_everything(session, room_ids):
            session.sync_session.expire_all()
            raise RuntimeError("the connection went away")

        with self._stand_ins(stamp=stamp_that_expires_everything):
            message = await MS.MessageService(db=self.db, livekit=self.livekit).send_message(
                room_id=self.room.id, sender_id=self.guest.id, content="hello from outside", content_type="text")
        self.livekit.send_data.assert_awaited_once()
        payload = self.livekit.send_data.await_args.args[1]["message"]
        self.assertEqual(payload["id"], str(sa_inspect(message).identity[0]))
        self.assertEqual((payload["content"], payload["sender"]["username"]), ("hello from outside", "guest-7f3a"))
        self.assertEqual(payload["content_type"], "text")
        self.assertEqual(self.warnings, ["class_floor_on_insert_failed"])

    async def test_an_owners_line_never_reaches_the_stamp(self) -> None:
        """PIN: a human's line does not floor at insert, so nothing can fail."""
        stamp = AsyncMock(side_effect=AssertionError("the stamp must not run for a human author"))
        with self._stand_ins(stamp=stamp):
            await MS.MessageService(db=self.db, livekit=self.livekit).send_message(
                room_id=self.room.id, sender_id=self.aaron.id, content="mine", content_type="text")
        stamp.assert_not_awaited()
        self.assertEqual(self.warnings, [])


class TheFloorUpdateLeavesTheSessionAlone(IsolatedAsyncioTestCase):
    """Measured on PostgreSQL 17 (lane report): the e20c618 statement left
    ``metadata_`` and ``updated_at`` EXPIRED on every Room the session held,
    and the next read raised MissingGreenlet — on the success path too."""

    async def test_the_session_is_not_asked_to_reconcile(self) -> None:
        db = AsyncMock()
        await RC.stamp_class_floor_shared(db, [uuid.uuid4()])
        statement = db.execute.await_args.args[0]
        self.assertIs(statement.get_execution_options().get("synchronize_session"), False)
        sql = " ".join(str(statement.compile(dialect=postgresql.dialect())).lower().split())
        self.assertIn("coalesce(rooms.metadata", sql)
        self.assertIn("||", sql)                                       # still a merge of one key
