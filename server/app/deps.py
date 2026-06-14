from __future__ import annotations

import uuid
from typing import Annotated, Any, AsyncGenerator

import structlog
from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import extract_user_identity, validate_token
from app.config import Settings, get_settings
from app.models.participant import Participant, ParticipantStatus, ParticipantType
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
        import traceback
        with open("/tmp/jwt-debug.log", "a") as f:
            f.write(f"===== {exc} =====\n")
            f.write(traceback.format_exc())
            f.write("=====\n")
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

    # Ensure the participant exists in our database (upsert)
    result = await db.execute(
        select(Participant).where(Participant.keycloak_sub == user_identity["sub"])
    )
    participant = result.scalar_one_or_none()

    if participant is None:
        participant = Participant(
            keycloak_sub=user_identity["sub"],
            username=user_identity["username"],
            display_name=user_identity.get("display_name") or user_identity["username"],
            avatar_url=user_identity.get("avatar_url"),
            participant_type=ParticipantType(user_identity["participant_type"]),
            status=ParticipantStatus.ONLINE,
        )
        db.add(participant)
        await db.commit()
        await db.refresh(participant)
        logger.info(
            "participant_auto_created",
            participant_id=str(participant.id),
            username=participant.username,
        )
    else:
        # Sync mutable fields if Keycloak changed them
        changed = False
        new_display = user_identity.get("display_name")
        if new_display and new_display != participant.display_name:
            participant.display_name = new_display
            changed = True
        new_avatar = user_identity.get("avatar_url")
        if new_avatar and new_avatar != participant.avatar_url:
            participant.avatar_url = new_avatar
            changed = True
        if changed:
            await db.commit()
            await db.refresh(participant)

    user_identity["participant_id"] = participant.id
    return user_identity
