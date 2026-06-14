from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import structlog
from livekit.api import AccessToken, LiveKitAPI, VideoGrants
from livekit.api.room_service import CreateRoomRequest, DeleteRoomRequest, ListRoomsRequest
from livekit.api.room_service import MuteRoomTrackRequest, RoomParticipantIdentity
from livekit.api.room_service import SendDataRequest, UpdateRoomMetadataRequest
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

    async def mute_participant(
        self, room_name: str, identity: str, muted: bool
    ) -> None:
        """Mute or unmute a participant in a LiveKit room."""
        request = MuteRoomTrackRequest(
            room=room_name,
            identity=identity,
            muted=muted,
        )
        await self._api.room.mute_published_track(request)
        logger.info(
            "livekit_participant_mute_changed",
            room=room_name,
            identity=identity,
            muted=muted,
        )

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
    ) -> dict[str, Any]:
        """Dispatch a worker job to a room so an agent joins as a participant.

        `agent_name` is the `WorkerOptions.agent_name` the worker registered
        with. `metadata` is serialized into the dispatch and also the room so
        the worker can read which Brigade agent to act as.
        """
        metadata_str = json.dumps(metadata or {})

        # Also bake metadata into the room so the worker's job handler can
        # read brigade_agent_id from ctx.room.metadata.
        try:
            await self.update_room_metadata(room_name, metadata_str)
        except Exception:
            logger.warning(
                "livekit_room_metadata_update_failed",
                room=room_name,
                exc_info=True,
            )

        if not _HAS_AGENT_DISPATCH or CreateAgentDispatchRequest is None:
            logger.warning(
                "livekit_agent_dispatch_unavailable",
                note="SDK does not expose AgentDispatchService; metadata was "
                     "applied to the room but no explicit dispatch was sent. "
                     "Workers with auto_accept will still pick up the job.",
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
        resp = await self._api.agent_dispatch.create_dispatch(request)
        logger.info(
            "livekit_agent_dispatched",
            room=room_name,
            agent_name=agent_name,
            dispatch_id=getattr(resp, "id", ""),
            metadata=metadata or {},
        )
        return {
            "dispatched": True,
            "dispatch_id": getattr(resp, "id", ""),
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
