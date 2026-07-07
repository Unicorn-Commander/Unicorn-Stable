"""Web-Push subscription endpoints (VAPID). The FE fetches the public key,
subscribes its browser PushSubscription, and unsubscribes on opt-out."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep
from app.models.push_subscription import PushSubscription

router = APIRouter()


class _Keys(BaseModel):
    p256dh: str
    auth: str


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: _Keys
    user_agent: str | None = None


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.get("/push/vapid-public-key")
async def vapid_public_key(
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict[str, str]:
    """The VAPID public key the browser needs as its applicationServerKey.
    Empty string means web-push is not configured on this deployment."""
    return {"key": settings.vapid_public_key}


@router.post("/push/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def subscribe(
    body: SubscribeRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Response:
    """Register (or refresh) this browser's push subscription for the caller."""
    existing = (
        await db.execute(
            select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.participant_id = user["participant_id"]
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        existing.user_agent = body.user_agent
    else:
        db.add(
            PushSubscription(
                participant_id=user["participant_id"],
                endpoint=body.endpoint,
                p256dh=body.keys.p256dh,
                auth=body.keys.auth,
                user_agent=body.user_agent,
            )
        )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/push/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    body: UnsubscribeRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Response:
    """Remove this browser's subscription (opt-out / permission revoked)."""
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint,
            PushSubscription.participant_id == user["participant_id"],
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
