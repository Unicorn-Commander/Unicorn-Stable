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
