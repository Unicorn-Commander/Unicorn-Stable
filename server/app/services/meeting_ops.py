"""Meeting-Ops federation client (optional).

Stable can export a finalized call transcript as a structured JSON payload
and, when configured, POST it to a Meeting-Ops ingest URL.

No secrets are hardcoded. Configure via env:

  MEETING_OPS_URL          Base URL (e.g. https://meetingops.example.com)
  MEETING_OPS_INGEST_PATH  Path appended to the base (default /api/v1/sessions/ingest)
  MEETING_OPS_API_KEY      Optional bearer / API key (Authorization: Bearer …)
  MEETING_OPS_ENABLED      Master switch (default true when URL is set)

When URL is empty the export still succeeds server-side (payload is accepted
and logged) but nothing is forwarded — useful for local dev and CI.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog

from app.config import Settings

logger = structlog.get_logger(__name__)


def meeting_ops_configured(settings: Settings) -> bool:
    """True when a forward target is configured and enabled."""
    url = (settings.meeting_ops_url or "").strip()
    if not url:
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

    Returns a small status dict:
      { "forwarded": bool, "status": "ok"|"skipped"|"error", "detail": str, ... }

    Never raises to the caller — failures are returned as status=error so the
    export endpoint can still 200 with a clear delivery report.
    """
    if not meeting_ops_configured(settings):
        return {
            "forwarded": False,
            "status": "skipped",
            "detail": "MEETING_OPS_URL unset or MEETING_OPS_ENABLED=false — payload accepted locally only",
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
            }
        logger.info(
            "meeting_ops_forward_ok",
            url=url,
            status=resp.status_code,
            lines=len(payload.get("lines") or []),
        )
        # Best-effort parse of a remote session id if they return one.
        remote_id: str | None = None
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
        except Exception:
            remote_id = None
        return {
            "forwarded": True,
            "status": "ok",
            "detail": "Delivered to Meeting-Ops",
            "http_status": resp.status_code,
            "remote_session_id": remote_id,
        }
    except Exception as exc:
        logger.warning("meeting_ops_forward_failed", url=url, error=str(exc), exc_info=True)
        return {
            "forwarded": False,
            "status": "error",
            "detail": f"Meeting-Ops request failed: {exc}",
        }
