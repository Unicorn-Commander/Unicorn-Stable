"""Meeting-Ops federation client (optional).

Stable can export a finalized call transcript as a structured JSON payload
and, when configured, POST it to a Meeting-Ops ingest URL.

No secrets are hardcoded. Configure via env:

  MEETING_OPS_URL          Base URL (e.g. https://meetingops.example.com)
  MEETING_OPS_INGEST_PATH  Path appended to the base (default /api/v1/sessions/ingest)
  MEETING_OPS_API_KEY      Meeting-Ops PAT (Authorization: Bearer …)
  MEETING_OPS_ORG_SLUG     Explicit target organization slug
  MEETING_OPS_ENABLED      Master switch (default true when URL is set)

When configuration is incomplete the durable outbox retains the export as
blocked and this adapter does not attempt a request.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
import structlog

from app.config import Settings

logger = structlog.get_logger(__name__)


def trusted_remote_session_url(settings: Settings, value: Any) -> str | None:
    """Accept deep links only from the configured Meeting-Ops origin."""
    if not isinstance(value, str) or not value.strip():
        return None
    base = urlsplit((settings.meeting_ops_url or "").strip())
    candidate_value = urljoin(f"{base.scheme}://{base.netloc}/", value.strip())
    candidate = urlsplit(candidate_value)
    if candidate.scheme not in {"http", "https"}:
        return None
    if (
        candidate.scheme,
        candidate.hostname,
        candidate.port,
    ) != (
        base.scheme,
        base.hostname,
        base.port,
    ):
        logger.warning(
            "meeting_ops_untrusted_session_url",
            candidate_origin=f"{candidate.scheme}://{candidate.netloc}",
        )
        return None
    return candidate_value


def meeting_ops_configured(settings: Settings) -> bool:
    """True only when the complete authenticated tenant target is configured."""
    url = (settings.meeting_ops_url or "").strip()
    api_key = (settings.meeting_ops_api_key or "").strip()
    org_slug = (settings.meeting_ops_org_slug or "").strip()
    if not url or not api_key or not org_slug:
        return False
    if not settings.meeting_ops_enabled:
        return False
    return True


def build_ingest_url(settings: Settings) -> str | None:
    base = (settings.meeting_ops_url or "").strip().rstrip("/")
    if not base:
        return None
    path = (settings.meeting_ops_ingest_path or "/api/v1/sessions/ingest").strip()
    if not path.startswith("/"):
        path = "/" + path
    return f"{base}{path}"


async def forward_transcript_to_meeting_ops(
    *,
    settings: Settings,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """POST the structured transcript to Meeting-Ops if configured.

    Returns a small status dict with forwarding, retryability, and remote IDs.

    Never raises to the caller — failures are returned as status=error so the
    export endpoint can still 200 with a clear delivery report.
    """
    if not meeting_ops_configured(settings):
        return {
            "forwarded": False,
            "status": "skipped",
            "detail": "Meeting-Ops URL, PAT, organization, or enabled flag is missing",
        }

    url = build_ingest_url(settings)
    if not url:
        return {
            "forwarded": False,
            "status": "skipped",
            "detail": "Meeting-Ops URL could not be built",
        }

    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "unicorn-stable-transcript-export/1.0",
    }
    api_key = (settings.meeting_ops_api_key or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    org_slug = (settings.meeting_ops_org_slug or "").strip()
    if org_slug:
        headers["X-MeetingOps-Org"] = org_slug
    export_id = str(payload.get("export_id") or "").strip()
    if export_id:
        headers["Idempotency-Key"] = export_id

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0)) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.warning(
                "meeting_ops_forward_http_error",
                url=url,
                status=resp.status_code,
                body=resp.text[:300],
            )
            return {
                "forwarded": False,
                "status": "error",
                "detail": f"Meeting-Ops returned HTTP {resp.status_code}",
                "http_status": resp.status_code,
                "retryable": resp.status_code == 429 or resp.status_code >= 500,
            }
        logger.info(
            "meeting_ops_forward_ok",
            url=url,
            status=resp.status_code,
            lines=len(payload.get("lines") or []),
        )
        # Best-effort parse of a remote session id if they return one.
        remote_id: str | None = None
        remote_url: str | None = None
        try:
            body = resp.json()
            if isinstance(body, dict):
                remote_id = (
                    body.get("session_id")
                    or body.get("id")
                    or body.get("meeting_session_id")
                )
                if remote_id is not None:
                    remote_id = str(remote_id)
                value = body.get("session_url") or body.get("url")
                remote_url = trusted_remote_session_url(settings, value)
        except Exception:
            remote_id = None
        return {
            "forwarded": True,
            "status": "ok",
            "detail": "Delivered to Meeting-Ops",
            "http_status": resp.status_code,
            "remote_session_id": remote_id,
            "remote_session_url": remote_url,
            "retryable": False,
        }
    except Exception as exc:
        logger.warning("meeting_ops_forward_failed", url=url, error=str(exc), exc_info=True)
        return {
            "forwarded": False,
            "status": "error",
            "detail": "Meeting-Ops request failed",
            "retryable": True,
        }
