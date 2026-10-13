"""Project channels (design §3, L2 item 5): a private channel bound to a
Project-Ops project through ``rooms.project_number``.

Pure helpers (number normalisation, slug/display naming, webhook payload
extraction, task filtering) live here so they are testable without a
network; the two Project-Ops calls go through :func:`call_projectops_tool`,
a thin seam over the existing server-credential MCP client in
``api/messages.py`` that tests monkeypatch. The PAT/JWT is read from settings
inside that client and never appears here, in a log line, or in an error
detail.

Open tasks for a bound project are cached for 60 s per project number
(``GET /rooms/{id}/tasks``), the same TTL the projects picker uses.
"""

from __future__ import annotations

import re
import time
from typing import Any

import structlog
from fastapi import HTTPException, status

logger = structlog.get_logger(__name__)

#: "P-00115", "p-115", "P00115" → "P-00115". Width matches Project-Ops.
_PROJECT_NUMBER_RE = re.compile(r"^\s*P\s*-?\s*0*(\d{1,10})\s*$", re.IGNORECASE)
PROJECT_NUMBER_WIDTH = 5

#: Project-Ops task statuses that are NOT open.
CLOSED_TASK_STATUSES = frozenset({"COMPLETED", "CANCELLED", "DONE", "ARCHIVED"})

#: Tasks cache: project number → (expires_at monotonic, tasks, fetched_at iso).
TASKS_CACHE_TTL_SECONDS = 60.0
_TASKS_CACHE: dict[str, tuple[float, list[dict[str, Any]], str]] = {}

#: Per-project channel slug — must satisfy RoomCreate's ``^[a-z0-9][a-z0-9._-]*$``
#: and the 100-char column.
SLUG_MAX_LEN = 100
SLUG_TITLE_LEN = 48


def normalize_project_number(raw: Any) -> str | None:
    """Canonical ``P-00115`` form, or None when ``raw`` is not a project number."""
    if not isinstance(raw, str):
        return None
    m = _PROJECT_NUMBER_RE.match(raw)
    if m is None:
        return None
    return f"P-{int(m.group(1)):0{PROJECT_NUMBER_WIDTH}d}"


def slugify(text: str, max_len: int = SLUG_TITLE_LEN) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:max_len].strip("-")
    return slug


def project_channel_slug(project_number: str, title: str | None) -> str:
    """``p-00115-<slug of title>`` (design §3)."""
    base = project_number.lower()
    tail = slugify(title or "")
    slug = f"{base}-{tail}" if tail else base
    return slug[:SLUG_MAX_LEN].rstrip("-.")


def project_channel_display_name(project_number: str, title: str | None) -> str:
    """``P-00115 · <title>`` (design §3)."""
    clean = " ".join((title or "").split())
    return f"{project_number} · {clean}" if clean else project_number


def extract_project_number(data: Any) -> str | None:
    """The project number a Project-Ops webhook event is about, top-level or
    nested (``project.projectNumber``, ``task.projectNumber``,
    ``task.project.projectNumber``). Normalised; None when absent."""
    if not isinstance(data, dict):
        return None
    candidates: list[Any] = [data.get("projectNumber")]
    project = data.get("project")
    if isinstance(project, dict):
        candidates.append(project.get("projectNumber"))
    task = data.get("task")
    if isinstance(task, dict):
        candidates.append(task.get("projectNumber"))
        nested = task.get("project")
        if isinstance(nested, dict):
            candidates.append(nested.get("projectNumber"))
    for value in candidates:
        number = normalize_project_number(value)
        if number:
            return number
    return None


def _unwrap(value: Any, keys: tuple[str, ...]) -> Any:
    if isinstance(value, dict):
        for key in keys:
            nested = value.get(key)
            if nested is not None:
                return nested
    return value


def normalize_project(value: Any) -> dict[str, Any] | None:
    """The fields a project channel records from a Project-Ops project."""
    project = _unwrap(value, ("project", "data", "result"))
    if not isinstance(project, dict):
        return None
    number = normalize_project_number(project.get("projectNumber") or project.get("project_number"))
    title = project.get("title") or project.get("name")
    if not number or not isinstance(title, str) or not title.strip():
        return None
    return {
        "id": str(project.get("id")) if project.get("id") else None,
        "projectNumber": number,
        "title": " ".join(title.split()),
        "status": project.get("status"),
        "priority": project.get("priority"),
        "dueDate": project.get("dueDate") or project.get("due_date"),
    }


def is_open_task(task: Any) -> bool:
    if not isinstance(task, dict):
        return False
    status_value = str(task.get("status") or "").strip().upper()
    if status_value in CLOSED_TASK_STATUSES:
        return False
    if task.get("completedAt"):
        return False
    return True


def _assignee_name(task: dict[str, Any]) -> str | None:
    who = task.get("assignedTo") or task.get("assignee")
    if isinstance(who, dict):
        first = (who.get("firstName") or "").strip()
        last = (who.get("lastName") or "").strip()
        full = " ".join(p for p in (first, last) if p)
        return full or who.get("email") or who.get("name")
    if isinstance(who, str) and who.strip():
        return who.strip()
    return None


def normalize_task(task: Any, *, dashboard_url: str, project_id: str | None) -> dict[str, Any] | None:
    if not isinstance(task, dict):
        return None
    task_id = task.get("id") or task.get("taskId")
    title = task.get("title")
    if not task_id or not isinstance(title, str):
        return None
    number = task.get("taskNumber") or task.get("task_number") or task.get("number")
    project_ref = project_id or task.get("projectId")
    url = f"{dashboard_url}/dashboard/projects/{project_ref}" if project_ref else f"{dashboard_url}/dashboard/tasks/{task_id}"
    return {
        "id": str(task_id),
        "task_number": str(number) if number else None,
        "title": title,
        "status": task.get("status"),
        "priority": task.get("priority"),
        "due_date": task.get("dueDate") or task.get("due_date"),
        "assignee": _assignee_name(task),
        "url": url,
    }


def _task_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("tasks", "data", "items", "result"):
            nested = value.get(key)
            if isinstance(nested, list):
                return nested
    return []


async def call_projectops_tool(name: str, arguments: dict[str, Any]) -> Any:
    """Seam over the server-credential MCP client
    (``api/messages._call_projectops_tool``).
    Raises HTTPException(502) when Project-Ops is unreachable/unconfigured."""
    from app.api.messages import _call_projectops_tool

    return await _call_projectops_tool(name, arguments)


async def fetch_project(project_number: str) -> dict[str, Any]:
    """The bound project's title/status/due for naming the channel. 404 when
    Project-Ops does not know the number; 502 when it cannot be asked."""
    try:
        raw = await call_projectops_tool("get_project", {"projectNumber": project_number})
    except HTTPException as exc:
        # Project-Ops answers "not found" through the MCP error channel,
        # which the client surfaces as 502 with its message; map the obvious
        # not-found wording so the caller sees a 404, not a broken proxy.
        detail = str(exc.detail or "")
        if exc.status_code == 502 and "not found" in detail.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project {project_number} not found")
        raise
    project = normalize_project(raw)
    if project is None or project["projectNumber"] != project_number:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project {project_number} not found")
    return project


def _cache_get(project_number: str) -> tuple[list[dict[str, Any]], str] | None:
    hit = _TASKS_CACHE.get(project_number)
    if hit is None or hit[0] <= time.monotonic():
        return None
    return hit[1], hit[2]


def clear_tasks_cache() -> None:
    _TASKS_CACHE.clear()


async def fetch_open_tasks(project_number: str, *, dashboard_url: str) -> dict[str, Any]:
    """Open tasks for ``project_number`` — cached 60 s per project."""
    cached = _cache_get(project_number)
    if cached is not None:
        tasks, fetched_at = cached
        return {"project_number": project_number, "tasks": tasks, "cached": True, "fetched_at": fetched_at}

    raw = await call_projectops_tool("list_project_tasks", {"projectNumber": project_number, "limit": 100})
    project = normalize_project(raw.get("project")) if isinstance(raw, dict) else None
    project_id = project["id"] if project else None
    tasks: list[dict[str, Any]] = []
    for item in _task_list(raw):
        if not is_open_task(item):
            continue
        normalized = normalize_task(item, dashboard_url=dashboard_url, project_id=project_id)
        if normalized is not None:
            tasks.append(normalized)
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _TASKS_CACHE[project_number] = (time.monotonic() + TASKS_CACHE_TTL_SECONDS, tasks, fetched_at)
    return {"project_number": project_number, "tasks": tasks, "cached": False, "fetched_at": fetched_at}


__all__ = [
    "CLOSED_TASK_STATUSES",
    "TASKS_CACHE_TTL_SECONDS",
    "normalize_project_number",
    "slugify",
    "project_channel_slug",
    "project_channel_display_name",
    "extract_project_number",
    "normalize_project",
    "is_open_task",
    "normalize_task",
    "call_projectops_tool",
    "fetch_project",
    "fetch_open_tasks",
    "clear_tasks_cache",
]
