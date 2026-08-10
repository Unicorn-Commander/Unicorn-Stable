"""Per-user agent access control — resolution + enforcement.

WHAT IS GATED (human actions that ESTABLISH access to an agent):
  * agent-DM creation and any agent bind into a room
    (``POST /rooms/{room}/invite-brigade-agent`` — the one funnel the web
    client uses for "New chat", the in-room agent picker, AND the call-time
    voice dispatch);
  * inviting an agent-typed Participant through the generic member-invite
    route (``POST /rooms/{room_id}/invite``).

WHAT IS DELIBERATELY NOT GATED:
  * the agents WORKER runtime. The worker authenticates to the same public
    routes as a Keycloak service account whose identity extraction yields
    ``participant_type == "agent"`` (see auth/keycloak.extract_user_identity);
    ``ensure_agent_access`` passes every non-human principal through untouched.
    The ``/api/v1/internal/*`` surface (internal bearer) and ``api/gateway.py``
    (gateway credentials) never call into this module at all.
  * sending a message into a room whose resident agent the caller is not
    entitled to. Others in the room may be entitled; the gate is on
    establishing agent access, not on talking in a room.
  * removing/kicking an agent — revoking a binding is not acquiring one.

Resolution order for a (human participant, agent) pair:
  1. a grant row (``agent_access_grants``) wins in both directions:
     effect=allow → allowed, effect=deny → denied;
  2. otherwise the instance default (``Settings.agent_access_default``,
     env AGENT_ACCESS_DEFAULT): "open" → allowed, "closed" → denied.

Every denial emits a structured ``agent_access_denied`` audit log.

Instance-admin determination (for the grants API) reuses the mechanism
``api/instance_meta.py`` established: the caller's Keycloak realm roles
(``user["roles"]``) intersected with the STABLE_ADMIN_ROLES env allowlist
(default ``stable-admin,realm-admin,admin``).
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Iterable

import structlog
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.agent_access import AgentAccessEffect, AgentAccessGrant

logger = structlog.get_logger(__name__)

# Pseudo-sub prefix agent Participants carry (``brigade:<agent_id>``) — the
# bridge between a Participant row and the Brigade string id grants key on.
_BRIGADE_SUB_PREFIX = "brigade:"


def agent_id_for_participant(keycloak_sub: str | None) -> str:
    """The grant-table key for an agent-typed Participant.

    Brigade agents (``brigade:perry`` → ``perry``) are the normal case. Any
    other agent-typed principal (e.g. a ``webhook:*`` bot) keys on its full
    pseudo-sub, so it can still be granted/denied explicitly and is subject to
    the same closed-mode default as everything else.
    """
    sub = (keycloak_sub or "").strip()
    if sub.startswith(_BRIGADE_SUB_PREFIX):
        return sub[len(_BRIGADE_SUB_PREFIX):]
    return sub


def _default_is_open() -> bool:
    return get_settings().agent_access_default != "closed"


async def resolve_agent_access(
    db: AsyncSession,
    *,
    participant_id: uuid.UUID | str,
    agent_id: str,
) -> tuple[bool, str]:
    """Return ``(allowed, reason)`` for one (participant, agent) pair.

    ``reason`` ∈ {"grant_allow", "grant_deny", "default_open",
    "default_closed"} — carried into the audit log so a denial names the rule
    that produced it.
    """
    grant = (
        await db.execute(
            select(AgentAccessGrant).where(
                AgentAccessGrant.participant_id == participant_id,
                AgentAccessGrant.agent_id == agent_id,
            )
        )
    ).scalar_one_or_none()
    if grant is not None:
        if grant.effect == AgentAccessEffect.ALLOW:
            return True, "grant_allow"
        return False, "grant_deny"
    if _default_is_open():
        return True, "default_open"
    return False, "default_closed"


async def ensure_agent_access(
    db: AsyncSession,
    user: dict[str, Any],
    agent_id: str,
    *,
    surface: str,
) -> None:
    """Raise 403 unless the HUMAN caller is entitled to ``agent_id``.

    Non-human principals (the agents worker's Keycloak service account —
    ``participant_type == "agent"``) pass unconditionally: entitlements gate
    human actions, never the worker's own operations. ``surface`` names the
    enforcement point for the audit log ("agent_invite", "room_member_invite").
    """
    if user.get("participant_type") == "agent":
        return
    allowed, reason = await resolve_agent_access(
        db, participant_id=user["participant_id"], agent_id=agent_id
    )
    if allowed:
        return
    logger.warning(
        "agent_access_denied",
        participant_id=str(user.get("participant_id")),
        username=user.get("username"),
        agent_id=agent_id,
        surface=surface,
        reason=reason,
        mode=get_settings().agent_access_default,
    )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"You don't have access to the agent '{agent_id}'. "
            "Ask an admin to grant it."
        ),
    )


async def entitled_agent_ids(
    db: AsyncSession,
    *,
    participant_id: uuid.UUID | str,
    agent_ids: Iterable[str],
) -> set[str]:
    """The subset of ``agent_ids`` this participant may reach (one query).

    Used by the roster endpoints to annotate each agent ``entitled`` without a
    per-agent round trip.
    """
    ids = [a for a in agent_ids if a]
    if not ids:
        return set()
    grants = (
        (
            await db.execute(
                select(AgentAccessGrant).where(
                    AgentAccessGrant.participant_id == participant_id,
                    AgentAccessGrant.agent_id.in_(ids),
                )
            )
        )
        .scalars()
        .all()
    )
    by_agent = {g.agent_id: g.effect for g in grants}
    open_default = _default_is_open()
    entitled: set[str] = set()
    for aid in ids:
        effect = by_agent.get(aid)
        if effect is None:
            if open_default:
                entitled.add(aid)
        elif effect == AgentAccessEffect.ALLOW:
            entitled.add(aid)
    return entitled


# ---------------------------------------------------------------------------
# Instance-admin gate (grants API)
# ---------------------------------------------------------------------------


def _admin_roles() -> set[str]:
    # Same env contract as api/instance_meta.py — one knob, one admin concept.
    raw = os.environ.get("STABLE_ADMIN_ROLES", "stable-admin,realm-admin,admin")
    return {r.strip() for r in raw.split(",") if r.strip()}


def is_instance_admin(user: dict[str, Any]) -> bool:
    roles = {str(r) for r in (user.get("roles") or [])}
    return bool(roles & _admin_roles())


def require_instance_admin(user: dict[str, Any]) -> None:
    if not is_instance_admin(user):
        # 403, not 404: the caller is authenticated, they simply aren't an admin.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an instance admin can manage agent access grants.",
        )
