from __future__ import annotations

import json
from typing import Any

import structlog
from livekit.api import AccessToken, LiveKitAPI, VideoGrants
from livekit.api.room_service import CreateRoomRequest, DeleteRoomRequest, ListRoomsRequest
from livekit.api.room_service import MuteRoomParticipantRequest, RoomParticipantIdentity
from livekit.api.room_service import SendDataRequest
from livekit.protocol.room import Room as LKRoom

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
            .with_ttl(ttl)
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
        request = MuteRoomParticipantRequest(
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
