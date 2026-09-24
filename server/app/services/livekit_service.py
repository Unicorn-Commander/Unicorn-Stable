from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import structlog
from livekit.api import AccessToken, LiveKitAPI, VideoGrants
from livekit.api.room_service import CreateRoomRequest, DeleteRoomRequest, ListRoomsRequest
from livekit.api.egress_service import ListEgressRequest
from livekit.api.room_service import MuteRoomTrackRequest, RoomParticipantIdentity
from livekit.api.room_service import SendDataRequest, UpdateParticipantRequest
from livekit.api.room_service import UpdateRoomMetadataRequest
from livekit.protocol.models import ParticipantInfo, ParticipantPermission, TrackType
from livekit.protocol.models import Room as LKRoom

try:
    # LiveKit >=1.5 ships agent dispatch on AgentDispatchService
    from livekit.api.agent_dispatch_service import (
        CreateAgentDispatchRequest,
    )
    _HAS_AGENT_DISPATCH = True
except ImportError:  # pragma: no cover — older SDKs
    CreateAgentDispatchRequest = None  # type: ignore[assignment]
    _HAS_AGENT_DISPATCH = False

logger = structlog.get_logger(__name__)


class LiveKitService:
    """Service layer for LiveKit room and participant management."""

    def __init__(self, api: LiveKitAPI, ws_url: str) -> None:
        self._api = api
        self._ws_url = ws_url

    async def create_room(
        self,
        name: str,
        empty_timeout: int = 300,
        max_participants: int = 50,
        metadata: str = "",
    ) -> LKRoom:
        """Create a new LiveKit room."""
        request = CreateRoomRequest(
            name=name,
            empty_timeout=empty_timeout,
            max_participants=max_participants,
            metadata=metadata,
        )
        room = await self._api.room.create_room(request)
        logger.info("livekit_room_created", room_name=name, sid=room.sid)
        return room

    async def delete_room(self, name: str) -> None:
        """Delete a LiveKit room."""
        request = DeleteRoomRequest(room=name)
        await self._api.room.delete_room(request)
        logger.info("livekit_room_deleted", room_name=name)

    async def list_rooms(self, names: list[str] | None = None) -> list[LKRoom]:
        """List LiveKit rooms, optionally filtering by name."""
        request = ListRoomsRequest(names=names or [])
        response = await self._api.room.list_rooms(request)
        return list(response.rooms)

    async def get_room(self, name: str) -> dict[str, Any]:
        """Get a LiveKit room with its participant list."""
        rooms = await self.list_rooms(names=[name])
        if not rooms:
            return {"room": None, "participants": []}

        room = rooms[0]
        request = RoomParticipantIdentity(room=name)
        participants_response = await self._api.room.list_participants(request)
        return {
            "room": room,
            "participants": list(participants_response.participants),
        }

    async def start_room_audio_egress(self, room_name: str, filepath: str) -> Any:
        """Start an audio-only room-composite egress writing an OGG file.

        Requires the stack's `egress` service (livekit/egress) to be running
        and registered against the same Redis as the SFU; callers treat any
        failure here as "recording unavailable" and stay fail-open.
        """
        from livekit.protocol import egress as proto_egress

        request = proto_egress.RoomCompositeEgressRequest(
            room_name=room_name,
            audio_only=True,
            file_outputs=[
                proto_egress.EncodedFileOutput(
                    file_type=proto_egress.EncodedFileType.OGG,
                    filepath=filepath,
                )
            ],
        )
        info = await self._api.egress.start_room_composite_egress(request)
        logger.info(
            "livekit_egress_started",
            room_name=room_name,
            egress_id=getattr(info, "egress_id", None),
        )
        return info

    async def start_room_composite_video_egress(
        self,
        room_name: str,
        filepath: str,
        *,
        custom_base_url: str,
        preset: str = "H264_720P_30",
        layout: str = "grid",
    ) -> Any:
        """Start a composite VIDEO egress that renders our own web template.

        ``custom_base_url`` is the broadcast page carrying a recorder token
        (design §8: "the recording looks exactly like the show feed"); the
        egress worker's headless Chrome loads it and LiveKit appends its own
        ``url``/``token``/``layout`` query parameters. Writes an MP4 to the
        shared egress volume. Same fail-open contract as the audio variant.

        The URL carries a credential, so it is never logged here — only the
        room and the returned egress id are.
        """
        from livekit.protocol import egress as proto_egress

        try:
            preset_value = proto_egress.EncodingOptionsPreset.Value(preset)
        except ValueError:
            preset_value = proto_egress.EncodingOptionsPreset.Value("H264_720P_30")

        request = proto_egress.RoomCompositeEgressRequest(
            room_name=room_name,
            layout=layout,
            custom_base_url=custom_base_url,
            preset=preset_value,
            file_outputs=[
                proto_egress.EncodedFileOutput(
                    file_type=proto_egress.EncodedFileType.MP4,
                    filepath=filepath,
                )
            ],
        )
        info = await self._api.egress.start_room_composite_egress(request)
        logger.info(
            "livekit_composite_egress_started",
            room_name=room_name,
            egress_id=getattr(info, "egress_id", None),
            preset=preset,
        )
        return info

    async def stop_egress(self, egress_id: str) -> Any:
        """Stop a running egress. LiveKit errors if it already ended."""
        from livekit.protocol import egress as proto_egress

        request = proto_egress.StopEgressRequest(egress_id=egress_id)
        info = await self._api.egress.stop_egress(request)
        logger.info("livekit_egress_stop_requested", egress_id=egress_id)
        return info

    async def list_egress(self, room_name: str) -> list[Any]:
        """Return LiveKit's current/finished egress records for a room."""
        response = await self._api.egress.list_egress(ListEgressRequest(room_name=room_name))
        return list(response.items)

    def generate_token(
        self,
        room_name: str,
        identity: str,
        name: str = "",
        grants: VideoGrants | None = None,
        ttl: int = 86400,
        api_key: str = "",
        api_secret: str = "",
    ) -> str:
        """Generate a LiveKit access token for a participant."""
        if grants is None:
            grants = VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )

        token = (
            AccessToken(api_key=api_key, api_secret=api_secret)
            .with_identity(identity)
            .with_name(name or identity)
            .with_grants(grants)
            .with_ttl(timedelta(seconds=ttl))
        )
        jwt_str = token.to_jwt()
        logger.info(
            "livekit_token_generated",
            room=room_name,
            identity=identity,
        )
        return jwt_str

    async def remove_participant(self, room_name: str, identity: str) -> None:
        """Remove a participant from a LiveKit room."""
        request = RoomParticipantIdentity(room=room_name, identity=identity)
        await self._api.room.remove_participant(request)
        logger.info(
            "livekit_participant_removed",
            room=room_name,
            identity=identity,
        )

    async def get_participant(
        self, room_name: str, identity: str
    ) -> ParticipantInfo:
        """Fetch one participant's live info (tracks, permission, state).

        Raises LiveKit's TwirpError when the participant is not in the room —
        callers decide whether that is a 404 or a no-op.
        """
        request = RoomParticipantIdentity(room=room_name, identity=identity)
        return await self._api.room.get_participant(request)

    async def mute_participant(
        self, room_name: str, identity: str, muted: bool
    ) -> list[str]:
        """Server-mute (or unmute) every AUDIO track a participant publishes.

        HISTORY: this used to send MuteRoomTrackRequest(room, identity, muted)
        with no ``track_sid``. LiveKit's MuteRoomTrack API mutes ONE TRACK —
        ``track_sid`` is required — so that request could never have worked
        (the server answers "track not found"). It had zero callers, so the
        bug sat unproven. The real shape, verified against the live SFU: read
        the participant, then mute each published audio track by its sid.

        Returns the sids that were muted/unmuted (empty when the participant
        has no audio published — e.g. mic never enabled — which is a no-op,
        not an error).

        ``muted=False`` IS REFUSED BY THIS DEPLOYMENT. Live-fire against our
        SFU: ``failed_precondition / 412 "remote unmute not enabled"`` — the
        server-side unmute is off by default in LiveKit (enabling it lets an
        operator silently re-open someone's microphone). Nothing in Stable
        calls it: moderation mutes, and "unsilence" restores publish rights so
        the person turns their own mic back on. Do not add an unmute caller
        without turning that server flag on deliberately, and think hard about
        why you would.
        """
        info = await self.get_participant(room_name, identity)
        audio_sids = [
            track.sid
            for track in info.tracks
            if track.type == TrackType.AUDIO
        ]
        for sid in audio_sids:
            request = MuteRoomTrackRequest(
                room=room_name,
                identity=identity,
                track_sid=sid,
                muted=muted,
            )
            await self._api.room.mute_published_track(request)
        logger.info(
            "livekit_participant_mute_changed",
            room=room_name,
            identity=identity,
            muted=muted,
            track_sids=audio_sids,
        )
        return audio_sids

    async def update_participant_permissions(
        self,
        room_name: str,
        identity: str,
        *,
        can_publish: bool | None = None,
        can_subscribe: bool | None = None,
    ) -> ParticipantInfo:
        """Update a participant's permission grants via LiveKit UpdateParticipant.

        UpdateParticipant REPLACES the whole permission message when one is
        supplied, so the current permission is read first and copied — fields
        this call does not name (can_publish_data, can_publish_sources,
        can_update_metadata, hidden, ...) keep their live values instead of
        resetting to proto defaults.

        NOTE: this state lives on the CONNECTION. A participant who leaves and
        rejoins gets whatever their next access token grants.
        """
        info = await self.get_participant(room_name, identity)
        permission = ParticipantPermission()
        permission.CopyFrom(info.permission)
        if can_publish is not None:
            permission.can_publish = can_publish
        if can_subscribe is not None:
            permission.can_subscribe = can_subscribe
        request = UpdateParticipantRequest(
            room=room_name,
            identity=identity,
            permission=permission,
        )
        updated = await self._api.room.update_participant(request)
        logger.info(
            "livekit_participant_permissions_updated",
            room=room_name,
            identity=identity,
            can_publish=can_publish,
            can_subscribe=can_subscribe,
        )
        return updated

    async def get_room_metadata(self, room_name: str) -> dict[str, Any]:
        """The room's current LiveKit metadata as a dict ({} when absent/bad)."""
        rooms = await self.list_rooms(names=[room_name])
        if not rooms:
            return {}
        raw = getattr(rooms[0], "metadata", "") or ""
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    async def update_room_metadata(self, room_name: str, metadata: str) -> None:
        """Update a LiveKit room's metadata JSON string in-place.

        The Stable agent worker reads this metadata to decide which agent class
        (and which Brigade agent, via `brigade_agent_id`) to spawn.
        """
        request = UpdateRoomMetadataRequest(room=room_name, metadata=metadata)
        await self._api.room.update_room_metadata(request)
        logger.info(
            "livekit_room_metadata_updated",
            room=room_name,
            metadata_len=len(metadata),
        )

    async def dispatch_agent(
        self,
        *,
        room_name: str,
        agent_name: str = "stable-brigade",
        metadata: dict[str, Any] | None = None,
        merge_metadata: bool = True,
    ) -> dict[str, Any]:
        """Explicitly dispatch a worker job so an agent joins the room as a
        participant (the real LiveKit in-room path).

        This is the in-room/voice leg of Stable'''s reversible-default design:
        the SERVER-SIDE text responder (services/agent_chat_responder.py) keeps
        answering TEXT, while this dispatch puts the agent into the LiveKit room
        for voice + media. The dispatched worker is told to stay silent on text
        (STABLE_TEXT_PATH_OWNS_CHAT, see agents/agent_runtime/base.py) so there
        is exactly one text reply.

        ``merge_metadata`` defaults to True because REPLACEMENT is the bug
        class: every client-triggered brigade dispatch used to overwrite the
        room's metadata wholesale, so ``voice_primary_agent_id`` vanished and
        the co-host fallback drifted to whoever was dispatched last — The
        General answered a solo host who had configured Majik.

        `agent_name` must equal the worker'''s `WorkerOptions.agent_name`
        (registered as "stable-brigade"). `metadata` is serialized into BOTH
        the dispatch and the room metadata, so the worker can read
        `brigade_agent_id` from `ctx.room.metadata` regardless of how it was
        assigned the job.
        """
        payload = dict(metadata or {})
        if merge_metadata:
            # REPLACING the room metadata drops keys another agent depends on —
            # `brigade_agent_id` above all, which is how a restarted Brigade
            # worker knows which persona it is. Losing it is what produced the
            # "green-haired Majik" persona miss. Merge instead, so a second
            # dispatch into a busy room is additive.
            try:
                existing = await self.get_room_metadata(room_name)
            except Exception:
                existing = {}
            merged = dict(existing)
            merged.update(payload)
            payload = merged
        # The ROOM copy never carries per-dispatch keys. agent_identity /
        # agent_display_name describe ONE worker's join; baked into the room
        # they leak into every LATER dispatch that falls back to room metadata
        # — which is how Majik once joined wearing the relay's identity and
        # evicted it. The dispatch itself still carries the full payload.
        room_payload = {
            k: v
            for k, v in payload.items()
            if k not in ("agent_identity", "agent_display_name")
        }
        metadata_str = json.dumps(payload)
        room_metadata_str = json.dumps(room_payload)

        # Bake metadata into the room first so the worker'''s job handler can
        # read brigade_agent_id from ctx.room.metadata. This also means that if
        # explicit dispatch fails below, an auto-accepting worker can still pick
        # the job up with the right metadata.
        try:
            await self.update_room_metadata(room_name, room_metadata_str)
        except Exception:
            logger.warning(
                "livekit_room_metadata_update_failed",
                room=room_name,
                exc_info=True,
            )

        # The installed livekit-api exposes AgentDispatchService; this branch is
        # the supported path. It is only skipped on an SDK too old to ship it.
        if not _HAS_AGENT_DISPATCH or CreateAgentDispatchRequest is None:
            logger.warning(
                "livekit_agent_dispatch_unavailable",
                note="SDK does not expose AgentDispatchService; metadata was "
                     "applied to the room but no explicit dispatch was sent. "
                     "A worker registered for this room can still auto-accept.",
            )
            return {
                "dispatched": False,
                "reason": "no_agent_dispatch_service",
                "metadata": metadata or {},
            }

        request = CreateAgentDispatchRequest(
            agent_name=agent_name,
            room=room_name,
            metadata=metadata_str,
        )
        try:
            resp = await self._api.agent_dispatch.create_dispatch(request)
        except Exception as exc:
            # Surface the failure without 500-ing the invite: the room metadata
            # is already set, so the agent is still reachable via auto-accept,
            # and the server text path keeps working regardless.
            logger.error(
                "livekit_agent_dispatch_failed",
                room=room_name,
                agent_name=agent_name,
                error=repr(exc),
                exc_info=True,
            )
            return {
                "dispatched": False,
                "reason": f"dispatch_error: {exc.__class__.__name__}",
                "agent_name": agent_name,
                "metadata": metadata or {},
            }

        dispatch_id = getattr(resp, "id", "")
        logger.info(
            "livekit_agent_dispatched",
            room=room_name,
            agent_name=agent_name,
            dispatch_id=dispatch_id,
            metadata=metadata or {},
        )
        return {
            "dispatched": True,
            "dispatch_id": dispatch_id,
            "agent_name": agent_name,
            "metadata": metadata or {},
        }

    async def send_data(
        self,
        room_name: str,
        data: dict[str, Any],
        destination_identities: list[str] | None = None,
    ) -> None:
        """Send data to participants in a LiveKit room."""
        payload = json.dumps(data).encode("utf-8")
        request = SendDataRequest(
            room=room_name,
            data=payload,
            destination_identities=destination_identities or [],
        )
        await self._api.room.send_data(request)
        logger.debug(
            "livekit_data_sent",
            room=room_name,
            data_type=data.get("type"),
            destinations=destination_identities,
        )
