from __future__ import annotations

import time
import uuid
from typing import Annotated, Any, AsyncGenerator, Callable

import structlog
from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.gateway_auth import (
    GatewayAuthError,
    is_gateway_key,
    resolve_key_room_scope,
    verify_gateway_key,
)
from app.auth.guest_auth import (
    GUEST_SESSION_PREFIX,
    GuestAuthError,
    guest_user_dict,
    is_guest_credential,
    verify_guest_session,
)
from app.auth.keycloak import extract_user_identity, validate_token
from app.config import Settings, get_settings

from app.models.room import Room, RoomMember
from app.services.participant_identity import resolve_participant_for_identity
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)


def get_settings_dep() -> Settings:
    """Return the cached Settings singleton."""
    return get_settings()


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """Yield an async SQLAlchemy session from the app's engine."""
    session_factory = request.app.state.db_session_factory
    async with session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def get_redis(request: Request) -> Redis:
    """Return the Redis connection pool from app state."""
    return request.app.state.redis


def get_livekit(request: Request) -> LiveKitService:
    """Return the LiveKit service from app state."""
    return request.app.state.livekit_service


def get_presence(request: Request) -> PresenceService:
    """Return the Presence service from app state."""
    return request.app.state.presence_service


async def get_current_user(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """
    Validate the Keycloak JWT from the Authorization header.

    Returns a user dict with: sub, email, username, display_name, roles, participant_type, participant_id.
    Also ensures the Participant row exists in the database (upsert on first login).

    🔴 THIS DEPENDENCY MUST NEVER ACCEPT A GUEST CREDENTIAL. ~100 routes name it
    explicitly, so teaching it about guests would hand a guest token every one
    of them in a single edit — including every route written after that edit.
    Guest-reachable routes opt in ONE AT A TIME via ``get_guest_or_member``
    below. That inversion is what makes a route that does not exist yet
    guest-proof by default, with no reviewer vigilance required.

    (2026-08-09 precedent: Knowledge-Ops was found granting read scope to every
    OIDC principal, so merely passing the proxy silently meant "authorized".
    Authentication must never imply authorization.)
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_header.removeprefix("Bearer ").strip()

    # Structural default-deny. A guest credential is not a JWT, so it would
    # fail validation below anyway — but relying on "it happens to not parse"
    # is an accident, not a boundary. Refusing it BY NAME here means the
    # rejection is intentional, greppable, and directly testable.
    if is_guest_credential(token):
        logger.info("guest_credential_rejected", route_kind="member_only")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Guest credentials are not accepted on this endpoint",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        claims = await validate_token(
            token=token,
            keycloak_url=settings.keycloak_url,
            realm=settings.keycloak_realm,
            client_id=settings.keycloak_client_id,
        )
    except JWTError as exc:
        logger.warning("jwt_validation_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        user_identity = extract_user_identity(claims)
    except KeyError as exc:
        logger.warning(
            "token_missing_claim",
            missing=str(exc),
            claim_keys=list(claims.keys()),
            azp=claims.get("azp"),
            aud=claims.get("aud"),
            preferred_username=claims.get("preferred_username"),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token missing required claim: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Ensure the participant exists in our database (JIT provision; links an
    # existing email-matched persona instead of duplicating -- see
    # services/participant_identity.py).
    participant = await resolve_participant_for_identity(
        db, settings, user_identity, claims
    )

    user_identity["participant_id"] = participant.id
    return user_identity


# ---------------------------------------------------------------------------
# Guest access — the OPT-IN half of the default-deny arrangement
# ---------------------------------------------------------------------------
#
# GUEST ACCESS IS AN ACCESS MODE ON A ROOM, NOT A NEW PRODUCT SURFACE.
#
# A guest is an outsider with no Unicorn Commander account who redeemed a room
# owner's invite link. They may do exactly this and nothing else:
#
#   * read and post messages in THEIR room
#   * open a WebSocket scoped to THEIR room
#   * mint a LiveKit token for THEIR room (they are a guest ON the show, so
#     camera/mic is the point)
#   * see THEIR room's member list
#   * see their own guest record (GET /guest/me)
#
# They must not reach any other room, the room list/channel browser, either
# message-search endpoint, the agent roster/binding/tools, knowledge bases,
# uploads, admin, entitlements, gateway key administration, or any Keycloak
# identity / suite entitlement / cross-app federation. All of that is enforced
# by ABSENCE: those routes depend on get_current_user, which refuses a guest
# credential by name. Nothing was added to them, and nothing needs to be.
#
# Adding a guest-reachable route means changing that route's dependency here on
# purpose. If you are reading this because you are about to do that: the room
# scope check is NOT optional — use require_room_member_or_guest (path-param
# rooms) or call ensure_guest_room_scope() explicitly once you have resolved
# the room.


def is_guest(user: dict[str, Any]) -> bool:
    """True when this principal is an ephemeral room guest, not a member."""
    return bool(user.get("is_guest"))


def ensure_guest_room_scope(
    user: dict[str, Any], room_id: uuid.UUID | str
) -> None:
    """Refuse a guest asking about any room but the one their credential names.

    THE DOUBLE GATE. Guests are also real ``RoomMember`` rows, so the ordinary
    membership check already confines them — but membership is data that other
    code paths can write, while ``guest_room_id`` comes off the session row that
    authorized this very request. Checking both means a stray or maliciously
    created membership row still cannot widen a guest's reach.

    A no-op for members, so it is safe to call unconditionally.
    """
    if not is_guest(user):
        return
    if str(user.get("guest_room_id") or "") != str(room_id):
        logger.info(
            "guest_room_scope_denied",
            session_id=str(user.get("guest_session_id")),
            requested_room=str(room_id),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This guest link is not valid for that room",
        )


async def get_guest_or_member(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """Accept EITHER a real member (Keycloak JWT) OR a room guest session.

    Returns the same dict shape ``get_current_user`` returns, so a handler body
    keeps working after swapping the dependency; guests additionally carry
    ``is_guest`` / ``guest_room_id`` (see auth/guest_auth.guest_user_dict).

    Deliberately NOT the default for anything. Name it only on routes that have
    been reasoned about individually, and pair it with a room scope check.
    """
    auth_header = request.headers.get("Authorization") or ""
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth_header.removeprefix("Bearer ").strip()

    if not token.startswith(GUEST_SESSION_PREFIX):
        # Not a guest session (including a raw INVITE token, which is never an
        # API credential) — fall through to the ordinary member path, which
        # refuses guest credentials by name.
        return await get_current_user(request, settings, db)

    if not settings.guest_access_enabled:
        # Kill switch: existing sessions stop authenticating immediately.
        logger.info("guest_session_refused", reason="feature_disabled")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Guest access is disabled on this server",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        principal = await verify_guest_session(token, db)
    except GuestAuthError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.detail,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return guest_user_dict(principal)


async def require_guest(
    user: Annotated[dict[str, Any], Depends(get_guest_or_member)],
) -> dict[str, Any]:
    """Guest-ONLY dependency, for the small ``/guest/*`` self-service surface.

    A member reaching these would get a meaningless answer (they have no guest
    session), so refuse rather than return something confusing.
    """
    if not is_guest(user):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This endpoint requires a guest session",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# ---------------------------------------------------------------------------
# Room CONTROL — the voice-settings family may be driven by a gateway key
# ---------------------------------------------------------------------------
#
# The native Talk Controls desk app cannot durably hold a user JWT (minutes of
# life, no refresh flow worth building for a pedal) but already holds a Stable
# gateway key for /gateway/talk-gate. So the voice-settings write — and ONLY
# that family; moderation, membership and everything else stay on
# get_current_user — accepts a gateway key bearer when ALL of:
#
#   (a) the key is active (revoked → 401, exactly like the gateway),
#   (b) it is bound to agent_id ``talk-controls-app`` OR its row carries the
#       explicit ``can_manage_voice_settings`` grant (an ordinary agent key,
#       say grok's, is a 403 — posting messages is not reconfiguring the room),
#   (c) the target room is in the key's allowed_rooms (either name form,
#       ``"*"``, or ``"@member"`` = the key's seat AND its owner human are
#       current members — the gateway's own resolver,
#       gateway_auth.resolve_key_room_scope, shared, not re-derived).
#
# Everything else takes the ordinary get_current_user path unchanged, so a
# human still needs owner/admin on the room. The dependency returns the same
# dict SHAPE for both so the handler body stays one function; the control-key
# principal is flagged ``is_control_key`` and carries no participant_id.

CONTROL_KEY_ACTOR_PREFIX = "control_key:"


def is_control_key(user: dict[str, Any]) -> bool:
    """True when this principal is a gateway key acting as a room controller."""
    return bool(user.get("is_control_key"))


def room_control_actor(user: dict[str, Any]) -> str:
    """The audit label for whoever authorized a room-control write:
    ``control_key:<id prefix>`` for the desk app, ``user:<participant_id>``
    for a human. Never a secret, never a key hash."""
    if is_control_key(user):
        return f"{CONTROL_KEY_ACTOR_PREFIX}{str(user.get('control_key_id') or '')[:8]}"
    return f"user:{user.get('participant_id')}"


def control_key_user_dict(principal, room: Room) -> dict[str, Any]:
    """The synthetic principal for an authorized control key. Same keys a
    human dict has so handler code that reads them does not branch on
    absence; ``participant_id`` is None on purpose — a key is not a member."""
    key_id = str(principal.key_id or "")
    return {
        "sub": f"gateway-key:{key_id}",
        "email": None,
        "username": f"agent-{principal.agent_id}",
        "display_name": principal.agent_id.replace("-", " ").title(),
        "roles": [],
        "participant_type": "agent",
        "participant_id": None,
        "is_control_key": True,
        "control_key_id": key_id,
        "control_key_agent_id": principal.agent_id,
        "control_room_id": str(room.id),
    }


async def get_room_controller(
    room_id: uuid.UUID,
    request: Request,
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """Authenticate the caller of a room-control (voice-settings) route.

    A gateway key bearer is admitted under the three conditions documented
    above and returns ``control_key_user_dict``; anything else is handed to
    ``get_current_user`` and gets exactly the 401/403 it always got. The
    handler still runs the owner/admin ladder for the human path — this
    dependency does NOT widen what a JWT may do.

    Name it on the voice-settings family only. It is not a general "keys may
    act as owners" switch, and a route that does not name it cannot be
    reached by a key.
    """
    auth_header = request.headers.get("Authorization") or ""
    token = auth_header.removeprefix("Bearer ").strip() if auth_header.startswith("Bearer ") else ""
    if not is_gateway_key(token):
        return await get_current_user(request, settings, db)

    try:
        principal = await verify_gateway_key(token, db)
    except GatewayAuthError as exc:
        # Revoked or unknown key: the gateway's own 401, verbatim.
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.detail,
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not principal.may_manage_voice_settings():
        logger.info(
            "room_control_denied",
            reason="key_not_a_controller",
            agent_id=principal.agent_id,
            key_id=str(principal.key_id or "")[:8],
            room_id=str(room_id),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This gateway key may not manage room voice settings",
        )

    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    if not await resolve_key_room_scope(db, principal.allowed_rooms, principal.agent_id, room):
        logger.info(
            "room_control_denied",
            reason="room_out_of_key_scope",
            agent_id=principal.agent_id,
            key_id=str(principal.key_id or "")[:8],
            room_id=str(room_id),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Gateway key is not scoped to this room",
        )

    user = control_key_user_dict(principal, room)
    logger.info(
        "room_control_authorized",
        path="control_key",
        actor=room_control_actor(user),
        agent_id=principal.agent_id,
        room_id=str(room_id),
    )
    return user


# ---------------------------------------------------------------------------
# Room membership authorization
# ---------------------------------------------------------------------------
#
# Many read/interact routes historically trusted "authenticated == authorized"
# and let any logged-in user touch any room by UUID. These helpers centralize
# the membership check so every room-scoped route enforces it the same way.
# The pattern mirrors the existing inline checks in tokens.py / rooms.py pins.


async def is_room_member(
    db: AsyncSession,
    room_id: uuid.UUID | str,
    participant_id: uuid.UUID | str,
) -> bool:
    """Return True if the participant is a member of the room."""
    result = await db.execute(
        select(RoomMember.id).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_id == participant_id,
        )
    )
    return result.scalar_one_or_none() is not None


async def ensure_room_member(
    db: AsyncSession,
    room_id: uuid.UUID | str,
    user: dict[str, Any],
) -> None:
    """Raise 403 unless ``user`` is a member of ``room_id``.

    Use this from inside a handler that already loaded ``db`` + ``user`` when a
    dedicated path-param dependency isn't convenient (e.g. message-scoped
    routes that resolve the room from the message first).
    """
    if not await is_room_member(db, room_id, user["participant_id"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this room",
        )


async def require_room_member(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """FastAPI dependency: authenticate, then require room membership.

    Drop into any route that takes a ``room_id`` path param::

        @router.get("/rooms/{room_id}/...")
        async def handler(
            room_id: uuid.UUID,
            user: Annotated[dict, Depends(require_room_member)],
            ...
        ): ...

    Returns the same user dict ``get_current_user`` returns, so existing
    handler bodies keep working after swapping the dependency.
    """
    await ensure_room_member(db, room_id, user)
    return user


async def require_room_member_or_guest(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_guest_or_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """Like ``require_room_member``, but also admits a guest OF THIS ROOM.

    Two gates, both required for a guest:

      1. the session's own ``guest_room_id`` must be this room (the credential
         is scoped to one room and cannot be pointed at another), and
      2. the ordinary ``room_members`` check must pass.

    Swap ``require_room_member`` → this ONLY on routes a guest is meant to
    reach. Everything left on ``require_room_member`` stays member-only,
    because that path runs ``get_current_user``, which refuses guests.
    """
    ensure_guest_room_scope(user, room_id)
    await ensure_room_member(db, room_id, user)
    return user


# ---------------------------------------------------------------------------
# Rate limiting (Redis token-bucket)
# ---------------------------------------------------------------------------
#
# slowapi / limits aren't installed, but redis.asyncio is already wired into
# app.state. This is a small fixed-window counter keyed in Redis. It's
# atomic (INCR + EXPIRE), shared across workers, and self-expiring. Good
# enough for abuse protection on a handful of write paths; not a precise
# distributed token bucket, which we don't need here.


# ---------------------------------------------------------------------------
# In-process fallback limiter (Redis-outage degradation)
# ---------------------------------------------------------------------------
#
# Redis is the shared, correct limiter. This is the answer to "what happens
# when it is gone" for the one route that can neither fail open (it is the only
# unauthenticated endpoint in the guest feature, so it is THE brute-force
# target) nor fail closed (failing closed means a Redis blip locks every guest
# out of a live show).
#
# It is deliberately WORSE than Redis, in ways worth naming:
#   * per PROCESS, so with N uvicorn workers the effective ceiling is N x limit;
#   * a plain fixed window, so it permits the 2x burst across a window edge that
#     the Redis path's weighted two-window read smooths out;
#   * memory-bounded, so it cannot be turned into a memory-exhaustion lever by
#     an attacker rotating source addresses.
#
# What it is NOT is unlimited. When the table is full of live entries it
# refuses rather than admitting an untracked caller — running out of room to
# count is a reason to say no, never a reason to stop counting.
_LOCAL_WINDOWS: dict[tuple[str, str], list[int]] = {}
# ~20k identifiers is a few MB at worst and far more than a real deployment
# sees in one window; it exists so an attacker cannot grow this without bound.
_LOCAL_WINDOWS_MAX = 20_000

_LOCAL_ALLOW = "allow"
_LOCAL_LIMITED = "limited"
_LOCAL_UNAVAILABLE = "unavailable"


def _prune_local_windows(current_window: int) -> None:
    """Drop counters from windows that have already closed."""
    stale = [k for k, v in _LOCAL_WINDOWS.items() if v[0] < current_window]
    for key in stale:
        _LOCAL_WINDOWS.pop(key, None)


def _local_rate_limit_check(
    bucket: str, identifier: str, limit: int, window_seconds: int
) -> str:
    """Count this call in the per-process window and say what to do with it.

    Returns ``_LOCAL_ALLOW`` (within budget), ``_LOCAL_LIMITED`` (over budget →
    429), or ``_LOCAL_UNAVAILABLE`` (no room left to track this caller → 503).
    The last one is the fail-closed escape hatch: it never silently allows.
    """
    if limit <= 0:
        return _LOCAL_LIMITED
    window = int(time.time()) // window_seconds
    key = (bucket, identifier)
    entry = _LOCAL_WINDOWS.get(key)
    if entry is not None and entry[0] == window:
        entry[1] += 1
        return _LOCAL_ALLOW if entry[1] <= limit else _LOCAL_LIMITED
    # New window (or new caller). Make room before adding a key.
    if entry is None and len(_LOCAL_WINDOWS) >= _LOCAL_WINDOWS_MAX:
        _prune_local_windows(window)
        if len(_LOCAL_WINDOWS) >= _LOCAL_WINDOWS_MAX:
            return _LOCAL_UNAVAILABLE
    _LOCAL_WINDOWS[key] = [window, 1]
    return _LOCAL_ALLOW


async def _rate_limit_hit(
    redis: Redis,
    *,
    bucket: str,
    identifier: str,
    limit: int,
    window_seconds: int = 60,
    fail_open: bool = True,
    local_fallback: bool = False,
) -> None:
    """Sliding-window counter; raise 429 when the weighted rate exceeds ``limit``.

    Uses the standard two-window weighted approximation: the current window's
    count plus the previous window's count scaled by the fraction of the
    current window still "in view". This smooths the fixed-window burst edge
    (where a caller could do 2×limit across a window boundary).

    ``fail_open`` controls Redis-outage behavior. Cheap/idempotent routes stay
    OPEN (don't hard-fail user traffic on an infra blip). Scarce-resource
    routes (GPU embedding, disk writes, TTS) pass ``fail_open=False`` so a
    Redis outage can't be used to bypass the only backpressure on an expensive
    upstream — better a 503 than an unmetered GPU stampede.

    ``local_fallback`` adds a THIRD answer for the routes where neither of
    those is acceptable. With it, a Redis outage degrades to the in-process
    limiter above — still limited, just less well — instead of refusing
    everyone. It is opt-in per call site rather than global on purpose: for a
    GPU bucket a 503 really is the right answer, so nothing changes for those.
    """
    if limit <= 0:
        return
    now = time.time()
    window = int(now) // window_seconds
    elapsed = now - (window * window_seconds)
    cur_key = f"ratelimit:{bucket}:{identifier}:{window}"
    prev_key = f"ratelimit:{bucket}:{identifier}:{window - 1}"
    try:
        current = await redis.incr(cur_key)
        if current == 1:
            # TTL spans this window + the next so the prev-window read survives.
            await redis.expire(cur_key, window_seconds * 2 + 1)
        prev_raw = await redis.get(prev_key)
        prev = int(prev_raw) if prev_raw is not None else 0
    except Exception:
        logger.warning(
            "rate_limit_redis_error",
            bucket=bucket,
            fail_open=fail_open,
            local_fallback=local_fallback,
            exc_info=True,
        )
        if fail_open:
            return
        if local_fallback:
            verdict = _local_rate_limit_check(
                bucket, identifier, limit, window_seconds
            )
            if verdict == _LOCAL_ALLOW:
                # Loud on purpose: the service is running on a degraded,
                # per-worker limiter and an operator should know it, but the
                # guest at the door still gets in.
                logger.warning(
                    "rate_limit_degraded_to_local", bucket=bucket, limit=limit
                )
                return
            if verdict == _LOCAL_LIMITED:
                logger.info(
                    "rate_limited",
                    bucket=bucket,
                    identifier=identifier,
                    source="local_fallback",
                    limit=limit,
                )
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Rate limit exceeded. Slow down and try again shortly.",
                    headers={"Retry-After": str(window_seconds)},
                )
            # _LOCAL_UNAVAILABLE — no room left to count this caller. Fall
            # through to the 503: we would rather refuse than stop counting.
            logger.warning("rate_limit_local_table_full", bucket=bucket)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Rate limiter unavailable; try again shortly.",
            headers={"Retry-After": str(window_seconds)},
        )

    weight = max(0.0, (window_seconds - elapsed) / window_seconds)
    estimated = current + prev * weight
    if estimated > limit:
        logger.info(
            "rate_limited",
            bucket=bucket,
            identifier=identifier,
            estimated=round(estimated, 2),
            limit=limit,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Slow down and try again shortly.",
            headers={"Retry-After": str(window_seconds)},
        )


# Buckets whose upstream is a scarce shared resource (GPU embedding/synthesis,
# disk). These fail CLOSED so a Redis outage can't lift the only backpressure.
_FAIL_CLOSED_BUCKETS = frozenset(
    {
        "upload",
        "kb_upload",
        "kb_create",
        "tts",
        "stt",
        "agent_invite",
        "agent_chat",
    }
)


def rate_limit(
    bucket: str,
    limit_attr: str,
    *,
    window_seconds: int = 60,
    fail_open: bool | None = None,
) -> Callable[..., Any]:
    """Build a FastAPI dependency that rate-limits the current user.

    ``bucket`` namespaces the counter; ``limit_attr`` is the Settings field
    holding the per-window cap. Keyed per participant_id. ``fail_open`` defaults
    to False for scarce-resource buckets (``_FAIL_CLOSED_BUCKETS``) and True
    otherwise; pass it explicitly to override.

        user: Annotated[dict, Depends(get_current_user)]
        _rl: Annotated[None, Depends(rate_limit("msg_send", "rate_limit_message_send_per_min"))]
    """
    effective_fail_open = (
        (bucket not in _FAIL_CLOSED_BUCKETS) if fail_open is None else fail_open
    )

    async def _dep(
        user: Annotated[dict[str, Any], Depends(get_current_user)],
        redis: Annotated[Redis, Depends(get_redis)],
        settings: Annotated[Settings, Depends(get_settings_dep)],
    ) -> None:
        if not settings.rate_limit_enabled:
            return
        limit = int(getattr(settings, limit_attr, 0) or 0)
        await _rate_limit_hit(
            redis,
            bucket=bucket,
            identifier=str(user["participant_id"]),
            limit=limit,
            window_seconds=window_seconds,
            fail_open=effective_fail_open,
        )

    return _dep


def rate_limit_principal(
    bucket: str,
    limit_attr: str,
    *,
    window_seconds: int = 60,
    fail_open: bool | None = None,
    invite_limit_attr: str | None = None,
) -> Callable[..., Any]:
    """``rate_limit`` for routes that also admit guests.

    WHY THIS EXISTS AT ALL: ``rate_limit`` above hard-depends on
    ``get_current_user``, which refuses guest credentials — so putting it on a
    guest-reachable route would 401 every guest at the rate limiter even though
    the route's own principal dependency accepted them. This is the same class
    of trap that made ``deps.rate_limit()`` unusable on ``/broadcast/join``.

    WHY IT IS A NEAR-COPY RATHER THAN A PARAMETERIZED FACTORY: this module uses
    ``from __future__ import annotations``, so FastAPI resolves the inner
    dependency's annotations with ``get_type_hints`` against MODULE GLOBALS. A
    closed-over ``principal_dep`` name would not resolve and the route would
    fail to register. The dependency callable has to be named literally.

    TWO KEYS FOR A GUEST, AND THE SECOND ONE IS THE POINT
    -----------------------------------------------------
    ``participant_id`` alone is the WRONG unit of trust for a guest. Every
    redemption mints a fresh Participant row, so a per-participant limit is a
    per-REDEMPTION limit: an invite with unlimited ``max_uses`` bought the full
    send rate N times over for N redemptions, all from what the room owner
    minted and reasons about as ONE link. The IP-keyed redeem limiter
    (``rate_limit_guest_redeem_per_min``) bounds how FAST identities can be
    minted, not how many exist, so it is a speed bump and not a bound.

    So when ``invite_limit_attr`` is given, a guest is charged TWICE:

    1. ``bucket`` keyed on ``participant_id`` — one person's hand speed,
       unchanged, and the only thing a member is ever charged.
    2. ``bucket:invite`` keyed on ``guest_invite_id`` — the LINK's aggregate
       budget, which no number of redemptions can multiply.

    Both, rather than replacing (1) with (2), because an invite is often
    legitimately shared: collapsing to the invite key alone would let one
    chatty guest on a fifty-seat webinar link starve the other forty-nine.
    Keeping the per-participant limit is what keeps a single guest from doing
    that; adding the per-invite limit is what stops the link as a whole from
    being a rate-limit bypass. The invite bucket inherits this bucket's
    ``fail_open`` rather than re-deriving it from the suffixed name, which
    would silently look up ``"msg_send:invite"`` in ``_FAIL_CLOSED_BUCKETS``
    and miss.

    Both keys are DERIVED server-side from the session row — never the
    presented secret, which would hand an attacker a fresh bucket per guess.
    """
    effective_fail_open = (
        (bucket not in _FAIL_CLOSED_BUCKETS) if fail_open is None else fail_open
    )

    async def _dep(
        user: Annotated[dict[str, Any], Depends(get_guest_or_member)],
        redis: Annotated[Redis, Depends(get_redis)],
        settings: Annotated[Settings, Depends(get_settings_dep)],
    ) -> None:
        if not settings.rate_limit_enabled:
            return
        limit = int(getattr(settings, limit_attr, 0) or 0)
        await _rate_limit_hit(
            redis,
            bucket=bucket,
            identifier=str(user["participant_id"]),
            limit=limit,
            window_seconds=window_seconds,
            fail_open=effective_fail_open,
        )
        if invite_limit_attr is None:
            return
        # A member's dict has no `guest_invite_id` key at all, so this is a
        # no-op for them by construction rather than by an `is_guest` branch
        # that a refactor could invert.
        invite_id = user.get("guest_invite_id")
        if not invite_id:
            return
        await _rate_limit_hit(
            redis,
            bucket=f"{bucket}:invite",
            identifier=str(invite_id),
            limit=int(getattr(settings, invite_limit_attr, 0) or 0),
            window_seconds=window_seconds,
            fail_open=effective_fail_open,
        )

    return _dep
