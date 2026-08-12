from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from livekit.api import VideoGrants
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    ensure_guest_room_scope,
    get_db,
    get_guest_or_member,
    get_livekit,
    get_settings_dep,
    is_guest,
    rate_limit_principal,
)
from app.models.room import Room, RoomMember
from app.schemas.auth import TokenRequest, TokenResponse
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


def livekit_identity(username: str, participant_id: Any) -> str:
    """The canonical LiveKit identity for a Stable participant.

    Factored out of the handler because it is a CONTRACT, not a formatting
    detail: ``webhooks._extract_participant_id`` parses it back with
    ``rsplit("_", 1)`` to attribute presence and call occupancy, and
    ``api/guests.py`` must rebuild the exact same string to evict a revoked
    guest from LiveKit. Two hand-rolled copies of this f-string would drift and
    the eviction would silently no-op.
    """
    return f"{username}_{participant_id}"


@router.post("/tokens/livekit", response_model=TokenResponse)
async def generate_livekit_token(
    body: TokenRequest,
    user: Annotated[dict[str, Any], Depends(get_guest_or_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[
        None,
        Depends(rate_limit_principal("token_mint", "rate_limit_token_mint_per_min")),
    ] = None,
) -> TokenResponse:
    """Generate a LiveKit access token for the caller to join a room.

    GUEST-REACHABLE (opt-in). A guest is a guest ON the show, so camera and mic
    are the entire point — but they get a token for THEIR room only, and the
    grant is built explicitly from the invite's ``can_publish`` rather than
    inherited from the service default, so a watch-only invite stays
    watch-only. The room scope is checked against the resolved Room, so a slug
    or LiveKit name cannot be used to sidestep it.
    """
    # Find the room by UUID id, LiveKit room name, or (slug) name. The web
    # client sends the room UUID, so the id match is what makes voice join work.
    conds = [Room.livekit_room_name == body.room_name, Room.name == body.room_name]
    try:
        conds.append(Room.id == uuid.UUID(body.room_name))
    except (ValueError, TypeError):
        pass
    result = await db.execute(select(Room).where(or_(*conds)))
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Room not found",
        )

    # Gate 1 (guests only): the credential itself must name THIS room. Checked
    # against the resolved room id, so passing a slug or livekit_room_name for
    # some other room cannot slip past.
    ensure_guest_room_scope(user, room.id)

    # Gate 2 (everyone): ordinary room membership.
    membership_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room.id,
            RoomMember.participant_id == user["participant_id"],
        )
    )
    if membership_result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of this room to get a token",
        )

    caller_is_guest = is_guest(user)
    ttl = int(settings.livekit_token_ttl_seconds or 3600)
    grants: VideoGrants | None = None
    if caller_is_guest:
        # A LiveKit token that outlived its authorizing guest session would
        # leave a revoked guest publishing until LiveKit's own clock ran out —
        # the same failure mode broadcast.py caps for. Clamp to whichever is
        # sooner; revocation additionally evicts them from the room outright.
        expires_at = user.get("guest_expires_at")
        if isinstance(expires_at, datetime):
            remaining = int(
                (expires_at - datetime.now(timezone.utc)).total_seconds()
            )
            ttl = max(60, min(ttl, remaining))
        # Explicit, not inherited. The service default grants publish to
        # everyone; a guest's A/V permission must come from the invite it was
        # issued under, and a watch-only invite has to stay watch-only. Room is
        # pinned to the one room they are scoped to; no room_admin, no
        # room_create, no room_list.
        can_publish = bool(user.get("guest_can_publish"))
        grants = VideoGrants(
            room_join=True,
            room=room.livekit_room_name,
            can_publish=can_publish,
            can_publish_data=can_publish,
            can_subscribe=True,
        )
        logger.info(
            "guest_livekit_token_issued",
            room=room.livekit_room_name,
            session_id=str(user.get("guest_session_id")),
            can_publish=can_publish,
            ttl=ttl,
        )

    # The participant's identity. Guest usernames are `guest-<hex>` — no
    # underscore — so the webhook parser still recovers the participant UUID
    # and guest presence/occupancy behaves like anyone else's.
    identity = livekit_identity(user["username"], user["participant_id"])
    token = livekit.generate_token(
        room_name=room.livekit_room_name,
        identity=identity,
        name=body.participant_name or user.get("display_name") or user["username"],
        grants=grants,
        ttl=ttl,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )

    logger.info(
        "livekit_token_issued",
        room=room.livekit_room_name,
        identity=identity,
        guest=caller_is_guest,
    )

    return TokenResponse(
        token=token,
        ws_url=settings.livekit_public_url or settings.livekit_url,
        room_name=room.livekit_room_name,
        participant_name=body.participant_name or user.get("display_name") or user["username"],
    )
