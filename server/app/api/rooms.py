from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_livekit, get_presence
from app.models.room import Room, RoomMember
from app.schemas.message import MessageResponse
from app.schemas.room import (
    RoomCreate,
    RoomListResponse,
    RoomMemberResponse,
    RoomResponse,
    RoomUpdate,
)
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService
from app.services.room_service import RoomService

logger = structlog.get_logger(__name__)

router = APIRouter()


def _build_room_service(
    db: AsyncSession,
    livekit: LiveKitService,
    presence: PresenceService,
) -> RoomService:
    return RoomService(db=db, livekit=livekit, presence=presence)


def _room_to_response(room: Any, member_count: int = 0, online_count: int = 0) -> RoomResponse:
    return RoomResponse(
        id=room.id,
        name=room.name,
        display_name=room.display_name,
        description=room.description,
        room_type=room.room_type.value,
        livekit_room_name=room.livekit_room_name,
        livekit_sid=room.livekit_sid,
        max_participants=room.max_participants,
        metadata_=room.metadata_,
        is_archived=room.is_archived,
        created_by=room.created_by,
        created_at=room.created_at,
        updated_at=room.updated_at,
        member_count=member_count,
        online_count=online_count,
    )


DEFAULT_BUSINESS_ROOMS = [
    # name (slug), display_name, description
    ("general", "General", "Company-wide announcements and water cooler."),
    ("accounting", "Accounting", "Bookkeeping, invoices, AP/AR, with Col. Finance."),
    ("sales", "Sales", "Pipeline, proposals, customer outreach."),
    ("marketing", "Marketing", "Campaigns, content, brand."),
    ("engineering", "Engineering", "Build + ship. Code reviews, deploys, incidents."),
    ("product", "Product", "Roadmap, specs, research."),
    ("operations", "Operations", "Infrastructure, tooling, vendor management."),
    ("hr-people", "HR & People", "Hiring, culture, benefits."),
    ("legal", "Legal", "Contracts, compliance, IP."),
    ("leadership", "Leadership", "Exec sync, strategy, OKRs."),
]


@router.post("/rooms/bootstrap-defaults", response_model=list[RoomResponse])
async def bootstrap_default_rooms(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> list[RoomResponse]:
    """One-shot: create standard business channels the caller owns.

    Skips any rooms the caller is already a member of (name-matched), so it's
    safe to call more than once.
    """
    svc = _build_room_service(db, livekit, presence)

    # Rooms the user already belongs to (any page) — skip name collisions.
    existing = await svc.list_rooms_for_user(
        participant_id=user["participant_id"], cursor=None, limit=100
    )
    existing_names = {r["room"].name for r in existing["rooms"]}

    created: list[RoomResponse] = []
    for name, display_name, description in DEFAULT_BUSINESS_ROOMS:
        if name in existing_names:
            continue
        try:
            room = await svc.create_room(
                name=name,
                display_name=display_name,
                room_type="channel",
                creator_id=user["participant_id"],
                description=description,
            )
            created.append(_room_to_response(room, member_count=1, online_count=1))
        except Exception:
            logger.warning("bootstrap_room_create_failed", name=name, exc_info=True)

    logger.info(
        "bootstrap_default_rooms",
        participant_id=str(user["participant_id"]),
        created_count=len(created),
    )
    return created


@router.post("/rooms", response_model=RoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Create a new room."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.create_room(
        name=body.name,
        display_name=body.display_name,
        room_type=body.room_type,
        creator_id=user["participant_id"],
        description=body.description,
        max_participants=body.max_participants,
    )
    return _room_to_response(room, member_count=1, online_count=1)


@router.get("/rooms/browse", response_model=list[RoomResponse])
async def browse_channels(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    q: str = Query("", max_length=100),
    limit: int = Query(50, ge=1, le=200),
) -> list[RoomResponse]:
    """List channels (room_type=channel) the caller is NOT yet a member of.

    Used by the channel browser. DMs and group_dms are intentionally excluded.
    """
    from sqlalchemy import and_, not_, select as _select

    from app.models.room import Room as _Room, RoomMember as _RM, RoomType as _RT

    member_subq = _select(_RM.room_id).where(
        _RM.participant_id == user["participant_id"]
    )
    stmt = _select(_Room).where(
        _Room.room_type == _RT.CHANNEL,
        _Room.is_archived == False,  # noqa: E712
        not_(_Room.id.in_(member_subq)),
    )
    if q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            (_Room.display_name.ilike(like)) | (_Room.name.ilike(like))
        )
    stmt = stmt.order_by(_Room.display_name).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()

    _ = (livekit, presence)  # unused; kept for parity
    return [_room_to_response(r, member_count=0, online_count=0) for r in rows]


@router.get("/rooms", response_model=RoomListResponse)
async def list_rooms(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> RoomListResponse:
    """List rooms the current user is a member of."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.list_rooms_for_user(
        participant_id=user["participant_id"],
        cursor=cursor,
        limit=limit,
    )
    rooms = [
        _room_to_response(r["room"], r["member_count"], r["online_count"])
        for r in result["rooms"]
    ]
    return RoomListResponse(
        rooms=rooms,
        total=result["total"],
        cursor=result["cursor"],
    )


@router.get("/rooms/{room_id}", response_model=RoomResponse)
async def get_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Get room details."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.get_room(room_id)
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
    )


@router.patch("/rooms/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: uuid.UUID,
    body: RoomUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Update room details. Requires admin or owner role."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.update_room(
        room_id=room_id,
        participant_id=user["participant_id"],
        display_name=body.display_name,
        description=body.description,
        is_archived=body.is_archived,
    )
    result = await svc.get_room(room_id)
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
    )


@router.delete("/rooms/{room_id}", response_model=RoomResponse)
async def archive_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Archive a room. Requires owner role."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.archive_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )
    return _room_to_response(room)


@router.post("/rooms/{room_id}/join", response_model=RoomMemberResponse)
async def join_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Join a room as a member."""
    svc = _build_room_service(db, livekit, presence)
    membership = await svc.join_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )
    return RoomMemberResponse(
        id=membership.id,
        participant_id=membership.participant_id,
        username=user.get("username"),
        display_name=user.get("display_name"),
        participant_type=user.get("participant_type"),
        role=membership.role.value,
        joined_at=membership.joined_at,
        last_read_at=membership.last_read_at,
        is_muted=membership.is_muted,
        status="online",
    )


class InviteMemberBody(BaseModel):
    # Either a local Participant id (user has signed in before) or a
    # Keycloak sub (user exists in the realm, never signed into Stable).
    participant_id: uuid.UUID | None = None
    keycloak_sub: str | None = None


@router.post("/rooms/{room_id}/invite", response_model=RoomMemberResponse)
async def invite_member(
    room_id: uuid.UUID,
    body: InviteMemberBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Invite a user into a room.

    Accepts either `participant_id` (user has Stable account) or `keycloak_sub`
    (user exists in Keycloak but never signed into Stable — we create the
    Participant row on their behalf). Caller must be a member of the room.
    """
    from app.api.users import resolve_or_create_participant
    from app.config import get_settings
    from app.models.participant import Participant as P

    if body.participant_id is None and body.keycloak_sub is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Must provide participant_id or keycloak_sub",
        )

    svc = _build_room_service(db, livekit, presence)

    # Caller must be in the room.
    caller_member = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_id == user["participant_id"],
        )
    )
    if caller_member.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of this room to invite others",
        )

    # Resolve target Participant — create on-demand from Keycloak if needed.
    if body.participant_id is not None:
        target = (
            await db.execute(select(P).where(P.id == body.participant_id))
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
            )
    else:
        try:
            target = await resolve_or_create_participant(
                db, get_settings(), body.keycloak_sub or ""
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
            )

    membership = await svc.join_room(
        room_id=room_id,
        participant_id=target.id,
        role="member",
    )

    # Auto-promote a DM (2 people) → group_dm once a 3rd person is added.
    try:
        from app.models.room import RoomType as _RT

        room_row = (
            await db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        if room_row is not None and room_row.room_type == _RT.DM:
            count = (
                await db.execute(
                    select(RoomMember).where(RoomMember.room_id == room_id)
                )
            ).scalars().all()
            if len(count) >= 3:
                room_row.room_type = _RT.GROUP_DM
                await db.commit()
    except Exception:
        logger.warning("dm_promote_failed", exc_info=True)

    # Fire-and-forget invite email. If SMTP isn't configured or fails, the
    # invite itself still succeeds — the user just won't get notified until
    # they sign in and see the channel in their sidebar.
    import asyncio as _asyncio

    async def _send_invite_email() -> None:
        try:
            from app.api.users import _load_keycloak_email_for_sub
            from app.config import get_settings
            from app.services.email_sender import GraphEmailSender

            cfg = get_settings()
            sender = GraphEmailSender(
                tenant_id=cfg.ms_graph_tenant_id,
                client_id=cfg.ms_graph_client_id,
                client_secret=cfg.ms_graph_client_secret,
                from_address=cfg.ms_graph_from_address,
            )
            if not sender.is_configured:
                return

            # Room we just joined to — fetch for name
            room_row = (
                await db.execute(select(Room).where(Room.id == room_id))
            ).scalar_one_or_none()
            room_display = (
                room_row.display_name if room_row else "a channel"
            )

            inviter_name = user.get("display_name") or user.get("username") or "Someone"
            to_email = await _load_keycloak_email_for_sub(
                target.keycloak_sub
            )
            if not to_email:
                return

            link = cfg.public_base_url
            subject = f"{inviter_name} invited you to {room_display} on Stable"
            html = f"""
<!doctype html>
<html>
  <body style="font-family: -apple-system, system-ui, sans-serif; color: #1e293b; line-height: 1.5;">
    <p>Hi {target.display_name or target.username},</p>
    <p><strong>{inviter_name}</strong> added you to
       <strong>{room_display}</strong> on Stable — a workspace where people and
       AI agents collaborate in the same room.</p>
    <p><a href="{link}" style="display:inline-block;padding:10px 18px;
         background:#7c3aed;color:#fff;text-decoration:none;border-radius:6px;">
         Open Stable</a></p>
    <p style="font-size: 13px; color: #64748b;">
       Sign in with your UC-1 Hub account. If this is your first visit, you
       can register from the sign-in page.
    </p>
  </body>
</html>
"""
            reply_to = user.get("email") if isinstance(user, dict) else None
            await sender.send(
                to=to_email,
                subject=subject,
                html_body=html,
                reply_to=reply_to,
            )
        except Exception:
            logger.warning("invite_email_error", exc_info=True)

    _asyncio.create_task(_send_invite_email())

    # Also emit a WS notification to the invitee (if they're online)
    try:
        from app.ws.handler import manager as ws_manager

        await ws_manager.send_to_participant(
            str(target.id),
            {
                "type": "room_invited",
                "room_id": str(room_id),
                "inviter_name": user.get("display_name") or user.get("username"),
            },
        )
    except Exception:
        logger.debug("ws_invite_notify_failed", exc_info=True)

    return RoomMemberResponse(
        id=membership.id,
        participant_id=membership.participant_id,
        username=target.username,
        display_name=target.display_name,
        participant_type=target.participant_type.value,
        role=membership.role.value,
        joined_at=membership.joined_at,
        last_read_at=membership.last_read_at,
        is_muted=membership.is_muted,
        status="online",
    )


class PinBody(BaseModel):
    message_id: uuid.UUID


@router.post("/rooms/{room_id}/pins", response_model=list[str])
async def toggle_pin(
    room_id: uuid.UUID,
    body: PinBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[str]:
    """Toggle pin/unpin for a message in a room.

    Stored as ``room.metadata_.pinned_message_ids`` (list of strings, newest
    first). Idempotent: posting twice with the same id removes it.
    """
    from app.models.message import Message as _Msg
    from app.ws.handler import manager as _ws_manager

    # Caller must be a member of the room
    caller = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_id == user["participant_id"],
        )
    )
    if caller.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this room",
        )

    # Confirm message belongs to room
    msg = (
        await db.execute(
            select(_Msg).where(_Msg.id == body.message_id, _Msg.room_id == room_id)
        )
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not in this room")

    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    meta = dict(room.metadata_ or {})
    pinned: list[str] = list(meta.get("pinned_message_ids") or [])
    mid = str(body.message_id)
    if mid in pinned:
        pinned.remove(mid)
    else:
        pinned.insert(0, mid)
        pinned = pinned[:50]  # cap at 50 pins per channel
    meta["pinned_message_ids"] = pinned
    room.metadata_ = meta
    await db.commit()

    # Fanout to room members
    try:
        member_ids = (
            await db.execute(
                select(RoomMember.participant_id).where(RoomMember.room_id == room_id)
            )
        ).scalars().all()
        await _ws_manager.broadcast_to_room(
            [str(m) for m in member_ids],
            {
                "type": "pins_changed",
                "room_id": str(room_id),
                "pinned_message_ids": pinned,
            },
        )
    except Exception:
        logger.warning("pin_fanout_failed", exc_info=True)

    return pinned


@router.get("/rooms/{room_id}/pins", response_model=list[MessageResponse])
async def list_pins(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> list[Any]:
    """Return the pinned messages for a room, newest pin first."""
    from app.api.messages import _msg_to_response
    from app.models.message import Message as _Msg

    caller = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_id == user["participant_id"],
        )
    )
    if caller.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this room",
        )
    _ = livekit  # injected for parity; not used here
    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        return []
    pinned: list[str] = list((room.metadata_ or {}).get("pinned_message_ids") or [])
    if not pinned:
        return []
    rows = (
        await db.execute(select(_Msg).where(_Msg.id.in_(pinned)))
    ).scalars().all()
    by_id = {str(m.id): m for m in rows}
    ordered = [by_id[mid] for mid in pinned if mid in by_id]
    # eager-load sender for the response
    return [_msg_to_response(m) for m in ordered]


@router.post("/rooms/{room_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> None:
    """Leave a room."""
    svc = _build_room_service(db, livekit, presence)
    await svc.leave_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )


@router.get("/rooms/{room_id}/members", response_model=list[RoomMemberResponse])
async def list_members(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> list[RoomMemberResponse]:
    """List members of a room."""
    svc = _build_room_service(db, livekit, presence)
    members = await svc.get_members(room_id)
    return [
        RoomMemberResponse(
            id=m["id"],
            participant_id=m["participant_id"],
            username=m["username"],
            display_name=m["display_name"],
            participant_type=m["participant_type"],
            role=m["role"],
            joined_at=m["joined_at"],
            last_read_at=m["last_read_at"],
            is_muted=m["is_muted"],
            status=m["status"],
        )
        for m in members
    ]
