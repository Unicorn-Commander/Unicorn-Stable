"""Project-Ops → Stable webhook contract (pure logic, no service imports).

These are the receiver-side rules for the signed webhooks Project-Ops pushes to
``POST /api/v1/webhooks/project-ops`` (see Project-Ops
``docs/integrations/AGENT-SEATS.md``). Everything here is a pure function with
no DB/LiveKit/network dependency so the verification, replay-window, mapping
and message-shaping rules can be unit-tested in isolation.

Wire contract (sender = Project-Ops ``backend/src/webhooks``):

    POST <endpoint>
    X-ProjectOps-Signature: sha256=<hex HMAC-SHA256 of the raw body under the secret>
    X-ProjectOps-Event:      task.assigned | task.comment.created | task.status_changed
    X-ProjectOps-Delivery:   <delivery id>  (dedupe key)

    body = {"event", "workspaceId", "data", "timestamp"}  (timestamp ISO-8601)

``task.comment.created`` is Project-Ops' name for the "task commented" event.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

SIGNATURE_HEADER = "X-ProjectOps-Signature"
EVENT_HEADER = "X-ProjectOps-Event"
DELIVERY_HEADER = "X-ProjectOps-Delivery"

# The subset of Project-Ops events this receiver turns into room messages.
HANDLED_EVENTS = frozenset(
    {"task.assigned", "task.comment.created", "task.status_changed"}
)

# A timestamp in the future is tolerated up to this many seconds (clock skew
# between Project-Ops and Stable), then rejected like a stale one.
FUTURE_SKEW_SECONDS = 60


def verify_signature(
    secret: str, raw_body: bytes, signature_header: str | None
) -> bool:
    """Constant-time check of the ``sha256=<hex>`` HMAC over the raw body.

    The sender signs the EXACT bytes it POSTs (sign-what-you-send), so the
    receiver must hash ``raw_body`` verbatim — never a re-serialized object.
    """
    if not signature_header:
        return False
    if not secret:
        return False
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={digest}".encode(), signature_header.encode())


def parse_envelope(raw_body: bytes) -> dict[str, Any] | None:
    """Parse the envelope; ``None`` on anything that is not a JSON object."""
    try:
        parsed = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def is_timestamp_fresh(
    timestamp: Any,
    max_age_seconds: int,
    future_skew_seconds: int = FUTURE_SKEW_SECONDS,
) -> bool:
    """Reject stale (replay) and far-future envelopes by their ``timestamp``.

    ``timestamp`` is the envelope's ISO-8601 field. A missing/unparseable/naive
    value is treated as NOT fresh (fail closed).
    """
    if not isinstance(timestamp, str) or not timestamp.strip():
        return False
    try:
        dt = datetime.fromisoformat(timestamp.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    if dt.tzinfo is None:
        return False
    age = (datetime.now(timezone.utc) - dt).total_seconds()
    if age < -future_skew_seconds:
        return False  # from the future beyond tolerated skew
    if age > max_age_seconds:
        return False  # too old → possible replay
    return True


def extract_assignee_id(data: Any) -> str | None:
    """The Project-Ops user id of the task's assignee (the room-mapping key).

    All three handled events carry a top-level ``assignedToId``; fall back to
    ``task.assignedToId`` for older payload shapes.
    """
    if not isinstance(data, dict):
        return None
    top = data.get("assignedToId")
    if isinstance(top, str) and top.strip():
        return top
    task = data.get("task")
    if isinstance(task, dict):
        nested = task.get("assignedToId")
        if isinstance(nested, str) and nested.strip():
            return nested
    return None


def extract_project_id(data: Any) -> str | None:
    """The project id, top-level or from the nested ``task`` object."""
    if not isinstance(data, dict):
        return None
    top = data.get("projectId")
    if isinstance(top, str) and top.strip():
        return top
    task = data.get("task")
    if isinstance(task, dict):
        nested = task.get("projectId")
        if isinstance(nested, str) and nested.strip():
            return nested
    return None


def build_task_link(
    dashboard_url: str,
    workspace_id: str | None,
    task_id: str | None,
    project_id: str | None,
) -> str | None:
    """A deep link into Project-Ops for the task (None when no base is set)."""
    base = (dashboard_url or "").rstrip("/")
    if not base:
        return None
    if project_id:
        return f"{base}/dashboard/projects/{project_id}"
    if task_id:
        return f"{base}/dashboard/projects?task={task_id}"
    return f"{base}/dashboard/projects"


def _snippet(text: Any, limit: int = 140) -> str:
    if not isinstance(text, str):
        return ""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_message(event: str, data: Any) -> str | None:
    """Render a short markdown message for a handled event.

    Returns ``None`` when the payload is too malformed to say anything useful,
    so the caller can drop the event rather than post garbage.
    """
    if not isinstance(data, dict):
        return None
    title = data.get("title")
    if not isinstance(title, str):
        task = data.get("task")
        title = task.get("title") if isinstance(task, dict) else None
    title = title.strip() if isinstance(title, str) and title.strip() else None

    task_id = data.get("taskId")

    if event == "task.assigned":
        if not title and not task_id:
            return None
        return f"**Task assigned** {title or task_id}"

    if event == "task.comment.created":
        if not title and not task_id:
            return None
        commenter = "A comment was posted"
        snippet = _snippet(data.get("content"))
        head = f"**New comment** on {title or task_id}"
        return f"{head}\n{commenter}: {snippet}" if snippet else head

    if event == "task.status_changed":
        if not title and not task_id:
            return None
        frm = data.get("fromStatus")
        to = data.get("toStatus")
        if frm and to:
            return f"**Status changed** {title or task_id}: {frm} → {to}"
        return f"**Status changed** {title or task_id}"

    return None
