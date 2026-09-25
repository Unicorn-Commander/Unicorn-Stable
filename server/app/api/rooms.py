from __future__ import annotations

import json
import uuid
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from redis.asyncio import Redis

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_livekit,
    get_presence,
    get_redis,
    get_room_controller,
    get_settings_dep,
    is_control_key,
    rate_limit,
    require_room_member,
    require_room_member_or_guest,
    room_control_actor,
)
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.schemas.message import MessageResponse
from app.schemas.room import (
    EnsureHumanDmBody,
    EnsureHumanDmResponse,
    RoomCreate,
    RoomListResponse,
    RoomMemberResponse,
    RoomPresenceResponse,
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


def _room_to_response(
    room: Any,
    member_count: int = 0,
    online_count: int = 0,
    last_message: Any = None,
    unread_count: int = 0,
    mention_count: int = 0,
    has_unread_mention: bool = False,
    thread_count: int = 0,
    counterpart: Any = None,
    agents: list[Any] | None = None,
    latest_thread_id: Any = None,
    threads: list[RoomResponse] | None = None,
    is_member: bool = True,
) -> RoomResponse:
    last_msg_resp = None
    if last_message is not None:
        # Reuse the canonical Message serializer (flattens sender_*, maps
        # parent_id -> thread_id) so last_message matches getMessages output.
        from app.api.messages import _msg_to_response

        last_msg_resp = _msg_to_response(last_message)
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
        last_message=last_msg_resp,
        unread_count=unread_count,
        mention_count=mention_count,
        has_unread_mention=has_unread_mention,
        # Conversation model (021) + recording policy (023). getattr keeps the
        # serializer usable on the SimpleNamespace rooms older tests build.
        parent_room_id=getattr(room, "parent_room_id", None),
        visibility=getattr(room, "visibility", None) or "public",
        project_number=getattr(room, "project_number", None),
        thread_count=thread_count,
        latest_thread_id=latest_thread_id,
        threads=threads or [],
        is_member=is_member,
        counterpart=counterpart,
        agents=agents or [],
        recording_policy=getattr(room, "recording_policy", None) or "off",
        recording_kind=getattr(room, "recording_kind", None) or "audio",
    )


def _room_entry_to_response(entry: dict[str, Any]) -> RoomResponse:
    """A ``list_rooms_for_user`` entry (room + list extras, optionally with
    nested ``threads`` entries of the same shape) → RoomResponse."""
    nested = [_room_entry_to_response(t) for t in entry.get("threads") or []]
    return _room_to_response(
        entry["room"],
        entry.get("member_count", 0),
        entry.get("online_count", 0),
        last_message=entry.get("last_message"),
        unread_count=entry.get("unread_count", 0),
        mention_count=entry.get("mention_count", 0),
        has_unread_mention=entry.get("has_unread_mention", False),
        thread_count=entry.get("thread_count", 0),
        counterpart=entry.get("counterpart"),
        agents=entry.get("agents") or [],
        latest_thread_id=entry.get("latest_thread_id"),
        threads=nested,
        is_member=entry.get("is_member", True),
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
                org_id=get_settings_dep().instance_org_id,
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


# Standing always-on video/conference rooms. Public channels (self-joinable),
# flagged conference in metadata so the UI surfaces them with a call affordance.
# Created lazily the first time anyone enters one, then they persist.
CONFERENCE_ROOMS = [
    # slug, display_name, description
    (
        "main-conference",
        "Main Conference Hall",
        "Always-on video room for the whole team — drop in anytime.",
    ),
    (
        "war-room",
        "War Room",
        "Standing room for incidents, deep work, and live problem-solving.",
    ),
]


class ConferenceRoomInfo(BaseModel):
    slug: str
    display_name: str
    description: str


@router.get("/rooms/conference/catalog", response_model=list[ConferenceRoomInfo])
async def conference_catalog(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> list[ConferenceRoomInfo]:
    """The fixed set of standing conference rooms (whether or not yet created)."""
    return [
        ConferenceRoomInfo(slug=s, display_name=d, description=desc)
        for s, d, desc in CONFERENCE_ROOMS
    ]


@router.post("/rooms/conference/{slug}/enter", response_model=RoomResponse)
async def enter_conference_room(
    slug: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Enter a standing conference room — create-or-get, then ensure membership.

    Idempotent and race-safe: lazily creates the canonical room the first time
    anyone enters, then every subsequent caller just joins the existing one.
    """
    match = next((c for c in CONFERENCE_ROOMS if c[0] == slug), None)
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown conference room",
        )
    name, display_name, description = match
    svc = _build_room_service(db, livekit, presence)

    async def _by_name() -> Room | None:
        res = await db.execute(select(Room).where(Room.name == name))
        return res.scalar_one_or_none()

    room = await _by_name()
    if room is None:
        try:
            room = await svc.create_room(
                name=name,
                display_name=display_name,
                room_type="channel",
                creator_id=user["participant_id"],
                description=description,
                max_participants=50,
                metadata={"conference": True},
                org_id=get_settings_dep().instance_org_id,
            )
        except HTTPException as exc:
            # Lost a create race with a concurrent enterer — fetch theirs.
            if exc.status_code == status.HTTP_409_CONFLICT:
                room = await _by_name()
            else:
                raise
    if room is None:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not open the conference room",
        )

    # Ensure the caller is a member (no-op if the create above already added
    # them as owner, or if they joined earlier).
    try:
        await svc.join_room(
            room_id=room.id,
            participant_id=user["participant_id"],
            self_join=True,
        )
    except HTTPException as exc:
        if exc.status_code != status.HTTP_409_CONFLICT:  # 409 = already a member
            raise

    info = await svc.get_room(room.id)
    return _room_to_response(
        room,
        member_count=info["member_count"],
        online_count=info["online_count"],
    )


@router.post("/rooms", response_model=RoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[
        None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))
    ] = None,
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
        org_id=settings.instance_org_id,  # B6: stamp the instance org
    )
    return _room_to_response(room, member_count=1, online_count=1)


@router.post("/dms/ensure", response_model=EnsureHumanDmResponse)
async def ensure_human_dm(
    body: EnsureHumanDmBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[
        None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))
    ] = None,
) -> EnsureHumanDmResponse:
    """Idempotently ensure a 1:1 human DM with ``participant_id``.

    Always returns 200. ``created`` is True only when this call inserted the
    room. Concurrent double-clicks yield a single room (advisory lock + unique
    ``dm_pair`` / deterministic name). Target must be a human, not self.
    """
    svc = _build_room_service(db, livekit, presence)
    room, created = await svc.ensure_human_dm(
        caller_id=user["participant_id"],
        target_id=body.participant_id,
        org_id=settings.instance_org_id,
    )
    info = await svc.get_room(room.id)
    base = _room_to_response(
        info["room"],
        member_count=info["member_count"],
        online_count=info["online_count"],
    )
    return EnsureHumanDmResponse(**base.model_dump(), created=created)


class StartGroupBody(BaseModel):
    """Selections to seed alongside the DM's own members. All optional —
    the DM's two sides always come along; these are the additions."""

    participant_ids: list[uuid.UUID] = Field(default_factory=list, max_length=48)
    # People who exist in Keycloak but never signed into Stable (the picker's
    # "hasn't signed in yet" rows) — resolved to Participants exactly like the
    # invite endpoint does.
    keycloak_subs: list[str] = Field(default_factory=list, max_length=48)
    agent_ids: list[str] = Field(default_factory=list, max_length=16)
    # Client-computed label (the standing "Group: A, B, C" formula). Optional:
    # the server derives the same formula from member names when absent.
    display_name: str | None = Field(None, max_length=255)


class StartGroupResponse(RoomResponse):
    """The freshly created group room; ``origin_room_id`` is the source DM."""

    origin_room_id: uuid.UUID


@router.post(
    "/rooms/{room_id}/start-group",
    response_model=StartGroupResponse,
    status_code=status.HTTP_201_CREATED,
)
async def start_group_from_dm(
    room_id: uuid.UUID,
    body: StartGroupBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    _rl: Annotated[
        None, Depends(rate_limit("room_create", "rate_limit_room_create_per_min"))
    ] = None,
) -> StartGroupResponse:
    """Start a NEW group DM from an existing 1:1 DM (explicit conversion).

    The new ``group_dm`` is seeded with both sides of the DM (human peer or
    resident agent) plus the selected people/agents. The source DM is never
    mutated — its history stays private. This is deliberately NOT the invite
    endpoint's silent DM→group promotion: the private room keeps its walls and
    the group is a new room with no prior history.

    One transactional server route (rather than client-side create+invite
    orchestration) so a partial failure can never mint a group that claims to
    include the peer without the peer — the room row and every membership
    commit together.
    """
    # Validate requested agents against Brigade up front (same contract as
    # invite-brigade-agent) and learn their display names for participant rows.
    agent_names: dict[str, str] = {}
    if body.agent_ids:
        from app.api.brigade import _fetch_brigade_agents

        roster = await _fetch_brigade_agents()
        known = {a.id: a for a in roster}
        for agent_id in body.agent_ids:
            if agent_id not in known:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Unknown Brigade agent: {agent_id}",
                )
            agent_names[agent_id] = known[agent_id].name

    # Resolve Keycloak-only picks into Participants (create-on-demand, same
    # path as the invite endpoint). Participants are global rows, not room
    # membership, so creating them ahead of the transaction is safe.
    extra_ids: list[uuid.UUID] = list(body.participant_ids)
    if body.keycloak_subs:
        from app.api.users import resolve_or_create_participant
        from app.config import get_settings

        for sub in body.keycloak_subs:
            try:
                resolved = await resolve_or_create_participant(
                    db, get_settings(), sub
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
                )
            extra_ids.append(resolved.id)

    svc = _build_room_service(db, livekit, presence)
    room = await svc.start_group_from_dm(
        source_room_id=room_id,
        caller_id=user["participant_id"],
        extra_participant_ids=extra_ids,
        new_agent_ids=body.agent_ids,
        agent_names=agent_names,
        display_name=body.display_name,
        org_id=settings.instance_org_id,
    )

    # Post-commit, best-effort: run the canonical agent-binding pass for the
    # requested agents. Membership already exists (written in the transaction
    # above), so this is the avatar/display backfill the invite path does —
    # a failure here costs a picture, never the binding.
    if body.agent_ids:
        from app.api.brigade import _ensure_agent_member

        for agent_id in body.agent_ids:
            try:
                await _ensure_agent_member(db, str(room.id), agent_id)
            except Exception:
                logger.warning(
                    "start_group_agent_backfill_failed",
                    room_id=str(room.id),
                    agent_id=agent_id,
                    exc_info=True,
                )

    # Tell every added human (peer + extras) about their new room, same event
    # the invite endpoint emits, so open sidebars pick the group up live. The
    # creator's OWN other devices get it too (no inviter_name → refetch, no
    # toast) so a phone never needs a restart to see the group (L2 item 7).
    try:
        from app.services.room_push import push_room_to_participants

        members = await svc.get_members(room.id, caller_id=user["participant_id"])
        await push_room_to_participants(
            [m["participant_id"] for m in members if m.get("participant_type") != "agent"],
            room_id=room.id,
            kind="group",
            inviter_name=user.get("display_name") or user.get("username"),
            self_id=user["participant_id"],
            display_name=room.display_name,
            room_type=room.room_type.value,
        )
    except Exception:
        logger.debug("start_group_ws_notify_failed", exc_info=True)

    info = await svc.get_room(room.id)
    base = _room_to_response(
        info["room"],
        member_count=info["member_count"],
        online_count=info["online_count"],
    )
    return StartGroupResponse(**base.model_dump(), origin_room_id=room_id)


@router.get("/rooms/browse", response_model=list[RoomResponse])
async def browse_channels(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    q: str = Query("", max_length=100),
    limit: int = Query(50, ge=1, le=200),
) -> list[RoomResponse]:
    """List channels (room_type=channel) the caller is NOT yet a member of.

    Used by the channel browser. DMs and group_dms are intentionally excluded.
    B6: on a per-org instance, only this org's (or org-less community) channels
    are discoverable — not every other org's channels in a shared Postgres.
    """
    from sqlalchemy import not_, or_, select as _select

    from app.models.room import Room as _Room, RoomMember as _RM, RoomType as _RT

    member_subq = _select(_RM.room_id).where(
        _RM.participant_id == user["participant_id"]
    )
    stmt = _select(_Room).where(
        _Room.room_type == _RT.CHANNEL,
        _Room.is_archived == False,  # noqa: E712
        # Private channels (design §3) are invite-only and never listed —
        # deny by default: anything not explicitly public stays out.
        _Room.visibility == "public",
        not_(_Room.id.in_(member_subq)),
    )
    org = settings.instance_org_id
    if org is not None:
        # Show this org's channels + org-less/community channels; hide others'.
        stmt = stmt.where(or_(_Room.org_id == org, _Room.org_id.is_(None)))
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
    is_archived: bool = Query(
        False,
        description=(
            "True returns ONLY the caller's archived rooms (the sidebar's "
            "Archived section); the default excludes archived rooms."
        ),
    ),
    view: Literal["flat", "nested"] = Query(
        "flat",
        description=(
            "flat (default): every room the caller is in as an ordinary row — "
            "threads included, with parent_room_id set. nested: threads hang "
            "under their parent row (`threads`, `latest_thread_id`) and are "
            "excluded from the top level. Design §3."
        ),
    ),
) -> RoomListResponse:
    """List rooms the current user is a member of."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.list_rooms_for_user(
        participant_id=user["participant_id"],
        cursor=cursor,
        limit=limit,
        is_archived=is_archived,
        nested=(view == "nested"),
    )
    rooms = [_room_entry_to_response(r) for r in result["rooms"]]
    return RoomListResponse(
        rooms=rooms,
        total=result["total"],
        cursor=result["cursor"],
    )


@router.get("/rooms/{room_id}", response_model=RoomResponse)
async def get_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Get room details. Caller must be a member of the room."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.get_room(room_id)
    extras = await svc.room_extras(result["room"])
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
        **extras,
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
    """Update room details. Requires admin or owner role.

    ``visibility`` / ``project_number`` / ``recording_policy`` /
    ``recording_kind`` are the conversation + recording contracts (design §3,
    §8); a visibility change fans out ``room_visibility`` to the room.
    """
    svc = _build_room_service(db, livekit, presence)
    room = await svc.update_room(
        room_id=room_id,
        participant_id=user["participant_id"],
        display_name=body.display_name,
        description=body.description,
        is_archived=body.is_archived,
        metadata=body.metadata,
        visibility=body.visibility,
        project_number=body.project_number,
        recording_policy=body.recording_policy,
        recording_kind=body.recording_kind,
    )
    if body.visibility is not None:
        try:
            from app.api.messages import _ws_broadcast_room
            from app.ws import events as ws_events

            await _ws_broadcast_room(
                db,
                room_id,
                {
                    "type": ws_events.ROOM_VISIBILITY,
                    "payload": {"room_id": str(room_id), "visibility": body.visibility},
                },
            )
        except Exception:
            logger.warning("room_visibility_fanout_failed", exc_info=True)
    result = await svc.get_room(room_id)
    extras = await svc.room_extras(result["room"])
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
        **extras,
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
    """Join a room as a member.

    Only public channels are self-joinable; DMs and group DMs are
    invite-only (enforced in RoomService.join_room via ``self_join``).
    """
    svc = _build_room_service(db, livekit, presence)
    membership = await svc.join_room(
        room_id=room_id,
        participant_id=user["participant_id"],
        self_join=True,
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

    # 1:1 DMs are closed two-person rooms. The old behaviour silently
    # promoted the DM to a group_dm in place when a 3rd member landed here —
    # converting a private thread without either side asking, and leaving the
    # promoted room squatting on the DM's canonical name (which wedges
    # /dms/ensure). The product flow is explicit: POST /rooms/{id}/start-group
    # creates a NEW group room and leaves the DM untouched.
    room_row = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    if room_row.room_type == RoomType.DM:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This is a 1:1 direct message — use 'Start a group' to bring "
                "more people in"
            ),
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

    # ENTITLEMENT: this generic invite route can also add an AGENT-typed
    # Participant (pseudo-sub ``brigade:<id>``) as a room member — a second
    # way to bind an agent that would bypass the gate on
    # /invite-brigade-agent. Same rule, same audit log: a human caller must
    # be entitled to the agent they are binding. Human targets are untouched,
    # and the agents worker's own invite_to_room calls (agent-typed
    # principal) pass through inside ensure_agent_access.
    from app.models.participant import ParticipantType as _PT_inv
    from app.services.agent_access import (
        agent_id_for_participant,
        ensure_agent_access,
    )

    if target.participant_type == _PT_inv.AGENT:
        await ensure_agent_access(
            db,
            user,
            agent_id_for_participant(target.keycloak_sub),
            surface="room_member_invite",
        )

    membership = await svc.join_room(
        room_id=room_id,
        participant_id=target.id,
        role="member",
    )

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

    # Also emit a WS notification to the invitee (if they're online). Publish to
    # the invitee's Redis user:{id} channel — the in-process ConnectionManager
    # only reaches sockets on the current worker, so with `uvicorn --workers 4`
    # send_to_participant missed the invitee ~3/4 of the time.
    try:
        from app.api.messages import _ws_send_participant

        await _ws_send_participant(
            str(target.id),
            {
                "type": "room_invited",
                "payload": {
                    "room_id": str(room_id),
                    "inviter_name": user.get("display_name") or user.get("username"),
                },
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

    # Fanout to room members over Redis room:{id} (cross-worker). The in-process
    # ConnectionManager only reaches sockets on the current worker, so under
    # `uvicorn --workers 4` this missed ~3/4 of open clients.
    try:
        from app.api.messages import _ws_broadcast_room

        await _ws_broadcast_room(
            db,
            room_id,
            {
                "type": "pins_changed",
                "payload": {
                    "room_id": str(room_id),
                    "pinned_message_ids": pinned,
                },
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


def _member_to_response(m: dict[str, Any]) -> RoomMemberResponse:
    return RoomMemberResponse(
        id=m["id"],
        participant_id=m["participant_id"],
        username=m["username"],
        display_name=m["display_name"],
        participant_type=m["participant_type"],
        role=m["role"],
        joined_at=m["joined_at"],
        last_read_at=m["last_read_at"],
        is_muted=m["is_muted"],
        is_self=m.get("is_self", False),
        is_online=bool(m.get("is_online", m.get("status") == "online")),
        status=m["status"],
        avatar_url=m.get("avatar_url"),
        avatar_emoji=m.get("avatar_emoji"),
        availability=m.get("availability"),
        availability_reason=m.get("availability_reason"),
    )


@router.get("/rooms/{room_id}/members", response_model=list[RoomMemberResponse])
async def list_members(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member_or_guest)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> list[RoomMemberResponse]:
    """List members of a room. Caller must be a member — or a GUEST of it.

    Safe to expose to a guest because ``RoomService.get_members`` returns only
    the identity facts a call needs (username, display name, participant type,
    role, avatar, presence) — never an email address and never a Keycloak
    subject. It is a room roster, not a realm export.

    ``participant_type`` on each row is ``"guest"`` for guests, which is how a
    client distinguishes a real member from an outsider whose display name they
    chose themselves. Clients MUST badge on that field rather than trusting the
    name string.
    """
    svc = _build_room_service(db, livekit, presence)
    members = await svc.get_members(room_id, caller_id=user["participant_id"])
    return [_member_to_response(m) for m in members]


@router.get("/rooms/{room_id}/presence", response_model=RoomPresenceResponse)
async def get_room_presence(
    room_id: uuid.UUID,
    _user: Annotated[dict[str, Any], Depends(require_room_member)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomPresenceResponse:
    """Snapshot the Participant IDs currently online in a room.

    Authz: caller must be a member of the room (``require_room_member`` — the
    same guard as GET /members). Lets a client seed presence on room open so
    peers who were already connected before the caller opened the room show
    online immediately, instead of only learning about them from subsequent
    live presence deltas.
    """
    online_ids = await presence.get_online_in_room(str(room_id))
    return RoomPresenceResponse(online=sorted(online_ids))


# ---------------------------------------------------------------------------
# Moderation: remove / change-role / mute a member (owner/admin)
# ---------------------------------------------------------------------------


class RoleBody(BaseModel):
    role: str  # owner | admin | member | guest


class MuteBody(BaseModel):
    is_muted: bool


async def _broadcast_members_changed(
    db: AsyncSession,
    room_id: uuid.UUID,
    *,
    removed_participant_id: str | None = None,
) -> None:
    """Tell every connected client in the room to refresh its member list.

    ``removed_participant_id`` lets a kicked client recognize it's the target
    and drop the room locally without waiting for a poll.
    """
    try:
        from app.api.messages import _ws_broadcast_room

        await _ws_broadcast_room(
            db,
            room_id,
            {
                "type": "members_changed",
                "payload": {
                    "room_id": str(room_id),
                    "removed_participant_id": removed_participant_id,
                },
            },
        )
    except Exception:
        logger.warning("members_changed_fanout_failed", exc_info=True)


async def _member_response_for(
    svc: RoomService, room_id: uuid.UUID, participant_id: uuid.UUID
) -> RoomMemberResponse:
    members = await svc.get_members(room_id)
    for m in members:
        if str(m["participant_id"]) == str(participant_id):
            return _member_to_response(m)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Member not found after update",
    )


@router.delete(
    "/rooms/{room_id}/members/{participant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_member(
    room_id: uuid.UUID,
    participant_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> None:
    """Remove a member from a room (kick). Owner or admin only."""
    svc = _build_room_service(db, livekit, presence)
    info = await svc.remove_member(room_id, user["participant_id"], participant_id)
    await _broadcast_members_changed(
        db, room_id, removed_participant_id=info["participant_id"]
    )
    try:
        await redis.publish(
            f"user:{info['participant_id']}",
            json.dumps({"type": "room_revoked", "room_id": str(room_id)}),
        )
    except Exception:
        logger.warning("room_revocation_fanout_failed", exc_info=True)


@router.patch(
    "/rooms/{room_id}/members/{participant_id}/role",
    response_model=RoomMemberResponse,
)
async def set_member_role(
    room_id: uuid.UUID,
    participant_id: uuid.UUID,
    body: RoleBody,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Change a member's role. Owner only."""
    try:
        new_role = MemberRole(body.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid role: {body.role}",
        )
    svc = _build_room_service(db, livekit, presence)
    await svc.set_member_role(room_id, user["participant_id"], participant_id, new_role)
    await _broadcast_members_changed(db, room_id)
    return await _member_response_for(svc, room_id, participant_id)


@router.patch(
    "/rooms/{room_id}/members/{participant_id}/mute",
    response_model=RoomMemberResponse,
)
async def set_member_mute(
    room_id: uuid.UUID,
    participant_id: uuid.UUID,
    body: MuteBody,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Mute or unmute a member (blocks them from posting). Owner or admin."""
    svc = _build_room_service(db, livekit, presence)
    await svc.set_member_mute(
        room_id, user["participant_id"], participant_id, body.is_muted
    )
    await _broadcast_members_changed(db, room_id)
    return await _member_response_for(svc, room_id, participant_id)


# ---------------------------------------------------------------------------
# Voice settings — how the room's voice relay decides a spoken line is FOR
# the agent. The web Settings UI is the intended caller; SQL was the only way
# to change this before, which is not a setting, it is an incantation.
# ---------------------------------------------------------------------------

#: Mirrors agents/voice_relay/agent.py::ACTIVATION_MODES. The two lists are
#: maintained by hand because the server and the agents runtime ship in
#: different images with no shared package; each side validates independently
#: so a drifted value degrades to the safe default rather than crashing.
VOICE_ACTIVATION_MODES = ("name", "window", "always", "ptt", "off")
DEFAULT_WINDOW_SECONDS = 75
MIN_WINDOW_SECONDS = 15
MAX_WINDOW_SECONDS = 300


def _flag_on(value: Any) -> bool:
    """A relay flag as the row holds it (bool) or a hand-edit left it (str)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _clamp_window_seconds(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WINDOW_SECONDS
    return max(MIN_WINDOW_SECONDS, min(MAX_WINDOW_SECONDS, n))


_FACE_SHAPES = ("wide", "square", "tall")
_NO_COHOST = frozenset({"", "nobody", "none", "off"})


class RoomVoiceSettingsBody(BaseModel):
    """Voice settings a room owner can change.

    ``activation`` may be omitted when the caller is setting one of the other
    keys (co-host, source, spoken length, face). Omitted keys are left as
    they are. ``max_spoken_chars`` of 0 means unlimited.
    """

    activation: str | None = Field(default=None, max_length=16)
    window_seconds: int | None = Field(default=None, ge=1, le=600)
    #: The cast: sender USERNAME → Kokoro voice id (``{"agent-grok":
    #: "am_onyx"}``). Omitted = unchanged; ``{}`` = clear. Voice ids are not
    #: checked against the served list here — the server does not know what
    #: Kokoro serves; the relay does, and falls back with a log line.
    voices: dict[str, str] | None = None
    #: Cast members OFF stage: usernames from the cast who keep their voice
    #: but do not join the call (no tile, no voice, no spoken routing) until
    #: brought back. Omitted = unchanged; ``[]`` = everyone on stage. The
    #: room's own voice agent and its co-host cannot be benched.
    bench: list[str] | None = None
    #: Publish a rendered puppet as each relay participant's CAMERA track, so
    #: agents show in the grid, on /broadcast and in OBS like a human on a
    #: webcam. Omitted = unchanged. Default off.
    video: bool | None = None
    #: Give every OTHER sender in ``voices`` its own LiveKit participant
    #: (identity = username), hosted by the relay. Omitted = unchanged.
    multi: bool | None = None
    #: Explicit co-host. ``nobody`` / ``none`` / ``off`` / ``""`` clears it.
    #: This is the only source of ``voice_primary_agent_id``.
    primary_agent_id: str | None = Field(default=None, max_length=64)
    #: Whose chat messages the relay speaks. A hub with no source defaults
    #: to the human owner's username instead of 409.
    source: str | None = Field(default=None, max_length=100)
    #: Kokoro persona. Stored as ``voice_relay_agent_id``.
    agent_id: str | None = Field(default=None, max_length=64)
    aliases: list[str] | None = None
    #: Per-seat spellings Whisper hears instead of the name
    #: (``{"agent-shox": ["shocks"]}``). Omitted = unchanged; ``{}`` = clear.
    #: Keys must be cast members. At most 8 aliases per seat, each 2 to 40
    #: characters, stored lowercase.
    cast_aliases: dict[str, Any] | None = None
    face_shape: str | None = Field(default=None, max_length=16)
    face_plate: bool | None = None
    max_spoken_chars: int | None = Field(default=None, ge=0, le=20000)


def _is_agent_hub(room: Any) -> bool:
    room_type = getattr(room, "room_type", None)
    value = str(getattr(room_type, "value", room_type) or "")
    return value == RoomType.AGENT_HUB.value


async def _hub_owner_username(db: AsyncSession, room: Any) -> str:
    """The human owner's username, used as the relay source on an unconfigured hub."""
    from app.models.participant import Participant

    username = (
        await db.execute(
            select(Participant.username)
            .join(RoomMember, RoomMember.participant_id == Participant.id)
            .where(
                RoomMember.room_id == room.id,
                RoomMember.role == MemberRole.OWNER,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return username.strip() if isinstance(username, str) else ""


def _clean_aliases(raw: list[str]) -> list[str]:
    cleaned: list[str] = []
    for item in raw:
        name = str(item or "").strip()
        if not name or len(name) > 64:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="aliases must be spoken names of at most 64 characters",
            )
        cleaned.append(name)
    return cleaned


def _clean_relay_voices(raw: dict[str, str]) -> dict[str, str]:
    """Trim and shape-check a cast map; junk entries are a 422, not a silent drop."""
    cleaned: dict[str, str] = {}
    for key, value in raw.items():
        sender = str(key or "").strip()
        voice = str(value or "").strip()
        if not sender or len(sender) > 64 or not voice or len(voice) > 32:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="voices must map a username (≤64 chars) to a voice id (≤32 chars)",
            )
        cleaned[sender] = voice
    return cleaned


_MAX_ALIASES_PER_SEAT = 8


def _clean_cast_aliases(raw: dict[str, Any]) -> dict[str, list[str]]:
    """Shape-check a cast-alias map. Stored lowercase, phrases sorted."""
    if not isinstance(raw, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="cast_aliases must map a cast username to a list of aliases",
        )
    cleaned: dict[str, list[str]] = {}
    for key, value in raw.items():
        seat = str(key or "").strip().lower()
        if not seat or len(seat) > 64:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="cast_aliases keys must be cast usernames",
            )
        if not isinstance(value, (list, tuple)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{seat}: aliases must be a list",
            )
        if len(value) > _MAX_ALIASES_PER_SEAT:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{seat}: at most {_MAX_ALIASES_PER_SEAT} aliases",
            )
        phrases: list[str] = []
        for item in value:
            phrase = str(item or "").strip().lower()
            if len(phrase) < 2 or len(phrase) > 40:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{seat}: each alias must be 2 to 40 characters",
                )
            if phrase not in phrases:
                phrases.append(phrase)
        cleaned[seat] = sorted(phrases)
    return cleaned


def _clean_bench(raw: list[str]) -> list[str]:
    """Shape-check a bench list; sorted and de-duplicated."""
    cleaned: set[str] = set()
    for item in raw:
        name = str(item or "").strip()
        if not name or len(name) > 64:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="bench must list cast usernames of at most 64 characters",
            )
        cleaned.add(name)
    return sorted(cleaned)


@router.get("/rooms/{room_id}/voice-cast")
async def get_voice_cast(
    room_id: uuid.UUID,
    _user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """The room's voice cast as seats: who is on stage and who is benched.

    Member-visible, because the stage is what everyone on the call sees;
    changing it is the owner/admin PATCH below. Names come from the
    participant rows, so a seat that is not a room member still shows as the
    character the room knows ("Corporal Forge", not "agent-qwen-35b").
    ``locked`` marks the two seats the PATCH refuses to bench: the room's own
    voice agent and its co-host.
    """
    from app.api.webhooks import relay_bench, relay_cast
    from app.models.participant import Participant

    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
    cast = relay_cast(meta.get("voice_relay_voices")) or {}
    benched = set(relay_bench(meta))
    names: dict[str, str] = {}
    if cast:
        rows = (
            await db.execute(
                select(Participant.username, Participant.display_name).where(
                    Participant.username.in_(list(cast))
                )
            )
        ).all()
        names = {username: (display or "").strip() for username, display in rows}
    source = str(meta.get("voice_relay_source") or "").strip()
    primary = str(meta.get("voice_primary_agent_id") or "").strip().lower()
    seats: list[dict[str, Any]] = []
    for username, voice in cast.items():
        short = username[6:] if username.startswith("agent-") else username
        locked: str | None = None
        if username == source:
            locked = "voice_agent"
        elif primary and primary not in _NO_COHOST and short.lower() == primary:
            locked = "co_host"
        seats.append(
            {
                "username": username,
                "display_name": names.get(username) or short,
                "voice": voice,
                "on_stage": username not in benched,
                "locked": locked,
            }
        )
    seats.sort(key=lambda seat: (seat["locked"] is None, seat["display_name"].lower()))
    return {"seats": seats, "bench": sorted(benched & set(cast))}


@router.patch("/rooms/{room_id}/voice-settings")
async def update_voice_settings(
    room_id: uuid.UUID,
    body: RoomVoiceSettingsBody,
    user: Annotated[dict[str, Any], Depends(get_room_controller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> dict[str, Any]:
    """Set how the room's voice agent decides a spoken line is addressed to it.

    Owner/admin only — the same ladder as call moderation, because changing who
    the agent listens to changes what everyone in the room experiences. The
    one other principal admitted is a CONTROL KEY (``deps.get_room_controller``:
    the Talk Controls desk app's gateway key, scoped to this room); it has no
    membership row, its room scope was enforced by the dependency, and the
    audit line says which path authorized the write.

    Writes the room's standing setting AND broadcasts a ``relay_config`` frame
    into the live call, so a relay already in the room switches immediately —
    the old behaviour (setting read once at dispatch) meant a change silently
    did nothing until everyone left and rejoined, which reads as broken.
    ``live`` in the response says whether a live session actually heard it.
    """
    mode: str | None
    if body.activation is None:
        mode = None
    else:
        mode = body.activation.strip().lower()
        if mode not in VOICE_ACTIVATION_MODES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"activation must be one of {', '.join(VOICE_ACTIVATION_MODES)}",
            )
    if body.face_shape is not None and body.face_shape.strip().lower() not in _FACE_SHAPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"face_shape must be one of {', '.join(_FACE_SHAPES)}",
        )
    aliases = _clean_aliases(body.aliases) if body.aliases is not None else None
    voices = _clean_relay_voices(body.voices) if body.voices is not None else None
    bench = _clean_bench(body.bench) if body.bench is not None else None
    cast_aliases = (
        _clean_cast_aliases(body.cast_aliases) if body.cast_aliases is not None else None
    )

    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")

    if is_control_key(user):
        # Belt and braces: the dependency resolved THIS room_id for the scope
        # check; refuse if a refactor ever lets a different room through.
        if str(user.get("control_room_id")) != str(room_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Gateway key is not scoped to this room",
            )
    else:
        membership = (
            await db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room_id,
                    RoomMember.participant_id == user["participant_id"],
                )
            )
        ).scalar_one_or_none()
        if membership is None or membership.role not in (MemberRole.OWNER, MemberRole.ADMIN):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Requires one of roles: owner, admin",
            )
    actor = room_control_actor(user)

    meta = dict(room.metadata_ or {})
    source = str(meta.get("voice_relay_source") or "").strip()
    if body.source is not None:
        source = body.source.strip()
        if not source:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="source must be a username",
            )
    if not source and _is_agent_hub(room):
        source = await _hub_owner_username(db, room)
        if source:
            logger.info(
                "voice_settings_hub_source_defaulted",
                room_id=str(room_id),
                source=source,
            )
    if not source:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This room has no voice agent configured",
        )
    meta["voice_relay_source"] = source
    if mode is None:
        existing = str(meta.get("voice_relay_activation") or "").strip().lower()
        mode = existing if existing in VOICE_ACTIVATION_MODES else "name"
    meta["voice_relay_activation"] = mode
    if body.primary_agent_id is not None:
        raw_primary = body.primary_agent_id.strip()
        meta["voice_primary_agent_id"] = (
            "nobody" if raw_primary.lower() in _NO_COHOST else raw_primary
        )
    if body.agent_id is not None and body.agent_id.strip():
        meta["voice_relay_agent_id"] = body.agent_id.strip()
    if aliases is not None:
        meta["voice_relay_aliases"] = aliases
    if body.face_shape is not None:
        meta["voice_relay_face_shape"] = body.face_shape.strip().lower()
    if body.face_plate is not None:
        meta["voice_relay_face_plate"] = bool(body.face_plate)
    if body.max_spoken_chars is not None:
        meta["voice_relay_max_spoken_chars"] = int(body.max_spoken_chars)
    elif "voice_relay_max_spoken_chars" not in meta:
        from app.api.webhooks import default_max_spoken_chars

        meta["voice_relay_max_spoken_chars"] = default_max_spoken_chars(room)
    window_seconds = (
        _clamp_window_seconds(body.window_seconds)
        if body.window_seconds is not None
        else _clamp_window_seconds(meta.get("voice_relay_window_seconds"))
    )
    if mode == "window":
        meta["voice_relay_window_seconds"] = window_seconds
    if voices is not None:
        if voices:
            meta["voice_relay_voices"] = voices
        else:
            meta.pop("voice_relay_voices", None)
    if body.video is not None:
        meta["voice_relay_video"] = bool(body.video)
    if body.multi is not None:
        meta["voice_relay_multi"] = bool(body.multi)
    from app.api.webhooks import (
        VOICE_BENCH_KEY,
        relay_bench,
        relay_cast,
        relay_cast_aliases,
        stage_voices,
    )

    CAST_ALIAS_KEY = "voice_relay_cast_aliases"

    if bench is not None:
        cast = relay_cast(meta.get("voice_relay_voices")) or {}
        unknown = [u for u in bench if u not in cast]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Not in this room's cast: {', '.join(unknown)}",
            )
        primary = str(meta.get("voice_primary_agent_id") or "").strip().lower()
        for username in bench:
            if username == source:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{username} is this room's voice agent and can't be benched",
                )
            short = username[6:] if username.startswith("agent-") else username
            if primary and primary not in _NO_COHOST and short.lower() == primary:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{username} is this room's co-host; choose another co-host first",
                )
        if bench:
            meta[VOICE_BENCH_KEY] = bench
        else:
            meta.pop(VOICE_BENCH_KEY, None)
    elif voices is not None and VOICE_BENCH_KEY in meta:
        # A new cast forgets bench entries it no longer names.
        kept = [u for u in relay_bench(meta) if u in voices]
        if kept:
            meta[VOICE_BENCH_KEY] = kept
        else:
            meta.pop(VOICE_BENCH_KEY, None)
    aliases_pruned = False
    if cast_aliases is not None:
        cast = relay_cast(meta.get("voice_relay_voices")) or {}
        unknown = [u for u in cast_aliases if u not in cast]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Not in this room's cast: {', '.join(unknown)}",
            )
        if cast_aliases:
            meta[CAST_ALIAS_KEY] = cast_aliases
        else:
            meta.pop(CAST_ALIAS_KEY, None)
    elif voices is not None and CAST_ALIAS_KEY in meta:
        # A new cast forgets alias entries it no longer names.
        kept = relay_cast_aliases(
            {seat: phrases for seat, phrases in (meta.get(CAST_ALIAS_KEY) or {}).items() if seat in voices}
        )
        aliases_pruned = True
        if kept:
            meta[CAST_ALIAS_KEY] = kept
        else:
            meta.pop(CAST_ALIAS_KEY, None)
    room.metadata_ = meta  # reassigned, not mutated, for JSONB change detection
    await db.commit()

    # Best-effort live switch AND a missing-relay dispatch. send_data only
    # reaches a worker already in the room — a call started before this room
    # was wired never got a relay, and hanging up twice was the only way to
    # summon one (2026-08-30). _ensure_voice_relay is the same join-webhook
    # helper, now also fired from this endpoint.
    live = False
    try:
        from app.api.webhooks import _ensure_voice_relay, _sync_voice_metadata

        await _sync_voice_metadata(livekit, room)
        await _ensure_voice_relay(livekit, room, db)
        frame = {
            "type": "relay_config",
            "activation": mode,
            "by": actor if is_control_key(user) else str(user["participant_id"]),
        }
        if mode == "window":
            frame["window_seconds"] = window_seconds
        if voices is not None or bench is not None:
            # The relay re-reads its cast from this frame, live — the STAGE
            # cast, so benching a seat takes its tile out of a running call
            # and bringing it back puts it in again.
            frame["voices"] = stage_voices(meta) or {}
            frame["bench"] = relay_bench(meta)
        if cast_aliases is not None or aliases_pruned:
            # Same live path as the cast: a running relay reads this frame,
            # not the database. ``{}`` clears room aliases; built-ins remain.
            frame["cast_aliases"] = meta.get(CAST_ALIAS_KEY) or {}
        if body.video is not None:
            frame["video"] = bool(body.video)
        if body.multi is not None:
            frame["multi"] = bool(body.multi)
        if "voice_relay_max_spoken_chars" in meta:
            frame["max_spoken_chars"] = int(meta["voice_relay_max_spoken_chars"])
        await livekit.send_data(room.livekit_room_name, frame)
        live = True
    except Exception:
        logger.info(
            "voice_settings_live_push_skipped",
            room_id=str(room_id),
            reason="no live media session",
        )

    logger.info(
        "voice_settings_updated",
        room_id=str(room_id),
        activation=mode,
        window_seconds=window_seconds if mode == "window" else None,
        actor=actor,
        # Which auth path authorized the write: ``control_key:<id prefix>``
        # (desk app gateway key) or ``user:<participant_id>`` (owner/admin JWT).
        voice_settings_updated_by=actor,
        live=live,
        voices=voices,
        bench=bench,
        cast_aliases=cast_aliases,
    )
    return {
        "activation": mode,
        "live": live,
        # Reported only once a room has ever set them — same "omitted means
        # unchanged/absent" contract as the request body, and a response a
        # room that never asked for faces would not recognise as its own.
        **({"video": _flag_on(meta.get("voice_relay_video"))} if "voice_relay_video" in meta else {}),
        **({"multi": _flag_on(meta.get("voice_relay_multi"))} if "voice_relay_multi" in meta else {}),
        **({"window_seconds": window_seconds} if mode == "window" else {}),
        **({"voices": voices} if voices is not None else {}),
        **({"bench": relay_bench(meta)} if bench is not None else {}),
        **(
            {"primary_agent_id": meta.get("voice_primary_agent_id")}
            if body.primary_agent_id is not None
            else {}
        ),
        **(
            {"max_spoken_chars": int(meta["voice_relay_max_spoken_chars"])}
            if body.max_spoken_chars is not None
            else {}
        ),
        **({"source": source} if body.source is not None else {}),
        **({"agent_id": meta.get("voice_relay_agent_id")} if body.agent_id is not None else {}),
        **({"aliases": aliases} if aliases is not None else {}),
        **(
            {"cast_aliases": meta.get(CAST_ALIAS_KEY) or {}}
            if cast_aliases is not None
            else {}
        ),
        **(
            {"face_shape": meta.get("voice_relay_face_shape")}
            if body.face_shape is not None
            else {}
        ),
        **(
            {"face_plate": bool(meta.get("voice_relay_face_plate"))}
            if body.face_plate is not None
            else {}
        ),
    }


class VoiceDiagnostic(BaseModel):
    model_config = {"extra": "forbid"}
    reason: Literal["publish", "route_change", "resume", "track_change", "permission"]
    track_muted: bool | None
    track_enabled: bool | None
    ready_state: Literal["live", "ended", "missing"]
    device_id: str | None = Field(default=None, max_length=256, pattern=r"^[a-zA-Z0-9_:+/=. -]*$")
    sample_rate: int | None = Field(default=None, ge=1, le=384000)
    audio_context_state: Literal["running", "suspended", "closed", "interrupted", "unavailable"]
    permission: Literal["granted", "denied", "prompt", "unsupported"]
    participant_sid: str = Field(default="", max_length=128, pattern=r"^[a-zA-Z0-9_-]*$")
    track_sid: str = Field(default="", max_length=128, pattern=r"^[a-zA-Z0-9_-]*$")


voice_diagnostic_rate_limit = rate_limit("voice_diag", "rate_limit_message_send_per_min")


@router.post("/rooms/{room_id}/voice-diagnostics", status_code=204)
async def report_voice_diagnostic(
    room_id: uuid.UUID,
    body: VoiceDiagnostic,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    _rl: Annotated[None, Depends(voice_diagnostic_rate_limit)],
) -> None:
    # Client-reported fields are diagnostic claims, never authorization inputs.
    logger.info("voice_client_diagnostic", room_id=str(room_id),
                authenticated_participant_id=str(user["participant_id"]), **body.model_dump())
