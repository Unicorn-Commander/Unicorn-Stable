"""Per-user agent access control (services/agent_access + its enforcement points).

Covers, per the feature contract:
  * resolution: default-open passthrough, closed-mode deny, allow-grant in
    closed mode, deny-grant in open mode;
  * enforcement point 1 — agent-DM creation / room bind
    (``invite_brigade_agent`` with dispatch=False);
  * enforcement point 2 — the generic member-invite route binding an
    agent-typed Participant (``rooms.invite_member``);
  * enforcement point 3 — the call-time voice dispatch
    (``invite_brigade_agent`` with dispatch=True) never reaches LiveKit for a
    denied caller;
  * the worker exemption: agent-typed principals are never gated;
  * roster annotation (``entitled`` flags on /brigade/agents);
  * admin authz on the grants API;
  * the structured ``agent_access_denied`` audit log.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.models.agent_access import AgentAccessEffect, AgentAccessGrant
from app.models.participant import ParticipantType
from app.services import agent_access as svc


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _human(roles: list[str] | None = None) -> dict:
    return {
        "sub": "kc-adam",
        "username": "adam",
        "display_name": "Adam",
        "participant_id": _uuid(),
        "participant_type": "human",
        "roles": roles or [],
    }


def _worker() -> dict:
    return {
        "sub": "svc-agents",
        "username": "stable-agents",
        "participant_id": _uuid(),
        "participant_type": "agent",
        "roles": ["agent-service"],
    }


def _settings(mode: str) -> SimpleNamespace:
    return SimpleNamespace(agent_access_default=mode)


def _grant(agent_id: str, effect: AgentAccessEffect) -> SimpleNamespace:
    # Duck-typed grant row (an instrumented AgentAccessGrant would need a
    # session); the service reads only .agent_id and .effect.
    return SimpleNamespace(
        participant_id=_uuid(), agent_id=agent_id, effect=effect
    )


def _scalar_result(value: object) -> MagicMock:
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _scalars_result(values: list[object]) -> MagicMock:
    res = MagicMock()
    res.scalars.return_value.all.return_value = values
    return res


def _count_result(value: int) -> MagicMock:
    res = MagicMock()
    res.scalar_one.return_value = value
    return res


class ResolveAgentAccessTests(IsolatedAsyncioTestCase):
    async def _resolve(self, *, mode: str, grant: AgentAccessGrant | None):
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(grant))
        with patch.object(svc, "get_settings", return_value=_settings(mode)):
            return await svc.resolve_agent_access(
                db, participant_id=_uuid(), agent_id="the-colonel"
            )

    async def test_default_open_passthrough(self) -> None:
        allowed, reason = await self._resolve(mode="open", grant=None)
        self.assertTrue(allowed)
        self.assertEqual(reason, "default_open")

    async def test_closed_mode_denies_without_grant(self) -> None:
        allowed, reason = await self._resolve(mode="closed", grant=None)
        self.assertFalse(allowed)
        self.assertEqual(reason, "default_closed")

    async def test_allow_grant_opens_pair_in_closed_mode(self) -> None:
        allowed, reason = await self._resolve(
            mode="closed", grant=_grant("the-colonel", AgentAccessEffect.ALLOW)
        )
        self.assertTrue(allowed)
        self.assertEqual(reason, "grant_allow")

    async def test_deny_grant_blocks_pair_in_open_mode(self) -> None:
        allowed, reason = await self._resolve(
            mode="open", grant=_grant("the-colonel", AgentAccessEffect.DENY)
        )
        self.assertFalse(allowed)
        self.assertEqual(reason, "grant_deny")


class EnsureAgentAccessTests(IsolatedAsyncioTestCase):
    async def test_denied_human_gets_403_with_clean_detail(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        with patch.object(svc, "get_settings", return_value=_settings("closed")):
            with self.assertRaises(HTTPException) as ctx:
                await svc.ensure_agent_access(
                    db, _human(), "the-colonel", surface="agent_invite"
                )
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("the-colonel", ctx.exception.detail)
        self.assertIn("Ask an admin", ctx.exception.detail)

    async def test_denial_emits_structured_audit_log(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalar_result(
                _grant("the-colonel", AgentAccessEffect.DENY)
            )
        )
        with (
            patch.object(svc, "get_settings", return_value=_settings("open")),
            patch.object(svc, "logger") as log,
        ):
            with self.assertRaises(HTTPException):
                await svc.ensure_agent_access(
                    db, _human(), "the-colonel", surface="agent_invite"
                )
        log.warning.assert_called_once()
        args, kwargs = log.warning.call_args
        self.assertEqual(args[0], "agent_access_denied")
        self.assertEqual(kwargs["agent_id"], "the-colonel")
        self.assertEqual(kwargs["surface"], "agent_invite")
        self.assertEqual(kwargs["reason"], "grant_deny")
        self.assertEqual(kwargs["username"], "adam")

    async def test_allowed_human_passes_silently(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalar_result(None))
        with (
            patch.object(svc, "get_settings", return_value=_settings("open")),
            patch.object(svc, "logger") as log,
        ):
            await svc.ensure_agent_access(
                db, _human(), "the-colonel", surface="agent_invite"
            )
        log.warning.assert_not_called()

    async def test_worker_principal_is_never_gated(self) -> None:
        """The agents worker (agent-typed service account) bypasses the gate
        entirely — even in closed mode, and without touching the database."""
        db = AsyncMock()
        with patch.object(svc, "get_settings", return_value=_settings("closed")):
            await svc.ensure_agent_access(
                db, _worker(), "the-colonel", surface="agent_invite"
            )
        db.execute.assert_not_awaited()


class EntitledAgentIdsTests(IsolatedAsyncioTestCase):
    async def test_open_mode_annotates_only_deny_grants(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [_grant("perry", AgentAccessEffect.DENY)]
            )
        )
        with patch.object(svc, "get_settings", return_value=_settings("open")):
            allowed = await svc.entitled_agent_ids(
                db, participant_id=_uuid(), agent_ids=["perry", "gunny"]
            )
        self.assertEqual(allowed, {"gunny"})

    async def test_closed_mode_annotates_only_allow_grants(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [_grant("perry", AgentAccessEffect.ALLOW)]
            )
        )
        with patch.object(svc, "get_settings", return_value=_settings("closed")):
            allowed = await svc.entitled_agent_ids(
                db, participant_id=_uuid(), agent_ids=["perry", "gunny"]
            )
        self.assertEqual(allowed, {"perry"})

    async def test_empty_input_short_circuits(self) -> None:
        db = AsyncMock()
        allowed = await svc.entitled_agent_ids(
            db, participant_id=_uuid(), agent_ids=[]
        )
        self.assertEqual(allowed, set())
        db.execute.assert_not_awaited()


class AgentIdForParticipantTests(IsolatedAsyncioTestCase):
    def test_brigade_prefix_is_stripped(self) -> None:
        self.assertEqual(svc.agent_id_for_participant("brigade:perry"), "perry")

    def test_non_brigade_agent_keys_on_full_sub(self) -> None:
        self.assertEqual(
            svc.agent_id_for_participant("webhook:alerts"), "webhook:alerts"
        )


# ---------------------------------------------------------------------------
# Enforcement point 1 + 3: invite_brigade_agent (DM bind AND call dispatch)
# ---------------------------------------------------------------------------


class InviteBrigadeAgentGateTests(IsolatedAsyncioTestCase):
    def _room(self) -> SimpleNamespace:
        # The "New chat with The Colonel" room at bind time: a bare dm (no
        # dm_pair, creator is the only human, no binding yet). The human-DM
        # bind guard runs its member-count query on this shape and passes.
        from app.models.room import RoomType

        rid = _uuid()
        return SimpleNamespace(
            id=rid,
            name="chat-with-colonel",
            livekit_room_name="stable-chat-with-colonel",
            room_type=RoomType.DM,
            metadata_={},
        )

    async def _call_route(
        self, *, mode: str, grant: AgentAccessGrant | None, dispatch: bool
    ) -> tuple[object, AsyncMock]:
        from app.api import brigade as brigade_api

        room = self._room()
        db = AsyncMock()
        # Execute order inside the route for a DENIED caller:
        #   1. room resolve, 2. caller membership, 3. the human-DM guard's
        #   member count (bare dm → 1 human → passes), 4. the exact grant
        #   lookup (and 5. the wildcard ``*`` lookup, only on an exact miss).
        results = [
            _scalar_result(room),
            _scalar_result(SimpleNamespace(id=_uuid())),  # caller member
            _count_result(1),  # human-DM guard count
            _scalar_result(grant),
        ]
        if grant is None:
            results.append(_scalar_result(None))  # wildcard lookup miss
        db.execute = AsyncMock(side_effect=results)
        livekit = AsyncMock()
        body = brigade_api.InviteAgentRequest(
            brigade_agent_id="the-colonel", dispatch=dispatch
        )
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[
                        brigade_api.BrigadeAgent(id="the-colonel", name="The Colonel")
                    ]
                ),
            ),
            patch.object(svc, "get_settings", return_value=_settings(mode)),
        ):
            result = await brigade_api.invite_brigade_agent(
                room_name=str(room.id),
                body=body,
                user=_human(),
                db=db,
                livekit=livekit,
            )
        return result, livekit

    async def test_dm_bind_denied_in_closed_mode(self) -> None:
        """Acceptance: Adam, closed mode, no grant, 'New chat' with The
        Colonel (dispatch=False bind) → 403."""
        with self.assertRaises(HTTPException) as ctx:
            await self._call_route(mode="closed", grant=None, dispatch=False)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("the-colonel", ctx.exception.detail)

    async def test_call_dispatch_denied_never_reaches_livekit(self) -> None:
        """Acceptance: same denial on the voice-call path (dispatch=True) —
        and the LiveKit dispatch must never fire."""
        from app.api import brigade as brigade_api

        room = self._room()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(room),
                _scalar_result(SimpleNamespace(id=_uuid())),
                _count_result(1),  # human-DM guard count (bare dm passes)
                _scalar_result(_grant("the-colonel", AgentAccessEffect.DENY)),
            ]
        )
        livekit = AsyncMock()
        body = brigade_api.InviteAgentRequest(
            brigade_agent_id="the-colonel", dispatch=True
        )
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[
                        brigade_api.BrigadeAgent(id="the-colonel", name="The Colonel")
                    ]
                ),
            ),
            patch.object(svc, "get_settings", return_value=_settings("open")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await brigade_api.invite_brigade_agent(
                    room_name=str(room.id),
                    body=body,
                    user=_human(),
                    db=db,
                    livekit=livekit,
                )
        self.assertEqual(ctx.exception.status_code, 403)
        livekit.dispatch_agent.assert_not_awaited()
        livekit.get_room.assert_not_awaited()

    async def test_default_open_still_binds_without_any_grant(self) -> None:
        """Dogfood passthrough: open mode + no grant rows behaves exactly as
        before the feature (the bind succeeds)."""
        from app.api import brigade as brigade_api

        room = self._room()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(room),  # room resolve
                _scalar_result(SimpleNamespace(id=_uuid())),  # caller member
                _count_result(1),  # human-DM guard count (bare dm passes)
                _scalar_result(None),  # exact grant lookup (none)
                _scalar_result(None),  # wildcard (*) lookup (none)
                _scalar_result(room),  # metadata persist re-lookup
            ]
        )
        livekit = AsyncMock()
        body = brigade_api.InviteAgentRequest(
            brigade_agent_id="the-colonel", dispatch=False
        )
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[
                        brigade_api.BrigadeAgent(id="the-colonel", name="The Colonel")
                    ]
                ),
            ),
            patch.object(brigade_api, "_ensure_agent_member", AsyncMock()),
            patch.object(svc, "get_settings", return_value=_settings("open")),
        ):
            result = await brigade_api.invite_brigade_agent(
                room_name=str(room.id),
                body=body,
                user=_human(),
                db=db,
                livekit=livekit,
            )
        self.assertEqual(result.brigade_agent_id, "the-colonel")
        self.assertFalse(result.dispatched)
        self.assertEqual(result.reason, "dispatch_not_requested")


# ---------------------------------------------------------------------------
# Enforcement point 2: rooms.invite_member with an agent-typed target
# ---------------------------------------------------------------------------


class InviteMemberAgentGateTests(IsolatedAsyncioTestCase):
    async def _invite(
        self,
        *,
        target: SimpleNamespace,
        mode: str,
        grant: AgentAccessGrant | None,
    ) -> MagicMock:
        from app.api import rooms as rooms_api

        db = AsyncMock()
        from app.models.room import RoomType as _RoomType

        execute_results = [
            _scalar_result(SimpleNamespace(id=_uuid())),  # caller membership
            # The DM guard loads the room up front (a 1:1 DM refuses invites).
            _scalar_result(
                SimpleNamespace(id=_uuid(), room_type=_RoomType.CHANNEL)
            ),
            _scalar_result(target),  # target participant
        ]
        if target.participant_type == ParticipantType.AGENT:
            execute_results.append(_scalar_result(grant))  # entitlement lookup
            # Closed-mode denial falls through to the wildcard (*) grant
            # lookup; extra side_effect entries are harmless when unused.
            execute_results.append(_scalar_result(None))
        db.execute = AsyncMock(side_effect=execute_results)

        from datetime import datetime, timezone

        room_svc = MagicMock()
        room_svc.join_room = AsyncMock(
            return_value=SimpleNamespace(
                id=_uuid(),
                participant_id=target.id,
                role=SimpleNamespace(value="member"),
                joined_at=datetime.now(timezone.utc),
                last_read_at=None,
                is_muted=False,
            )
        )
        body = rooms_api.InviteMemberBody(participant_id=target.id)
        with (
            patch.object(rooms_api, "_build_room_service", return_value=room_svc),
            patch.object(svc, "get_settings", return_value=_settings(mode)),
        ):
            await rooms_api.invite_member(
                room_id=_uuid(),
                body=body,
                user=_human(),
                db=db,
                livekit=AsyncMock(),
                presence=AsyncMock(),
            )
        return room_svc

    def _agent_target(self) -> SimpleNamespace:
        return SimpleNamespace(
            id=_uuid(),
            participant_type=ParticipantType.AGENT,
            keycloak_sub="brigade:the-colonel",
            username="agent-the-colonel",
            display_name="The Colonel",
        )

    def _human_target(self) -> SimpleNamespace:
        return SimpleNamespace(
            id=_uuid(),
            participant_type=ParticipantType.HUMAN,
            keycloak_sub="kc-bob",
            username="bob",
            display_name="Bob",
        )

    async def test_agent_target_denied_in_closed_mode(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._invite(
                target=self._agent_target(), mode="closed", grant=None
            )
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("the-colonel", ctx.exception.detail)

    async def test_agent_target_denied_never_joins(self) -> None:
        from app.api import rooms as rooms_api

        target = self._agent_target()
        db = AsyncMock()
        from app.models.room import RoomType as _RoomType

        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(SimpleNamespace(id=_uuid())),
                _scalar_result(
                    SimpleNamespace(id=_uuid(), room_type=_RoomType.CHANNEL)
                ),
                _scalar_result(target),
                _scalar_result(_grant("the-colonel", AgentAccessEffect.DENY)),
            ]
        )
        room_svc = MagicMock()
        room_svc.join_room = AsyncMock()
        body = rooms_api.InviteMemberBody(participant_id=target.id)
        with (
            patch.object(rooms_api, "_build_room_service", return_value=room_svc),
            patch.object(svc, "get_settings", return_value=_settings("open")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await rooms_api.invite_member(
                    room_id=_uuid(),
                    body=body,
                    user=_human(),
                    db=db,
                    livekit=AsyncMock(),
                    presence=AsyncMock(),
                )
        self.assertEqual(ctx.exception.status_code, 403)
        room_svc.join_room.assert_not_awaited()

    async def test_agent_target_allowed_by_grant_in_closed_mode(self) -> None:
        room_svc = await self._invite(
            target=self._agent_target(),
            mode="closed",
            grant=_grant("the-colonel", AgentAccessEffect.ALLOW),
        )
        room_svc.join_room.assert_awaited_once()

    async def test_human_target_is_never_entitlement_checked(self) -> None:
        """Human invites don't touch the grant table even in closed mode."""
        room_svc = await self._invite(
            target=self._human_target(), mode="closed", grant=None
        )
        room_svc.join_room.assert_awaited_once()


# ---------------------------------------------------------------------------
# Roster annotation
# ---------------------------------------------------------------------------


class RosterEntitlementAnnotationTests(IsolatedAsyncioTestCase):
    async def test_open_mode_marks_deny_granted_agent_unentitled(self) -> None:
        from app.api import brigade as brigade_api

        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [_grant("perry", AgentAccessEffect.DENY)]
            )
        )
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[
                        brigade_api.BrigadeAgent(id="perry", name="Perry"),
                        brigade_api.BrigadeAgent(id="gunny", name="Gunny"),
                    ]
                ),
            ),
            patch.object(svc, "get_settings", return_value=_settings("open")),
        ):
            agents = await brigade_api.list_brigade_agents(user=_human(), db=db)
        flags = {a.id: a.entitled for a in agents}
        self.assertEqual(flags, {"perry": False, "gunny": True})

    async def test_closed_mode_marks_only_allow_granted_entitled(self) -> None:
        from app.api import brigade as brigade_api

        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [_grant("perry", AgentAccessEffect.ALLOW)]
            )
        )
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[
                        brigade_api.BrigadeAgent(id="perry", name="Perry"),
                        brigade_api.BrigadeAgent(id="gunny", name="Gunny"),
                    ]
                ),
            ),
            patch.object(svc, "get_settings", return_value=_settings("closed")),
        ):
            agents = await brigade_api.list_brigade_agents(user=_human(), db=db)
        flags = {a.id: a.entitled for a in agents}
        self.assertEqual(flags, {"perry": True, "gunny": False})

    async def test_worker_caller_sees_everything_unfiltered(self) -> None:
        from app.api import brigade as brigade_api

        db = AsyncMock()
        with (
            patch.object(
                brigade_api,
                "_fetch_brigade_agents",
                AsyncMock(
                    return_value=[brigade_api.BrigadeAgent(id="perry", name="Perry")]
                ),
            ),
            patch.object(svc, "get_settings", return_value=_settings("closed")),
        ):
            agents = await brigade_api.list_brigade_agents(user=_worker(), db=db)
        self.assertTrue(all(a.entitled for a in agents))
        db.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Admin grants API authz
# ---------------------------------------------------------------------------


class GrantsAdminAuthzTests(IsolatedAsyncioTestCase):
    async def test_non_admin_cannot_list_grants(self) -> None:
        from app.api import agent_access as api

        with self.assertRaises(HTTPException) as ctx:
            await api.list_agent_access_grants(
                user=_human(roles=[]),
                settings=_settings("open"),
                db=AsyncMock(),
                participant_id=None,
                agent_id=None,
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_non_admin_cannot_upsert_grant(self) -> None:
        from app.api import agent_access as api

        body = api.UpsertGrantBody(
            participant_id=_uuid(),
            agent_id="the-colonel",
            effect=AgentAccessEffect.DENY,
        )
        db = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            await api.upsert_agent_access_grant(
                body=body, user=_human(roles=[]), db=db
            )
        self.assertEqual(ctx.exception.status_code, 403)
        db.execute.assert_not_awaited()

    async def test_non_admin_cannot_delete_grant(self) -> None:
        from app.api import agent_access as api

        db = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            await api.delete_agent_access_grant(
                user=_human(roles=[]),
                db=db,
                participant_id=_uuid(),
                agent_id="the-colonel",
            )
        self.assertEqual(ctx.exception.status_code, 403)
        db.execute.assert_not_awaited()

    async def test_admin_role_from_stable_admin_roles_env_passes(self) -> None:
        from app.api import agent_access as api

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_scalars_result([]))
        envelope = await api.list_agent_access_grants(
            user=_human(roles=["stable-admin"]),
            settings=_settings("closed"),
            db=db,
            participant_id=None,
            agent_id=None,
        )
        self.assertEqual(envelope.default, "closed")
        self.assertEqual(envelope.grants, [])

    async def test_admin_upsert_creates_grant_for_human(self) -> None:
        from app.api import agent_access as api

        admin = _human(roles=["realm-admin"])
        target_id = _uuid()
        body = api.UpsertGrantBody(
            participant_id=target_id,
            agent_id="the-colonel",
            effect=AgentAccessEffect.ALLOW,
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(
                    SimpleNamespace(
                        id=target_id, participant_type=ParticipantType.HUMAN
                    )
                ),
                _scalar_result(None),  # no existing grant
            ]
        )
        db.add = MagicMock()

        async def _stamp(obj: object) -> None:
            # Simulate the ORM assigning server defaults on refresh.
            from datetime import datetime, timezone

            if getattr(obj, "id", None) is None:
                obj.id = _uuid()  # type: ignore[attr-defined]
            obj.created_at = datetime.now(timezone.utc)  # type: ignore[attr-defined]

        db.refresh = AsyncMock(side_effect=_stamp)
        resp = await api.upsert_agent_access_grant(body=body, user=admin, db=db)
        self.assertEqual(resp.agent_id, "the-colonel")
        self.assertEqual(resp.effect, AgentAccessEffect.ALLOW)
        self.assertEqual(resp.granted_by, admin["participant_id"])
        db.add.assert_called_once()

    async def test_admin_cannot_grant_to_agent_participant(self) -> None:
        from app.api import agent_access as api

        body = api.UpsertGrantBody(
            participant_id=_uuid(),
            agent_id="the-colonel",
            effect=AgentAccessEffect.ALLOW,
        )
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalar_result(
                SimpleNamespace(
                    id=_uuid(), participant_type=ParticipantType.AGENT
                )
            )
        )
        with self.assertRaises(HTTPException) as ctx:
            await api.upsert_agent_access_grant(
                body=body, user=_human(roles=["admin"]), db=db
            )
        self.assertEqual(ctx.exception.status_code, 400)


class AgentAccessDefaultSettingTests(IsolatedAsyncioTestCase):
    def test_settings_normalizes_and_validates_mode(self) -> None:
        from app.config import Settings

        self.assertEqual(
            Settings(agent_access_default=" CLOSED ").agent_access_default,
            "closed",
        )
        self.assertEqual(
            Settings(agent_access_default="open").agent_access_default, "open"
        )
        with self.assertRaises(Exception):
            Settings(agent_access_default="wide-open")


if __name__ == "__main__":
    import unittest

    unittest.main()


class WildcardGrantResolutionTests(IsolatedAsyncioTestCase):
    """The ``*`` row: participant-wide posture, exact rows still win."""

    async def _resolve_seq(self, *, mode: str, results: list) -> tuple:
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_scalar_result(r) for r in results])
        with patch.object(svc, "get_settings", return_value=_settings(mode)):
            return await svc.resolve_agent_access(
                db, participant_id=_uuid(), agent_id="the-colonel"
            )

    async def test_wildcard_deny_blocks_unlisted_agent_in_open_mode(self) -> None:
        allowed, reason = await self._resolve_seq(
            mode="open",
            results=[None, _grant(svc.WILDCARD_AGENT_ID, AgentAccessEffect.DENY)],
        )
        self.assertFalse(allowed)
        self.assertEqual(reason, "wildcard_deny")

    async def test_exact_allow_overrides_wildcard_deny(self) -> None:
        # Exact row hits first; the wildcard query must not even run.
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _scalar_result(_grant("the-colonel", AgentAccessEffect.ALLOW))
            ]
        )
        with patch.object(svc, "get_settings", return_value=_settings("open")):
            allowed, reason = await svc.resolve_agent_access(
                db, participant_id=_uuid(), agent_id="the-colonel"
            )
        self.assertTrue(allowed)
        self.assertEqual(reason, "grant_allow")
        self.assertEqual(db.execute.await_count, 1)

    async def test_wildcard_allow_grants_in_closed_mode(self) -> None:
        allowed, reason = await self._resolve_seq(
            mode="closed",
            results=[None, _grant(svc.WILDCARD_AGENT_ID, AgentAccessEffect.ALLOW)],
        )
        self.assertTrue(allowed)
        self.assertEqual(reason, "wildcard_allow")

    async def test_no_wildcard_falls_back_to_default(self) -> None:
        allowed, reason = await self._resolve_seq(mode="open", results=[None, None])
        self.assertTrue(allowed)
        self.assertEqual(reason, "default_open")


class WildcardEntitledAgentIdsTests(IsolatedAsyncioTestCase):
    async def test_wildcard_deny_is_the_default_but_exact_allow_survives(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(
            return_value=_scalars_result(
                [
                    _grant(svc.WILDCARD_AGENT_ID, AgentAccessEffect.DENY),
                    _grant("majik", AgentAccessEffect.ALLOW),
                ]
            )
        )
        with patch.object(svc, "get_settings", return_value=_settings("open")):
            entitled = await svc.entitled_agent_ids(
                db,
                participant_id=_uuid(),
                agent_ids=["majik", "the-colonel", "gunny"],
            )
        self.assertEqual(entitled, {"majik"})
