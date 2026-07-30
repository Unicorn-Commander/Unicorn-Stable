from __future__ import annotations

import uuid
import unittest
from datetime import datetime, timezone

from fastapi import HTTPException

from app.api.messages import (
    DecideBody,
    decide_action,
    list_pending_approvals,
)
from app.models.agent import AgentConfig, AgentEvent, AgentType
from app.models.message import ContentType, Message
from app.models.participant import Participant, ParticipantType
from app.models.room import MemberRole, Room, RoomType


ROOM_ID = uuid.UUID("10000000-0000-0000-0000-000000000001")
MESSAGE_ID = uuid.UUID("20000000-0000-0000-0000-000000000002")
AGENT_ID = uuid.UUID("30000000-0000-0000-0000-000000000003")
CONFIG_ID = uuid.UUID("40000000-0000-0000-0000-000000000004")
APPROVER_ID = uuid.UUID("50000000-0000-0000-0000-000000000005")


class _Result:
    def __init__(self, *, scalar=None, row=None, rows=None):
        self.scalar = scalar
        self.row = row
        self.rows = rows or []

    def scalar_one_or_none(self):
        return self.scalar

    def one_or_none(self):
        return self.row

    def all(self):
        return self.rows


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
    def __init__(self):
        self.sent = []

    async def send_data(self, **kwargs):
        self.sent.append(kwargs)


def _fixtures(*, decision: str | None = None, canonical: bool = True):
    sender = Participant(
        id=AGENT_ID,
        keycloak_sub="brigade:the-general",
        username="the-general",
        display_name="The General",
        participant_type=ParticipantType.AGENT if canonical else ParticipantType.HUMAN,
    )
    message = Message(
        id=MESSAGE_ID,
        room_id=ROOM_ID,
        sender_id=AGENT_ID,
        sender=sender,
        content="Deploy the reviewed release",
        content_type=ContentType.AGENT_ACTION,
        metadata_={"decision": decision} if decision else {},
        is_deleted=False,
        is_edited=False,
        created_at=datetime(2026, 7, 29, tzinfo=timezone.utc),
    )
    room = Room(
        id=ROOM_ID,
        name="ops",
        display_name="Operations",
        room_type=RoomType.CHANNEL,
        livekit_room_name="stable-ops",
    )
    config = AgentConfig(
        id=CONFIG_ID,
        participant_id=AGENT_ID,
        agent_type=AgentType.CUSTOM,
        model_provider="brigade",
        model_name="canonical",
    )
    return sender, message, room, config


def _user():
    return {
        "participant_id": APPROVER_ID,
        "display_name": "Room Owner",
        "username": "owner",
    }


class ApprovalCenterTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_decision_locks_and_appends_secret_free_audit(self):
        sender, message, room, config = _fixtures()
        db = _DB(
            [
                _Result(scalar=message),
                _Result(scalar=MemberRole.OWNER),
                _Result(scalar=room),
                _Result(row=(sender, config)),
            ]
        )
        livekit = _LiveKit()

        response = await decide_action(
            MESSAGE_ID,
            DecideBody(decision="approved"),
            _user(),
            db,
            livekit,
        )

        self.assertIsNotNone(db.statements[0]._for_update_arg)
        self.assertIn("participant_type", str(db.statements[1]))
        self.assertEqual(response.metadata["decision"], "approved")
        self.assertEqual(db.commits, 1)
        self.assertEqual(len(db.added), 1)
        event = db.added[0]
        self.assertIsInstance(event, AgentEvent)
        self.assertEqual(event.event_type, "action_request.approved")
        self.assertNotIn("content", event.event_data)
        self.assertNotIn("metadata", event.event_data)
        self.assertEqual(event.event_data["approver_role"], "owner")
        self.assertEqual(len(livekit.sent), 1)

    async def test_member_is_forbidden_before_state_changes(self):
        _sender, message, _room, _config = _fixtures()
        db = _DB([_Result(scalar=message), _Result(scalar=None)])

        with self.assertRaises(HTTPException) as raised:
            await decide_action(
                MESSAGE_ID,
                DecideBody(decision="approved"),
                _user(),
                db,
                _LiveKit(),
            )

        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(db.commits, 0)
        self.assertEqual(db.added, [])

    async def test_same_decision_is_idempotent_but_conflict_is_409(self):
        for requested, expected_status in (("approved", None), ("rejected", 409)):
            sender, message, room, config = _fixtures(decision="approved")
            db = _DB(
                [
                    _Result(scalar=message),
                    _Result(scalar=MemberRole.ADMIN),
                    _Result(scalar=room),
                    _Result(row=(sender, config)),
                ]
            )
            if expected_status is None:
                response = await decide_action(
                    MESSAGE_ID,
                    DecideBody(decision=requested),
                    _user(),
                    db,
                    _LiveKit(),
                )
                self.assertEqual(response.metadata["decision"], "approved")
            else:
                with self.assertRaises(HTTPException) as raised:
                    await decide_action(
                        MESSAGE_ID,
                        DecideBody(decision=requested),
                        _user(),
                        db,
                        _LiveKit(),
                    )
                self.assertEqual(raised.exception.status_code, expected_status)
            self.assertEqual(db.commits, 0)
            self.assertEqual(db.added, [])

    async def test_noncanonical_sender_fails_closed(self):
        sender, message, room, config = _fixtures(canonical=False)
        db = _DB(
            [
                _Result(scalar=message),
                _Result(scalar=MemberRole.OWNER),
                _Result(scalar=room),
                _Result(row=(sender, config)),
            ]
        )

        with self.assertRaises(HTTPException) as raised:
            await decide_action(
                MESSAGE_ID,
                DecideBody(decision="approved"),
                _user(),
                db,
                _LiveKit(),
            )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(db.commits, 0)

    async def test_non_action_message_fails_closed(self):
        _sender, message, room, _config = _fixtures()
        message.content_type = ContentType.TEXT
        db = _DB(
            [
                _Result(scalar=message),
                _Result(scalar=MemberRole.OWNER),
                _Result(scalar=room),
            ]
        )

        with self.assertRaises(HTTPException) as raised:
            await decide_action(
                MESSAGE_ID,
                DecideBody(decision="approved"),
                _user(),
                db,
                _LiveKit(),
            )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(db.commits, 0)

    async def test_pending_list_returns_only_query_fenced_results(self):
        _sender, message, _room, _config = _fixtures()
        db = _DB([_Result(rows=[(message, "Operations")])])

        response = await list_pending_approvals(
            user=_user(),
            db=db,
            room_id=None,
            limit=50,
        )

        self.assertEqual(len(response.items), 1)
        self.assertEqual(response.items[0].room_name, "Operations")
        query = str(db.statements[0])
        self.assertIn("agent_configs", query)
        self.assertIn("room_members", query)
        self.assertIn("participant_type", query)
        self.assertIn("approval_actor", query)

    async def test_room_filtered_pending_list_requires_approver_role(self):
        db = _DB([_Result(scalar=None)])

        with self.assertRaises(HTTPException) as raised:
            await list_pending_approvals(
                user=_user(),
                db=db,
                room_id=ROOM_ID,
                limit=50,
            )

        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
