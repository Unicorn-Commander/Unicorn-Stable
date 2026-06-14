"""Microsoft Graph email sender.

Uses client_credentials (app-only) flow to call the Graph API. The Azure
app registration needs the `Mail.Send` application permission with admin
consent granted. The `from_address` must be a valid mailbox in the tenant
that the app has permission to send as.

Configured via env:
    MS_GRAPH_TENANT_ID
    MS_GRAPH_CLIENT_ID
    MS_GRAPH_CLIENT_SECRET
    MS_GRAPH_FROM_ADDRESS
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import structlog

logger = structlog.get_logger(__name__)


class GraphEmailSender:
    GRAPH_BASE = "https://graph.microsoft.com/v1.0"
    TOKEN_SCOPE = "https://graph.microsoft.com/.default"

    def __init__(
        self,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        from_address: str,
    ):
        self._tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._from_address = from_address
        self._token: str | None = None
        self._token_exp = 0.0

    @property
    def is_configured(self) -> bool:
        return bool(
            self._tenant_id
            and self._client_id
            and self._client_secret
            and self._from_address
        )

    async def _get_token(self) -> str:
        if self._token and time.time() < self._token_exp - 30:
            return self._token

        url = f"https://login.microsoftonline.com/{self._tenant_id}/oauth2/v2.0/token"
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as http:
            resp = await http.post(
                url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "scope": self.TOKEN_SCOPE,
                },
            )
            resp.raise_for_status()
            body = resp.json()

        self._token = body["access_token"]
        self._token_exp = time.time() + int(body.get("expires_in", 3600))
        return self._token

    async def send(
        self,
        *,
        to: str,
        subject: str,
        html_body: str,
        text_body: str | None = None,
        reply_to: str | None = None,
    ) -> bool:
        """Send an email. Returns True on success, False on failure (non-raising)."""
        if not self.is_configured:
            logger.info("email_skipped_unconfigured", to=to, subject=subject)
            return False

        try:
            token = await self._get_token()
        except Exception as exc:
            logger.warning("graph_token_failed", error=str(exc))
            return False

        message: dict[str, Any] = {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "toRecipients": [{"emailAddress": {"address": to}}],
        }
        if reply_to:
            message["replyTo"] = [{"emailAddress": {"address": reply_to}}]

        payload = {"message": message, "saveToSentItems": False}

        url = f"{self.GRAPH_BASE}/users/{self._from_address}/sendMail"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as http:
                resp = await http.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            if resp.status_code in (200, 202):
                logger.info("email_sent", to=to, subject=subject)
                return True
            logger.warning(
                "email_send_failed",
                to=to,
                status=resp.status_code,
                body=resp.text[:500],
            )
            return False
        except Exception as exc:
            logger.warning("email_send_exception", to=to, error=str(exc))
            return False
