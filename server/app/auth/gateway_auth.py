"""ORCH-1 — auth for the PUBLIC agent-gateway.

Two credential kinds, both mapped to a DERIVED, non-spoofable agent identity:

- **uchub user JWT** — validated for signature/issuer/expiry (reusing the
  existing crypto), then GATED on an explicit ``stable-agent-gateway`` realm/client
  role (or a subject allowlist). This is the critical difference from
  ``deps.get_current_user``: a valid-but-unauthorized suite token (every uchub
  user carries ``aud=account`` and passes signature validation) is REJECTED here,
  and we NEVER JIT-provision a human Participant. That closes the SSO-leak trap.
- **gateway key** — a Stable-owned ``agent_gateway_keys`` row, verified by SHA-256
  hash with ``compare_digest``. The ``agent_id`` and room allowlist come from the
  row, never from the caller.

The caller never supplies the agent id; it is derived here → cross-agent
impersonation is structurally impossible.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Iterable

import structlog
from jose import JWTError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import validate_token
from app.models.agent_gateway_key import AgentGatewayKey

logger = structlog.get_logger(__name__)

#: Logged instead of the key id. Long enough to find a row, short enough
#: that the line is not the id itself. Never the key or its hash.
_KEY_ID_PREFIX_LEN = 8


class GatewayAuthError(Exception):
    """Raised on a failed/unauthorized gateway credential. Carries an HTTP status."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


# Gateway-key prefixes we recognize (anything else on an Authorization header
# is treated as a JWT). Keys are minted with the first prefix.
KEY_PREFIXES = ("sbk-", "ubk-", "sk-")

#: The agent id of the native Talk Controls desk app. A key bound to it may
#: manage voice settings in its scoped rooms without the column being set —
#: the app's identity IS the grant (deps.get_room_controller).
TALK_CONTROLS_AGENT_ID = "talk-controls-app"


def is_gateway_key(token: str) -> bool:
    """True when a bearer credential is shaped like a gateway key, not a JWT."""
    return bool(token) and token.startswith(KEY_PREFIXES)


@dataclass
class GatewayPrincipal:
    """The authenticated caller of the gateway, mapped to a scoped agent identity."""

    auth_kind: str  # "jwt" | "key"
    agent_id: str  # DERIVED — the ONLY id this caller may post as
    # None  => JWT path: act only in rooms the human is already a member of.
    # list  => key path: explicit room allowlist ("*" = any room).
    allowed_rooms: list | None
    rate_key: str  # rate-limit identity (never the shared secret)
    rate_limit_rpm: int
    human_sub: str | None  # for audit metadata (JWT path)
    # Key path only: the row id (for audit) and the voice-settings grant.
    key_id: str | None = None
    can_manage_voice_settings: bool = False
    # Key path: the row's history floor (NULL = full history) and expiry.
    # JWT path leaves both None — a human-gated caller is not floored here.
    history_from: datetime | None = None
    expires_at: datetime | None = None

    def may_manage_voice_settings(self) -> bool:
        """A KEY whose agent is the desk app, or one an operator promoted."""
        return self.auth_kind == "key" and (
            self.agent_id == TALK_CONTROLS_AGENT_ID
            or bool(self.can_manage_voice_settings)
        )


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    return _SLUG_RE.sub("-", (value or "").strip().lower()).strip("-") or "anon"


def derive_agent_id(username: str, sub: str) -> str:
    """A deterministic, per-human agent id. Namespaced ``dev-`` so a gateway agent
    is visibly distinct from the internal ``brigade:`` fleet."""
    base = slugify(username) if username else ""
    if not base or base == "anon":
        base = (sub or "")[:8] or "anon"
    return f"dev-{base}"


def hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _roles_from_claims(claims: dict, client_id: str) -> set[str]:
    roles: set[str] = set()
    realm = claims.get("realm_access") or {}
    if isinstance(realm, dict):
        roles.update(realm.get("roles") or [])
    resource = claims.get("resource_access") or {}
    if isinstance(resource, dict):
        for key in (client_id, "stable", "account"):
            entry = resource.get(key) or {}
            if isinstance(entry, dict):
                roles.update(entry.get("roles") or [])
    return {str(r) for r in roles}


def _subject_allowlist() -> set[str]:
    raw = os.getenv("GATEWAY_JWT_SUBJECT_ALLOWLIST", "")
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def _default_rate_rpm() -> int:
    try:
        return int(os.getenv("GATEWAY_RATE_SEND_PER_MIN", "30") or 30)
    except (TypeError, ValueError):
        return 30


async def validate_gateway_jwt(token: str, settings) -> GatewayPrincipal:
    """Validate a uchub JWT AND require gateway authorization (role or allowlist).

    Rejects a valid-but-unauthorized suite token (the aud=account SSO-leak) with
    403 and never provisions a human account.
    """
    try:
        claims = await validate_token(
            token=token,
            keycloak_url=settings.keycloak_url,
            realm=settings.keycloak_realm,
            client_id=settings.keycloak_client_id,
        )
    except JWTError as exc:
        raise GatewayAuthError(401, f"Invalid or expired token: {exc}")

    sub = claims.get("sub") or ""
    username = claims.get("preferred_username") or sub
    roles = _roles_from_claims(claims, settings.keycloak_client_id)
    required_role = os.getenv("GATEWAY_JWT_REQUIRED_ROLE", "stable-agent-gateway")
    allowlist = _subject_allowlist()

    authorized = (
        (required_role and required_role in roles)
        or sub.lower() in allowlist
        or str(username).lower() in allowlist
    )
    if not authorized:
        # Valid signature but NOT authorized for the gateway — this is the SSO-leak
        # guard: "has a valid uchub token" is NOT "may use the gateway".
        raise GatewayAuthError(
            403,
            "This account is not authorized for the agent gateway "
            f"(needs the '{required_role}' role or an allowlisted subject).",
        )

    return GatewayPrincipal(
        auth_kind="jwt",
        agent_id=derive_agent_id(username, sub),
        allowed_rooms=None,  # human-membership-gated
        rate_key=f"gwjwt:{sub}",
        rate_limit_rpm=_default_rate_rpm(),
        human_sub=sub,
        history_from=None,
        expires_at=None,
    )


async def verify_gateway_key(raw_key: str, db: AsyncSession) -> GatewayPrincipal:
    """Verify a gateway key against its stored SHA-256 hash (constant-time)."""
    key_hash = hash_key(raw_key)
    row = (
        await db.execute(
            select(AgentGatewayKey).where(
                AgentGatewayKey.key_hash == key_hash,
                AgentGatewayKey.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    # compare_digest against the resolved row's hash too — defense in depth against
    # a hypothetical hash-collision/timing seam (the DB lookup already used the hash).
    if row is None or not hmac.compare_digest(row.key_hash, key_hash):
        raise GatewayAuthError(401, "Invalid or revoked gateway key")
    # Revoked wins over expired, with the same message as a missing row.
    # The query above already excludes revoked rows; this is that answer
    # again if a revoked row is ever handed back.
    if getattr(row, "revoked_at", None) is not None:
        raise GatewayAuthError(401, "Invalid or revoked gateway key")

    expires_at = _lifetime_or_refuse(row, "expires_at")
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise GatewayAuthError(401, "Gateway key expired")

    # A NULL allowlist is the legacy default ("*"); an EMPTY list is a key an
    # operator scoped to nothing and stays that way (never a wildcard).
    allowed = list(row.allowed_rooms) if row.allowed_rooms is not None else ["*"]
    return GatewayPrincipal(
        auth_kind="key",
        agent_id=row.agent_id,
        allowed_rooms=allowed,
        rate_key=f"gwkey:{row.id}",
        rate_limit_rpm=int(row.rate_limit_rpm or _default_rate_rpm()),
        human_sub=None,
        key_id=str(row.id),
        can_manage_voice_settings=bool(
            getattr(row, "can_manage_voice_settings", False)
        ),
        history_from=_lifetime_or_refuse(row, "history_from"),
        expires_at=expires_at,
    )


def _lifetime_or_refuse(row, field: str) -> datetime | None:
    """Missing attribute or None keeps 'no expiry' / 'full history'.

    A present value that is not a datetime must not widen access. One
    structured line names the key-id prefix and the field, never the key
    or its hash, and the key is refused with the same message as a bad key.
    """
    if not hasattr(row, field):
        return None
    value = getattr(row, field)
    if value is None:
        return None
    if isinstance(value, datetime):
        return _as_utc(value)
    logger.warning(
        "gateway_key_bad_lifetime",
        key_id_prefix=str(getattr(row, "id", "") or "")[:_KEY_ID_PREFIX_LEN],
        field=field,
    )
    raise GatewayAuthError(401, "Invalid or revoked gateway key")


def _as_utc(value: datetime | None) -> datetime | None:
    """A timestamptz as UTC. Naive values are UTC already (the column is
    ``timestamptz``; a test double sometimes omits the tz). None stays None,
    which is 'no expiry' / 'full history'. A non-datetime is not treated as
    None: that would mean no expiry."""
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise GatewayAuthError(401, "Invalid or revoked gateway key")
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


#: ``allowed_rooms`` token meaning "any room where this key's agent participant
#: is a member" (Nav v3, C1). Resolved against ``room_members`` at check time,
#: so a seat follows its human into every hub, thread and room it is added
#: to without a key re-scope. Explicit names and ``"*"`` keep their meaning.
MEMBER_SCOPE = "@member"


def key_scope_wants_membership(allowed_rooms: list | None) -> bool:
    """True when the allowlist carries the ``@member`` token."""
    return bool(allowed_rooms) and MEMBER_SCOPE in allowed_rooms


def room_in_key_scope(allowed_rooms: list | None, room) -> bool:
    """The gateway's allowlist rule, shared with the voice-settings path:
    ``"*"`` = any room; otherwise either name form must be listed.

    Pure and name-based on purpose. The ``@member`` token needs a database
    lookup — see :func:`resolve_key_room_scope`, which every scope check
    should call so the two rules cannot drift.
    """
    if allowed_rooms is None:
        return False
    return (
        "*" in allowed_rooms
        or getattr(room, "livekit_room_name", None) in allowed_rooms
        or getattr(room, "name", None) in allowed_rooms
    )


async def agent_is_room_member(db: AsyncSession, agent_id: str, room_id) -> bool:
    """Is the agent participant for ``agent_id`` (``keycloak_sub =
    brigade:<agent_id>``) a member of ``room_id``?"""
    from app.models.participant import Participant
    from app.models.room import RoomMember

    row = (
        await db.execute(
            select(RoomMember.id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(
                RoomMember.room_id == room_id,
                Participant.keycloak_sub == f"brigade:{agent_id}",
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return row is not None


async def seat_owner_usernames(db: AsyncSession, agent_id: str) -> frozenset[str]:
    """The usernames that own the seat ``agent_id`` (``participants.metadata
    .owner``, a string or a list). Empty when the seat has no row or no
    owner — and then ``@member`` matches nothing (fail closed)."""
    from app.models.participant import Participant
    from app.services.room_class import seat_owners

    meta = (
        await db.execute(
            select(Participant.metadata_).where(Participant.keycloak_sub == f"brigade:{agent_id}")
        )
    ).scalar_one_or_none()
    return seat_owners(SimpleNamespace(metadata_=meta))


async def owner_is_room_member(db: AsyncSession, owners: Iterable[str], room_id) -> bool:
    """Is one of ``owners`` (usernames) a current HUMAN member of ``room_id``?"""
    from app.models.participant import Participant, ParticipantType
    from app.models.room import RoomMember

    names = [name for name in owners if name]
    if not names:
        return False
    row = (
        await db.execute(
            select(RoomMember.id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(
                RoomMember.room_id == room_id,
                Participant.participant_type == ParticipantType.HUMAN,
                func.lower(Participant.username).in_(names),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return row is not None


async def seat_follows_human(db: AsyncSession, agent_id: str, room) -> bool:
    """R4 — the ``@member`` rule proper: the room is live (not archived), the
    seat is a member, AND the seat's owner human is a current member. The
    seat follows ITS human; a membership someone else minted for it is not
    authority on its own."""
    room_id = getattr(room, "id", None)
    if room_id is None or bool(getattr(room, "is_archived", False)):
        return False
    if not await agent_is_room_member(db, agent_id, room_id):
        return False
    owners = await seat_owner_usernames(db, agent_id)
    if not owners:
        return False
    return await owner_is_room_member(db, owners, room_id)


async def resolve_key_room_scope(
    db: AsyncSession, allowed_rooms: list | None, agent_id: str, room
) -> bool:
    """The full key-scope rule: names / ``*`` as :func:`room_in_key_scope`,
    then ``@member`` as :func:`seat_follows_human`. ``None`` (the JWT path)
    is never a key scope; an empty list is scoped to nothing."""
    if not allowed_rooms:
        return False
    if room_in_key_scope(allowed_rooms, room):
        return True
    if not key_scope_wants_membership(allowed_rooms):
        return False
    return await seat_follows_human(db, agent_id, room)


__all__ = [
    "GatewayPrincipal",
    "GatewayAuthError",
    "KEY_PREFIXES",
    "MEMBER_SCOPE",
    "TALK_CONTROLS_AGENT_ID",
    "agent_is_room_member",
    "is_gateway_key",
    "key_scope_wants_membership",
    "owner_is_room_member",
    "resolve_key_room_scope",
    "room_in_key_scope",
    "seat_follows_human",
    "seat_owner_usernames",
    "validate_gateway_jwt",
    "verify_gateway_key",
    "derive_agent_id",
    "hash_key",
    "slugify",
]
