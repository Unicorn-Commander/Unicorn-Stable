"""Thin Keycloak Admin API client scoped to user-directory reads.

Uses the backend's confidential client (KEYCLOAK_CLIENT_ID/SECRET) via the
client_credentials grant. The service account needs the `view-users` and
`query-users` roles on the `realm-management` client to call these endpoints.

Only the calls we actually need are wrapped — we're not building a full SDK.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import structlog

from app.config import Settings

logger = structlog.get_logger(__name__)


def _first_enabled_user(users: list[dict[str, Any]]) -> dict[str, Any] | None:
    """First row Keycloak marked enabled and that carries an id.

    ``enabled is False`` is the only disabled signal. A missing flag is left
    to the ``enabled=true`` query parameter rather than treated as off.
    """
    for user in users:
        if not isinstance(user, dict):
            continue
        if user.get("enabled") is False:
            continue
        if user.get("id"):
            return user
    return None


class KeycloakAdmin:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._token: str | None = None
        self._token_exp = 0.0

    @property
    def _admin_base(self) -> str:
        return f"{self._settings.keycloak_url}/admin/realms/{self._settings.keycloak_realm}"

    async def _get_token(self) -> str:
        # Reuse until 30s before expiry
        if self._token and time.time() < self._token_exp - 30:
            return self._token

        url = (
            f"{self._settings.keycloak_url}/realms/"
            f"{self._settings.keycloak_realm}/protocol/openid-connect/token"
        )
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as http:
            resp = await http.post(
                url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._settings.keycloak_client_id,
                    "client_secret": self._settings.keycloak_client_secret,
                },
            )
            resp.raise_for_status()
            body = resp.json()

        self._token = body["access_token"]
        self._token_exp = time.time() + int(body.get("expires_in", 300))
        return self._token

    async def search_users(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Search users in the realm by free-text substring.

        Keycloak's `search` param matches username, firstName, lastName, email.
        Empty query returns the first `limit` users alphabetically.
        """
        token = await self._get_token()
        params: dict[str, Any] = {"max": limit, "enabled": "true"}
        if query.strip():
            params["search"] = query.strip()

        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as http:
            resp = await http.get(
                f"{self._admin_base}/users",
                headers={"Authorization": f"Bearer {token}"},
                params=params,
            )
            if resp.status_code == 403:
                logger.warning(
                    "keycloak_admin_forbidden",
                    detail="Service account missing view-users/query-users role",
                )
                return []
            resp.raise_for_status()
            return resp.json()

    async def find_user_exact(self, query: str) -> dict[str, Any] | None:
        """Return one enabled realm user by exact username, or exact email.

        Keycloak matches both fields case-insensitively when ``exact=true``.
        This method keeps that behaviour and does not fold case itself: the
        trimmed query is sent as given. Email is queried only when the query
        contains ``@``. Username is tried first; an enabled hit there is the
        only result, so a username match and an email match cannot both come
        back. A 403 (service account missing view-users/query-users) is logged
        and treated as no match. Callers must still tolerate other Keycloak
        errors — this method lets those raise.
        """
        needle = (query or "").strip()
        if not needle:
            return None

        token = await self._get_token()
        username_rows = await self._exact_user_rows(token, {"username": needle})
        if username_rows is None:
            return None
        hit = _first_enabled_user(username_rows)
        if hit is not None or "@" not in needle:
            return hit

        email_rows = await self._exact_user_rows(token, {"email": needle})
        if email_rows is None:
            return None
        return _first_enabled_user(email_rows)

    async def _exact_user_rows(
        self, token: str, field: dict[str, str]
    ) -> list[dict[str, Any]] | None:
        """One exact admin lookup.

        Returns the JSON list, or None on 403 so the caller stops instead of
        trying the other field with the same missing role. ``field`` is either
        ``{"username": ...}`` or ``{"email": ...}`` — never Keycloak's
        substring ``search`` parameter.
        """
        params: dict[str, Any] = {
            "exact": "true",
            "enabled": "true",
            "max": 2,
            **field,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as http:
            resp = await http.get(
                f"{self._admin_base}/users",
                headers={"Authorization": f"Bearer {token}"},
                params=params,
            )
        if resp.status_code == 403:
            logger.warning(
                "keycloak_admin_forbidden",
                detail="Service account missing view-users/query-users role",
            )
            return None
        resp.raise_for_status()
        body = resp.json()
        if not isinstance(body, list):
            return []
        return body

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        """Fetch a user by Keycloak id (same value as JWT `sub`)."""
        token = await self._get_token()
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as http:
            resp = await http.get(
                f"{self._admin_base}/users/{user_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
