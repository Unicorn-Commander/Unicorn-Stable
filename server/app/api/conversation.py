"""Conversation-model routes (design §3, §4, §9): agent hubs, threads,
per-member agent mode, invite links, and the context endpoint.

Authorization posture, in one place:

* every route names ``get_current_user`` (or ``require_room_member``) — no
  guest, broadcast or gateway credential reaches any of them (the gateway
  gets its own mirror of ``/context`` in ``api/gateway.py``);
* hubs are ensured for the CALLER only (``human_id = user.participant_id``);
* threads require membership of the parent;
* member settings require owner/admin (a room-control gateway key is admitted
  through ``get_room_controller``, the same door as voice settings);
* invite links: any member of a PUBLIC channel; owner/admin of anything
  private (private channel, group, hub); never on a 1:1 DM (409 — use
  start-group). Unknown / revoked / expired / exhausted tokens are a uniform
  404 so the route is not a token oracle.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.rooms import (
    _broadcast_members_changed,
    _build_room_service,
    _member_response_for,
    _room_to_response,
)
from app.auth.gateway_auth import hash_key
from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_livekit,
    get_presence,
    get_room_controller,
    get_settings_dep,
    is_control_key,
    rate_limit,
    require_room_member,
)
from app.models.agent import AgentEvent
from app.models.participant import Participant
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.models.room_invite import RoomInvite
from app.schemas.room import (
    AgentHubResponse,
    ContextResponse,
    ConvertToChannelBody,
    InvitePreviewResponse,
    MemberSettingsBody,
    ProjectChannelBody,
    ProjectChannelResponse,
    ProjectTasksResponse,
    RoomInviteCreate,
    RoomInviteResponse,
    RoomMemberResponse,
    RoomResponse,
    ThreadCreate,
)
from app.services.agent_access import ensure_agent_access
from app.services.context_builder import DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS, build_context
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService
from app.services.project_channels import (
    fetch_open_tasks,
    fetch_project,
    normalize_project_number,
)
from app.services.room_push import push_room_to_participants
from app.ws import events as ws_events

logger = structlog.get_logger(__name__)

router = APIRouter()

INVITE_TOKEN_PREFIX = "sri-"
DEFAULT_INVITE_HOURS = 24 * 7
MAX_INVITE_HOURS = 24 * 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


def mint_invite_token() -> str:
    return f"{INVITE_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"


async def _ws_room(db: AsyncSession, room_id: Any, event_type: str, payload: dict[str, Any]) -> None:
    try:
        from app.api.messages import _ws_broadcast_room

        await _ws_broadcast_room(db, room_id, {"type": event_type, "payload": payload})
    except Exception:
        logger.warning("contract_event_fanout_failed", event=event_type, exc_info=True)


async def _room_response(svc, room: Room) -> RoomResponse:
    result = await svc.get_room(room.id)
    extras = await svc.room_extras(result["room"])
    return _room_to_response(
        result["room"], result["member_count"], result["online_count"], **extras
    )


async def _fanout_message(db: AsyncSession, message: Any) -> None:
    """Deliver a server-made message (a thread's system line / seed quote)
    over the ws plane in the same ``{type: "message"}`` shape the send route
    uses, so open clients render it live. Best-effort."""
    if message is None:
        return
    try:
        from app.api.messages import _msg_to_response, _ws_broadcast_room

        await _ws_broadcast_room(
            db,
            message.room_id,
            {
                "type": "message",
                "payload": {
                    "room_id": str(message.room_id),
                    "message": _msg_to_response(message).model_dump(mode="json"),
                },
            },
        )
    except Exception:
        logger.warning("server_message_fanout_failed", exc_info=True)


def _actor_name(user: dict[str, Any]) -> str | None:
    return user.get("display_name") or user.get("username")


# ---------------------------------------------------------------------------
# Agent hubs
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/hub",
    response_model=AgentHubResponse,
    status_code=status.HTTP_200_OK,
)
async def ensure_agent_hub(
    agent_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))],
) -> AgentHubResponse:
    """Find-or-create the caller's hub with ``agent_id`` (idempotent).

    Replaces "New chat" minting a room per conversation: "Talk to <agent>"
    opens the hub; new conversations are THREADS under it
    (``POST /rooms/{hub_id}/threads``).
    """
    # ENTITLEMENT: the same funnel every human path that establishes agent
    # access goes through (agent invite, the deprecated agent-DM bind, voice
    # dispatch) — a hub is agent access.
    await ensure_agent_access(db, user, (agent_id or "").strip().lower(), surface="agent_hub")

    svc = _build_room_service(db, livekit, presence)
    room, created = await svc.ensure_agent_hub(
        human_id=user["participant_id"],
        agent_id=agent_id,
        org_id=settings.instance_org_id,
    )
    if created:
        # The caller's OTHER devices learn about the hub now (L2 item 7).
        await push_room_to_participants(
            [user["participant_id"]],
            room_id=room.id,
            kind="hub",
            self_id=user["participant_id"],
            display_name=room.display_name,
            room_type=room.room_type.value,
        )
    base = await _room_response(svc, room)
    return AgentHubResponse(**base.model_dump(by_alias=True), created=created)


# ---------------------------------------------------------------------------
# Threads
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/threads",
    response_model=RoomResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_thread(
    room_id: uuid.UUID,
    body: ThreadCreate,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))],
) -> RoomResponse:
    """Start a thread (child room) under ``room_id`` — any room type, any
    member. Fans out ``thread_created`` + the parent's system line to the
    parent, the seed quote to the thread, and pushes the new room to every
    seeded member's sockets (``room_invited``, kind=thread)."""
    svc = _build_room_service(db, livekit, presence)
    made = await svc.create_thread(
        parent_id=room_id,
        creator_id=user["participant_id"],
        title=body.title,
        seed_message_id=body.seed_message_id,
    )
    thread = made.room
    await _ws_room(
        db,
        room_id,
        ws_events.THREAD_CREATED,
        {
            "parent_room_id": str(room_id),
            "room_id": str(thread.id),
            "display_name": thread.display_name,
            "created_by": str(user["participant_id"]),
            "seed_message_id": str(body.seed_message_id) if body.seed_message_id else None,
            "member_ids": [str(pid) for pid in made.member_ids],
        },
    )
    await _fanout_message(db, made.system_message)
    await _fanout_message(db, made.seed_message)
    await push_room_to_participants(
        made.member_ids,
        room_id=thread.id,
        kind="thread",
        inviter_name=_actor_name(user),
        self_id=user["participant_id"],
        parent_room_id=room_id,
        display_name=thread.display_name,
        room_type=thread.room_type.value,
    )
    return await _room_response(svc, thread)


@router.get("/rooms/{room_id}/threads", response_model=list[RoomResponse])
async def list_threads(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    include_archived: bool = Query(False),
) -> list[RoomResponse]:
    """Threads under ``room_id`` that the caller can see (membership of the
    parent is required; each thread row is still membership-scoped for
    reads elsewhere)."""
    svc = _build_room_service(db, livekit, presence)
    threads = await svc.list_threads(room_id, include_archived=include_archived)
    if not threads:
        return []
    extras = await svc._conversation_extras(threads)
    return [
        _room_to_response(t, member_count=len(t.members or []), **extras.get(str(t.id), {}))
        for t in threads
    ]


# ---------------------------------------------------------------------------
# Member settings (agent mode / context depth)
# ---------------------------------------------------------------------------


@router.patch(
    "/rooms/{room_id}/members/{participant_id}",
    response_model=RoomMemberResponse,
)
async def set_member_settings(
    room_id: uuid.UUID,
    participant_id: uuid.UUID,
    body: MemberSettingsBody,
    user: Annotated[dict[str, Any], Depends(get_room_controller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Set an agent member's ``agent_mode`` and/or a member's
    ``context_depth``. Owner/admin, or a room-control gateway key."""
    if body.agent_mode is None and body.context_depth is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nothing to change",
        )
    svc = _build_room_service(db, livekit, presence)
    controller = is_control_key(user)
    membership = await svc.set_member_settings(
        room_id=room_id,
        actor_id=None if controller else user["participant_id"],
        target_participant_id=participant_id,
        agent_mode=body.agent_mode,
        context_depth=body.context_depth,
        actor_is_controller=controller,
    )
    await _ws_room(
        db,
        room_id,
        ws_events.MEMBER_MODE,
        {
            "room_id": str(room_id),
            "participant_id": str(participant_id),
            "agent_mode": membership.agent_mode,
            "context_depth": membership.context_depth,
        },
    )
    return await _member_response_for(svc, room_id, participant_id)


# ---------------------------------------------------------------------------
# Invite links
# ---------------------------------------------------------------------------


async def _load_room(db: AsyncSession, room_id: uuid.UUID) -> Room:
    room = (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


async def _require_invite_manager(db: AsyncSession, room: Room, user: dict[str, Any]) -> RoomMember:
    """Who may mint/list/revoke links for this room (module docstring)."""
    membership = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this room")
    if room.room_type == RoomType.DM:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A 1:1 conversation has no invite links; start a group instead",
        )
    is_public_channel = room.room_type == RoomType.CHANNEL and getattr(room, "visibility", "public") == "public"
    if not is_public_channel and membership.role not in (MemberRole.OWNER, MemberRole.ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the room owner or an admin may manage invite links here",
        )
    return membership


def _invite_out(row: RoomInvite) -> RoomInviteResponse:
    return RoomInviteResponse(
        id=row.id,
        room_id=row.room_id,
        token_prefix=row.token_prefix,
        role=row.role,
        expires_at=row.expires_at,
        max_uses=row.max_uses,
        use_count=row.use_count,
        revoked_at=row.revoked_at,
        created_at=row.created_at,
        created_by=row.created_by,
    )


def invite_is_usable(row: RoomInvite, now: datetime | None = None) -> bool:
    now = now or _now()
    if row.revoked_at is not None:
        return False
    if row.expires_at is not None and row.expires_at <= now:
        return False
    if row.max_uses is not None and row.use_count >= row.max_uses:
        return False
    return True


@router.post(
    "/rooms/{room_id}/invites",
    response_model=RoomInviteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def mint_room_invite(
    room_id: uuid.UUID,
    body: RoomInviteCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _rl: Annotated[None, Depends(rate_limit("room_invite", "rate_limit_room_invite_per_min"))],
) -> RoomInviteResponse:
    """Mint an invite link. Raw token is returned ONCE; only its hash is stored."""
    room = await _load_room(db, room_id)
    await _require_invite_manager(db, room, user)
    if room.is_archived:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This room is archived")

    hours = int(body.expires_hours or DEFAULT_INVITE_HOURS)
    hours = max(1, min(hours, MAX_INVITE_HOURS))
    raw = mint_invite_token()
    row = RoomInvite(
        token_hash=hash_key(raw),
        token_prefix=raw[:12],
        room_id=room_id,
        created_by=user["participant_id"],
        role=body.role,
        expires_at=_now() + timedelta(hours=hours),
        max_uses=body.max_uses,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "room_invite_minted",
        room_id=str(room_id),
        token_prefix=row.token_prefix,  # prefix only — never the raw token
        role=row.role,
        hours=hours,
        max_uses=row.max_uses,
    )
    await _ws_room(
        db,
        room_id,
        ws_events.INVITE_CREATED,
        {
            "room_id": str(room_id),
            "token_prefix": row.token_prefix,
            "role": row.role,
            "expires_at": row.expires_at.isoformat(),
            "created_by": str(user["participant_id"]),
        },
    )
    out = _invite_out(row)
    out.token = raw
    out.url_path = f"/join/{raw}"
    return out


@router.get("/rooms/{room_id}/invites", response_model=list[RoomInviteResponse])
async def list_room_invites(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    include_dead: bool = Query(False, description="Include revoked/expired/exhausted links"),
) -> list[RoomInviteResponse]:
    room = await _load_room(db, room_id)
    await _require_invite_manager(db, room, user)
    rows = (
        await db.execute(
            select(RoomInvite).where(RoomInvite.room_id == room_id).order_by(RoomInvite.created_at.desc())
        )
    ).scalars().all()
    now = _now()
    return [_invite_out(r) for r in rows if include_dead or invite_is_usable(r, now)]


@router.delete("/rooms/{room_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_room_invite(
    room_id: uuid.UUID,
    invite_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    room = await _load_room(db, room_id)
    await _require_invite_manager(db, room, user)
    row = (
        await db.execute(
            select(RoomInvite).where(RoomInvite.id == invite_id, RoomInvite.room_id == room_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    if row.revoked_at is None:
        row.revoked_at = _now()
        await db.commit()
    logger.info("room_invite_revoked", room_id=str(room_id), token_prefix=row.token_prefix)


async def _lookup_usable_invite(db: AsyncSession, token: str) -> RoomInvite:
    """Uniform 404 for unknown / revoked / expired / exhausted."""
    token = (token or "").strip()
    if not token.startswith(INVITE_TOKEN_PREFIX) or len(token) < 20:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    row = (
        await db.execute(select(RoomInvite).where(RoomInvite.token_hash == hash_key(token)))
    ).scalar_one_or_none()
    if row is None or not invite_is_usable(row):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    return row


@router.get("/invites/{token}", response_model=InvitePreviewResponse)
async def preview_invite(
    token: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvitePreviewResponse:
    """What a signed-in user sees before accepting: the room, the role, the
    inviter, and whether they are already in."""
    row = await _lookup_usable_invite(db, token)
    room = await _load_room(db, row.room_id)
    member_count = int(
        (
            await db.execute(select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room.id))
        ).scalar()
        or 0
    )
    inviter = None
    if row.created_by is not None:
        inviter = (
            await db.execute(select(Participant.display_name).where(Participant.id == row.created_by))
        ).scalar_one_or_none()
    already = (
        await db.execute(
            select(RoomMember.id).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none() is not None
    return InvitePreviewResponse(
        room_id=room.id,
        display_name=room.display_name,
        room_type=room.room_type.value,
        visibility=getattr(room, "visibility", "public"),
        member_count=member_count,
        role=row.role,
        expires_at=row.expires_at,
        inviter_display_name=inviter,
        already_member=already,
    )


@router.post("/invites/{token}/accept", response_model=RoomMemberResponse)
async def accept_invite(
    token: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[None, Depends(rate_limit("room_invite", "rate_limit_room_invite_per_min"))] = None,
) -> RoomMemberResponse:
    """Join the room the link points at. Idempotent for existing members.
    Rate-limited like minting, so a token cannot be guessed at speed."""
    # Lock the row so two concurrent accepts of a max_uses=1 link cannot both
    # win; the usability check re-runs under the lock.
    token = (token or "").strip()
    if not token.startswith(INVITE_TOKEN_PREFIX) or len(token) < 20:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    row = (
        await db.execute(
            select(RoomInvite).where(RoomInvite.token_hash == hash_key(token)).with_for_update()
        )
    ).scalar_one_or_none()
    if row is None or not invite_is_usable(row):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    room = await _load_room(db, row.room_id)
    if room.is_archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")

    svc = _build_room_service(db, livekit, presence)
    existing = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        # self_join=False: this IS the authorized add; the link is the invite.
        await svc.join_room(
            room_id=room.id,
            participant_id=user["participant_id"],
            role=row.role,
            self_join=False,
        )
        row.use_count = int(row.use_count or 0) + 1
        await db.commit()
        logger.info(
            "room_invite_accepted",
            room_id=str(room.id),
            token_prefix=row.token_prefix,
            participant_id=str(user["participant_id"]),
            use_count=row.use_count,
        )
        await _broadcast_members_changed(db, room.id)
        # The joiner's OWN sockets (every device) get the room now — the
        # accept happened on one of them; the others must not need a
        # restart (L2 item 7). inviter_name = whoever minted the link.
        inviter_name = None
        if row.created_by is not None:
            inviter_name = (
                await db.execute(select(Participant.display_name).where(Participant.id == row.created_by))
            ).scalar_one_or_none()
        await push_room_to_participants(
            [user["participant_id"]],
            room_id=room.id,
            kind="invite",
            inviter_name=inviter_name if isinstance(inviter_name, str) else None,
            display_name=room.display_name,
            room_type=room.room_type.value,
        )
    else:
        await db.commit()
    return await _member_response_for(svc, room.id, user["participant_id"])


# ---------------------------------------------------------------------------
# Project channels (design §3, L2 item 5)
# ---------------------------------------------------------------------------


@router.post("/rooms/for-project", response_model=ProjectChannelResponse)
async def ensure_project_channel(
    body: ProjectChannelBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))] = None,
) -> ProjectChannelResponse:
    """Ensure the private channel bound to a Project-Ops project
    (``p-<number>-<slug>``, display ``P-00115 · <title>``). Idempotent: the
    creator owns a new one; a later caller joins the existing one. The title
    comes from Project-Ops through the server's service client (never the
    browser's credential); 404 for an unknown number, 502 when Project-Ops
    cannot be reached."""
    number = normalize_project_number(body.project_number)
    if number is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_number must look like P-00115",
        )
    project = await fetch_project(number)
    svc = _build_room_service(db, livekit, presence)
    room, created = await svc.ensure_project_channel(
        creator_id=user["participant_id"],
        project_number=number,
        project=project,
        org_id=settings.instance_org_id,
    )
    if created:
        await push_room_to_participants(
            [user["participant_id"]],
            room_id=room.id,
            kind="project_channel",
            self_id=user["participant_id"],
            display_name=room.display_name,
            room_type=room.room_type.value,
        )
    base = await _room_response(svc, room)
    return ProjectChannelResponse(**base.model_dump(by_alias=True), created=created)


@router.get("/rooms/{room_id}/tasks", response_model=ProjectTasksResponse)
async def list_project_tasks(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ProjectTasksResponse:
    """Open tasks of the project this room is bound to (server proxy over
    the Project-Ops service client, cached 60 s per project). Members only;
    404 for a room with no binding."""
    room = await _load_room(db, room_id)
    number = normalize_project_number(getattr(room, "project_number", None))
    if number is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This room is not bound to a Project-Ops project",
        )
    payload = await fetch_open_tasks(number, dashboard_url=settings.projectops_dashboard_url)
    return ProjectTasksResponse(room_id=room.id, **payload)


# ---------------------------------------------------------------------------
# Group DM → private channel (design §3, L2 item 6)
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/convert-to-channel", response_model=RoomResponse)
async def convert_group_to_channel(
    room_id: uuid.UUID,
    body: ConvertToChannelBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Explicit, owner-only: turn a group conversation into a (private by
    default) channel in place — renamed, retyped, members and history kept.
    Audited as an ``agent_events`` row (the append-only stream every other
    room-changing decision lands in) and fanned out as ``room_converted``."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.convert_group_to_channel(
        room_id=room_id,
        actor_id=user["participant_id"],
        name=body.name,
        display_name=body.display_name,
        visibility=body.visibility,
    )
    converted_from = (room.metadata_ or {}).get("converted_from") or {}
    occurred_at = _now()
    db.add(
        AgentEvent(
            org_id=room.org_id,
            agent_identity=user.get("username") or user.get("sub") or str(user["participant_id"]),
            agent_type="human",
            event_type="room.converted_to_channel",
            room_ref=str(room.id),
            correlation_id=str(room.id),
            event_data={
                "room_id": str(room.id),
                "from_room_type": RoomType.GROUP_DM.value,
                "to_room_type": room.room_type.value,
                "from_name": converted_from.get("name"),
                "name": room.name,
                "display_name": room.display_name,
                "visibility": room.visibility,
                "by": str(user["participant_id"]),
            },
            occurred_at=occurred_at,
        )
    )
    await db.commit()
    logger.info(
        "room_converted_to_channel",
        room_id=str(room.id),
        name=room.name,
        visibility=room.visibility,
        by=str(user["participant_id"]),
    )
    await _ws_room(
        db,
        room.id,
        ws_events.ROOM_CONVERTED,
        {
            "room_id": str(room.id),
            "room_type": room.room_type.value,
            "visibility": room.visibility,
            "name": room.name,
            "display_name": room.display_name,
            "by": str(user["participant_id"]),
        },
    )
    return await _room_response(svc, room)


# ---------------------------------------------------------------------------
# Context (design §4)
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/context", response_model=ContextResponse)
async def get_room_context(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    budget_tokens: int = Query(DEFAULT_BUDGET_TOKENS, ge=1, le=MAX_BUDGET_TOKENS),
    since: uuid.UUID | None = Query(None, description="Only entries newer than this message id"),
    for_participant: uuid.UUID | None = Query(
        None, alias="for", description="Honour this member's context_depth override"
    ),
) -> ContextResponse:
    """The room stream an agent (or a client) walks into: messages from every
    sender, replies inline, voice lines, within a token budget. Never filtered
    by join or mention time.

    MEMBER-ONLY on purpose: the guest-reachable route set is pinned as an
    exact list (tests/test_guest_access.py) and widening it is a deliberate,
    separate decision — a guest does not run agents and has the ordinary
    floored history read for its own client."""
    payload = await build_context(
        db,
        room_id=room_id,
        budget_tokens=budget_tokens,
        since_message_id=since,
        for_participant_id=for_participant,
    )
    return ContextResponse(**payload)
