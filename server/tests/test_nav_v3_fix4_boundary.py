"""Nav v3 fix lane 4 — who is an agent at the public boundary
(REVIEW-4.md P2-6).

e20c618 took "agent" from the token: ``participant_type`` there comes from
the ``azp`` claim ending ``-agent`` or the ``agent-service`` role. A human's
row signed in through such a client was an "agent principal" and kept every
metadata key. And a real agent kept everything except ``agent_id``:
``brigade_agent_id`` (the web's read-aloud picks its voice from it),
``on_behalf_of``, ``gateway``, ``kind``, ``source`` — and could post
``content_type: system``.

Now agent-ness is read from the SENDER'S ROW (``participants
.participant_type``). An agent row has ``agent_id`` bound from the row and
loses those five keys; ``system`` is refused for everybody.

Every test here FAILED on e20c618 unless its docstring says it is a pin.
"""

from __future__ import annotations

import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects import postgresql

from app.api import messages as M
from app.deps import get_db, get_guest_or_member, get_livekit, get_redis
from app.models.participant import ParticipantType
from app.schemas.message import MessageCreate, MessageResponse

NOW = datetime(2026, 9, 29, 3, 0, tzinfo=timezone.utc)

#: A token that SAYS agent: azp ends "-agent", so keycloak.py types it so.
AGENT_TOKEN = {"participant_id": uuid.uuid4(), "participant_type": "agent", "sub": "kc-svc-uuid",
               "username": "agent-persephone", "display_name": "Looks like Persephone", "email": None}


def _row(participant_type, keycloak_sub, username):
    return SimpleNamespace(participant_type=participant_type, keycloak_sub=keycloak_sub, username=username)


class _Stored:
    def __init__(self):
        self.lines: list[dict] = []

    async def send_message(self, **kwargs):
        self.lines.append(kwargs)
        return SimpleNamespace(id=uuid.uuid4(), room_id=kwargs["room_id"], sender_id=kwargs["sender_id"],
                               content=kwargs["content"], metadata_=kwargs["metadata"])


class _Redis:
    async def incr(self, _key):
        return 1

    async def expire(self, *_a, **_kw):
        return True

    async def get(self, _key):
        return None


def _shown(message, *_a):
    return MessageResponse(id=message.id, room_id=message.room_id, sender_id=message.sender_id, sender_type="agent",
                           sender_name="x", content=message.content, content_type="text",
                           metadata=dict(message.metadata_ or {}), created_at=NOW)


async def _post(user, sender, body):
    """POST /api/v1/rooms/{id}/messages over HTTP: the real router, the real
    body dependency, the real rate limiter. ``sender`` is what the session
    returns for the caller's participant row."""
    session = AsyncMock()
    session.execute = AsyncMock(return_value=SimpleNamespace(one_or_none=lambda: sender))
    app = FastAPI()
    app.include_router(M.router, prefix="/api/v1")
    app.dependency_overrides[get_guest_or_member] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_livekit] = lambda: AsyncMock()
    app.dependency_overrides[get_redis] = lambda: _Redis()
    stored = _Stored()
    with ExitStack() as stack:
        stack.enter_context(patch.object(M, "_build_message_service", return_value=stored))
        stack.enter_context(patch.object(M, "_msg_to_response", side_effect=_shown))
        for name in ("_maybe_dispatch_mention_emails", "_ws_broadcast_room", "_find_recent_send_by_client_msg_id"):
            stack.enter_context(patch.object(M, name, new=AsyncMock(return_value=None)))
        stack.enter_context(patch.object(M, "_agent_chat_within_budget", new=AsyncMock(return_value=False)))
        stack.enter_context(patch("app.services.push_service.dispatch_message_pushes", new=AsyncMock()))
        stack.enter_context(patch("app.services.agent_status.mark_relay_pending_for_room", new=AsyncMock()))
        stack.enter_context(patch("app.services.rag_service.rag_service.index_message_attachments", new=AsyncMock()))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(f"/api/v1/rooms/{uuid.uuid4()}/messages", json=body)
    return response, stored, session


EVERYTHING = {"agent_id": "persephone", "brigade_agent_id": "persephone", "on_behalf_of": "kc-aaron", "gateway": True,
              "kind": "recording", "source": "regen", "via": "tool", "delegated_from": {"agent_id": "majik"},
              "attachments": [{"id": "a1"}]}


class P2_6_AgentNessComesFromTheRow(IsolatedAsyncioTestCase):
    async def test_a_humans_row_behind_an_agent_token_is_held_to_the_humans_rule(self) -> None:
        human_row = _row(ParticipantType.HUMAN, "kc-mallory", "mallory")
        response, stored, _session = await _post(AGENT_TOKEN, human_row, {"content": "do the thing", "metadata": dict(EVERYTHING)})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(stored.lines[0]["metadata"], {"attachments": [{"id": "a1"}]})

    async def test_a_guests_row_and_a_missing_row_are_held_to_it_too(self) -> None:
        for row in (_row(ParticipantType.GUEST, "guest:abc", "guest-abc"), None):
            response, stored, _session = await _post(AGENT_TOKEN, row, {"content": "x", "metadata": dict(EVERYTHING)})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(stored.lines[0]["metadata"], {"attachments": [{"id": "a1"}]})

    async def test_an_agents_row_loses_the_five_keys_and_is_bound_to_itself(self) -> None:
        # The TOKEN says "agent-persephone"; the ROW is the triage agent's.
        agent_row = _row(ParticipantType.AGENT, "kc-svc-uuid", "agent-triage")
        response, stored, _session = await _post(AGENT_TOKEN, agent_row, {"content": "done", "metadata": dict(EVERYTHING)})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(stored.lines[0]["metadata"], {
            "agent_id": "triage",                          # from the row, not from the body or the token
            "via": "tool", "delegated_from": {"agent_id": "majik"}, "attachments": [{"id": "a1"}],
        })
        self.assertEqual(M.AGENT_BODY_DROPPED_KEYS, frozenset({"brigade_agent_id", "on_behalf_of", "gateway", "kind", "source"}))

    async def test_a_token_that_says_human_with_an_agents_row_is_an_agent(self) -> None:
        user = {**AGENT_TOKEN, "participant_type": "human", "username": "mallory"}
        agent_row = _row(ParticipantType.AGENT, "brigade:grok", "agent-grok")
        response, stored, _session = await _post(user, agent_row, {"content": "x", "metadata": {"agent_id": "zen", "gateway": True, "note": 1}})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(stored.lines[0]["metadata"], {"note": 1, "agent_id": "grok"})

    async def test_nobody_posts_a_system_line_through_the_public_route(self) -> None:
        agent_row = _row(ParticipantType.AGENT, "kc-svc-uuid", "agent-triage")
        response, stored, session = await _post(AGENT_TOKEN, agent_row, {"content": "Audio recording started", "content_type": "system",
                                                                         "metadata": {"kind": "recording"}})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(stored.lines, [])
        session.execute.assert_not_awaited()               # refused before anything is read
        with self.assertRaises(HTTPException) as ctx:
            M.sanitize_client_message(MessageCreate(content="x", content_type="system"), AGENT_TOKEN, agent_row)
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_a_plain_message_costs_no_lookup(self) -> None:
        """PIN (true on e20c618, which looked nothing up): the row is read
        only when there is metadata to judge."""
        agent_row = _row(ParticipantType.AGENT, "kc-svc-uuid", "agent-triage")
        for body in ({"content": "hello"}, {"content": "hello", "metadata": {}}, {"content": "hello", "metadata": None}):
            response, stored, session = await _post(AGENT_TOKEN, agent_row, body)
            self.assertEqual(response.status_code, 201, response.text)
            session.execute.assert_not_awaited()
            self.assertFalse(stored.lines[0]["metadata"])

    async def test_the_lookup_reads_the_callers_own_row(self) -> None:
        session = AsyncMock()
        row = _row(ParticipantType.AGENT, "brigade:grok", "agent-grok")
        session.execute = AsyncMock(return_value=SimpleNamespace(one_or_none=lambda: row))
        self.assertIs(await M.load_sender_row(session, AGENT_TOKEN["participant_id"]), row)
        statement = session.execute.await_args.args[0]
        sql = " ".join(str(statement.compile(dialect=postgresql.dialect())).lower().split())
        self.assertIn("participants.participant_type, participants.keycloak_sub, participants.username", sql)
        self.assertIn("where participants.id =", sql)
        self.assertIn(AGENT_TOKEN["participant_id"], list(statement.compile(dialect=postgresql.dialect()).params.values()))
        self.assertIsNone(await M.load_sender_row(AsyncMock(), None))

    def test_agent_ness_is_the_rows_type_and_nothing_else(self) -> None:
        self.assertTrue(M.sender_is_agent(_row(ParticipantType.AGENT, "x", "y")))
        self.assertTrue(M.sender_is_agent(_row("agent", "x", "y")))
        for row in (_row(ParticipantType.HUMAN, "brigade:persephone", "agent-persephone"),
                    _row(ParticipantType.GUEST, "brigade:persephone", "agent-persephone"),
                    _row(None, "brigade:persephone", "agent-persephone"), None):
            self.assertFalse(M.sender_is_agent(row))
        self.assertFalse(hasattr(M, "_principal_is_agent"))
