from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import structlog
from jose import JWTError, jwk, jwt
from jose.utils import base64url_decode

logger = structlog.get_logger(__name__)

_jwks_cache: dict[str, Any] = {}
_oidc_config_cache: dict[str, Any] = {}
_last_jwks_refresh: float = 0.0
JWKS_REFRESH_INTERVAL: int = 3600  # seconds


async def fetch_oidc_config(keycloak_url: str, realm: str) -> dict[str, Any]:
    """Fetch the OIDC well-known configuration from Keycloak."""
    global _oidc_config_cache
    if _oidc_config_cache:
        return _oidc_config_cache

    url = f"{keycloak_url}/realms/{realm}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        _oidc_config_cache = resp.json()
        logger.info("fetched_oidc_config", issuer=_oidc_config_cache.get("issuer"))
        return _oidc_config_cache


async def fetch_jwks(keycloak_url: str, realm: str) -> dict[str, Any]:
    """Fetch the JSON Web Key Set from Keycloak, with caching."""
    global _jwks_cache, _last_jwks_refresh

    now = time.monotonic()
    if _jwks_cache and (now - _last_jwks_refresh) < JWKS_REFRESH_INTERVAL:
        return _jwks_cache

    oidc_config = await fetch_oidc_config(keycloak_url, realm)
    jwks_uri = oidc_config["jwks_uri"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(jwks_uri)
        resp.raise_for_status()
        _jwks_cache = resp.json()
        _last_jwks_refresh = now
        logger.info("refreshed_jwks", key_count=len(_jwks_cache.get("keys", [])))
        return _jwks_cache


def _find_key(jwks: dict[str, Any], kid: str) -> dict[str, Any] | None:
    """Find the signing key matching the kid from the JWKS."""
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return key
    return None


async def validate_token(
    token: str,
    keycloak_url: str,
    realm: str,
    client_id: str,
) -> dict[str, Any]:
    """
    Validate a Keycloak JWT token.

    Verifies signature, audience, issuer, and expiry.
    Returns the decoded claims on success.
    Raises JWTError on any validation failure.
    """
    # Decode header without verification to get the kid
    unverified_header = jwt.get_unverified_header(token)
    kid = unverified_header.get("kid")
    if not kid:
        raise JWTError("Token header missing 'kid'")

    # Fetch JWKS and find matching key
    jwks_data = await fetch_jwks(keycloak_url, realm)
    signing_key = _find_key(jwks_data, kid)

    if signing_key is None:
        # Key not found -- force refresh in case keys rotated
        global _last_jwks_refresh
        _last_jwks_refresh = 0.0
        jwks_data = await fetch_jwks(keycloak_url, realm)
        signing_key = _find_key(jwks_data, kid)
        if signing_key is None:
            raise JWTError(f"Unable to find signing key with kid: {kid}")

    # Build the RSA public key
    rsa_key = {
        "kty": signing_key["kty"],
        "kid": signing_key["kid"],
        "use": signing_key.get("use", "sig"),
        "n": signing_key["n"],
        "e": signing_key["e"],
    }

    expected_issuer = f"{keycloak_url}/realms/{realm}"

    # python-jose requires audience to be a string (not list), so verify
    # signature/issuer/expiry via jose and accept any of our valid audiences
    # manually. Keycloak tokens typically have aud="account" for user tokens
    # or aud=client_id for tokens minted for a specific resource.
    claims = jwt.decode(
        token,
        rsa_key,
        algorithms=["RS256"],
        issuer=expected_issuer,
        options={
            "verify_aud": False,
            "verify_iss": True,
            "verify_exp": True,
            "verify_iat": True,
        },
    )

    token_aud = claims.get("aud")
    aud_list = [token_aud] if isinstance(token_aud, str) else list(token_aud or [])
    accepted = {"account", client_id}
    if not (accepted & set(aud_list)):
        raise JWTError(
            f"Token audience {aud_list!r} does not include any of {sorted(accepted)!r}"
        )

    return claims


def extract_user_identity(claims: dict[str, Any]) -> dict[str, Any]:
    """
    Extract a normalized user identity from validated JWT claims.

    Handles both human users and agent service accounts.
    """
    roles: list[str] = []
    realm_access = claims.get("realm_access", {})
    if isinstance(realm_access, dict):
        roles = realm_access.get("roles", [])

    # Determine participant type from client roles or token azp
    is_agent = "agent-service" in roles or claims.get("azp", "").endswith("-agent")
    participant_type = "agent" if is_agent else "human"

    # Avatar comes from the Keycloak `picture` claim, or nowhere. There is
    # deliberately NO Gravatar fallback. The old one built a gravatar.com URL
    # with `d=404`, which is a server-side EXISTENCE PROBE, not an image
    # source: dropped into <img src> it renders a BROKEN IMAGE for every user
    # without a Gravatar account. Verified 2026-07-20 -- 3 of 3 stamped rows
    # returned HTTP 404. It also leaked each user's email MD5 to a third party
    # on every avatar render, which is why the newer avatar spine rejected
    # Gravatar outright (see the note in api/participants.py).
    # A null avatar is correct: the UI already falls back to initials.
    avatar_url: str | None = claims.get("picture") or None

    return {
        "sub": claims["sub"],
        "username": claims.get("preferred_username", claims["sub"]),
        "email": claims.get("email"),
        "display_name": claims.get("name", claims.get("preferred_username", "")),
        "avatar_url": avatar_url,
        "roles": roles,
        "participant_type": participant_type,
    }


async def start_jwks_refresh_task(keycloak_url: str, realm: str) -> asyncio.Task[None]:
    """Start a background task that periodically refreshes the JWKS cache."""

    async def _refresh_loop() -> None:
        while True:
            try:
                await asyncio.sleep(JWKS_REFRESH_INTERVAL)
                global _last_jwks_refresh
                _last_jwks_refresh = 0.0
                await fetch_jwks(keycloak_url, realm)
            except asyncio.CancelledError:
                logger.info("jwks_refresh_task_cancelled")
                break
            except Exception:
                logger.exception("jwks_refresh_failed")
                await asyncio.sleep(60)

    task = asyncio.create_task(_refresh_loop(), name="jwks-refresh")
    return task


def clear_caches() -> None:
    """Clear all cached OIDC config and JWKS data. Used for testing."""
    global _jwks_cache, _oidc_config_cache, _last_jwks_refresh
    _jwks_cache = {}
    _oidc_config_cache = {}
    _last_jwks_refresh = 0.0
