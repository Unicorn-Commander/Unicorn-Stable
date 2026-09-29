"""ORCH-1 — PUBLIC agent-gateway router (mounted at /api/v1/gateway).

Lets a dev/agent authenticate with a role-gated uchub JWT OR a scoped gateway key
and post to / read from Stable rooms AS A SCOPED, NON-SPOOFABLE agent identity —
replacing the SSH+docker-exec bridge and the single shared ``internal_agent_secret``
(which let any holder post as any agent).

Rides the existing ``stable-api`` Traefik router (PathPrefix ``/api``); it is NOT
under ``/api/v1/internal`` so it is reachable off-host with NO compose change. The
legacy ``/internal/agent-messages`` path is untouched (the SSH bridge keeps working;
rollback = drop this router / GATEWAY_ENABLED=false).
"""

from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

import structlog
import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer, verify_key_admin_bearer
from app.api.messages import _build_message_service, _msg_to_response, send_message
from app.auth.gateway_auth import (
    KEY_PREFIXES,
    MEMBER_SCOPE,
    GatewayAuthError,
    GatewayPrincipal,
    hash_key,
    resolve_key_room_scope,
    slugify,
    validate_gateway_jwt,
    verify_gateway_key,
)
from app.services.room_class import (
    SEAT_EFFORTS,
    SEAT_MODEL_RE,
    room_class_for,
    seat_setting_from_metadata,
)
from app.config import Settings, get_settings
from app.services.agent_status import (
    clear_relay_pending,
    touch_gateway_agent as touch_bridge_seen,
)
from app.deps import (
    _rate_limit_hit,
    get_db,
    get_livekit,
    get_redis,
    get_settings_dep,
    is_room_member,
)
from app.models.agent_gateway_key import AgentGatewayKey
from app.models.participant import (
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.models.room import MemberRole, Room, RoomMember
from app.schemas.message import MessageCreate, MessageListResponse, MessageResponse
from app.services.agent_availability import (
    touch_gateway_agent as touch_bridge_fresh,
)
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/gateway", tags=["Gateway"])

# Gateway-key prefixes we recognize (anything else on the Authorization header is
# treated as a JWT). Keys are minted with the first prefix. Defined once in
# auth/gateway_auth so deps.get_room_controller recognises the same shapes.
_KEY_PREFIXES = KEY_PREFIXES


def _gateway_enabled() -> bool:
    return os.getenv("GATEWAY_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------


async def authenticate_gateway_caller(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> GatewayPrincipal:
    """Resolve the caller to a scoped GatewayPrincipal (JWT or key).

    Also records the caller as a currently-reachable bridge agent. A bridge is
    an external process (a Claude Code holding a gateway credential) that is
    reachable only while it is polling — there is no long-poll endpoint and no
    socket to observe — so a recent authenticated call is the only liveness
    evidence that exists. Doing it here rather than in each endpoint means both
    the read and the post path are covered and neither can forget; the touch is
    best-effort and cannot fail the request. See
    services/agent_availability.py.
    """
    if not _gateway_enabled():
        # Feature-flagged off → behave as if the router does not exist.
        raise HTTPException(status_code=404, detail="Not found")

    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing bearer credential (gateway key or uchub JWT)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth.removeprefix("Bearer ").strip()
    try:
        if token.startswith(_KEY_PREFIXES):
            principal = await verify_gateway_key(token, db)
        else:
            principal = await validate_gateway_jwt(token, settings)
    except GatewayAuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    await touch_bridge_fresh(redis, principal.agent_id)
    return principal


async def _gateway_rate_limit(
    principal: GatewayPrincipal,
    redis: Redis,
    *,
    bucket: str,
    fail_open: bool,
) -> None:
    """Per-identity rate limit keyed on the principal (not a shared secret)."""
    await _rate_limit_hit(
        redis,
        bucket=bucket,
        identifier=principal.rate_key,
        limit=int(principal.rate_limit_rpm or 30),
        window_seconds=60,
        fail_open=fail_open,
    )


# ---------------------------------------------------------------------------
# Room + participant resolution + scope enforcement
# ---------------------------------------------------------------------------


async def _resolve_room(db: AsyncSession, ref: str) -> Room:
    """Resolve a room by livekit_room_name OR display slug ``name``."""
    room = (
        await db.execute(
            select(Room).where(
                (Room.livekit_room_name == ref) | (Room.name == ref)
            )
        )
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail=f"Room not found: {ref}")
    return room


async def _enforce_scope(
    db: AsyncSession, principal: GatewayPrincipal, room: Room
) -> None:
    """Authorize this principal for this room, on BOTH read and write.

    - Key path (allowed_rooms is a list): the room must be in the allowlist
      (``*`` = any; ``@member`` = any room the key's agent participant is a
      member of, resolved against ``room_members`` — Nav v3 C1).
    - JWT path (allowed_rooms is None): the underlying HUMAN must already be a
      member of the room — the agent identity can only act where its human
      principal already belongs. No new reach beyond the human's membership.
    """
    if principal.allowed_rooms is not None:
        if await resolve_key_room_scope(
            db, principal.allowed_rooms, principal.agent_id, room
        ):
            return
        raise HTTPException(
            status_code=403, detail="Gateway key is not scoped to this room"
        )

    human = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == principal.human_sub)
        )
    ).scalar_one_or_none()
    if human is None or not await is_room_member(db, room.id, human.id):
        raise HTTPException(
            status_code=403,
            detail="Not authorized: you must be a member of this room",
        )


#: room_members.agent_mode values under which a seat never SPEAKS in the room
#: (design §3): listening reads (context builder) but never posts; muted
#: ignores the room. Neither may trigger a text run, so the messages poll —
#: the thing a bridge reacts to — hands them an empty page.
SILENT_AGENT_MODES: frozenset[str] = frozenset({"listening", "muted"})


async def _seat_agent_mode(db: AsyncSession, room: Room, agent_id: str) -> str | None:
    """The caller seat's ``agent_mode`` in ``room`` (None when unset or when
    the seat is not a member)."""
    row = (
        await db.execute(
            select(RoomMember.agent_mode)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(
                RoomMember.room_id == room.id,
                Participant.keycloak_sub == f"brigade:{agent_id}",
            )
        )
    ).scalar_one_or_none()
    return row if isinstance(row, str) and row else None


def seat_is_silent(agent_mode: str | None) -> bool:
    return agent_mode in SILENT_AGENT_MODES


def _room_envelope_facts(room: Room, seat_mode: str | None) -> dict[str, Any]:
    """Additive facts on the messages-page envelope (L2/L4 contract): the
    room, its type (a thread inherits its parent's), its parent when it is
    a thread, and the calling seat's own agent_mode."""
    room_type = getattr(room, "room_type", None)
    return {
        "room_id": getattr(room, "id", None),
        "room_type": getattr(room_type, "value", room_type) if room_type is not None else None,
        "parent_room_id": getattr(room, "parent_room_id", None),
        "agent_mode": seat_mode,
    }


async def _resolve_agent_participant(
    db: AsyncSession, agent_id: str, room: Room
) -> Participant:
    """Find-or-create the AGENT participant for ``agent_id`` and ensure it is a
    member of ``room`` (mirrors the legacy post_agent_message block, but the
    agent_id is DERIVED from the credential — never caller-supplied)."""
    pseudo_sub = f"brigade:{agent_id}"
    agent_p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is None:
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=f"agent-{agent_id}",
            display_name=agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
            metadata_={"backend": "runner"},
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    if (agent_p.metadata_ or {}).get("backend") != "runner":
        agent_p.metadata_ = {**(agent_p.metadata_ or {}), "backend": "runner"}
        await db.commit()

    member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        db.add(RoomMember(room_id=room.id, participant_id=agent_p.id, role=MemberRole.MEMBER))
        await db.commit()
    return agent_p


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class GatewayMessageBody(BaseModel):
    room: str = Field(..., description="livekit_room_name or room slug")
    content: str = Field(..., min_length=1)
    parent_id: uuid.UUID | None = None
    via: str | None = None


class GatewayTtsBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str | None = None
    agent: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def validate_allowed_rooms(rooms: list[str]) -> list[str]:
    """Normalise a key's ``allowed_rooms``: room names (either form), ``"*"``,
    or the ``@member`` token. Any other ``@…`` token is a typo, not a scope,
    and is refused so a mis-typed key never silently scopes to nothing."""
    out: list[str] = []
    for raw in rooms:
        entry = (raw or "").strip()
        if not entry:
            raise ValueError("allowed_rooms entries must be non-empty")
        if len(entry) > 255:
            raise ValueError("allowed_rooms entry is too long")
        if entry.startswith("@") and entry != MEMBER_SCOPE:
            raise ValueError(f"unknown scope token {entry!r} (only {MEMBER_SCOPE!r})")
        if entry not in out:
            out.append(entry)
    return out


class MintKeyBody(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=100)
    label: str | None = None
    #: Room names, ``"*"``, or ``"@member"`` (every room the agent is a
    #: member of — the operator's explicit choice, never the default).
    allowed_rooms: list[str] = Field(default_factory=lambda: ["*"])
    rate_limit_rpm: int = Field(30, ge=1, le=600)
    #: Promote this key to a room voice-settings controller (PATCH
    #: /rooms/{id}/voice-settings) in its allowed rooms. ``talk-controls-app``
    #: keys have this by identity; set it for any other key on purpose.
    can_manage_voice_settings: bool = False

    @field_validator("allowed_rooms")
    @classmethod
    def _rooms(cls, value: list[str]) -> list[str]:
        return validate_allowed_rooms(value)


class PatchKeyBody(BaseModel):
    """Partial update. Omitted fields stay as they are. 405 was the old answer."""

    label: str | None = None
    allowed_rooms: list[str] | None = None
    rate_limit_rpm: int | None = Field(default=None, ge=1, le=600)
    can_manage_voice_settings: bool | None = None

    @field_validator("allowed_rooms")
    @classmethod
    def _rooms(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else validate_allowed_rooms(value)


SeatEffort = Literal["low", "medium", "high", "max"]

#: Slug shape for a runner harness name (``claude-code``, ``codex``, …).
HARNESS_RE = r"^[a-z0-9][a-z0-9._-]{0,39}$"
#: Most models a seat may announce (C1: ``PUT /gateway/me``).
SEAT_CAPABILITIES_MAX_MODELS = 24
#: Participant-metadata key the announcement is stored under.
SEAT_CAPABILITIES_KEY = "seat_capabilities"


class SeatModelSpec(BaseModel):
    id: str = Field(..., pattern=SEAT_MODEL_RE.pattern)
    label: str = Field(default="", max_length=80)

    @field_validator("label")
    @classmethod
    def _label(cls, value: str) -> str:
        return (value or "").strip()


class SeatCapabilitiesBody(BaseModel):
    """What a runner announces about itself (design C1): its harness, the
    brain it runs by default, and the models / efforts a room may pick from
    (``metadata.seat``). The web reads it back through ``GET /crew``."""

    harness: str = Field(..., pattern=HARNESS_RE)
    default_model: str | None = Field(default=None, pattern=SEAT_MODEL_RE.pattern)
    default_effort: SeatEffort | None = None
    models: list[SeatModelSpec] = Field(
        default_factory=list, max_length=SEAT_CAPABILITIES_MAX_MODELS
    )
    efforts: list[SeatEffort] = Field(default_factory=lambda: list(SEAT_EFFORTS))

    @field_validator("models")
    @classmethod
    def _models(cls, value: list[SeatModelSpec]) -> list[SeatModelSpec]:
        seen: set[str] = set()
        out: list[SeatModelSpec] = []
        for spec in value:
            if spec.id in seen:
                continue
            seen.add(spec.id)
            out.append(SeatModelSpec(id=spec.id, label=spec.label or spec.id))
        return out

    @field_validator("efforts")
    @classmethod
    def _efforts(cls, value: list[str]) -> list[str]:
        # Keep the announced order, drop repeats; the enum is enforced by the
        # Literal so nothing outside low/medium/high/max gets this far.
        return list(dict.fromkeys(value))


class SeatSetting(BaseModel):
    model: str | None = None
    effort: SeatEffort | None = None


class GatewayRoomRow(BaseModel):
    """One row of ``GET /gateway/rooms`` — a room the key's seat is a member
    of, with the facts the runner needs to pick a policy (design C1)."""

    id: str
    name: str
    livekit_room_name: str
    display_name: str
    room_type: str
    parent_room_id: str | None = None
    #: private | shared | channel (design §2.3; ownership decides, §2.0).
    room_class: str
    #: HUMAN members (guests are counted under ``guests``).
    humans: int
    #: OTHER runner seats owned by a human in the room (caller not counted).
    own_seats: int
    #: OTHER runner seats owned by someone else, or by nobody (caller not
    #: counted) — one of these is what makes a room ``shared``.
    foreign_seats: int
    #: Guest humans + guest agents (``metadata.kind = guest_agent``).
    guests: int
    #: The caller seat's own membership agent_mode (null = pre-contract rule).
    agent_mode: str | None = None
    seat: SeatSetting
    updated_at: datetime | None = None


# ---------------------------------------------------------------------------
# Message endpoints
# ---------------------------------------------------------------------------


@router.post("/messages", response_model=MessageResponse, status_code=201)
async def gateway_post_message(
    body: GatewayMessageBody,
    request: Request,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> MessageResponse:
    """Post a message to a room AS the caller's derived agent identity."""
    await _gateway_rate_limit(principal, redis, bucket="gw_msg_send", fail_open=False)
    room = await _resolve_room(db, body.room)
    await _enforce_scope(db, principal, room)
    agent_p = await _resolve_agent_participant(db, principal.agent_id, room)
    # agent_mode (design §3): a listening or muted seat never speaks here.
    seat_mode = await _seat_agent_mode(db, room, principal.agent_id)
    if seat_is_silent(seat_mode):
        raise HTTPException(
            status_code=403,
            detail=f"This agent is {seat_mode} in this room and does not post",
        )

    fake_user = {
        "participant_id": agent_p.id,
        "sub": f"brigade:{principal.agent_id}",
        "username": agent_p.username,
        "display_name": agent_p.display_name,
        "email": None,
    }
    metadata: dict[str, Any] = {"agent_id": principal.agent_id, "gateway": True}
    if principal.human_sub:
        metadata["on_behalf_of"] = principal.human_sub
    if body.via:
        metadata["via"] = body.via

    result = await send_message(
        room_id=room.id,
        body=MessageCreate(
            content=body.content,
            content_type="text",
            metadata=metadata,
            parent_id=body.parent_id,
        ),
        user=fake_user,
        db=db,
        livekit=livekit,
        request=request,
    )

    # The bridge answered: retract any outstanding-relay marker for it. This is
    # the honest terminal state for a gateway agent — we never claimed it was
    # "thinking", only that something was undelivered, and delivery just
    # happened. Best-effort: a signalling failure must not fail the post, and
    # the marker's TTL clears it regardless.
    try:
        await touch_bridge_seen(principal.agent_id)
        await clear_relay_pending(room_id=room.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_relay_clear_failed", exc_info=True)

    return result


@router.get("/rooms/{room}/messages", response_model=MessageListResponse)
async def gateway_get_messages(
    room: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Cursor-paginated room history for the scoped caller (the missing token-authed
    READ endpoint — un-stubs the MCP's get_new_messages)."""
    await _gateway_rate_limit(principal, redis, bucket="gw_msg_read", fail_open=True)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)
    # agent_mode (design §3): the poll is what triggers a bridge's text run,
    # so a listening/muted seat gets an empty page here. Listening still
    # READS the room through GET /gateway/rooms/{room}/context.
    seat_mode = await _seat_agent_mode(db, room_obj, principal.agent_id)
    envelope = _room_envelope_facts(room_obj, seat_mode)
    if seat_is_silent(seat_mode):
        logger.info(
            "gateway_messages_silenced_by_agent_mode",
            room_id=str(room_obj.id),
            agent_id=principal.agent_id,
            agent_mode=seat_mode,
        )
        return MessageListResponse(messages=[], cursor=None, has_more=False, **envelope)
    # Reading IS collection: once the bridge has pulled the room's messages it
    # is no longer "waiting to relay", so drop the marker here as well as on
    # post. Two independent clearing paths plus a TTL means the indicator
    # cannot strand itself on. The touch is what proves this bridge is running
    # NOW — see agent_status.mark_relay_pending_for_room. Both are plain Redis
    # writes, and the clear only fans out on a real transition, so this stays
    # cheap on a 1-2s poll loop.
    try:
        await touch_bridge_seen(principal.agent_id)
        await clear_relay_pending(room_id=room_obj.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_relay_clear_failed", exc_info=True)

    svc = _build_message_service(db, livekit)
    result = await svc.get_messages(room_id=room_obj.id, cursor=cursor, limit=limit)
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages, cursor=result["cursor"], has_more=result["has_more"], **envelope
    )


@router.get("/rooms/{room}/context")
async def gateway_get_context(
    room: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    budget_tokens: int = Query(6000, ge=1, le=32000),
    since: uuid.UUID | None = Query(None, description="Only entries newer than this message id"),
) -> dict:
    """The room stream a SEAT walks into (design §4) — the gateway mirror of
    ``GET /rooms/{id}/context``: every sender, replies inline, voice lines,
    within a token budget, never filtered by when the seat joined or was
    last mentioned. Honours the seat's own ``context_depth`` when its
    participant is a member. Same scope rules as the messages poll."""
    from app.services.context_builder import build_context

    await _gateway_rate_limit(principal, redis, bucket="gw_msg_read", fail_open=True)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)
    seat = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == f"brigade:{principal.agent_id}")
        )
    ).scalar_one_or_none()
    membership = None
    if seat is not None:
        membership = (
            await db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room_obj.id,
                    RoomMember.participant_id == seat.id,
                )
            )
        ).scalar_one_or_none()
    payload = await build_context(
        db,
        room_id=room_obj.id,
        budget_tokens=budget_tokens,
        since_message_id=since,
        for_participant_id=seat.id if seat is not None else None,
    )
    # Plain JSON (uuids/datetimes stringified) — the runner reads it as data.
    from app.schemas.room import ContextResponse

    out = ContextResponse(**payload).model_dump(mode="json")
    # L4: the seat's own standing in this room, so a runner learns its mode
    # (listening / muted / when_named / answers_all — design §3) and can tell
    # its own lines apart (entry.sender.id == seat_participant_id) from the
    # one call it already makes. Additive; the member endpoint's contract
    # (ContextResponse) is unchanged.
    out["seat_participant_id"] = str(seat.id) if seat is not None else None
    out["agent_mode"] = getattr(membership, "agent_mode", None) if membership is not None else None
    out["context_depth"] = (
        getattr(membership, "context_depth", None) if membership is not None else None
    )
    # Nav v3 C1: the room's class (private / shared / channel, design §2.3)
    # and its seat setting ({model, effort}, nulls = the seat's defaults) so
    # a runner can pick its policy and brain from the one call it already
    # makes per turn. Same values GET /gateway/rooms reports.
    facts = room_class_for(
        room_obj, seat_participant_id=seat.id if seat is not None else None
    )
    out["room_class"] = facts.room_class
    out["seat"] = seat_setting_from_metadata(getattr(room_obj, "metadata_", None))
    return out


def seat_room_row(room: Any, seat_participant_id: Any) -> GatewayRoomRow:
    """Pure: one ``GET /gateway/rooms`` row from a loaded room (members
    selectin-loaded) and the caller seat's participant id."""
    facts = room_class_for(room, seat_participant_id=seat_participant_id)
    agent_mode: str | None = None
    for member in getattr(room, "members", None) or []:
        if str(getattr(member, "participant_id", None)) == str(seat_participant_id):
            mode = getattr(member, "agent_mode", None)
            agent_mode = mode if isinstance(mode, str) and mode else None
            break
    room_type = getattr(room, "room_type", None)
    parent = getattr(room, "parent_room_id", None)
    return GatewayRoomRow(
        id=str(room.id),
        name=room.name,
        livekit_room_name=room.livekit_room_name,
        display_name=room.display_name,
        room_type=str(getattr(room_type, "value", room_type) or ""),
        parent_room_id=str(parent) if parent is not None else None,
        room_class=facts.room_class,
        humans=facts.humans,
        own_seats=facts.own_seats,
        foreign_seats=facts.foreign_seats,
        guests=facts.guests,
        agent_mode=agent_mode,
        seat=SeatSetting(**seat_setting_from_metadata(getattr(room, "metadata_", None))),
        updated_at=getattr(room, "updated_at", None),
    )


async def _find_seat_participant(db: AsyncSession, agent_id: str) -> Participant | None:
    return (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == f"brigade:{agent_id}")
        )
    ).scalar_one_or_none()


@router.get("/rooms", response_model=list[GatewayRoomRow])
async def gateway_list_rooms(
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> list[GatewayRoomRow]:
    """Every non-archived room the caller's seat is a member of (design C1).

    This is how a seat follows its human: the runner polls it and watches
    whatever it finds — hubs, threads, rooms it was added to — under the
    policy the ``room_class`` implies, instead of a YAML list. Membership is
    the whole filter; the key's ``allowed_rooms`` still gates what the seat
    may then read or post (``@member`` makes the two agree).
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_msg_read", fail_open=True)
    seat = await _find_seat_participant(db, principal.agent_id)
    if seat is None:
        # A provisioned seat that has never posted has no participant row
        # yet, hence no memberships. Empty, not 404: the runner keeps polling.
        return []
    rooms = (
        await db.execute(
            select(Room)
            .join(RoomMember, RoomMember.room_id == Room.id)
            .where(
                RoomMember.participant_id == seat.id,
                Room.is_archived.is_(False),
            )
            .order_by(Room.updated_at.desc())
        )
    ).scalars().all()
    return [seat_room_row(room, seat.id) for room in rooms]


async def _get_or_create_seat_participant(db: AsyncSession, agent_id: str) -> Participant:
    """The seat's participant row, created on first contact (mirrors
    ``_resolve_agent_participant`` minus the room membership)."""
    seat = await _find_seat_participant(db, agent_id)
    if seat is None:
        seat = Participant(
            keycloak_sub=f"brigade:{agent_id}",
            username=f"agent-{agent_id}",
            display_name=agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
            metadata_={"backend": "runner"},
        )
        db.add(seat)
        await db.commit()
        await db.refresh(seat)
    return seat


@router.put("/me")
async def gateway_put_me(
    body: SeatCapabilitiesBody,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> dict[str, Any]:
    """A runner announces its harness, default brain and the models/efforts a
    room may pick from (design C1). Stored on the seat participant as
    ``metadata.seat_capabilities`` — merged, so the seat's other metadata
    (``backend``, ``crew``, avatar…) is never clobbered — and returned as
    stored. Runners call it at start and hourly; the web reads it via
    ``GET /crew``."""
    await _gateway_rate_limit(principal, redis, bucket="gw_me", fail_open=True)
    seat = await _get_or_create_seat_participant(db, principal.agent_id)
    stored = body.model_dump(mode="json")
    stored["updated_at"] = datetime.now(timezone.utc).isoformat()
    # Reassign, never mutate: SQLAlchemy does not see in-place JSONB edits.
    meta = dict(seat.metadata_ or {})
    if meta.get("backend") != "runner":
        # Whoever announces capabilities through the gateway IS a runner-backed
        # seat (same stamp the post path applies).
        meta["backend"] = "runner"
    meta[SEAT_CAPABILITIES_KEY] = stored
    seat.metadata_ = meta
    await db.commit()
    logger.info(
        "gateway_seat_capabilities_stored",
        agent_id=principal.agent_id,
        harness=body.harness,
        models=len(body.models),
    )
    return stored


# ---------------------------------------------------------------------------
# Voice (suite TTS / STT) + session lifecycle for MCP bridges
# ---------------------------------------------------------------------------


class TalkGateBody(BaseModel):
    """Hold or release the talk gate for a room."""

    room: str = Field(..., min_length=1, max_length=200)
    open: bool
    #: Who the held pedal addresses: an agent USERNAME (``agent-grok``), or
    #: ``rook``/omitted for the relay's own persona. The relay persists the
    #: heard line as ``@<target> …`` so that agent's poller sees a mention.
    target: str | None = Field(
        default=None, min_length=2, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$"
    )


@router.post("/talk-gate", status_code=202)
async def set_talk_gate(
    body: TalkGateBody,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> dict:
    """Say "I am addressing the agent now" (or stopped).

    THE ONE PRIMITIVE for external activation. A foot pedal, a stream deck, a
    phone button or a hotkey all become clients of this rather than each
    needing its own integration — which is why there is no pedal-shaped
    endpoint here.

    The state is not stored: it is broadcast into the room's LiveKit session as
    a ``talk_gate`` frame, exactly like every other in-room signal, so the
    voice relay (agents/voice_relay) simply hears it. Nothing to reconcile,
    nothing to leak if a holder disconnects mid-press — the next release, or
    the relay's own teardown, ends it.
    """
    # A pedal press is a high-frequency event; fail OPEN on a limiter blip so a
    # rate-limit hiccup cannot leave the gate stuck and the agent deaf.
    await _gateway_rate_limit(principal, redis, bucket="gw_talk_gate", fail_open=True)
    room = await _resolve_room(db, body.room)
    await _enforce_scope(db, principal, room)
    target = (body.target or "").strip() or None
    frame: dict[str, Any] = {
        "type": "talk_gate",
        "open": bool(body.open),
        "by": principal.agent_id,
    }
    if target:
        frame["target"] = target
    try:
        await livekit.send_data(room.livekit_room_name, frame)
    except Exception:
        # No live session is the ordinary case, not a fault: a pedal held
        # before anyone joins the call has nobody to tell. Reporting that as a
        # 502 would train the holder to ignore real failures, and a pedal that
        # errors when the call has not started yet feels broken when it is not.
        logger.info(
            "talk_gate_undelivered",
            room=room.livekit_room_name,
            open=bool(body.open),
            reason="no live media session for this room",
        )
        return {"room": body.room, "open": bool(body.open), "target": target, "delivered": False}
    logger.info(
        "talk_gate_set",
        room=room.livekit_room_name,
        open=bool(body.open),
        by=principal.agent_id,
        target=target,
    )
    return {"room": body.room, "open": bool(body.open), "target": target, "delivered": True}


@router.post("/tts")
async def gateway_tts(
    body: GatewayTtsBody,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    redis: Annotated[Redis, Depends(get_redis)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Response:
    """Synthesize speech via suite Kokoro (Orator) for a gateway/MCP agent.

    Same contract as ``POST /api/v1/tts`` but authenticated with a gateway key
    or uchub JWT that has the agent-gateway role. Rate-limited per principal.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_tts", fail_open=False)

    # Reuse the public TTS voice map + speakable scrub via a local import so we
    # don't drift from the browser path.
    from app.api.tts import (
        AGENT_DEFAULT_VOICE,
        AGENT_VOICES,
        _normalize_agent,
    )
    import re as _re

    speakable = _re.sub(r"\s+", " ", body.text).strip()
    speakable = _re.sub(
        r"[\U00010000-\U0010ffff\u2600-\u27BF\uFE0F\u200D]+",
        " ",
        speakable,
    )
    speakable = _re.sub(r"\s+", " ", speakable).strip()
    if not speakable or not _re.search(r"[A-Za-z0-9]", speakable):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nothing to speak",
        )

    if body.voice:
        voice = body.voice
    elif body.agent:
        voice = AGENT_VOICES.get(_normalize_agent(body.agent), AGENT_DEFAULT_VOICE)
    else:
        # Prefer the caller's own agent identity voice when known.
        voice = AGENT_VOICES.get(
            _normalize_agent(principal.agent_id), settings.tts_default_voice
        )

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                f"{settings.kokoro_base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "input": speakable,
                    "voice": voice,
                    "response_format": "mp3",
                    "speed": body.speed,
                },
            )
    except httpx.HTTPError:
        logger.warning("gateway_tts_upstream_unreachable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "gateway_tts_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS synthesis failed",
        )

    logger.info(
        "gateway_tts_synthesized",
        agent_id=principal.agent_id,
        chars=len(speakable),
        voice=voice,
    )
    return Response(
        content=upstream.content,
        media_type=upstream.headers.get("content-type", "audio/mpeg"),
    )


@router.post("/stt")
async def gateway_stt(
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    redis: Annotated[Redis, Depends(get_redis)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    file: UploadFile = File(..., description="Audio file to transcribe"),
    language: str | None = Form(default=None),
    model: str | None = Form(default=None),
) -> dict[str, Any]:
    """Transcribe audio via suite STT (Amanuensis/Parakeet) for a gateway agent.

    Same upstream as ``POST /api/v1/stt``; auth is gateway key / agent JWT.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_stt", fail_open=False)

    base = (settings.whisper_base_url or "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STT service not configured",
        )

    audio = await file.read()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty audio payload",
        )
    if len(audio) > 25 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Audio exceeds 25 MB limit",
        )

    use_model = (model or settings.whisper_model or "whisper-1").strip()
    filename = file.filename or "audio.webm"
    content_type = (file.content_type or "application/octet-stream").split(";")[0]
    form_data: dict[str, Any] = {"model": use_model}
    if language:
        form_data["language"] = language.strip()

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                f"{base}/audio/transcriptions",
                data=form_data,
                files={"file": (filename, audio, content_type)},
            )
    except httpx.HTTPError:
        logger.warning("gateway_stt_upstream_unreachable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "gateway_stt_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT transcription failed",
        )

    try:
        body = upstream.json()
    except ValueError:
        body = {"text": upstream.text}

    logger.info(
        "gateway_stt_transcribed",
        agent_id=principal.agent_id,
        bytes=len(audio),
        chars=len((body.get("text") if isinstance(body, dict) else "") or ""),
    )
    if isinstance(body, dict):
        return body
    return {"text": str(body)}


@router.post("/rooms/{room}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def gateway_leave_room(
    room: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> None:
    """Remove the caller's agent identity from a room (clean bridge exit).

    Deletes the RoomMember row for ``brigade:{agent_id}``, clears any relay
    marker, and best-effort-evicts the LiveKit participant so the strip no
    longer shows a ghost agent after Claude Code / MCP disconnects.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_leave", fail_open=True)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)

    pseudo_sub = f"brigade:{principal.agent_id}"
    agent_p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            delete(RoomMember).where(
                RoomMember.room_id == room_obj.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
        await db.commit()

    try:
        await clear_relay_pending(room_id=room_obj.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_leave_relay_clear_failed", exc_info=True)

    # Best-effort LiveKit eviction (identity patterns match remove_brigade_agent).
    try:
        for identity in (
            f"agent-{principal.agent_id}",
            f"agent-brigade-{principal.agent_id}",
            principal.agent_id,
        ):
            try:
                await livekit.remove_participant(
                    room_name=room_obj.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("gateway_leave_livekit_evict_failed", exc_info=True)

    logger.info(
        "gateway_left_room",
        agent_id=principal.agent_id,
        room=room_obj.livekit_room_name,
    )
    return None


@router.delete(
    "/rooms/{room}/brigade-agents/{brigade_agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def gateway_remove_brigade_agent(
    room: str,
    brigade_agent_id: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> None:
    """Kick a stuck Brigade agent from a room the caller is scoped to.

    Mirrors ``DELETE /api/v1/rooms/{room}/brigade-agents/{id}`` for MCP bridges
    that hold a gateway credential rather than a browser user JWT. The caller
    must be scoped to the room; they may remove any agent in that room
    (including themselves — prefer ``POST .../leave`` for self-exit).
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_kick", fail_open=False)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)

    agent_id = (brigade_agent_id or "").strip()
    if not agent_id:
        raise HTTPException(status_code=422, detail="brigade_agent_id required")

    pseudo_sub = f"brigade:{agent_id}"
    agent_p = (
        await db.execute(
            select(Participant).where(
                Participant.keycloak_sub == pseudo_sub,
                Participant.participant_type == ParticipantType.AGENT,
            )
        )
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            delete(RoomMember).where(
                RoomMember.room_id == room_obj.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
        await db.commit()

    try:
        await clear_relay_pending(room_id=room_obj.id, agent_id=agent_id)
    except Exception:
        logger.debug("gateway_kick_relay_clear_failed", exc_info=True)

    try:
        for identity in (
            f"agent-{agent_id}",
            f"agent-brigade-{agent_id}",
            agent_id,
        ):
            try:
                await livekit.remove_participant(
                    room_name=room_obj.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("gateway_kick_livekit_evict_failed", exc_info=True)

    logger.info(
        "gateway_removed_agent",
        by=principal.agent_id,
        removed=agent_id,
        room=room_obj.livekit_room_name,
    )
    return None


# ---------------------------------------------------------------------------
# Key administration (operator-only, gated by the internal bearer secret)
# ---------------------------------------------------------------------------


@router.post("/keys", status_code=201)
async def mint_gateway_key(
    body: MintKeyBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Mint a scoped gateway key. Operator-only (internal bearer secret).

    The raw key is returned ONCE; only its SHA-256 hash is stored.
    """
    verify_key_admin_bearer(request)
    agent_id = slugify(body.agent_id)
    raw = f"{_KEY_PREFIXES[0]}{secrets.token_urlsafe(32)}"
    row = AgentGatewayKey(
        key_hash=hash_key(raw),
        key_prefix=raw[:12],
        agent_id=agent_id,
        label=body.label,
        allowed_rooms=body.allowed_rooms or ["*"],
        rate_limit_rpm=body.rate_limit_rpm,
        can_manage_voice_settings=bool(body.can_manage_voice_settings),
        created_by=(request.headers.get("X-Operator") or "operator"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("gateway_key_minted", agent_id=agent_id, key_id=str(row.id))
    return {
        "id": str(row.id),
        "agent_id": agent_id,
        "key": raw,  # shown ONCE
        "key_prefix": row.key_prefix,
        "allowed_rooms": row.allowed_rooms,
        "rate_limit_rpm": row.rate_limit_rpm,
        "can_manage_voice_settings": bool(row.can_manage_voice_settings),
    }


@router.get("/keys")
async def list_gateway_keys(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """List key metadata (no secrets). Operator-only."""
    verify_key_admin_bearer(request)
    rows = (await db.execute(select(AgentGatewayKey))).scalars().all()
    return {
        "keys": [
            {
                "id": str(r.id),
                "agent_id": r.agent_id,
                "key_prefix": r.key_prefix,
                "label": r.label,
                "allowed_rooms": r.allowed_rooms,
                "rate_limit_rpm": r.rate_limit_rpm,
                "can_manage_voice_settings": bool(r.can_manage_voice_settings),
                "revoked": r.revoked_at is not None,
            }
            for r in rows
        ]
    }


@router.patch("/keys/{key_id}")
async def patch_gateway_key(
    key_id: uuid.UUID,
    body: PatchKeyBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Update rooms/rate/label on an existing key. Operator-only.

    Mint-and-swap was the only option because this returned 405. A live
    room that needs 360 rpm on both name forms should not require a new
    secret.
    """
    verify_key_admin_bearer(request)
    row = (
        await db.execute(select(AgentGatewayKey).where(AgentGatewayKey.id == key_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Key not found")
    if row.revoked_at is not None:
        raise HTTPException(status_code=409, detail="Key is revoked")
    if body.label is not None:
        row.label = body.label
    if body.allowed_rooms is not None:
        row.allowed_rooms = body.allowed_rooms
    if body.rate_limit_rpm is not None:
        row.rate_limit_rpm = body.rate_limit_rpm
    if body.can_manage_voice_settings is not None:
        row.can_manage_voice_settings = bool(body.can_manage_voice_settings)
    await db.commit()
    logger.info("gateway_key_patched", key_id=str(key_id), agent_id=row.agent_id)
    return {
        "id": str(row.id),
        "agent_id": row.agent_id,
        "key_prefix": row.key_prefix,
        "label": row.label,
        "allowed_rooms": row.allowed_rooms,
        "rate_limit_rpm": row.rate_limit_rpm,
        "can_manage_voice_settings": bool(row.can_manage_voice_settings),
        "revoked": False,
    }


@router.delete("/keys/{key_id}")
async def revoke_gateway_key(
    key_id: uuid.UUID,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Revoke a key (instant). Operator-only."""
    verify_key_admin_bearer(request)
    from datetime import datetime, timezone

    row = (
        await db.execute(select(AgentGatewayKey).where(AgentGatewayKey.id == key_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Key not found")
    row.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    return {"id": str(key_id), "revoked": True}


@router.get("/health")
async def gateway_health() -> dict:
    """Public liveness for the gateway feature (no auth, no data)."""
    return {"gateway": "enabled" if _gateway_enabled() else "disabled"}
