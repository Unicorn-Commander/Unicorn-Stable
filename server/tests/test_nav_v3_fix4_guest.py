"""Nav v3 fix lane 4 — what a guest can still learn (REVIEW-4.md P2-2).

The roster already hid who owns each seat. Two other things told a guest
which agents are gateway seats:

* ``availability_reason`` on the same rows (``bridge_session_active`` marks a
  live gateway seat, ``brigade_registered`` a Brigade agent);
* message metadata, on the list route and on the WebSocket echo: every
  gateway line carries ``gateway: true`` and ``agent_id``, and a JWT-path
  seat's line carries ``on_behalf_of``, a Keycloak subject.

For a GUEST caller both are gone. Members keep everything, and nothing that
is stored changes.

Every test here FAILED on e20c618 unless its docstring says it is a pin.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from app.api import messages as M
from app.api import rooms as R
from app.models.participant import ParticipantType
from app.models.room import MemberRole
from app.schemas.message import MessageResponse
from app.ws import handler as H

NOW = datetime(2026, 9, 29, 3, 0, tzinfo=timezone.utc)
GUEST = {"participant_id": uuid.uuid4(), "participant_type": "guest", "is_guest": True, "sub": "guest:abc",
         "guest_history_from": datetime(2026, 9, 1, tzinfo=timezone.utc)}
MEMBER = {"participant_id": uuid.uuid4(), "participant_type": "human", "sub": "kc-jordan"}
GATEWAY_LINE = {"agent_id": "persephone", "gateway": True, "on_behalf_of": "3f0c-kc-sub-of-a-person", "via": "mcp"}


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(), keycloak_sub=f"kc-{username}",
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None, avatar_emoji=None)


def _agent(agent_id, metadata):
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=metadata,
                           avatar_url=None, avatar_emoji=None)


class _Result:
    def __init__(self, *, rows=None):
        self._rows = list(rows or [])

    def all(self):
        return list(self._rows)


class GuestsDoNotLearnAnAgentsBackendFromTheRoster(IsolatedAsyncioTestCase):
    AVAILABILITY = {
        "persephone": ("available", "bridge_session_active"),
        "majik": ("available", "brigade_registered"),
    }

    def _rows(self):
        def membership(mode=None, depth=None):
            return SimpleNamespace(id=uuid.uuid4(), role=MemberRole.MEMBER, joined_at=NOW, last_read_at=None, is_muted=False,
                                   agent_mode=mode, context_depth=depth)
        return [
            (membership(), _human("aaron")),
            (membership("answers_all", 40), _agent("persephone", {"backend": "runner", "owner": "aaron"})),
            (membership("when_named"), _agent("majik", None)),
        ]

    async def _list(self, user):
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(rows=self._rows()), _Result(rows=[("aaron", "Aaron Stransky")])])
        presence = SimpleNamespace(get_online_in_room=AsyncMock(return_value=set()), redis=AsyncMock())
        lookup = AsyncMock(return_value=dict(self.AVAILABILITY))
        with patch("app.services.room_service.get_agent_availability", new=lookup):
            rows = await R.list_members(room_id=uuid.uuid4(), user=user, db=db, livekit=AsyncMock(), presence=presence)
        return {row.username: row for row in rows}, lookup

    async def test_a_guest_gets_no_availability_and_no_reason(self) -> None:
        by_name, lookup = await self._list(GUEST)
        for name in ("agent-persephone", "agent-majik", "aaron"):
            self.assertIsNone(by_name[name].availability, name)
            self.assertIsNone(by_name[name].availability_reason, name)
        dumped = json.dumps([row.model_dump(mode="json") for row in by_name.values()])
        for tell in ("bridge_session_active", "brigade_registered", "runner", "owner"):
            self.assertNotIn(tell, dumped)
        lookup.assert_not_awaited()                        # not even asked for
        # The seat's standing in the room stays: it is what the guest sees happen.
        self.assertEqual((by_name["agent-persephone"].agent_mode, by_name["agent-persephone"].context_depth), ("answers_all", 40))
        self.assertEqual(by_name["agent-majik"].agent_mode, "when_named")

    async def test_a_member_keeps_availability(self) -> None:
        """PIN (already true on e20c618)."""
        by_name, lookup = await self._list(MEMBER)
        self.assertEqual((by_name["agent-persephone"].availability, by_name["agent-persephone"].availability_reason),
                         ("available", "bridge_session_active"))
        self.assertEqual(by_name["agent-majik"].availability_reason, "brigade_registered")
        self.assertIsNone(by_name["aaron"].availability)
        lookup.assert_awaited_once()


def _line(metadata, sender_type="agent"):
    return MessageResponse(id=uuid.uuid4(), room_id=uuid.uuid4(), sender_id=uuid.uuid4(), sender_type=sender_type,
                           sender_name="Persephone", content="hi", content_type="text", metadata=metadata, created_at=NOW)


class GuestsDoNotLearnItFromTheFeedEither(IsolatedAsyncioTestCase):
    async def _read(self, user, stored):
        service = SimpleNamespace(get_messages=AsyncMock(return_value={
            "messages": [{"message": m, "reply_count": 0} for m in stored], "cursor": None, "has_more": False}))
        with patch.object(M, "_build_message_service", return_value=service), \
             patch.object(M, "_msg_to_response", side_effect=lambda m, _rc: m.response):
            page = await M.get_messages(room_id=uuid.uuid4(), user=user, db=AsyncMock(), livekit=AsyncMock(), cursor=None, limit=50)
        return page, service

    async def test_the_list_route_strips_the_three_keys_for_a_guest(self) -> None:
        stored = [SimpleNamespace(response=_line(dict(GATEWAY_LINE))),
                  SimpleNamespace(response=_line({"via": "voice", "client_msg_id": "c1"}, "human")),
                  SimpleNamespace(response=_line({}, "human"))]
        page, service = await self._read(GUEST, stored)
        self.assertEqual([m.metadata for m in page.messages], [{"via": "mcp"}, {"via": "voice", "client_msg_id": "c1"}, {}])
        # What was read from storage is untouched: the same objects may be on
        # their way to a member.
        self.assertEqual(stored[0].response.metadata, GATEWAY_LINE)
        # The guest's history floor still applies.
        self.assertEqual(service.get_messages.await_args.kwargs["not_before"], GUEST["guest_history_from"])

    async def test_a_member_reads_the_line_as_stored(self) -> None:
        """PIN (already true on e20c618)."""
        page, _service = await self._read(MEMBER, [SimpleNamespace(response=_line(dict(GATEWAY_LINE)))])
        self.assertEqual(page.messages[0].metadata, GATEWAY_LINE)


class _PubSub:
    """A room channel that delivers the given frames, then hangs up."""

    def __init__(self, frames):
        self.frames = [json.dumps(f).encode() for f in frames] + [json.dumps({"type": H.FORCE_DISCONNECT_EVENT}).encode()]

    async def subscribe(self, *_a):
        return None

    async def unsubscribe(self, *_a):
        return None

    async def aclose(self):
        return None

    async def get_message(self, **_kw):
        await asyncio.sleep(0)
        return {"type": "message", "data": self.frames.pop(0)}


class TheWebSocketEcho(IsolatedAsyncioTestCase):
    def _echo(self, metadata):
        line = _line(metadata).model_dump(mode="json")
        return {"type": "message", "payload": {"room_id": line["room_id"], "message": line}}

    async def _deliver(self, frames, *, guest_session_id):
        """The real forward loop, one socket, a fake Redis channel."""
        redis = MagicMock()
        redis.pubsub = MagicMock(return_value=_PubSub(frames))
        sent: list = []
        socket = MagicMock()
        socket.send_json = AsyncMock(side_effect=sent.append)
        room_id = str(uuid.uuid4())
        await H._subscribe_to_rooms(redis, [room_id], socket, str(uuid.uuid4()), {room_id}, guest_session_id)
        return [frame for frame in sent if frame.get("type") != "session_ended"]

    async def test_a_guests_socket_gets_the_line_without_the_three_keys(self) -> None:
        typing = {"type": "typing", "participant_id": "someone-else", "room_id": "r"}
        delivered = await self._deliver([self._echo(dict(GATEWAY_LINE)), typing], guest_session_id=str(uuid.uuid4()))
        self.assertEqual(delivered[0]["payload"]["message"]["metadata"], {"via": "mcp"})
        self.assertEqual(delivered[0]["payload"]["message"]["content"], "hi")
        self.assertEqual(delivered[1], typing)             # every other frame passes untouched

    async def test_a_members_socket_gets_the_line_as_published(self) -> None:
        """PIN (already true on e20c618)."""
        delivered = await self._deliver([self._echo(dict(GATEWAY_LINE))], guest_session_id=None)
        self.assertEqual(delivered[0]["payload"]["message"]["metadata"], GATEWAY_LINE)


class TheGuestView(TestCase):
    def test_it_never_mutates_what_it_is_given(self) -> None:
        from app.services import guest_view as GV

        self.assertEqual(GV.GUEST_HIDDEN_METADATA_KEYS, frozenset({"gateway", "on_behalf_of", "agent_id"}))
        stored = dict(GATEWAY_LINE)
        self.assertEqual(GV.guest_view_of_metadata(stored), {"via": "mcp"})
        self.assertEqual(stored, GATEWAY_LINE)
        clean = {"via": "voice"}
        self.assertIs(GV.guest_view_of_metadata(clean), clean)   # nothing to remove: nothing copied
        for passthrough in (None, "text", 3, []):
            self.assertEqual(GV.guest_view_of_metadata(passthrough), passthrough)
        response = _line(dict(GATEWAY_LINE))
        seen = GV.guest_view_of_message(response)
        self.assertEqual((seen.metadata, response.metadata), ({"via": "mcp"}, GATEWAY_LINE))
        envelope = {"type": "message", "payload": {"room_id": "r", "message": {"id": "m", "metadata": dict(GATEWAY_LINE)}}}
        self.assertEqual(GV.guest_view_of_envelope(envelope)["payload"]["message"], {"id": "m", "metadata": {"via": "mcp"}})
        self.assertEqual(envelope["payload"]["message"]["metadata"], GATEWAY_LINE)
        for other in ({"type": "presence", "participant_id": "p"}, {"type": "message", "payload": None}, "x", None):
            self.assertEqual(GV.guest_view_of_envelope(other), other)
