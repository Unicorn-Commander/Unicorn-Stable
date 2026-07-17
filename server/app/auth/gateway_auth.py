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

from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import validate_token
from app.models.agent_gateway_key import AgentGatewayKey


class GatewayAuthError(Exception):
    """Raised on a failed/unauthorized gateway credential. Carries an HTTP status."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


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

    allowed = list(row.allowed_rooms or ["*"])
    return GatewayPrincipal(
        auth_kind="key",
        agent_id=row.agent_id,
        allowed_rooms=allowed,
        rate_key=f"gwkey:{row.id}",
        rate_limit_rpm=int(row.rate_limit_rpm or _default_rate_rpm()),
        human_sub=None,
    )


__all__ = [
    "GatewayPrincipal",
    "GatewayAuthError",
    "validate_gateway_jwt",
    "verify_gateway_key",
    "derive_agent_id",
    "hash_key",
    "slugify",
]
