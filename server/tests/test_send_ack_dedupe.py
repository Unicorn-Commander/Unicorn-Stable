"""Tests for the send-ACK protocol's server half.

The client half (web/src/lib/sendPipeline.ts) shows an optimistic bubble as
`pending` until the server acknowledges its client_msg_id, fails it visibly on
timeout, and retries with the SAME id. This suite pins the two server
guarantees that make that safe:

  1. the ACK is only ever issued for a persisted message — the route stamps
     client_msg_id into metadata as part of the same persist the 201 reports;
  2. a retried client_msg_id whose original send DID persist (only the
     response was lost) is answered with the existing message and fires NONE
     of the side effects again — no duplicate row, no second ws echo, no
     second agent reply.

Plus the mark_read hardening: a client-supplied non-UUID message_id (an
unACKed `optimistic-…` bubble id) must degrade to None instead of raising in
the asyncpg UUID bind and tearing down the whole websocket.
"""

from __future__ import annotations

import contextlib
import unittest
import uuid
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.api import messages as messages_api
from app.models.message import ContentType, Message
from app.models.participant import Participant, ParticipantType
from app.schemas.message import MessageCreate
from app.ws.handler import _mark_read_message_uuid

ROOM_ID = uuid.UUID("10000000-0000-0000-0000-000000000001")
MESSAGE_ID = uuid.UUID("20000000-0000-0000-0000-000000000002")
SENDER_ID = uuid.UUID("30000000-0000-0000-0000-000000000003")
CLIENT_MSG_ID = "9f5b1c2a-4242-4242-4242-deadbeef0001"


def _sql(clause) -> str:
    compiled = clause.compile(dialect=postgresql.dialect())
    return str(compiled).replace("\n", " ")


def _params(clause) -> dict:
    return dict(clause.compile(dialect=postgresql.dialect()).params)


class _Result:
    def __init__(self, *, scalar=None):
        self.scalar = scalar

    def scalar_one_or_none(self):
        return self.scalar


class _DB:
    def __init__(self, results):
        self.results = list(results)
        self.statements = []
        self.added = []
        self.commits = 0

    async def execute(self, statement):
        self.statements.append(statement)
        return self.results.pop(0)

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        self.commits += 1

    async def refresh(self, _value):
        return None


class _LiveKit:
    async def send_data(self, **kwargs):
        return None


class _RecordingService:
    """Stands in for MessageService: records the send and returns a Message
    whose metadata is exactly what the route asked to persist."""

    def __init__(self):
        self.calls = []

    async def send_message(self, **kwargs):
        self.calls.append(kwargs)
        return _persisted_message(metadata=kwargs.get("metadata"))


def _persisted_message(
    *,
    metadata: dict | None,
    message_id: uuid.UUID = MESSAGE_ID,
) -> Message:
    sender = Participant(
        id=SENDER_ID,
        keycloak_sub="kc-sub-aaron",
        username="aaron",
        display_name="Aaron",
        participant_type=ParticipantType.HUMAN,
    )
    return Message(
        id=message_id,
        room_id=ROOM_ID,
        sender_id=SENDER_ID,
        sender=sender,
        content="hello there",
        content_type=ContentType.TEXT,
        metadata_=metadata,
        is_deleted=False,
        is_edited=False,
        created_at=datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc),
    )


def _user() -> dict:
    return {
        "participant_id": SENDER_ID,
        "sub": "kc-sub-aaron",
        "username": "aaron",
        "display_name": "Aaron",
        "email": None,
    }


@contextlib.contextmanager
def _patched_route(svc):
    """Route the seams: the persist goes to the recording service, the ws
    fan-out into a list, and the fire-and-forget notifiers (mention emails,
    web push — both swallow their own errors by design) become no-ops so a
    test's fake db is only ever touched by the code under test."""
    import app.services.push_service as push_service

    broadcasts: list = []

    async def _record_broadcast(db, room_id, envelope):
        broadcasts.append((str(room_id), envelope))

    async def _async_noop(**kwargs):
        return None

    orig_build = messages_api._build_message_service
    orig_broadcast = messages_api._ws_broadcast_room
    orig_mentions = messages_api._maybe_dispatch_mention_emails
    orig_push = push_service.dispatch_message_pushes
    messages_api._build_message_service = lambda db, livekit: svc
    messages_api._ws_broadcast_room = _record_broadcast
    messages_api._maybe_dispatch_mention_emails = _async_noop
    push_service.dispatch_message_pushes = _async_noop
    try:
        yield broadcasts
    finally:
        messages_api._build_message_service = orig_build
        messages_api._ws_broadcast_room = orig_broadcast
        messages_api._maybe_dispatch_mention_emails = orig_mentions
        push_service.dispatch_message_pushes = orig_push


class MessageCreateSchemaTests(unittest.TestCase):
    def test_client_msg_id_defaults_to_none(self) -> None:
        body = MessageCreate(content="hi")
        self.assertIsNone(body.client_msg_id)

    def test_client_msg_id_accepts_a_uuid_string(self) -> None:
        body = MessageCreate(content="hi", client_msg_id=CLIENT_MSG_ID)
        self.assertEqual(body.client_msg_id, CLIENT_MSG_ID)

    def test_client_msg_id_is_length_capped(self) -> None:
        with self.assertRaises(ValidationError):
            MessageCreate(content="hi", client_msg_id="x" * 65)


class DedupeLookupTests(unittest.IsolatedAsyncioTestCase):
    async def test_lookup_filters_on_room_sender_window_and_metadata_id(self) -> None:
        db = _DB([_Result(scalar=None)])
        found = await messages_api._find_recent_send_by_client_msg_id(
            db,
            room_id=ROOM_ID,
            sender_id=SENDER_ID,
            client_msg_id=CLIENT_MSG_ID,
        )
        self.assertIsNone(found)
        self.assertEqual(len(db.statements), 1)

        sql = _sql(db.statements[0])
        # JSONB text extraction — the id lives in metadata, no schema change.
        self.assertIn("->>", sql)
        self.assertIn("is_deleted", sql)
        self.assertIn("created_at >=", sql)
        self.assertIn("LIMIT", sql)

        values = list(_params(db.statements[0]).values())
        self.assertIn(CLIENT_MSG_ID, values)
        self.assertIn("client_msg_id", values)  # the JSONB key
        self.assertIn(ROOM_ID, values)
        self.assertIn(SENDER_ID, values)


class SendMessageAckTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_send_stamps_client_msg_id_and_echoes_it(self) -> None:
        svc = _RecordingService()
        # One db hit: the dedupe lookup missing (this id was never persisted).
        db = _DB([_Result(scalar=None)])

        with _patched_route(svc) as broadcasts:
            response = await messages_api.send_message(
                ROOM_ID,
                MessageCreate(
                    content="hello there",
                    content_type="text",
                    metadata={"attachments": []},
                    client_msg_id=CLIENT_MSG_ID,
                ),
                _user(),
                db,
                _LiveKit(),
            )

        # Persisted exactly once, with the id stamped INTO the stored
        # metadata alongside what the client sent.
        self.assertEqual(len(svc.calls), 1)
        self.assertEqual(
            svc.calls[0]["metadata"],
            {"attachments": [], "client_msg_id": CLIENT_MSG_ID},
        )
        # The 201 body is the ACK: it references the client's id.
        self.assertEqual(response.id, MESSAGE_ID)
        self.assertEqual(response.metadata.get("client_msg_id"), CLIENT_MSG_ID)
        # …and the ws echo carries it too, so the sender's other ACK path
        # (the echo) can reconcile the same send.
        self.assertEqual(len(broadcasts), 1)
        room_id, envelope = broadcasts[0]
        self.assertEqual(room_id, str(ROOM_ID))
        self.assertEqual(envelope["type"], "message")
        self.assertEqual(
            envelope["payload"]["message"]["metadata"]["client_msg_id"],
            CLIENT_MSG_ID,
        )

    async def test_retry_of_a_persisted_send_acks_without_reposting(self) -> None:
        svc = _RecordingService()
        already = _persisted_message(
            metadata={"client_msg_id": CLIENT_MSG_ID},
            message_id=uuid.UUID("20000000-0000-0000-0000-00000000BEEF"),
        )
        db = _DB([_Result(scalar=already)])

        with _patched_route(svc) as broadcasts:
            response = await messages_api.send_message(
                ROOM_ID,
                MessageCreate(
                    content="hello there",
                    content_type="text",
                    client_msg_id=CLIENT_MSG_ID,
                ),
                _user(),
                db,
                _LiveKit(),
            )

        # ACKed with the EXISTING message — nothing persisted again, and no
        # side effect (echo/agent/mentions) fired a second time.
        self.assertEqual(response.id, already.id)
        self.assertEqual(response.metadata.get("client_msg_id"), CLIENT_MSG_ID)
        self.assertEqual(svc.calls, [])
        self.assertEqual(broadcasts, [])
        self.assertEqual(db.added, [])
        self.assertEqual(db.commits, 0)

    async def test_send_without_client_msg_id_skips_the_dedupe_lookup(self) -> None:
        svc = _RecordingService()
        db = _DB([])  # any db hit would raise — proving no lookup happens

        with _patched_route(svc) as broadcasts:
            response = await messages_api.send_message(
                ROOM_ID,
                MessageCreate(content="hello there", content_type="text"),
                _user(),
                db,
                _LiveKit(),
            )

        self.assertEqual(len(svc.calls), 1)
        self.assertIsNone(svc.calls[0]["metadata"])
        self.assertEqual(db.statements, [])
        self.assertEqual(response.id, MESSAGE_ID)
        self.assertEqual(len(broadcasts), 1)

    async def test_blank_client_msg_id_is_treated_as_absent(self) -> None:
        svc = _RecordingService()
        db = _DB([])

        with _patched_route(svc):
            await messages_api.send_message(
                ROOM_ID,
                MessageCreate(
                    content="hello there",
                    content_type="text",
                    client_msg_id="   ",
                ),
                _user(),
                db,
                _LiveKit(),
            )

        self.assertEqual(db.statements, [])
        self.assertIsNone(svc.calls[0]["metadata"])


class MarkReadMessageIdGuardTests(unittest.TestCase):
    def test_valid_uuid_string_parses(self) -> None:
        self.assertEqual(
            _mark_read_message_uuid(str(MESSAGE_ID)), MESSAGE_ID
        )

    def test_optimistic_bubble_id_degrades_to_none(self) -> None:
        self.assertIsNone(
            _mark_read_message_uuid("optimistic-9f5b1c2a-4242")
        )

    def test_none_and_garbage_degrade_to_none(self) -> None:
        self.assertIsNone(_mark_read_message_uuid(None))
        self.assertIsNone(_mark_read_message_uuid(""))
        self.assertIsNone(_mark_read_message_uuid(12345))
        self.assertIsNone(_mark_read_message_uuid({"nested": "junk"}))
