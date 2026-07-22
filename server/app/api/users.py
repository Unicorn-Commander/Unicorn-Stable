"""User directory + invite endpoints.

Source of truth is Keycloak (uchub realm). People who've signed into Stable
once also exist as Participant rows locally. Search merges both so you can
invite anyone in the realm, whether or not they've logged in yet.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep
from app.models.participant import Participant, ParticipantType
from app.services.keycloak_admin import KeycloakAdmin
from app.services.participant_identity import link_participant_by_email

logger = structlog.get_logger(__name__)

router = APIRouter()


class UserPreferences(BaseModel):
    """Per-user preferences that follow the account across devices (stored on
    the Participant's metadata). Currently just the default agent the
    ChatGPT-style "New chat" button starts a conversation with."""

    default_agent_id: str | None = None


@router.get("/users/me/preferences", response_model=UserPreferences)
async def get_my_preferences(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserPreferences:
    """Return the caller's preferences (server-side, so they follow the user
    across devices). Missing/unset → nulls; the client falls back to its
    built-in default agent."""
    p = await db.get(Participant, user["participant_id"])
    meta = p.metadata_ if (p is not None and isinstance(p.metadata_, dict)) else {}
    val = meta.get("default_agent_id")
    return UserPreferences(
        default_agent_id=val if isinstance(val, str) and val else None
    )


@router.put("/users/me/preferences", response_model=UserPreferences)
async def set_my_preferences(
    body: UserPreferences,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserPreferences:
    """Update the caller's preferences. Passing a null/empty default_agent_id
    clears it (revert to the client's built-in default)."""
    p = await db.get(Participant, user["participant_id"])
    if p is None:
        raise HTTPException(status_code=404, detail="Participant not found")
    meta = dict(p.metadata_ or {})
    aid = (body.default_agent_id or "").strip()
    if aid:
        meta["default_agent_id"] = aid
    else:
        meta.pop("default_agent_id", None)
    p.metadata_ = meta  # reassign (not mutate) so SQLAlchemy tracks the JSONB change
    await db.commit()
    return UserPreferences(default_agent_id=aid or None)


class UserResult(BaseModel):
    # When the user has signed in, we have a local Participant row with id.
    # When they haven't, we only know their Keycloak sub. The frontend uses
    # whichever is present and the backend resolves/creates Participant on invite.
    id: UUID | None = None
    keycloak_sub: str
    username: str
    display_name: str
    email: str | None
    avatar_url: str | None
    signed_in: bool


@router.get("/users/search", response_model=list[UserResult])
async def search_users(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    q: str = Query("", min_length=0, max_length=100),
    limit: int = Query(20, ge=1, le=50),
) -> list[UserResult]:
    """Search humans in the Keycloak realm.

    Returns users with `signed_in=true` if they have a local Participant row
    (seen them before), otherwise false. Invite flow handles both.
    """
    admin = KeycloakAdmin(settings)
    try:
        kc_users = await admin.search_users(q, limit=limit)
    except Exception as e:
        logger.warning("keycloak_search_failed", error=str(e))
        kc_users = []

    # Exclude the caller's own account
    caller_sub = user.get("sub")
    kc_users = [u for u in kc_users if u.get("id") and u.get("id") != caller_sub]

    # Batch-lookup local participants by sub
    subs = [u["id"] for u in kc_users]
    existing: dict[str, Participant] = {}
    if subs:
        rows = (
            await db.execute(
                select(Participant).where(
                    Participant.keycloak_sub.in_(subs),
                    Participant.participant_type == ParticipantType.HUMAN,
                )
            )
        ).scalars().all()
        existing = {p.keycloak_sub: p for p in rows}

    results: list[UserResult] = []
    for u in kc_users:
        sub = u["id"]
        p = existing.get(sub)
        first = (u.get("firstName") or "").strip()
        last = (u.get("lastName") or "").strip()
        name = " ".join(x for x in (first, last) if x) or u.get("username") or ""
        results.append(
            UserResult(
                id=p.id if p else None,
                keycloak_sub=sub,
                username=u.get("username") or "",
                display_name=name,
                email=None,  # not exposed via search — avoid realm-wide email enumeration (invite uses keycloak_sub)
                avatar_url=p.avatar_url if p else None,
                signed_in=p is not None,
            )
        )
    return results


async def _load_keycloak_email_for_sub(sub: str) -> str | None:
    """Fetch a user's email from Keycloak by their sub."""
    from app.config import get_settings

    try:
        admin = KeycloakAdmin(get_settings())
        kc_user = await admin.get_user(sub)
        return (kc_user or {}).get("email") or None
    except Exception:
        logger.debug("keycloak_email_lookup_failed", exc_info=True)
        return None


async def resolve_or_create_participant(
    db: AsyncSession,
    settings: Settings,
    keycloak_sub: str,
) -> Participant:
    """Return the Participant for a Keycloak user, creating it on first invite.

    This mirrors the upsert that happens on first login in get_current_user
    so we can invite users who haven't signed in yet. They'll link up to this
    row the first time they log into Stable (same keycloak_sub).
    """
    existing = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == keycloak_sub)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    admin = KeycloakAdmin(settings)
    kc_user = await admin.get_user(keycloak_sub)
    if kc_user is None:
        raise ValueError(f"Keycloak user not found: {keycloak_sub}")

    # Before minting a fresh row, link an existing email-matched persona
    # (the invitee may already exist under the OTHER Keycloak realm's sub --
    # see services/participant_identity.py). The sub here came from the
    # configured realm's admin API, so it is trusted by construction.
    email = (kc_user.get("email") or "").strip().lower()
    if email:
        linked = await link_participant_by_email(
            db, settings, new_sub=keycloak_sub, email=email
        )
        if linked is not None:
            return linked

    first = (kc_user.get("firstName") or "").strip()
    last = (kc_user.get("lastName") or "").strip()
    display = " ".join(x for x in (first, last) if x) or kc_user.get("username") or ""
    username = kc_user.get("username") or keycloak_sub

    p = Participant(
        keycloak_sub=keycloak_sub,
        username=username,
        display_name=display,
        participant_type=ParticipantType.HUMAN,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p
