"""Call moderation (api/moderation.py + the LiveKitService verbs under it).

Covers, per the feature contract:
  * the authz matrix — owner ok, admin ok, member/guest/non-member 403;
  * the ladder — an admin cannot target the owner (owner-immune) or another
    admin; an owner can; nobody moderates themselves;
  * action → LiveKit-call dispatch (mute_mic / silence / unsilence / deafen /
    undeafen / remove_from_call), including the privacy rule that unsilence
    restores publish WITHOUT force-unmuting the track;
  * target resolution — participant UUID → canonical identity (human
    ``username_<uuid>``, agent bare ``agent-<id>``), raw LiveKit identity
    passthrough (the agent kill-switch path), and the rank check still firing
    when a raw ``username_<uuid>`` identity names a ranked member;
  * LiveKit "participant not found" mapping to 404;
  * LiveKitService.mute_participant — the track_sid fix: mutes each published
    AUDIO track by sid (the old request carried no track_sid and could never
    have worked);
  * LiveKitService.update_participant_permissions — preserves permission
    fields it was not asked to change.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.api import moderation as mod
from app.api.moderation import CallModerationBody, moderate_call_participant
from app.models.participant import ParticipantType
from app.models.room import MemberRole
from app.services.livekit_service import LiveKitService


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _room(name: str = "lk-room-1") -> SimpleNamespace:
    return SimpleNamespace(livekit_room_name=name)


def _member(role: MemberRole) -> SimpleNamespace:
    return SimpleNamespace(role=role)


def _user(participant_id: uuid.UUID | None = None) -> dict:
    return {
        "sub": "kc-actor",
        "username": "actor",
        "participant_id": participant_id or _uuid(),
    }


def _human_row(pid: uuid.UUID, username: str = "aaron") -> SimpleNamespace:
    return SimpleNamespace(
        id=pid, username=username, participant_type=ParticipantType.HUMAN
    )


def _agent_row(pid: uuid.UUID, slug: str = "majik") -> SimpleNamespace:
    return SimpleNamespace(
        id=pid,
        username=f"agent-{slug}",
        participant_type=ParticipantType.AGENT,
    )


class ModerationEndpointTests(IsolatedAsyncioTestCase):
    """Drive the handler directly with the module data seams patched."""

    async def _call(
        self,
        *,
        actor_role: MemberRole | None,
        target: str,
        action: str = "mute_mic",
        target_membership: SimpleNamespace | None = None,
        target_participant: SimpleNamespace | None = None,
        livekit: AsyncMock | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        room_id = _uuid()
        user = _user(actor_id)
        lk = livekit or AsyncMock(spec=LiveKitService)
        if livekit is None:
            lk.mute_participant.return_value = []

        memberships = [
            _member(actor_role) if actor_role is not None else None,
            target_membership,
        ]
        with (
            patch.object(mod, "_get_room", AsyncMock(return_value=_room())),
            patch.object(
                mod, "_get_membership", AsyncMock(side_effect=memberships)
            ),
            patch.object(
                mod,
                "_get_participant",
                AsyncMock(return_value=target_participant),
            ),
        ):
            return await moderate_call_participant(
                room_id=room_id,
                body=CallModerationBody(
                    participant_id=target, action=action
                ),
                user=user,
                db=MagicMock(),
                livekit=lk,
            )

    # ---- authz matrix ----------------------------------------------------

    async def test_owner_can_moderate(self) -> None:
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target="agent-majik",
        )
        self.assertEqual(resp.status, "ok")

    async def test_admin_can_moderate_member(self) -> None:
        pid = _uuid()
        resp = await self._call(
            actor_role=MemberRole.ADMIN,
            target=str(pid),
            target_membership=_member(MemberRole.MEMBER),
            target_participant=_human_row(pid),
        )
        self.assertEqual(resp.status, "ok")

    async def test_member_403(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.MEMBER, target="agent-majik"
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_guest_403(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.GUEST, target="agent-majik"
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_non_member_403(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(actor_role=None, target="agent-majik")
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_admin_cannot_target_owner(self) -> None:
        pid = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.ADMIN,
                target=str(pid),
                target_membership=_member(MemberRole.OWNER),
                target_participant=_human_row(pid),
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_admin_cannot_target_admin(self) -> None:
        pid = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.ADMIN,
                target=str(pid),
                target_membership=_member(MemberRole.ADMIN),
                target_participant=_human_row(pid),
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_owner_can_target_admin(self) -> None:
        pid = _uuid()
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target=str(pid),
            target_membership=_member(MemberRole.ADMIN),
            target_participant=_human_row(pid),
        )
        self.assertEqual(resp.status, "ok")

    async def test_cannot_moderate_self(self) -> None:
        actor_id = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target=str(actor_id),
                target_participant=_human_row(actor_id),
                actor_id=actor_id,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_rank_check_fires_on_raw_username_uuid_identity(self) -> None:
        """A raw ``username_<uuid>`` identity still exposes the target's rank."""
        pid = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.ADMIN,
                target=f"aaron_{pid}",
                target_membership=_member(MemberRole.OWNER),
            )
        self.assertEqual(ctx.exception.status_code, 403)

    # ---- target resolution ----------------------------------------------

    async def test_human_uuid_resolves_to_canonical_identity(self) -> None:
        pid = _uuid()
        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.return_value = ["TR_1"]
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target=str(pid),
            target_membership=_member(MemberRole.MEMBER),
            target_participant=_human_row(pid, username="aaron"),
            livekit=lk,
        )
        self.assertEqual(resp.target_identity, f"aaron_{pid}")
        self.assertEqual(resp.muted_track_sids, ["TR_1"])

    async def test_agent_uuid_resolves_to_agent_identity(self) -> None:
        pid = _uuid()
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target=str(pid),
            target_membership=_member(MemberRole.MEMBER),
            target_participant=_agent_row(pid, slug="majik"),
        )
        self.assertEqual(resp.target_identity, "agent-majik")

    async def test_raw_agent_identity_passthrough(self) -> None:
        lk = AsyncMock(spec=LiveKitService)
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target="agent-the-general",
            action="remove_from_call",
            livekit=lk,
        )
        self.assertEqual(resp.target_identity, "agent-the-general")
        lk.remove_participant.assert_awaited_once_with(
            "lk-room-1", "agent-the-general"
        )

    async def test_unknown_uuid_404(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target=str(_uuid()),
                target_participant=None,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    # ---- action → LiveKit dispatch --------------------------------------

    async def _dispatch(self, action: str) -> AsyncMock:
        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.return_value = ["TR_a"]
        await self._call(
            actor_role=MemberRole.OWNER,
            target="agent-majik",
            action=action,
            livekit=lk,
        )
        return lk

    async def test_mute_mic_dispatch(self) -> None:
        lk = await self._dispatch("mute_mic")
        lk.mute_participant.assert_awaited_once_with(
            "lk-room-1", "agent-majik", muted=True
        )
        lk.update_participant_permissions.assert_not_awaited()

    async def test_unmute_mic_sends_the_relay_control_packet(self) -> None:
        """No server-side unmute exists (see LiveKitService.mute_participant's
        412 note) — this goes over the same data channel
        rooms.update_voice_settings uses to push ``relay_config``."""
        lk = await self._dispatch("unmute_mic")
        lk.mute_participant.assert_not_awaited()
        lk.update_participant_permissions.assert_not_awaited()
        lk.send_data.assert_awaited_once()
        args, kwargs = lk.send_data.await_args
        room_name, payload = args[0], args[1]
        self.assertEqual(room_name, "lk-room-1")
        self.assertEqual(payload["type"], "voice_relay_control")
        self.assertEqual(payload["action"], "unmute")
        self.assertEqual(kwargs["destination_identities"], ["agent-majik"])

    async def test_unmute_mic_response_shape(self) -> None:
        lk = AsyncMock(spec=LiveKitService)
        resp = await self._call(
            actor_role=MemberRole.OWNER,
            target="agent-majik",
            action="unmute_mic",
            livekit=lk,
        )
        self.assertEqual(resp.status, "ok")
        self.assertEqual(resp.action, "unmute_mic")
        self.assertEqual(resp.target_identity, "agent-majik")
        self.assertEqual(resp.muted_track_sids, [])

    async def test_unmute_mic_rejected_for_a_human_uuid_target(self) -> None:
        pid = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target=str(pid),
                action="unmute_mic",
                target_membership=_member(MemberRole.MEMBER),
                target_participant=_human_row(pid),
            )
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_unmute_mic_rejected_for_a_raw_human_identity(self) -> None:
        """The identity-passthrough path (call-tile shape) gets the same gate
        as the UUID path — ``agent-`` is the only thing that grants it."""
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target=f"aaron_{_uuid()}",
                action="unmute_mic",
            )
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_silence_dispatch(self) -> None:
        lk = await self._dispatch("silence")
        lk.mute_participant.assert_awaited_once_with(
            "lk-room-1", "agent-majik", muted=True
        )
        lk.update_participant_permissions.assert_awaited_once_with(
            "lk-room-1", "agent-majik", can_publish=False
        )

    async def test_unsilence_restores_publish_without_unmuting(self) -> None:
        lk = await self._dispatch("unsilence")
        lk.update_participant_permissions.assert_awaited_once_with(
            "lk-room-1", "agent-majik", can_publish=True
        )
        # PRIVACY: never force-unmute the track — they re-open their own mic.
        lk.mute_participant.assert_not_awaited()

    async def test_deafen_dispatch(self) -> None:
        lk = await self._dispatch("deafen")
        lk.update_participant_permissions.assert_awaited_once_with(
            "lk-room-1", "agent-majik", can_subscribe=False
        )

    async def test_undeafen_dispatch(self) -> None:
        lk = await self._dispatch("undeafen")
        lk.update_participant_permissions.assert_awaited_once_with(
            "lk-room-1", "agent-majik", can_subscribe=True
        )

    async def test_remove_from_call_dispatch(self) -> None:
        lk = await self._dispatch("remove_from_call")
        lk.remove_participant.assert_awaited_once_with(
            "lk-room-1", "agent-majik"
        )

    async def test_livekit_not_found_maps_to_404(self) -> None:
        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.side_effect = Exception(
            "twirp error not_found: participant does not exist"
        )
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target="agent-majik",
                livekit=lk,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_real_livekit_server_error_maps_to_404(self) -> None:
        """The REAL error class, not a stand-in Exception.

        The hand-rolled Exception above only exercises the text fallback; this
        one carries the twirp ``code``/``status`` the SFU actually raises, so
        the production path is proven rather than assumed.
        """
        from livekit.api.twirp_client import TwirpError

        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.side_effect = TwirpError(
            "not_found", "participant does not exist", status=404
        )
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target="agent-majik",
                livekit=lk,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_real_livekit_server_error_other_code_maps_to_502(self) -> None:
        """A genuine LiveKit fault must NOT be dressed up as a missing target."""
        from livekit.api.twirp_client import TwirpError

        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.side_effect = TwirpError(
            "internal", "sfu exploded", status=500
        )
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target="agent-majik",
                livekit=lk,
            )
        self.assertEqual(ctx.exception.status_code, 502)

    async def test_livekit_other_error_maps_to_502(self) -> None:
        lk = AsyncMock(spec=LiveKitService)
        lk.mute_participant.side_effect = Exception("connection refused")
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                actor_role=MemberRole.OWNER,
                target="agent-majik",
                livekit=lk,
            )
        self.assertEqual(ctx.exception.status_code, 502)

    async def test_room_missing_404(self) -> None:
        with patch.object(mod, "_get_room", AsyncMock(return_value=None)):
            with self.assertRaises(HTTPException) as ctx:
                await moderate_call_participant(
                    room_id=_uuid(),
                    body=CallModerationBody(
                        participant_id="agent-majik", action="mute_mic"
                    ),
                    user=_user(),
                    db=MagicMock(),
                    livekit=AsyncMock(spec=LiveKitService),
                )
            self.assertEqual(ctx.exception.status_code, 404)


class LiveKitServiceModerationTests(IsolatedAsyncioTestCase):
    """The service verbs, against real protobuf messages from livekit-api."""

    def _service(self) -> tuple[LiveKitService, MagicMock]:
        api = MagicMock()
        api.room.get_participant = AsyncMock()
        api.room.mute_published_track = AsyncMock()
        api.room.update_participant = AsyncMock()
        return LiveKitService(api, "ws://test"), api

    def _participant_info(self):
        from livekit.protocol.models import (
            ParticipantInfo,
            ParticipantPermission,
            TrackInfo,
            TrackType,
        )

        return ParticipantInfo(
            identity="aaron_x",
            tracks=[
                TrackInfo(sid="TR_mic", type=TrackType.AUDIO),
                TrackInfo(sid="TR_cam", type=TrackType.VIDEO),
                TrackInfo(sid="TR_share_audio", type=TrackType.AUDIO),
            ],
            permission=ParticipantPermission(
                can_subscribe=True,
                can_publish=True,
                can_publish_data=True,
                hidden=False,
                can_update_metadata=True,
            ),
        )

    async def test_mute_participant_mutes_each_audio_track_by_sid(self) -> None:
        svc, api = self._service()
        api.room.get_participant.return_value = self._participant_info()

        sids = await svc.mute_participant("room-x", "aaron_x", muted=True)

        self.assertEqual(sids, ["TR_mic", "TR_share_audio"])
        self.assertEqual(api.room.mute_published_track.await_count, 2)
        requests = [
            call.args[0]
            for call in api.room.mute_published_track.await_args_list
        ]
        # THE FIX under test: every request names a track_sid (the old code
        # sent none, which LiveKit rejects — MuteRoomTrack is per-track).
        self.assertEqual(
            [r.track_sid for r in requests], ["TR_mic", "TR_share_audio"]
        )
        self.assertTrue(all(r.muted for r in requests))
        self.assertTrue(all(r.room == "room-x" for r in requests))
        self.assertTrue(all(r.identity == "aaron_x" for r in requests))

    async def test_mute_participant_no_audio_is_a_noop(self) -> None:
        from livekit.protocol.models import ParticipantInfo

        svc, api = self._service()
        api.room.get_participant.return_value = ParticipantInfo(
            identity="quiet"
        )

        sids = await svc.mute_participant("room-x", "quiet", muted=True)

        self.assertEqual(sids, [])
        api.room.mute_published_track.assert_not_awaited()

    async def test_update_permissions_preserves_unnamed_fields(self) -> None:
        svc, api = self._service()
        api.room.get_participant.return_value = self._participant_info()

        await svc.update_participant_permissions(
            "room-x", "aaron_x", can_publish=False
        )

        request = api.room.update_participant.await_args.args[0]
        self.assertEqual(request.room, "room-x")
        self.assertEqual(request.identity, "aaron_x")
        self.assertFalse(request.permission.can_publish)
        # Everything not named keeps its live value instead of resetting to
        # proto defaults — the whole reason we read-modify-write.
        self.assertTrue(request.permission.can_subscribe)
        self.assertTrue(request.permission.can_publish_data)
        self.assertTrue(request.permission.can_update_metadata)

    async def test_update_permissions_can_subscribe_only(self) -> None:
        svc, api = self._service()
        api.room.get_participant.return_value = self._participant_info()

        await svc.update_participant_permissions(
            "room-x", "aaron_x", can_subscribe=False
        )

        request = api.room.update_participant.await_args.args[0]
        self.assertFalse(request.permission.can_subscribe)
        self.assertTrue(request.permission.can_publish)
