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

from app.auth.keycloak import extract_user_identity, validate_token
from app.config import Settings, get_settings

from app.models.room import RoomMember
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
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_header.removeprefix("Bearer ").strip()

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


# ---------------------------------------------------------------------------
# Rate limiting (Redis token-bucket)
# ---------------------------------------------------------------------------
#
# slowapi / limits aren't installed, but redis.asyncio is already wired into
# app.state. This is a small fixed-window counter keyed in Redis. It's
# atomic (INCR + EXPIRE), shared across workers, and self-expiring. Good
# enough for abuse protection on a handful of write paths; not a precise
# distributed token bucket, which we don't need here.


async def _rate_limit_hit(
    redis: Redis,
    *,
    bucket: str,
    identifier: str,
    limit: int,
    window_seconds: int = 60,
    fail_open: bool = True,
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
            exc_info=True,
        )
        if fail_open:
            return
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
    {"upload", "kb_upload", "kb_create", "tts", "agent_invite", "agent_chat"}
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
