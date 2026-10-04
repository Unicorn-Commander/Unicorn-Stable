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

import math
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Iterable, Literal

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
from pydantic import BaseModel, Field, field_validator, model_validator
from redis.asyncio import Redis
from sqlalchemy import cast, delete, func, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.api._internal_auth import verify_internal_bearer, verify_key_admin_bearer
from app.api.messages import (
    AGENT_IDENTITY_METADATA_KEYS,
    _build_message_service,
    agent_id_of_identity,
    _msg_to_response,
    send_message,
)
from app.auth.gateway_auth import (
    KEY_PREFIXES,
    MEMBER_SCOPE,
    GatewayAuthError,
    GatewayPrincipal,
    hash_key,
    key_scope_wants_membership,
    resolve_key_room_scope,
    room_in_key_scope,
    slugify,
    validate_gateway_jwt,
    verify_gateway_key,
)
from app.services.room_class import (
    SEAT_CAPABILITIES_KEY,
    SEAT_EFFORTS,
    SEAT_MODEL_RE,
    Actor,
    RoomClassFacts,
    RoomLite,
    apply_class_floors,
    compute_room_classes,
    load_members,
    seat_owners,
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


def _room_envelope_facts(
    room: Room,
    seat_mode: str | None,
    facts: RoomClassFacts | None = None,
    seat: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Additive facts on the messages-page envelope (L2/L4 contract): the
    room, its type (a thread inherits its parent's), its parent when it is
    a thread, the calling seat's own agent_mode and — Nav v3 R11 — the
    room's class and the seat's own ``{model, effort}``, so the poll that
    triggers a turn can downgrade the runner's hands on the spot."""
    room_type = getattr(room, "room_type", None)
    return {
        "room_id": getattr(room, "id", None),
        "room_type": getattr(room_type, "value", room_type) if room_type is not None else None,
        "parent_room_id": getattr(room, "parent_room_id", None),
        "agent_mode": seat_mode,
        "room_class": facts.room_class if facts is not None else None,
        "class_reasons": list(facts.reasons) if facts is not None else [],
        "seat": seat,
    }


def _asking_seat(seat: Participant | None, agent_id: str) -> Any:
    """The principal's own seat as the classifier counts it (R3): its row
    when it has one, else a runner-shaped stand-in with no owner — which
    reads every room as ``shared`` until the seat exists and is owned. The
    stand-in carries a sentinel id so it is never mistaken for an OTHER seat
    (or for a real row) in the counts."""
    if seat is not None:
        return seat
    return Actor(
        id=f"asking:{agent_id}",
        participant_type=ParticipantType.AGENT,
        username=f"agent-{agent_id}",
        keycloak_sub=f"brigade:{agent_id}",
        metadata_={"backend": "runner"},
    )


async def _principal_owner_username(db: AsyncSession, principal: GatewayPrincipal) -> str | None:
    """For a JWT-path principal (``dev-<username>``) the human behind the
    token owns the agent identity — R1 stamps ``metadata.owner`` with that
    username. Key-path principals get their owner from the operator."""
    if getattr(principal, "auth_kind", None) != "jwt" or not getattr(principal, "human_sub", None):
        return None
    username = (
        await db.execute(
            select(Participant.username).where(Participant.keycloak_sub == principal.human_sub)
        )
    ).scalar_one_or_none()
    return username or None


async def _classify_for_seat(
    db: AsyncSession, room: Room, seat: Participant | None, agent_id: str
) -> RoomClassFacts:
    """The R2 class of one room as the asking seat sees it (``room_class``).
    The sticky floor is written only from what was WRITTEN in the room
    (``history_shared``, REVIEW-3 P1-2): never from who is a member now and
    never from who is asking, so reading a room cannot change it."""
    facts = (await compute_room_classes(db, [room], asking_seat=_asking_seat(seat, agent_id)))[
        str(room.id)
    ]
    if await apply_class_floors(db, [room], {str(room.id): facts}):
        await db.commit()
    return facts


async def _resolve_agent_participant(
    db: AsyncSession, agent_id: str, room: Room, *, owner_username: str | None = None
) -> Participant:
    """Find-or-create the AGENT participant for ``agent_id`` and ensure it is a
    member of ``room`` (mirrors the legacy post_agent_message block, but the
    agent_id is DERIVED from the credential — never caller-supplied).
    ``owner_username`` (JWT-path principals) is stamped as ``metadata.owner``
    when the row has none (R1)."""
    pseudo_sub = f"brigade:{agent_id}"
    agent_p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is None:
        meta: dict[str, Any] = {"backend": "runner"}
        if owner_username:
            meta["owner"] = owner_username
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=f"agent-{agent_id}",
            display_name=agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
            metadata_=meta,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    patch: dict[str, Any] = {}
    if (agent_p.metadata_ or {}).get("backend") != "runner":
        patch["backend"] = "runner"
    if owner_username and not seat_owners(agent_p):
        patch["owner"] = owner_username
    if patch:
        agent_p.metadata_ = {**(agent_p.metadata_ or {}), **patch}
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
    if not rooms:
        # An empty allowlist used to fall through to ["*"] on mint and on
        # verify. A key scoped to nothing must be said so, not widened.
        raise ValueError('allowed_rooms must not be empty (use ["*"] for any room)')
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


#: participants.username is String(100) and a seat's username is
#: ``agent-<agent_id>``; a longer id 500s on the post path.
MAX_SEAT_AGENT_ID_LEN = 94


#: Why the API takes one name. A list-form owner means "one person with two
#: accounts" and must never name two people: a seat owned by two people
#: reads ``private`` in either one's room and bridges their private worlds.
#: Nothing in ``participants`` can prove two rows are one person, so a list
#: is written only by a migration an operator has reviewed.
LIST_OWNER_DETAIL = (
    "owner must be ONE username: list-form owners are set by migration only"
)


def validate_owner(value: Any) -> str | None:
    """``owner`` on mint and PATCH: ONE username, trimmed and lower-cased.
    A list (or anything else that is not a string) is refused. That the
    name belongs to a HUMAN is checked against the database by the handler
    (:func:`require_human_owner`)."""
    if value is None:
        return None
    if isinstance(value, (list, tuple, set, dict)):
        raise ValueError(LIST_OWNER_DETAIL)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("owner must be a username")
    name = value.strip().lower()
    if len(name) > 100:
        raise ValueError("owner username is too long")
    return name


async def require_human_owner(db: AsyncSession, owner: str) -> str:
    """422 unless ``owner`` names exactly one existing HUMAN participant,
    compared the way every reader compares it: ``lower(btrim(username))``.

    An owner string with no human row behind it is a standing offer: on a
    realm that allows registration, the first account to take that name
    owns the seat. Two human rows that normalise to the same name make
    "the owner" ambiguous. Both are refused here rather than discovered
    later by the room class."""
    matches = (
        (
            await db.execute(
                select(Participant.id)
                .where(
                    Participant.participant_type == ParticipantType.HUMAN,
                    func.lower(func.btrim(Participant.username)) == owner,
                )
                .limit(2)
            )
        )
        .scalars()
        .all()
    )
    if not matches:
        raise HTTPException(
            status_code=422,
            detail=f"owner {owner!r} is not the username of an existing human participant",
        )
    if len(matches) > 1:
        raise HTTPException(
            status_code=422,
            detail=(
                f"more than one human participant is named {owner!r} once trimmed and "
                "lower-cased; resolve the duplicate before owning a seat with that name"
            ),
        )
    return owner


def _principal_history_from(principal: Any) -> datetime | None:
    """The key's history floor, or None.

    None is full history: the JWT path sets it explicitly, and a NULL
    ``history_from`` column means the same. A caller double that predates
    the field is treated as NULL, never as 'hide everything'. A value that
    is present and not a datetime is not full history: the caller reads
    nothing older than now."""
    value = getattr(principal, "history_from", None)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.now(timezone.utc)


def _operator_of(request: Request) -> str | None:
    """Who the caller says they are (``X-Operator``), for the audit line.
    Self-declared by the holder of the key-admin secret; capped."""
    value = (request.headers.get("X-Operator") or "").strip()
    return value[:120] or None


#: Named in every 422 that rejects a missing or doubled expiry choice.
EXPIRY_CHOICE_DETAIL = (
    "Choose exactly one of expires_in_days, expires_at, or no_expiry=true"
)
HISTORY_DETAIL = 'history must be "full", "from_mint", or an ISO-8601 time'
HISTORY_FUTURE_DETAIL = "history must not be in the future"
EXPIRES_PAST_DETAIL = "expires_at is in the past"


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _expiry_choice_count(
    expires_in_days: int | None, expires_at: datetime | None, no_expiry: bool
) -> int:
    """``no_expiry`` counts only when true. False is the default, not a choice."""
    return (
        int(expires_in_days is not None)
        + int(expires_at is not None)
        + int(bool(no_expiry))
    )


def parse_history(history: str, *, now: datetime, from_mint_at: datetime) -> datetime | None:
    """``full`` → NULL, ``from_mint`` → ``from_mint_at``, else an ISO time.

    An ISO time in the future is refused. Naive datetimes are UTC.
    """
    raw = (history or "").strip()
    if raw == "full":
        return None
    if raw == "from_mint":
        return _as_utc(from_mint_at)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(HISTORY_DETAIL) from exc
    parsed = _as_utc(parsed)
    if parsed > _as_utc(now):
        raise ValueError(HISTORY_FUTURE_DETAIL)
    return parsed


def resolve_expiry(
    *,
    expires_in_days: int | None,
    expires_at: datetime | None,
    no_expiry: bool,
    now: datetime,
) -> datetime | None:
    """The ``expires_at`` to store. The caller has already required one choice."""
    if no_expiry:
        return None
    if expires_in_days is not None:
        return _as_utc(now) + timedelta(days=int(expires_in_days))
    if expires_at is None:
        raise ValueError(EXPIRY_CHOICE_DETAIL)
    expires = _as_utc(expires_at)
    # ``<= now`` matches verify_gateway_key, so mint cannot store a key that
    # is already expired.
    if expires <= _as_utc(now):
        raise ValueError(EXPIRES_PAST_DETAIL)
    return expires


def resolve_mint_lifetime(
    *,
    expires_in_days: int | None,
    expires_at: datetime | None,
    no_expiry: bool,
    history: str,
    now: datetime,
) -> tuple[datetime | None, datetime | None]:
    if _expiry_choice_count(expires_in_days, expires_at, no_expiry) != 1:
        raise ValueError(EXPIRY_CHOICE_DETAIL)
    return (
        resolve_expiry(
            expires_in_days=expires_in_days,
            expires_at=expires_at,
            no_expiry=no_expiry,
            now=now,
        ),
        parse_history(history, now=now, from_mint_at=now),
    )


def apply_patch_lifetime(row: Any, body: Any, now: datetime) -> None:
    """Set or extend expiry, and/or set history. Does not touch ``revoked_at``."""
    count = _expiry_choice_count(body.expires_in_days, body.expires_at, body.no_expiry)
    if count > 1:
        raise ValueError(EXPIRY_CHOICE_DETAIL)
    if count == 1:
        row.expires_at = resolve_expiry(
            expires_in_days=body.expires_in_days,
            expires_at=body.expires_at,
            no_expiry=body.no_expiry,
            now=now,
        )
    if body.history is not None:
        mint_at = getattr(row, "created_at", None)
        if not isinstance(mint_at, datetime):
            mint_at = now
        row.history_from = parse_history(body.history, now=now, from_mint_at=mint_at)


def key_lifetime_view(
    expires_at: datetime | None,
    history_from: datetime | None,
    *,
    now: datetime,
) -> dict[str, Any]:
    """``days_left`` is a positive integer, or null. An expired key is
    ``expired: true`` with ``days_left`` null — never 0 or a negative."""
    now_utc = _as_utc(now)
    expires = _as_utc(expires_at) if isinstance(expires_at, datetime) else None
    history = _as_utc(history_from) if isinstance(history_from, datetime) else None
    if expires is None:
        expired = False
        days_left: int | None = None
    else:
        seconds = (expires - now_utc).total_seconds()
        expired = seconds <= 0
        if expired:
            days_left = None
        else:
            days_left = math.ceil(seconds / 86400)
            if days_left <= 0:
                days_left = None
    return {
        "expires_at": expires,
        "history_from": history,
        "days_left": days_left,
        "expired": expired,
    }


def _lifetime_422(exc: ValueError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
    )


class MintKeyBody(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=MAX_SEAT_AGENT_ID_LEN)
    label: str | None = None
    #: Room names, ``"*"``, or ``"@member"`` (every room the agent is a
    #: member of — the operator's explicit choice, never the default).
    allowed_rooms: list[str] = Field(default_factory=lambda: ["*"])
    rate_limit_rpm: int = Field(30, ge=1, le=600)
    #: Promote this key to a room voice-settings controller (PATCH
    #: /rooms/{id}/voice-settings) in its allowed rooms. ``talk-controls-app``
    #: keys have this by identity; set it for any other key on purpose.
    can_manage_voice_settings: bool = False
    #: The human this seat belongs to: ONE username, which must be an
    #: existing HUMAN participant (422 otherwise; a list is refused).
    #: Stamped on the seat's participant row at mint — created there and
    #: then if the seat has never posted — so the seat is owned from its
    #: first contact (R1 / P2-9). Ownership decides room privacy.
    owner: str | None = None
    #: Exactly one of these three. ``no_expiry=true`` stores NULL (the key
    #: does not expire). ``expires_in_days`` is 1..366 from now.
    expires_in_days: int | None = Field(default=None, ge=1, le=366)
    expires_at: datetime | None = None
    no_expiry: bool = False
    #: Required. ``full`` stores NULL (the whole room). ``from_mint`` stores
    #: the mint time. An ISO-8601 time stores that time, and must not be in
    #: the future. There is no default: a forgotten field must not grant
    #: the room's full history.
    history: str

    @model_validator(mode="before")
    @classmethod
    def _history_is_required(cls, data: Any) -> Any:
        # A missing or null history is not "full". Blank it so the field
        # validator names the three options, and so other missing fields
        # (agent_id) are still reported on the same 422.
        if isinstance(data, dict) and data.get("history") is None:
            data = dict(data)
            data["history"] = ""
        return data

    @field_validator("history", mode="before")
    @classmethod
    def _history_names_the_options(cls, value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(HISTORY_DETAIL)
        return value

    @field_validator("allowed_rooms")
    @classmethod
    def _rooms(cls, value: list[str]) -> list[str]:
        return validate_allowed_rooms(value)

    @field_validator("owner", mode="before")
    @classmethod
    def _owner(cls, value: Any) -> str | None:
        return validate_owner(value)

    @model_validator(mode="after")
    def _explicit_expiry(self) -> MintKeyBody:
        try:
            resolve_mint_lifetime(
                expires_in_days=self.expires_in_days,
                expires_at=self.expires_at,
                no_expiry=self.no_expiry,
                history=self.history,
                now=datetime.now(timezone.utc),
            )
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        return self


class PatchKeyBody(BaseModel):
    """Partial update. Omitted fields stay as they are. 405 was the old answer."""

    label: str | None = None
    allowed_rooms: list[str] | None = None
    rate_limit_rpm: int | None = Field(default=None, ge=1, le=600)
    can_manage_voice_settings: bool | None = None
    #: Set (or change) the human who owns this key's seat: ONE username,
    #: which must be an existing HUMAN participant (422 otherwise; a list is
    #: refused). Stamped on the seat's participant row by merge; the row is
    #: created if the seat has never posted. The only way to own a seat
    #: minted before owners existed.
    owner: str | None = None
    #: Omitted = leave ``expires_at`` as it is. When any of these is sent,
    #: exactly one: set ``expires_at``, set it to now + days, or clear it.
    #: There is no field that clears ``revoked_at``.
    expires_in_days: int | None = Field(default=None, ge=1, le=366)
    expires_at: datetime | None = None
    no_expiry: bool = False
    #: Omitted = leave ``history_from``. Same three values as mint.
    #: ``from_mint`` stores the key's ``created_at``, not the patch time.
    history: str | None = None

    @field_validator("allowed_rooms")
    @classmethod
    def _rooms(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else validate_allowed_rooms(value)

    @field_validator("owner", mode="before")
    @classmethod
    def _owner(cls, value: Any) -> str | None:
        return validate_owner(value)

    @model_validator(mode="after")
    def _expiry_choice(self) -> PatchKeyBody:
        count = _expiry_choice_count(
            self.expires_in_days, self.expires_at, self.no_expiry
        )
        if count > 1:
            raise ValueError(EXPIRY_CHOICE_DETAIL)
        now = datetime.now(timezone.utc)
        try:
            if count == 1:
                resolve_expiry(
                    expires_in_days=self.expires_in_days,
                    expires_at=self.expires_at,
                    no_expiry=self.no_expiry,
                    now=now,
                )
            if self.history is not None:
                parse_history(self.history, now=now, from_mint_at=now)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        return self


SeatEffort = Literal["low", "medium", "high", "max"]

#: Slug shape for a runner harness name (``claude-code``, ``codex``, …).
HARNESS_RE = r"^[a-z0-9][a-z0-9._-]{0,39}$"
#: Most models a seat may announce (C1: ``PUT /gateway/me``). The
#: participant-metadata key it is stored under is
#: ``room_class.SEAT_CAPABILITIES_KEY`` (shared with the crew reader).
SEAT_CAPABILITIES_MAX_MODELS = 24


def _validate_model_id(value: str | None) -> str | None:
    """Whole-string match (``fullmatch``): pydantic's ``pattern`` searches,
    and ``$`` would let a trailing newline through — the stored id reaches
    the runner's ``--model`` verbatim."""
    if value is None:
        return None
    if not isinstance(value, str) or not SEAT_MODEL_RE.fullmatch(value):
        raise ValueError("model id must match ^[a-z0-9][a-z0-9.:_/-]{0,80}$")
    return value


class SeatModelSpec(BaseModel):
    id: str
    label: str = Field(default="", max_length=80)

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        return _validate_model_id(value) or ""

    @field_validator("label")
    @classmethod
    def _label(cls, value: str) -> str:
        return (value or "").strip()


class SeatCapabilitiesBody(BaseModel):
    """What a runner announces about itself (design C1): its harness, the
    brain it runs by default, and the models / efforts a room may pick from
    (``metadata.seats[<agent_id>]``). The web reads it back through ``GET /crew``."""

    harness: str = Field(..., pattern=HARNESS_RE)
    default_model: str | None = None
    default_effort: SeatEffort | None = None

    @field_validator("default_model")
    @classmethod
    def _default_model(cls, value: str | None) -> str | None:
        return _validate_model_id(value)
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
    #: private | shared | channel (design §2.3; ownership decides, §2.0),
    #: judged over members + every historical sender + the thread seed +
    #: the parent + the sticky floor (R2).
    room_class: str
    #: Why it is shared (short tags: foreign_seat, integration, guest_agent,
    #: unattributed_actor, humans_N, floor, parent_shared…); empty when private.
    class_reasons: list[str] = Field(default_factory=list)
    #: HUMAN actors (guests are counted under ``guests``).
    humans: int
    #: OTHER runner seats owned by a human in the room (caller not counted).
    own_seats: int
    #: OTHER runner seats owned by someone else, or by nobody (caller not
    #: counted) — one of these is what makes a room ``shared``.
    foreign_seats: int
    #: Foreign non-seat actors: integrations, webhook / Project-Ops senders,
    #: unknown backends, unattributed lines.
    foreign_actors: int = 0
    #: Guest humans + guest agents (``metadata.kind = guest_agent``).
    guests: int
    #: The caller seat's own membership agent_mode (null = pre-contract rule).
    agent_mode: str | None = None
    seat: SeatSetting
    updated_at: datetime | None = None
    #: The newest line in the room (null when empty; deleted lines and the
    #: seat's own posts count) — the runner's poll cadence / cap keys off it.
    last_message_at: datetime | None = None


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
    agent_p = await _resolve_agent_participant(
        db,
        principal.agent_id,
        room,
        owner_username=await _principal_owner_username(db, principal),
    )
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


def _sender_agent_id(sender: Any) -> str | None:
    """The agent id a stored line's SENDER may speak as — the same rule the
    write side binds a principal to (``agent_id_of_identity``)."""
    if sender is None:
        return None
    return agent_id_of_identity(getattr(sender, "keycloak_sub", None), getattr(sender, "username", None))


def scrub_identity_on_read(pairs: list[tuple[Any, MessageResponse]]) -> list[MessageResponse]:
    """What a seat reads never carries a borrowed identity (covers rows
    stored before the public boundary existed):

    * a line whose sender is NOT an agent loses the identity keys
      (``agent_id``, ``on_behalf_of``, ``gateway``, ``brigade_agent_id``);
    * an agent's line keeps ``agent_id`` only when it is the sender's own.

    Provenance is untouched: a spoken line keeps ``via: "voice"`` — the
    runner answers a by-name spoken address only when it sees it."""
    out: list[MessageResponse] = []
    for message, response in pairs:
        meta = getattr(response, "metadata", None)
        if isinstance(meta, dict) and meta:
            if getattr(response, "sender_type", None) == "agent":
                claimed = meta.get("agent_id")
                if claimed is not None and claimed != _sender_agent_id(getattr(message, "sender", None)):
                    response.metadata = {k: v for k, v in meta.items() if k != "agent_id"}
            elif AGENT_IDENTITY_METADATA_KEYS & set(meta):
                response.metadata = {
                    k: v for k, v in meta.items() if k not in AGENT_IDENTITY_METADATA_KEYS
                }
        out.append(response)
    return out


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
    seat_row = await _find_seat_participant(db, principal.agent_id)
    seat_setting = seat_setting_from_metadata(
        getattr(room_obj, "metadata_", None), principal.agent_id
    )
    if seat_is_silent(seat_mode):
        logger.info(
            "gateway_messages_silenced_by_agent_mode",
            room_id=str(room_obj.id),
            agent_id=principal.agent_id,
            agent_mode=seat_mode,
        )
        facts = await _classify_for_seat(db, room_obj, seat_row, principal.agent_id)
        envelope = _room_envelope_facts(room_obj, seat_mode, facts, seat_setting)
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
    # history_from NULL (and the JWT path) is the whole room. A cursor older
    # than the floor cannot page past it: get_messages ANDs the cursor with
    # not_before, so that page is empty.
    result = await svc.get_messages(
        room_id=room_obj.id,
        cursor=cursor,
        limit=limit,
        not_before=_principal_history_from(principal),
    )
    messages = scrub_identity_on_read(
        [
            (item["message"], _msg_to_response(item["message"], item["reply_count"]))
            for item in result["messages"]
        ]
    )
    # Classify AFTER the page is read (P2-1): a line committed between the
    # two would otherwise ride out under a class judged before it existed.
    facts = await _classify_for_seat(db, room_obj, seat_row, principal.agent_id)
    envelope = _room_envelope_facts(room_obj, seat_mode, facts, seat_setting)
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
    # The key floor hides lines from before history_from, and build_context
    # withholds the rolling summary when a floor is set (that summary covers
    # lines the floor exists to hide). A `since` older than the floor is not
    # a way under it: the floor stays the lower bound.
    payload = await build_context(
        db,
        room_id=room_obj.id,
        budget_tokens=budget_tokens,
        since_message_id=since,
        not_before=_principal_history_from(principal),
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
    # Nav v3 C1: the room's class (private / shared / channel, design §2.3,
    # computed the R2 way over members + history + seed + parent + floor) and
    # the asking seat's own {model, effort} (nulls = the seat's defaults) so
    # a runner can pick its policy and brain from the one call it already
    # makes per turn. Same values GET /gateway/rooms reports.
    facts = await _classify_for_seat(db, room_obj, seat, principal.agent_id)
    out["room_class"] = facts.room_class
    out["class_reasons"] = list(facts.reasons)
    out["seat"] = seat_setting_from_metadata(
        getattr(room_obj, "metadata_", None), principal.agent_id
    )
    return out


def seat_room_row(
    room: Any,
    seat_participant_id: Any,
    facts: RoomClassFacts,
    agent_id: str,
    last_message_at: datetime | None = None,
) -> GatewayRoomRow:
    """Pure: one ``GET /gateway/rooms`` row from a room (members attached),
    the caller seat's participant id, its computed facts, its agent id
    (which keys ``metadata.seats``) and the room's last message time."""
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
        class_reasons=list(facts.reasons),
        humans=facts.humans,
        own_seats=facts.own_seats,
        foreign_seats=facts.foreign_seats,
        foreign_actors=facts.foreign_actors,
        guests=facts.guests,
        agent_mode=agent_mode,
        seat=SeatSetting(**seat_setting_from_metadata(getattr(room, "metadata_", None), agent_id)),
        updated_at=getattr(room, "updated_at", None),
        last_message_at=last_message_at,
    )


async def _find_seat_participant(db: AsyncSession, agent_id: str) -> Participant | None:
    return (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == f"brigade:{agent_id}")
        )
    ).scalar_one_or_none()


def seat_rooms_statement(seat_id: Any):
    """Non-archived rooms the seat is a member of, as columns (no eager
    creator / membership loads), newest activity first — with each room's
    newest line as a per-room TOP-1 on ``ix_messages_room_id_created_at``
    (P2-3): one index probe per room instead of a grouped max over every
    entry of every listed room."""
    from app.models.message import Message

    last_message_at = (
        select(Message.created_at)
        .where(Message.room_id == Room.id)
        .order_by(Message.created_at.desc())
        .limit(1)
        .correlate(Room)
        .scalar_subquery()
    )
    return (
        select(
            Room.id,
            Room.name,
            Room.livekit_room_name,
            Room.display_name,
            Room.room_type,
            Room.parent_room_id,
            Room.metadata_,
            Room.updated_at,
            Room.is_archived,
            last_message_at,
        )
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(RoomMember.participant_id == seat_id, Room.is_archived.is_(False))
        .order_by(Room.updated_at.desc())
    )


async def _seat_rooms_lite(db: AsyncSession, seat_id: Any) -> list[RoomLite]:
    rows = (await db.execute(seat_rooms_statement(seat_id))).all()
    return [
        RoomLite(
            id=row[0],
            name=row[1],
            livekit_room_name=row[2],
            display_name=row[3],
            room_type=row[4],
            parent_room_id=row[5],
            metadata_=row[6] if isinstance(row[6], dict) else None,
            updated_at=row[7],
            is_archived=bool(row[8]),
            last_message_at=row[9] if len(row) > 9 else None,
        )
        for row in rows
    ]


async def _rooms_with_owner_present(
    db: AsyncSession, room_ids: list[Any], owners: Iterable[str]
) -> set[str]:
    """Of ``room_ids``, those where one of ``owners`` (usernames) is a
    current HUMAN member — the ``@member`` rule for a batch (R4)."""
    names = [name for name in owners if name]
    if not names or not room_ids:
        return set()
    rows = (
        await db.execute(
            select(RoomMember.room_id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(
                RoomMember.room_id.in_(room_ids),
                Participant.participant_type == ParticipantType.HUMAN,
                func.lower(Participant.username).in_(names),
            )
            .distinct()
        )
    ).scalars().all()
    return {str(room_id) for room_id in rows}


async def _rooms_with_human_present(
    db: AsyncSession, room_ids: list[Any], human_sub: str | None
) -> set[str]:
    """JWT path: the rooms where the human behind the token is a member."""
    if not human_sub or not room_ids:
        return set()
    rows = (
        await db.execute(
            select(RoomMember.room_id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id.in_(room_ids), Participant.keycloak_sub == human_sub)
            .distinct()
        )
    ).scalars().all()
    return {str(room_id) for room_id in rows}


async def _scope_filter_rooms(
    db: AsyncSession, principal: GatewayPrincipal, seat: Participant, rooms: list[RoomLite]
) -> list[RoomLite]:
    """Keep the rooms the principal may actually read (R4 / P2-6): inside
    the key's scope (its names, ``*``, or ``@member``) AND — for every key
    kind — where the seat's owner human is a current member: the seat
    follows ITS human, whatever the key says. A JWT principal lists the
    rooms its human is in."""
    if not rooms:
        return rooms
    ids = [room.id for room in rooms]
    if principal.allowed_rooms is None:
        keep = await _rooms_with_human_present(db, ids, principal.human_sub)
        return [room for room in rooms if str(room.id) in keep]
    allowed = principal.allowed_rooms
    if not allowed:
        return []
    owner_present = await _rooms_with_owner_present(db, ids, seat_owners(seat))
    in_scope: set[str] = {str(room.id) for room in rooms if room_in_key_scope(allowed, room)}
    if key_scope_wants_membership(allowed):
        in_scope |= owner_present
    return [room for room in rooms if str(room.id) in in_scope and str(room.id) in owner_present]


@router.get("/rooms", response_model=list[GatewayRoomRow])
async def gateway_list_rooms(
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> list[GatewayRoomRow]:
    """The rooms the caller's seat is a member of AND may read (design C1,
    R4): non-archived, inside the key's scope — for ``@member`` that means
    the seat's owner human is a current member, because the seat follows
    ITS human. Each row carries the R2 class (members + history + seed +
    parent + floor) so the runner picks its policy from it; a ``shared``
    verdict also writes the sticky floor.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_rooms", fail_open=True)
    seat = await _find_seat_participant(db, principal.agent_id)
    if seat is None:
        # A provisioned seat that has never posted has no participant row
        # yet, hence no memberships. Empty, not 404: the runner keeps polling.
        return []
    rooms = await _scope_filter_rooms(db, principal, seat, await _seat_rooms_lite(db, seat.id))
    if not rooms:
        return []
    ids = [room.id for room in rooms]
    members = await load_members(db, ids)
    for room in rooms:
        room.members = members.get(str(room.id), [])
    facts = await compute_room_classes(db, rooms, asking_seat=seat)
    if await apply_class_floors(db, rooms, facts):
        await db.commit()
    return [
        seat_room_row(
            room, seat.id, facts[str(room.id)], principal.agent_id, getattr(room, "last_message_at", None)
        )
        for room in rooms
    ]


async def _get_or_create_seat_participant(
    db: AsyncSession, agent_id: str, *, owner_username: str | None = None
) -> Participant:
    """The seat's participant row, created on first contact (mirrors
    ``_resolve_agent_participant`` minus the room membership). Safe against
    a concurrent first contact: an IntegrityError on the unique sub re-reads
    the winner instead of surfacing a 500."""
    seat = await _find_seat_participant(db, agent_id)
    if seat is not None:
        return seat
    meta: dict[str, Any] = {"backend": "runner"}
    if owner_username:
        meta["owner"] = owner_username
    seat = Participant(
        keycloak_sub=f"brigade:{agent_id}",
        username=f"agent-{agent_id}",
        display_name=agent_id.replace("-", " ").title(),
        participant_type=ParticipantType.AGENT,
        status=ParticipantStatus.ONLINE,
        metadata_=meta,
    )
    db.add(seat)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = await _find_seat_participant(db, agent_id)
        if winner is None:
            raise
        return winner
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
    ``metadata.seat_capabilities`` through an SQL ``||`` merge — so the
    seat's other metadata (``backend``, ``crew``, ``owner``, avatar…) is never
    clobbered, even by a concurrent write — and returned as stored. Runners
    call it at start and hourly; the web reads it via ``GET /crew``."""
    await _gateway_rate_limit(principal, redis, bucket="gw_me", fail_open=True)
    if len(principal.agent_id) > MAX_SEAT_AGENT_ID_LEN:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"agent id longer than {MAX_SEAT_AGENT_ID_LEN} characters",
        )
    owner_username = await _principal_owner_username(db, principal)
    seat = await _get_or_create_seat_participant(
        db, principal.agent_id, owner_username=owner_username
    )
    stored = body.model_dump(mode="json")
    stored["updated_at"] = datetime.now(timezone.utc).isoformat()
    patch: dict[str, Any] = {SEAT_CAPABILITIES_KEY: stored}
    if (seat.metadata_ or {}).get("backend") != "runner":
        # Whoever announces capabilities through the gateway IS a runner-backed
        # seat (same stamp the post path applies).
        patch["backend"] = "runner"
    if owner_username and not seat_owners(seat):
        patch["owner"] = owner_username
    await db.execute(
        update(Participant)
        .where(Participant.id == seat.id)
        .values(
            metadata_=func.coalesce(Participant.metadata_, cast({}, JSONB)).op("||")(
                cast(patch, JSONB)
            )
        )
        # Without this the session expires the loaded seat's metadata_ (a
        # JSONB `||` cannot be evaluated in Python), and the mirror below
        # lazy-loads it: MissingGreenlet under asyncpg, a 500 on every
        # announce (measured on dogfood 2026-09-29). Same rule as the owner
        # PATCH and the class floor.
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    # Mirror the merge on the loaded row so this request's readers agree,
    # without scheduling an ORM write of the whole column.
    merged = {**(seat.metadata_ or {}), **patch}
    if hasattr(seat, "_sa_instance_state"):
        set_committed_value(seat, "metadata_", merged)
    else:
        seat.metadata_ = merged
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
    if agent_id != principal.agent_id and not room_in_key_scope(
        principal.allowed_rooms or [], room_obj
    ):
        # A key that reaches this room only through ``@member`` may remove
        # itself, not other agents: membership is not moderation authority.
        raise HTTPException(
            status_code=403,
            detail="A member-scoped key may only remove its own agent from a room",
        )

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
    if len(agent_id) > MAX_SEAT_AGENT_ID_LEN:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"agent_id longer than {MAX_SEAT_AGENT_ID_LEN} characters",
        )
    if body.owner is not None:
        # Before the key exists: a refused owner must not leave a key behind.
        await require_human_owner(db, body.owner)
    now = datetime.now(timezone.utc)
    try:
        expires_at, history_from = resolve_mint_lifetime(
            expires_in_days=body.expires_in_days,
            expires_at=body.expires_at,
            no_expiry=body.no_expiry,
            history=body.history,
            now=now,
        )
    except ValueError as exc:
        raise _lifetime_422(exc) from exc
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
        expires_at=expires_at,
        history_from=history_from,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    key_id, key_prefix = str(row.id), row.key_prefix
    allowed_rooms, rate_limit_rpm = row.allowed_rooms, row.rate_limit_rpm
    can_manage = bool(row.can_manage_voice_settings)
    stored_owner: Any = None
    owner_stamped = body.owner is None
    if body.owner is not None:
        # The key is committed and its raw value exists only in this
        # response: a failed stamp must never cost the caller the key.
        try:
            seat = await _stamp_seat_owner(
                db, agent_id, body.owner, operator=_operator_of(request), source="mint"
            )
            stored_owner = (seat.metadata_ or {}).get("owner")
            owner_stamped = True
        except Exception:
            logger.warning("gateway_key_owner_stamp_failed", agent_id=agent_id, exc_info=True)
            try:
                await db.rollback()
            except Exception:
                pass
    logger.info("gateway_key_minted", agent_id=agent_id, key_id=key_id, owned=stored_owner is not None)
    return {
        "id": key_id,
        "agent_id": agent_id,
        "key": raw,  # shown ONCE — never logged, never repeated by GET /keys
        "key_prefix": key_prefix,
        "allowed_rooms": allowed_rooms,
        "rate_limit_rpm": rate_limit_rpm,
        "can_manage_voice_settings": can_manage,
        # The owner STORED on the seat's row (an existing owner is kept at
        # mint; PATCH the key to change it).
        "owner": stored_owner,
        "owner_stamped": owner_stamped,
        **key_lifetime_view(expires_at, history_from, now=now),
    }


async def _stamp_seat_owner(
    db: AsyncSession,
    agent_id: str,
    owner: str,
    *,
    overwrite: bool = False,
    operator: str | None = None,
    source: str = "mint",
) -> Participant:
    """Own the seat (P2-9): create its participant row (backend runner,
    owner) when it has never posted, else merge ``owner`` in by SQL ``||``.
    At mint an existing owner is kept; ``overwrite`` (PATCH) replaces it.

    ``backend`` on an EXISTING row is never touched here. A row without one
    is exactly what a Brigade-served agent looks like, and an operator's
    owner stamp must not silence it (REVIEW-3 P2-6). The seat flips its own
    row to ``runner`` the first time it announces itself or posts through
    the gateway — evidence that a runner really serves the id.

    EVERY CHANGE IS LOGGED (``gateway_seat_owner_changed``) with the old
    owner, the new owner and who the caller says they are. An owner stamp
    re-attributes every line the seat ever wrote, so it has to be possible
    to say afterwards who moved a seat, from whom, to whom."""
    seat = await _find_seat_participant(db, agent_id)
    if seat is None:
        seat = Participant(
            keycloak_sub=f"brigade:{agent_id}",
            username=f"agent-{agent_id}",
            display_name=agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
            metadata_={"backend": "runner", "owner": owner},
        )
        db.add(seat)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            seat = await _find_seat_participant(db, agent_id)
            if seat is None:
                raise
        else:
            await db.refresh(seat)
            logger.info(
                "gateway_seat_owner_changed",
                agent_id=agent_id,
                old_owner=None,
                new_owner=owner,
                operator=operator,
                source=source,
                row_created=True,
            )
            return seat
    old_owner = (seat.metadata_ or {}).get("owner") if isinstance(seat.metadata_, dict) else None
    if (overwrite or not seat_owners(seat)) and old_owner != owner:
        patch: dict[str, Any] = {"owner": owner}
        await db.execute(
            update(Participant)
            .where(Participant.id == seat.id)
            .values(
                metadata_=func.coalesce(Participant.metadata_, cast({}, JSONB)).op("||")(
                    cast(patch, JSONB)
                )
            )
            .execution_options(synchronize_session=False)
        )
        await db.commit()
        merged = {**(seat.metadata_ or {}), **patch}
        if hasattr(seat, "_sa_instance_state"):
            # Show the merge on the loaded row without scheduling an ORM
            # write of the whole column over a concurrent PUT /gateway/me.
            set_committed_value(seat, "metadata_", merged)
        else:
            seat.metadata_ = merged
        logger.info(
            "gateway_seat_owner_changed",
            agent_id=agent_id,
            old_owner=old_owner,
            new_owner=owner,
            operator=operator,
            source=source,
            row_created=False,
        )
    return seat


@router.get("/keys")
async def list_gateway_keys(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """List key metadata (no secrets). Operator-only.

    Never the raw key and never its hash. ``days_left`` is null when the
    key has no expiry, and null (with ``expired: true``) once it has lapsed.
    """
    verify_key_admin_bearer(request)
    rows = (await db.execute(select(AgentGatewayKey))).scalars().all()
    now = datetime.now(timezone.utc)
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
                **key_lifetime_view(
                    getattr(r, "expires_at", None),
                    getattr(r, "history_from", None),
                    now=now,
                ),
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
    if body.owner is not None:
        # Before anything is changed: a refused owner must not leave the
        # rest of the PATCH half applied.
        await require_human_owner(db, body.owner)
    if body.label is not None:
        row.label = body.label
    if body.allowed_rooms is not None:
        row.allowed_rooms = body.allowed_rooms
    if body.rate_limit_rpm is not None:
        row.rate_limit_rpm = body.rate_limit_rpm
    if body.can_manage_voice_settings is not None:
        row.can_manage_voice_settings = bool(body.can_manage_voice_settings)
    now = datetime.now(timezone.utc)
    try:
        # Sets expires_at / history_from only. revoked_at is not a field
        # on the body and is not assigned here, so a PATCH cannot un-revoke.
        apply_patch_lifetime(row, body, now)
    except ValueError as exc:
        raise _lifetime_422(exc) from exc
    await db.commit()
    out = {
        "id": str(row.id),
        "agent_id": row.agent_id,
        "key_prefix": row.key_prefix,
        "label": row.label,
        "allowed_rooms": row.allowed_rooms,
        "rate_limit_rpm": row.rate_limit_rpm,
        "can_manage_voice_settings": bool(row.can_manage_voice_settings),
        "revoked": False,
        **key_lifetime_view(
            getattr(row, "expires_at", None),
            getattr(row, "history_from", None),
            now=now,
        ),
    }
    if body.owner is not None:
        # The operator's explicit choice: stamped on the seat's row by merge
        # (the row is created when the seat has never posted). The only way
        # to own a seat whose key was minted before owners existed.
        seat = await _stamp_seat_owner(
            db,
            out["agent_id"],
            body.owner,
            overwrite=True,
            operator=_operator_of(request),
            source="patch",
        )
        out["owner"] = (seat.metadata_ or {}).get("owner")
    logger.info("gateway_key_patched", key_id=str(key_id), agent_id=out["agent_id"], owner_set=body.owner is not None)
    return out


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
