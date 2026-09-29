"""Nav v3 fix lane 2 — surfaces (REVIEW-2.md P2-4..9, P2-12, P2-16, P2-17 and
the queued cross-lane items a–d).

Members rows carry mode / depth and a guest-safe metadata subset; crew rows
carry last_seen_at; gateway rows carry last_message_at; human posts cannot
forge agent metadata; the rooms list applies the owner-present rule to every
key kind; R5 matches the caller's DB username and covers agent principals
and the facilitator; mint takes an owner and caps the id. Every test here
FAILED on 45bfb7f.

Amended in fix lane 3 (REVIEW-3.md P1-1, P2-3, P2-5): ``via`` is NOT a
forgeable identity key (spoken lines carry ``via: "voice"`` and must keep it);
client metadata is an allowlist applied at the public HTTP boundary, not
inside the shared ``send_message``; ``last_message_at`` rides the rooms select
as a per-room top-1. ``test_nav_v3_fix3.py`` holds the tests that fail on
5ee32e9.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.api import gateway as G
from app.models.participant import ParticipantType
from app.models.room import MemberRole, RoomType
from app.services import crew as C
from app.services import room_class as RC

NOW = datetime(2026, 9, 28, 23, 0, tzinfo=timezone.utc)
HUB = RoomType.AGENT_HUB


def _human(username="aaron", display=None):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=display or username.title(),
                           participant_type=ParticipantType.HUMAN, metadata_={}, keycloak_sub=f"kc-{username}", avatar_url=None, avatar_emoji=None)


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta,
                           avatar_url=None, avatar_emoji=None)


def _brigade(agent_id="majik", metadata=None):
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=metadata,
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


# ---------------------------------------------------------------------------
# (a) members rows
# ---------------------------------------------------------------------------


class MembersCarryModeDepthAndASafeSubset(IsolatedAsyncioTestCase):
    async def test_get_members_shape(self) -> None:
        from app.services.room_service import RoomService

        aaron, persephone, majik = _human("aaron", "Aaron Stransky"), _seat(), _brigade()
        rows = [
            (SimpleNamespace(id=uuid.uuid4(), role=MemberRole.OWNER, joined_at=NOW, last_read_at=None, is_muted=False, agent_mode=None, context_depth=None), aaron),
            (SimpleNamespace(id=uuid.uuid4(), role=MemberRole.MEMBER, joined_at=NOW, last_read_at=None, is_muted=False, agent_mode="answers_all", context_depth=80), persephone),
            (SimpleNamespace(id=uuid.uuid4(), role=MemberRole.MEMBER, joined_at=NOW, last_read_at=None, is_muted=False, agent_mode="when_named", context_depth=None), majik),
        ]
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(rows=rows), _Result(rows=[("aaron", "Aaron Stransky")])])
        presence = SimpleNamespace(get_online_in_room=AsyncMock(return_value=set()), redis=AsyncMock())
        svc = RoomService(db=db, livekit=AsyncMock(), presence=presence)
        with patch("app.services.room_service.get_agent_availability", new=AsyncMock(return_value={})):
            members = await svc.get_members(uuid.uuid4(), caller_id=aaron.id)
        by_name = {m["username"]: m for m in members}
        self.assertIsNone(by_name["aaron"]["metadata"])
        self.assertIsNone(by_name["aaron"]["agent_mode"])
        seat = by_name["agent-persephone"]
        self.assertEqual((seat["agent_mode"], seat["context_depth"]), ("answers_all", 80))
        self.assertEqual(seat["metadata"], {"kind": None, "backend": "runner", "owner": "aaron", "owner_display_name": "Aaron Stransky"})
        self.assertEqual(set(seat["metadata"]), {"kind", "backend", "owner", "owner_display_name"})  # and nothing else
        house = by_name["agent-majik"]
        self.assertEqual(house["metadata"], {"kind": None, "backend": None, "owner": None, "owner_display_name": None})
        self.assertEqual(house["agent_mode"], "when_named")

    def test_response_model_carries_the_fields(self) -> None:
        from app.api.rooms import _member_to_response

        resp = _member_to_response({
            "id": uuid.uuid4(), "participant_id": uuid.uuid4(), "username": "agent-persephone", "display_name": "Persephone",
            "participant_type": "agent", "role": "member", "joined_at": NOW, "last_read_at": None, "is_muted": False,
            "status": "offline", "agent_mode": "answers_all", "context_depth": 40,
            "metadata": {"kind": None, "backend": "runner", "owner": "aaron", "owner_display_name": "Aaron", "seat_capabilities": {"x": 1}},
        })
        dumped = resp.model_dump()
        self.assertEqual((dumped["agent_mode"], dumped["context_depth"]), ("answers_all", 40))
        self.assertEqual(dumped["metadata"]["owner"], "aaron")


# ---------------------------------------------------------------------------
# (b) crew last_seen_at, (P2-4) the hub is for THIS agent
# ---------------------------------------------------------------------------


def _hub(human_id, agent_id="persephone", parent=None):
    return SimpleNamespace(id=uuid.uuid4(), room_type=HUB, parent_room_id=parent,
                           metadata_={"agent_hub": {"human_id": str(human_id), "agent_id": agent_id}})


def _crew(*, rows=(), seats=(), live=("persephone", "flow"), caller="aaron", caller_id=None, fresh=None, last_seen=None):
    return C.rank_crew(
        C.assemble_crew(
            now=NOW, caller_id=caller_id, caller_username=caller, runner_seats=list(seats),
            all_key_agent_ids=set(live), live_key_agent_ids=set(live), shared_rows=list(rows),
            last_messages={}, unread_by_room={}, events=[], gateway_fresh=fresh, gateway_last_seen=last_seen,
        ),
        NOW,
    )


class CrewLastSeenAndHubForThisAgent(IsolatedAsyncioTestCase):
    def test_last_seen_at_rides_on_seats_only(self) -> None:
        persephone, majik = _seat(), _brigade()
        me = uuid.uuid4()
        crew = _crew(seats=[persephone], rows=[(majik, SimpleNamespace(agent_mode=None), _hub(me, "majik"))], caller_id=me,
                     fresh={"persephone"}, last_seen={"persephone": NOW, "majik": NOW})
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["persephone"].last_seen_at, NOW)
        self.assertIsNone(by_id["majik"].last_seen_at)
        from app.api.crew import crew_row

        self.assertEqual(crew_row(by_id["persephone"]).model_dump()["last_seen_at"], NOW)

    def test_another_agent_sitting_in_the_hub_does_not_get_it(self) -> None:
        persephone, majik = _seat(), _brigade()
        me = uuid.uuid4()
        hub = _hub(me, "persephone")
        crew = _crew(seats=[persephone], rows=[(persephone, SimpleNamespace(agent_mode="answers_all"), hub), (majik, SimpleNamespace(agent_mode=None), hub)], caller_id=me)
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["persephone"].hub_room_id, str(hub.id))
        self.assertIsNone(by_id["majik"].hub_room_id)
        self.assertTrue(C.is_caller_hub(hub, me, "persephone"))
        self.assertFalse(C.is_caller_hub(hub, me, "majik"))

    async def test_last_seen_is_stored_beside_the_marker_and_read_back(self) -> None:
        from app.services import agent_availability as AV

        redis = AsyncMock()
        await AV.touch_gateway_agent(redis, "persephone")
        keys = [c.args[0] for c in redis.set.await_args_list]
        self.assertIn("stable:gwfresh:persephone", keys)
        self.assertIn("stable:gwlast:persephone", keys)
        last_call = [c for c in redis.set.await_args_list if c.args[0] == "stable:gwlast:persephone"][0]
        self.assertGreaterEqual(last_call.kwargs["ex"], 30 * 24 * 3600)
        redis.mget = AsyncMock(return_value=[b"1790000000", None])
        seen = await AV.get_gateway_last_seen(redis, ["persephone", "grok"])
        self.assertEqual(list(seen), ["persephone"])
        self.assertEqual(seen["persephone"].tzinfo, timezone.utc)

    async def test_build_crew_never_uses_the_tokens_username(self) -> None:
        from app.api import crew as crew_api

        with patch.object(crew_api, "build_crew", new=AsyncMock(return_value=[])) as build, \
             patch.object(crew_api, "load_brigade_role_lines", new=AsyncMock(return_value={})):
            await crew_api.list_crew(user={"participant_id": uuid.uuid4(), "username": "aaron-from-token"}, db=AsyncMock(), redis=AsyncMock())
        self.assertNotIn("caller_username", build.await_args.kwargs)


# ---------------------------------------------------------------------------
# (c) gateway rows: last_message_at; (P2-6) owner-present for every key kind
# ---------------------------------------------------------------------------


class GatewayRowsLastMessageAndOwnerRule(IsolatedAsyncioTestCase):
    def test_row_carries_last_message_at(self) -> None:
        aaron, persephone = _human(), _seat()
        room = RC.RoomLite(id=uuid.uuid4(), name="hub-1", livekit_room_name="stable-hub-1", display_name="P", room_type=HUB,
                           metadata_={}, updated_at=NOW, members=[SimpleNamespace(participant=aaron, participant_id=aaron.id, agent_mode=None),
                                                                  SimpleNamespace(participant=persephone, participant_id=persephone.id, agent_mode="answers_all")])
        facts = RC.room_class_for(room, asking_seat=persephone)
        row = G.seat_room_row(room, persephone.id, facts, "persephone", NOW).model_dump(mode="json")
        self.assertEqual(row["last_message_at"], NOW.isoformat().replace("+00:00", "Z"))
        self.assertIsNone(G.seat_room_row(room, persephone.id, facts, "persephone").last_message_at)

    def test_last_message_at_rides_the_rooms_select(self) -> None:
        from sqlalchemy.dialects import postgresql

        sql = str(G.seat_rooms_statement(uuid.uuid4()).compile(dialect=postgresql.dialect())).lower()
        self.assertIn("order by messages.created_at desc", sql)   # per-room top-1 (REVIEW-3 P2-3)
        self.assertNotIn("max(messages.created_at)", sql)
        self.assertNotIn("group by", sql)

    async def test_star_and_name_scoped_keys_also_need_the_owner_present(self) -> None:
        seat = _seat()
        a = RC.RoomLite(id=uuid.uuid4(), name="hub-1", livekit_room_name="stable-hub-1")
        b = RC.RoomLite(id=uuid.uuid4(), name="mallory-room", livekit_room_name="stable-mallory-room")
        for allowed in (["*"], ["hub-1", "mallory-room"], ["@member"]):
            db = AsyncMock()
            db.execute = AsyncMock(return_value=_Result(scalars=[a.id]))  # owner present in a only
            kept = await G._scope_filter_rooms(db, SimpleNamespace(allowed_rooms=allowed, human_sub=None), seat, [a, b])
            self.assertEqual([r.name for r in kept], ["hub-1"], allowed)
            db.execute.assert_awaited_once()
        # A name-scoped key still lists only its names, even where the owner is present.
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalars=[a.id, b.id]))
        kept = await G._scope_filter_rooms(db, SimpleNamespace(allowed_rooms=["hub-1"], human_sub=None), seat, [a, b])
        self.assertEqual([r.name for r in kept], ["hub-1"])


# ---------------------------------------------------------------------------
# (d) forged agent metadata on human posts
# ---------------------------------------------------------------------------


class HumanPostsCannotForgeAgentMetadata(IsolatedAsyncioTestCase):
    def test_boundary_rule(self) -> None:
        from app.api.messages import sanitize_client_message
        from app.schemas.message import MessageCreate

        human = {"participant_id": uuid.uuid4(), "participant_type": "human", "sub": "kc-mallory", "username": "mallory"}
        guest = {"participant_id": uuid.uuid4(), "participant_type": "guest", "sub": "guest:abc", "username": "guest-abc", "is_guest": True}
        gateway = {"participant_id": uuid.uuid4(), "sub": "brigade:persephone", "username": "agent-persephone"}
        worker = {"participant_id": uuid.uuid4(), "participant_type": "agent", "sub": "svc", "username": "agent-triage"}
        forged = {"agent_id": "persephone", "gateway": True, "on_behalf_of": "kc-aaron", "via": "mcp",
                  "client_msg_id": "c1", "attachments": [{"id": "a1"}]}

        def clean(user, metadata=forged):
            body = MessageCreate(content="x", metadata=None if metadata is None else dict(metadata))
            return sanitize_client_message(body, user).metadata

        for user in (human, guest):
            self.assertEqual(clean(user), {"client_msg_id": "c1", "attachments": [{"id": "a1"}]})
        self.assertEqual(clean(gateway), forged)                                  # its own id: untouched
        self.assertEqual(clean(worker), {**forged, "agent_id": "triage"})         # never another agent's (P2-5)
        self.assertIsNone(clean(human, None))

    async def test_a_forged_agent_id_never_reaches_storage(self) -> None:
        from app.api import messages as M
        from app.schemas.message import MessageCreate

        stored = SimpleNamespace(id=uuid.uuid4(), room_id=uuid.uuid4(), sender_id=uuid.uuid4(), content="hi", content_type="text",
                                 metadata_={}, parent_id=None, is_edited=False, edited_at=None, is_deleted=False, created_at=NOW, sender=None)
        svc = SimpleNamespace(send_message=AsyncMock(return_value=stored))
        user = {"participant_id": stored.sender_id, "participant_type": "human", "sub": "kc-mallory", "username": "mallory", "display_name": "Mallory", "email": None}
        raw = MessageCreate(content="hi", content_type="text", metadata={"agent_id": "persephone", "gateway": True, "via": "mcp", "client_msg_id": "c9"})
        # What FastAPI does for the public route: the body dependency, then the handler.
        body = await M.client_message_body(raw, user)
        from app.schemas.message import MessageResponse

        shown = MessageResponse(id=stored.id, room_id=stored.room_id, sender_id=stored.sender_id, sender_type="human",
                                sender_name="Mallory", content="hi", content_type="text", metadata={}, created_at=NOW)
        with patch.object(M, "_build_message_service", return_value=svc), \
             patch.object(M, "_find_recent_send_by_client_msg_id", new=AsyncMock(return_value=None)), \
             patch.object(M, "_msg_to_response", return_value=shown), \
             patch.object(M, "_maybe_dispatch_mention_emails", new=AsyncMock()), \
             patch.object(M, "_ws_broadcast_room", new=AsyncMock()), \
             patch("app.services.push_service.dispatch_message_pushes", new=AsyncMock(), create=True):
            await M.send_message(room_id=stored.room_id, body=body, user=user, db=AsyncMock(), livekit=AsyncMock(), request=None)
        svc.send_message.assert_awaited_once()
        metadata = svc.send_message.await_args.kwargs["metadata"]
        self.assertEqual(metadata, {"client_msg_id": "c9"})

    async def test_a_forged_row_already_stored_never_reaches_the_gateway_read(self) -> None:
        from app.schemas.message import MessageResponse

        def line(sender, sender_type, metadata):
            response = MessageResponse(
                id=uuid.uuid4(), room_id=uuid.uuid4(), sender_id=uuid.uuid4(), sender_type=sender_type,
                sender_name="x", content="hi", content_type="text", metadata=metadata, created_at=NOW,
            )
            return SimpleNamespace(sender=sender, response=response)

        forged = {"agent_id": "persephone", "gateway": True, "on_behalf_of": "kc-aaron", "via": "mcp", "client_msg_id": "c1"}
        guest = SimpleNamespace(id=uuid.uuid4(), username="guest-1", keycloak_sub="guest:1", participant_type=ParticipantType.GUEST, metadata_={})
        human_line = line(_human("mallory"), "human", dict(forged))
        guest_line = line(guest, "guest", dict(forged))
        agent_line = line(_seat(), "agent", dict(forged))
        borrowed = line(_seat("grok"), "agent", dict(forged))        # another agent's id on an agent's line
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, parent_room_id=None, metadata_={})
        facts = RC.RoomClassFacts(room_class="shared", humans=2, own_seats=0, foreign_seats=0, guests=1)
        items = [{"message": m, "reply_count": 0} for m in (human_line, guest_line, agent_line, borrowed)]
        svc = SimpleNamespace(get_messages=AsyncMock(return_value={"messages": items, "cursor": None, "has_more": False}))
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")), \
             patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=_seat())), \
             patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=facts)), \
             patch.object(G, "touch_bridge_seen", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()), \
             patch.object(G, "_msg_to_response", side_effect=lambda m, _rc: m.response), \
             patch.object(G, "_build_message_service", return_value=svc):
            out = await G.gateway_get_messages(room="hub", principal=SimpleNamespace(agent_id="persephone"), db=AsyncMock(), livekit=AsyncMock(), redis=AsyncMock(), cursor=None, limit=50)
        # `via` is how the line arrived, not who wrote it: it stays.
        self.assertEqual(out.messages[0].metadata, {"via": "mcp", "client_msg_id": "c1"})
        self.assertEqual(out.messages[1].metadata, {"via": "mcp", "client_msg_id": "c1"})
        self.assertEqual(out.messages[2].metadata, forged)  # the agent's own line keeps its stamps
        self.assertEqual(out.messages[3].metadata, {k: v for k, v in forged.items() if k != "agent_id"})


# ---------------------------------------------------------------------------
# (P2-7/8) R5 by DB username, agent principals, the facilitator
# ---------------------------------------------------------------------------


class R5MatchesTheDbUsernameAndCoversEveryPrincipal(IsolatedAsyncioTestCase):
    async def test_token_name_is_ignored_db_username_decides(self) -> None:
        from app.services import agent_access as AA

        pid = uuid.uuid4()
        # Token says "aaron", the participants row says "aaron.s": refused.
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar={"backend": "runner", "owner": "aaron"}), _Result(scalar="aaron.s")])
        with patch.object(AA, "resolve_agent_access", new=AsyncMock(return_value=(True, "default_open"))):
            with self.assertRaises(HTTPException) as ctx:
                await AA.ensure_agent_access(db, {"participant_id": pid, "username": "aaron", "participant_type": "human"}, "persephone", surface="agent_hub")
        self.assertEqual(ctx.exception.status_code, 403)
        # Token says something else, the row says the owner: allowed.
        db.execute = AsyncMock(side_effect=[_Result(scalar={"backend": "runner", "owner": "aaron"}), _Result(scalar="Aaron")])
        with patch.object(AA, "resolve_agent_access", new=AsyncMock(return_value=(True, "default_open"))):
            await AA.ensure_agent_access(db, {"participant_id": pid, "username": "someone-else", "participant_type": "human"}, "persephone", surface="agent_hub")

    async def test_agent_typed_principals_go_through_r5(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar={"backend": "runner", "owner": "aaron"}), _Result(scalar="stable-agents-worker")])
        with self.assertRaises(HTTPException) as ctx:
            await AA.ensure_agent_access(db, {"participant_id": uuid.uuid4(), "username": "worker", "participant_type": "agent"}, "persephone", surface="agent_hub")
        self.assertEqual(ctx.exception.status_code, 403)
        # …and still pass for a Brigade agent without touching the grants.
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        with patch.object(AA, "resolve_agent_access", new=AsyncMock()) as resolve:
            await AA.ensure_agent_access(db, {"participant_id": uuid.uuid4(), "username": "worker", "participant_type": "agent"}, "majik", surface="agent_hub")
        resolve.assert_not_awaited()

    async def test_roster_entitlement_uses_the_participant_id(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(rows=[("brigade:persephone", {"backend": "runner", "owner": "aaron"}), ("brigade:majik", None)]),
            _Result(scalar="mallory"),   # caller's DB username
            _Result(scalars=[]),         # grants
        ])
        with patch.object(AA, "_default_is_open", return_value=True):
            entitled = await AA.entitled_agent_ids(db, participant_id=uuid.uuid4(), agent_ids=["persephone", "majik"])
        self.assertEqual(entitled, {"majik"})

    async def test_facilitator_never_adds_a_runner_seat(self) -> None:
        from app.services import facilitator as F

        db = AsyncMock()
        with patch.object(F, "find_agent_participant", new=AsyncMock(return_value=SimpleNamespace(metadata_={"backend": "runner"}))):
            with self.assertRaises(HTTPException) as ctx:
                await F._ensure_member(db, SimpleNamespace(id=uuid.uuid4()), "perry", {"name": "Perry"})
        self.assertEqual(ctx.exception.status_code, 409)
        db.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# (P2-9 / P2-16) mint takes an owner and caps the id; (P2-5) stable- prefix
# ---------------------------------------------------------------------------


class MintOwnerAndIdCap(IsolatedAsyncioTestCase):
    def test_body_accepts_owner_and_caps_the_id(self) -> None:
        body = G.MintKeyBody(agent_id="persephone", owner="Aaron")
        self.assertEqual(body.owner, "aaron")
        self.assertEqual(G.MintKeyBody(agent_id="flow", owner=["shafen", "ShafenKhan", "shafen"]).owner, ["shafen", "shafenkhan"])
        with self.assertRaises(ValidationError):
            G.MintKeyBody(agent_id="x" * 95)
        with self.assertRaises(ValidationError):
            G.MintKeyBody(agent_id="x", owner=[""])
        self.assertIsNone(G.MintKeyBody(agent_id="x").owner)

    async def test_mint_stamps_the_owner_on_a_new_seat_row(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        seat = await G._stamp_seat_owner(db, "persephone", "aaron")
        self.assertEqual(seat.metadata_, {"backend": "runner", "owner": "aaron"})
        self.assertEqual(seat.keycloak_sub, "brigade:persephone")

    async def test_mint_merges_the_owner_into_an_unowned_row_and_keeps_an_existing_one(self) -> None:
        unowned = _seat(owner=None)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=unowned), _Result()])
        db.commit = AsyncMock()
        await G._stamp_seat_owner(db, "persephone", "aaron")
        self.assertIn("||", str(db.execute.await_args_list[1].args[0]))
        self.assertEqual(unowned.metadata_["owner"], "aaron")
        owned = _seat(owner="shafen")
        db.execute = AsyncMock(return_value=_Result(scalar=owned))
        await G._stamp_seat_owner(db, "persephone", "aaron")
        self.assertEqual(owned.metadata_["owner"], "shafen")
        self.assertEqual(db.execute.await_count, 1)


class StablePrefixOnlyOnClientNames(IsolatedAsyncioTestCase):
    async def test_threads_under_a_legacy_stable_room_still_work(self) -> None:
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        livekit = AsyncMock()
        livekit.create_room = AsyncMock(return_value=SimpleNamespace(sid="sid"))
        svc = RoomService(db=db, livekit=livekit, presence=AsyncMock())
        room = await svc.create_room(name="stable-legacy-t-1a2b3c4d", display_name="thread", room_type="agent_hub", creator_id=uuid.uuid4())
        self.assertEqual(room.name, "stable-legacy-t-1a2b3c4d")

    async def test_converting_a_group_to_a_stable_channel_is_refused(self) -> None:
        from app.services.room_service import RoomService

        room = SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.GROUP_DM, parent_room_id=None, display_name="Crew", metadata_={})
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=SimpleNamespace(role=MemberRole.OWNER)), _Result(scalar=room)])
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        with self.assertRaises(HTTPException) as ctx:
            await svc.convert_group_to_channel(room_id=room.id, actor_id=uuid.uuid4(), name="stable-crew", display_name=None, visibility="private")
        self.assertEqual(ctx.exception.status_code, 422)


class R6LadderIs422Then403Then409(IsolatedAsyncioTestCase):
    async def test_an_absent_seat_owned_by_someone_else_is_403_before_409(self) -> None:
        from app.services.room_service import RoomService

        aaron = _human()
        me = SimpleNamespace(participant=aaron, participant_id=aaron.id, role=MemberRole.OWNER, agent_mode=None)
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, members=[me], metadata_={}, parent_room_id=None, is_archived=False)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=me), _Result(scalar=room), _Result(scalar={"backend": "runner", "owner": "shafen"})])
        db.commit = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"flow": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 403)
        # The owner asking about a seat that is simply not in the room: 409.
        db.execute = AsyncMock(side_effect=[_Result(scalar=me), _Result(scalar=room), _Result(scalar={"backend": "runner", "owner": "aaron"})])
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 409)
