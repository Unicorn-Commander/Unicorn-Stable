"""Constant-time authn for the internal agent surface.

Every ``/api/v1/internal/*`` route and the agent-message-inject paths in
``messages.py`` authenticate with a shared bearer. Historically each site
inlined ``auth != f"Bearer {secret}"`` against ``livekit_api_secret`` — a
timing-observable compare that also overloaded the LiveKit token secret as the
internal bearer. This module is the single source of truth: a distinct
``internal_agent_secret`` (falling back to the LiveKit secret only if unset for
migration safety) checked with :func:`hmac.compare_digest`.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from app.config import get_settings

_BEARER = "Bearer "


def _expected_internal_secret() -> str:
    cfg = get_settings()
    # Prefer the dedicated internal secret; fall back to the LiveKit secret
    # only while a deploy has not yet set the split value.
    return cfg.internal_agent_secret or cfg.livekit_api_secret


def internal_bearer_ok(auth_header: str | None) -> bool:
    """Constant-time check of an ``Authorization: Bearer <secret>`` header."""
    expected = _expected_internal_secret()
    if not expected or not auth_header or not auth_header.startswith(_BEARER):
        return False
    presented = auth_header[len(_BEARER):]
    return hmac.compare_digest(presented, expected)


def verify_internal_bearer(request: Request) -> None:
    """Raise 401 unless the request carries the valid internal agent bearer."""
    if not internal_bearer_ok(request.headers.get("Authorization")):
        raise HTTPException(status_code=401, detail="Bad agent secret")


def _expected_key_admin_secret() -> str:
    cfg = get_settings()
    # Dedicated key-admin credential; fall back to the internal bearer (and in
    # turn the LiveKit secret) while a deploy has not yet set the split value.
    return cfg.gateway_key_admin_secret or _expected_internal_secret()


def verify_key_admin_bearer(request: Request) -> None:
    """Raise 401 unless the request carries the gateway KEY-ADMIN bearer.

    Guards the gateway key mint/list/revoke endpoints. Those sit on the public
    `/api` router and are internet-reachable by design, so they get their own
    credential rather than reusing the widely-distributed internal agent
    secret — a leak of that secret should not confer the ability to mint
    long-lived agent identities. Constant-time compare, same as the internal
    bearer.
    """
    expected = _expected_key_admin_secret()
    auth = request.headers.get("Authorization")
    if not expected or not auth or not auth.startswith(_BEARER):
        raise HTTPException(status_code=401, detail="Bad key-admin secret")
    if not hmac.compare_digest(auth[len(_BEARER):], expected):
        raise HTTPException(status_code=401, detail="Bad key-admin secret")
