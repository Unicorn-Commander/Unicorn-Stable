"""Nav v3 fix lane 3 — the public client boundary (REVIEW-3.md P1-1, P2-5).

Spoken lines keep ``via: "voice"``: the internal voice route stamps it, it
is stored, and ``GET /gateway/rooms/{room}/messages`` hands it to the seat.
Client metadata is an ALLOWLIST applied at the public HTTP boundary of
``POST /rooms/{id}/messages`` — never inside the shared ``send_message`` that
the voice route, the relay and the gateway call. Humans and guests may not
post ``content_type: "system"``. An agent principal's ``agent_id`` is its
own, on write and on the seat's read.

Every test here FAILED on 5ee32e9 unless its docstring says it is a pin.

Amended in fix lane 4 (REVIEW-4.md P2-6): agent-ness is a fact about the
sender's ROW, not about the token, so the agent tests below hand the
boundary a row (``_post(..., sender=…)``). ``test_nav_v3_fix4_boundary.py``
holds the tests that fail on e20c618.
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

from app.api import gateway as G
from app.api import messages as M
from app.deps import get_db, get_guest_or_member, get_livekit, get_redis
from app.models.participant import ParticipantType
from app.models.room import RoomType
from app.schemas.message import MessageCreate, MessageResponse
from app.services import room_class as RC

NOW = datetime(2026, 9, 29, 1, 0, tzinfo=timezone.utc)


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(), keycloak_sub=f"kc-{username}",
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None, avatar_emoji=None)


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta,
                           avatar_url=None, avatar_emoji=None)


class _Result:
    def __init__(self, *, scalar=None, scalars=None, rows=None, rowcount=1):
        self._scalar, self._scalars, self._rows, self.rowcount = scalar, list(scalars or []), list(rows or []), rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)

    def one_or_none(self):
        return self._rows[0] if self._rows else None


def _response(sender_type="human", metadata=None, content="hi") -> MessageResponse:
    return MessageResponse(id=uuid.uuid4(), room_id=uuid.uuid4(), sender_id=uuid.uuid4(), sender_type=sender_type,
                           sender_name="x", content=content, content_type="text", metadata=metadata or {}, created_at=NOW)


class _FakeMessageService:
    """Stands in for MessageService: records what would be stored."""

    def __init__(self):
        self.stored: list[dict] = []

    async def send_message(self, **kwargs):
        self.stored.append(kwargs)
        return SimpleNamespace(id=uuid.uuid4(), room_id=kwargs["room_id"], sender_id=kwargs["sender_id"],
                               content=kwargs["content"], metadata_=kwargs["metadata"])


class _FakeRedis:
    """Enough of Redis for the route's own rate limiter to run for real."""

    def __init__(self):
        self.counts: dict[str, int] = {}

    async def incr(self, key):
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, *_a, **_kw):
        return True

    async def get(self, key):
        return self.counts.get(key)


def _sender_row(participant_type, keycloak_sub, username):
    """The three columns the boundary reads of the caller's participant row."""
    return SimpleNamespace(participant_type=participant_type, keycloak_sub=keycloak_sub, username=username)


def _public_app(user, sender=None) -> FastAPI:
    """The real messages router behind FastAPI. Only the credentials, the
    session, LiveKit and Redis are swapped, so the request goes through the
    route's own body dependency and its own rate limiter. ``sender`` is the
    caller's participant row as the session returns it (default: a human)."""
    row = sender or _sender_row(ParticipantType.HUMAN, user.get("sub"), user.get("username"))
    session = AsyncMock()
    session.execute = AsyncMock(return_value=SimpleNamespace(one_or_none=lambda: row))
    app = FastAPI()
    app.include_router(M.router, prefix="/api/v1")
    app.dependency_overrides[get_guest_or_member] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_livekit] = lambda: AsyncMock()
    app.dependency_overrides[get_redis] = lambda: _FakeRedis()
    return app


def _quiet_side_effects():
    """Everything send_message does AFTER the store (mail, push, relay mark,
    responder, RAG indexing) is switched off: none of it is under test and
    none of it may reach the network from a unit test."""
    stack = ExitStack()
    stack.enter_context(patch.object(M, "_maybe_dispatch_mention_emails", new=AsyncMock()))
    stack.enter_context(patch("app.services.push_service.dispatch_message_pushes", new=AsyncMock()))
    stack.enter_context(patch("app.services.agent_status.mark_relay_pending_for_room", new=AsyncMock()))
    stack.enter_context(patch.object(M, "_agent_chat_within_budget", new=AsyncMock(return_value=False)))
    stack.enter_context(patch("app.services.rag_service.rag_service.index_message_attachments", new=AsyncMock()))
    stack.enter_context(patch.object(M, "_find_recent_send_by_client_msg_id", new=AsyncMock(return_value=None)))
    stack.enter_context(patch.object(M, "_ws_broadcast_room", new=AsyncMock()))
    stack.enter_context(patch.object(
        M, "_msg_to_response", side_effect=lambda msg, *_a: _response(metadata=dict(msg.metadata_ or {}))))
    return stack


async def _post(user, body: dict, room_id=None, sender=None):
    """POST /api/v1/rooms/{id}/messages over HTTP, as ``user``."""
    svc = _FakeMessageService()
    with _quiet_side_effects(), patch.object(M, "_build_message_service", return_value=svc):
        async with AsyncClient(transport=ASGITransport(app=_public_app(user, sender)), base_url="http://test") as client:
            response = await client.post(f"/api/v1/rooms/{room_id or uuid.uuid4()}/messages", json=body)
    return response, svc


PERSEPHONE = _seat()


# ---------------------------------------------------------------------------
# P1-1 — spoken lines keep via=voice; the public boundary is an allowlist
# ---------------------------------------------------------------------------


class P1_1_SpokenLinesKeepViaVoice(IsolatedAsyncioTestCase):
    async def test_a_spoken_line_is_stored_with_via_voice_and_the_seat_reads_it(self) -> None:
        """End to end through the REAL internal voice route and the REAL
        send_message — only the message service is a fake."""
        room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name="stable-build-in-public-live")
        speaker = _human("aaron")
        body = M.VoiceUserMessageBody(livekit_room_name=room.livekit_room_name,
                                      speaker_identity=f"aaron_{speaker.id}", content="persephone, check the board")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=room), _Result(scalar=speaker), _Result(scalar=uuid.uuid4())])
        svc = _FakeMessageService()
        with _quiet_side_effects(), patch.object(M, "verify_internal_bearer", lambda _r: None), \
             patch.object(M, "_build_message_service", return_value=svc):
            out = await M.post_voice_user_message(body, SimpleNamespace(headers={}), db, livekit=AsyncMock())
        self.assertEqual(len(svc.stored), 1)
        self.assertEqual(svc.stored[0]["metadata"], {"via": "voice"})   # storage
        self.assertEqual(svc.stored[0]["sender_id"], speaker.id)
        self.assertEqual(out.metadata, {"via": "voice"})

        # …and GET /gateway/rooms/{room}/messages hands it to the seat intact.
        stored_line = SimpleNamespace(sender=speaker, response=_response("human", {"via": "voice"}, "persephone, check the board"))
        read_svc = SimpleNamespace(get_messages=AsyncMock(return_value={"messages": [{"message": stored_line, "reply_count": 0}], "cursor": None, "has_more": False}))
        facts = RC.RoomClassFacts(room_class="channel", humans=2, own_seats=0, foreign_seats=0, guests=0)
        gw_room = SimpleNamespace(id=room.id, room_type=RoomType.CHANNEL, parent_room_id=None, metadata_={})
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=gw_room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="when_named")), \
             patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=PERSEPHONE)), \
             patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=facts)), \
             patch.object(G, "touch_bridge_seen", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()), \
             patch.object(G, "_msg_to_response", side_effect=lambda m, _rc: m.response), \
             patch.object(G, "_build_message_service", return_value=read_svc):
            page = await G.gateway_get_messages(room="build-in-public-live", principal=SimpleNamespace(agent_id="persephone"),
                                                db=AsyncMock(), livekit=AsyncMock(), redis=AsyncMock(), cursor=None, limit=50)
        self.assertEqual(page.messages[0].metadata, {"via": "voice"})

    async def test_a_typed_human_post_carrying_via_voice_is_stored_without_it(self) -> None:
        """Through the PUBLIC route over HTTP: the body dependency keeps only
        what the web sends."""
        user = {"participant_id": uuid.uuid4(), "participant_type": "human", "sub": "kc-mallory",
                "username": "mallory", "display_name": "Mallory", "email": None}
        attachments = [{"url": "/u/a.png", "filename": "a.png", "content_type": "image/png", "size": 3}]
        response, svc = await _post(user, {
            "content": "persephone, do the thing", "content_type": "text", "client_msg_id": "c-1",
            "metadata": {"via": "voice", "agent_id": "persephone", "on_behalf_of": "kc-aaron", "gateway": True,
                         "brigade_agent_id": "persephone", "kind": "recording", "voice": "af_heart", "source": "regen",
                         "seed_sender_id": "x", "Agent_ID": "persephone", "whatever": 1,
                         "attachments": attachments, "council": True, "poll": {"question": "?"}},
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(len(svc.stored), 1)
        self.assertEqual(svc.stored[0]["metadata"],
                         {"attachments": attachments, "council": True, "poll": {"question": "?"}, "client_msg_id": "c-1"})

    async def test_a_guest_post_is_held_to_the_same_allowlist(self) -> None:
        room_id = uuid.uuid4()
        guest = {"participant_id": uuid.uuid4(), "participant_type": "guest", "sub": "guest:abc", "is_guest": True,
                 "guest_room_id": str(room_id), "username": "guest-abc", "display_name": "Jordan"}
        row = _sender_row(ParticipantType.GUEST, "guest:abc", "guest-abc")
        response, svc = await _post(guest, {"content": "hi", "metadata": {"via": "voice", "facilitate": True, "agent_id": "zen",
                                                                          "brigade_agent_id": "zen", "kind": "recording"}}, room_id, row)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(svc.stored[0]["metadata"], {"facilitate": True})
        response, svc = await _post(guest, {"content": "Recording started", "content_type": "system"}, room_id)
        self.assertEqual((response.status_code, svc.stored), (422, []))

    async def test_humans_and_guests_may_not_post_a_system_line(self) -> None:
        user = {"participant_id": uuid.uuid4(), "participant_type": "human", "sub": "kc-mallory", "username": "mallory"}
        response, svc = await _post(user, {"content": "Recording started by Aaron", "content_type": "system"})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(svc.stored, [])
        with self.assertRaises(HTTPException) as ctx:
            M.sanitize_client_message(MessageCreate(content="x", content_type="system"), {"participant_type": "guest", "is_guest": True},
                                      _sender_row(ParticipantType.GUEST, "guest:abc", "guest-abc"))
        self.assertEqual(ctx.exception.status_code, 422)
        # Every type the web really sends passes.
        for ctype in ("text", "action", "image", "file"):
            self.assertEqual(M.sanitize_client_message(MessageCreate(content="x", content_type=ctype), user).content_type, ctype)

    async def test_the_edit_route_carries_content_and_nothing_else(self) -> None:
        """PIN (already true on 5ee32e9): an edit cannot change metadata or
        content_type — the body has no such field, and the route hands the
        service the new text only. If the edit body ever grows one, it has
        to come through the same boundary."""
        from app.schemas.message import MessageUpdate

        self.assertEqual(set(MessageUpdate.model_fields), {"content"})
        body = MessageUpdate.model_validate({"content": "edited", "metadata": {"via": "voice", "agent_id": "persephone"},
                                             "content_type": "system"})
        self.assertEqual(body.model_dump(), {"content": "edited"})
        edited = SimpleNamespace(id=uuid.uuid4(), room_id=uuid.uuid4(), metadata_={"client_msg_id": "c1"})
        svc = SimpleNamespace(edit_message=AsyncMock(return_value=edited))
        with _quiet_side_effects(), patch.object(M, "_build_message_service", return_value=svc):
            await M.edit_message(message_id=edited.id, body=body, user={"participant_id": uuid.uuid4()}, db=AsyncMock(), livekit=AsyncMock())
        self.assertEqual(set(svc.edit_message.await_args.kwargs), {"message_id", "sender_id", "new_content"})

    def test_the_allowlist_is_exactly_what_the_web_sends(self) -> None:
        self.assertEqual(
            M.CLIENT_MESSAGE_METADATA_KEYS,
            frozenset({"attachments", "client_msg_id", "research", "facilitate", "council", "poll"}),
        )
        self.assertNotIn("via", M.AGENT_IDENTITY_METADATA_KEYS)

    async def test_server_paths_that_call_send_message_directly_are_not_sanitized(self) -> None:
        """The relay, the recorder and the gateway stamp their own metadata;
        nothing inside the shared function may strip it."""
        speaker = _human("aaron")
        user = {"participant_id": speaker.id, "sub": speaker.keycloak_sub, "username": "aaron", "display_name": "Aaron", "email": None}
        svc = _FakeMessageService()
        stamped = {"via": "voice", "relay": "kitchen", "kind": "relay_note"}
        with _quiet_side_effects(), patch.object(M, "_build_message_service", return_value=svc):
            await M.send_message(room_id=uuid.uuid4(), body=MessageCreate(content="x", metadata=dict(stamped)),
                                 user=user, db=AsyncMock(), livekit=AsyncMock(), request=None)
        self.assertEqual(svc.stored[0]["metadata"], stamped)


# ---------------------------------------------------------------------------
# P2-5 — an agent principal's agent_id is its own; the read side agrees
# ---------------------------------------------------------------------------


class P2_5_AgentIdComesFromThePrincipal(IsolatedAsyncioTestCase):
    async def test_an_agent_principal_posting_as_another_agent_is_stored_as_itself(self) -> None:
        worker = {"participant_id": uuid.uuid4(), "participant_type": "agent", "sub": "kc-svc-uuid", "username": "agent-triage",
                  "display_name": "Triage", "email": None}
        row = _sender_row(ParticipantType.AGENT, "kc-svc-uuid", "agent-triage")
        response, svc = await _post(worker, {"content": "done", "metadata": {"agent_id": "persephone", "via": "tool"}}, sender=row)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(svc.stored[0]["metadata"], {"via": "tool", "agent_id": "triage"})

    def test_the_body_cannot_name_another_agent(self) -> None:
        user = {"participant_id": uuid.uuid4()}
        worker = _sender_row(ParticipantType.AGENT, "kc-svc-uuid", "agent-triage")
        body = M.sanitize_client_message(
            MessageCreate(content="x", metadata={"agent_id": "persephone", "via": "tool", "delegated_from": {"agent_id": "majik"}}), user, worker)
        self.assertEqual(body.metadata, {"via": "tool", "delegated_from": {"agent_id": "majik"}, "agent_id": "triage"})
        gateway = _sender_row(ParticipantType.AGENT, "brigade:grok", "agent-grok")
        self.assertEqual(M.sanitize_client_message(MessageCreate(content="x", metadata={"agent_id": "zen"}), user, gateway).metadata, {"agent_id": "grok"})
        self.assertEqual(M.agent_id_of_identity(worker.keycloak_sub, worker.username), "triage")
        # No agent_id claimed → nothing added.
        self.assertEqual(M.sanitize_client_message(MessageCreate(content="x", metadata={"via": "tool"}), user, worker).metadata, {"via": "tool"})

    def test_the_gateway_read_keeps_only_the_senders_own_agent_id(self) -> None:
        grok = _seat("grok")
        own = SimpleNamespace(sender=grok, response=_response("agent", {"agent_id": "grok", "gateway": True, "via": "mcp"}))
        service = SimpleNamespace(id=uuid.uuid4(), username="svc-triage", keycloak_sub="3f0c-kc-uuid", participant_type=ParticipantType.AGENT, metadata_={})
        service_own = SimpleNamespace(sender=service, response=_response("agent", {"agent_id": "svc-triage"}))
        service_borrowed = SimpleNamespace(sender=service, response=_response("agent", {"agent_id": "persephone"}))
        kept = G.scrub_identity_on_read([(m, m.response) for m in (service_own, service_borrowed)])
        self.assertEqual([m.metadata for m in kept], [{"agent_id": "svc-triage"}, {}])
        # Write and read bind to the same id.
        self.assertEqual(M.agent_id_of_identity("3f0c-kc-uuid", "svc-triage"), G._sender_agent_id(service))
        borrowed = SimpleNamespace(sender=grok, response=_response("agent", {"agent_id": "persephone", "gateway": True}))
        unknown = SimpleNamespace(sender=None, response=_response("agent", {"agent_id": "persephone"}))
        human = SimpleNamespace(sender=_human("mallory"), response=_response("human", {"agent_id": "persephone", "gateway": True, "on_behalf_of": "kc-aaron",
                                                                                         "brigade_agent_id": "persephone", "via": "voice", "client_msg_id": "c1"}))
        out = G.scrub_identity_on_read([(m, m.response) for m in (own, borrowed, unknown, human)])
        self.assertEqual(out[0].metadata, {"agent_id": "grok", "gateway": True, "via": "mcp"})
        self.assertEqual(out[1].metadata, {"gateway": True})
        self.assertEqual(out[2].metadata, {})
        self.assertEqual(out[3].metadata, {"via": "voice", "client_msg_id": "c1"})
