from __future__ import annotations

import asyncio
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Any, Literal

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_livekit, get_settings_dep
from app.models.agent import AgentConfig, AgentEvent
from app.models.artifact import Artifact, ArtifactVersion
from app.models.broadcast_token import BroadcastToken
from app.models.call_egress import ACTIVE_EGRESS_STATUSES, CallEgress
from app.models.message import ContentType, Message
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember, RoomType, TranscriptExport
from app.services.livekit_service import LiveKitService
from app.services.meeting_ops import meeting_ops_configured

logger = structlog.get_logger(__name__)

router = APIRouter()

# Needs-you rows older than this are history. The client folds them.
STALE_AFTER = timedelta(days=14)
NEEDS_YOU_CAP = 40
CREW_CAP = 24
# A cold Project-Ops / Meeting-Ops call must not pin the home poll. Hits are
# cached; a miss returns null (the UI hides that block) rather than waiting.
FEDERATION_TIMEOUT = httpx.Timeout(0.8, connect=0.25)
_CACHE_HIT_S = 45.0
_CACHE_MISS_S = 12.0
_PO_CACHE: dict[str, tuple[float, list[Any] | None]] = {}
_RECAP_CACHE: dict[str, tuple[float, list[Any] | None]] = {}

HOME_SECTION_IDS = ("needs_you", "live_now", "crew", "recent", "today")
URGENCY = {"approval": 0, "mention": 1, "dm": 2, "agent_waiting": 3, "invite": 4}
ACTION_FOR = {
    "approval": "approve",
    "mention": "reply",
    "dm": "reply",
    "agent_waiting": "reply",
    "invite": "join",
}
DONE_TASK_STATUSES = {"COMPLETED", "CANCELLED", "CANCELED", "DONE"}
HEARTBEAT_FRESH = timedelta(seconds=90)
TASK_FRESH = timedelta(minutes=15)
RECAP_WINDOW = timedelta(hours=24)


class LiveCall(BaseModel):
    room_id: str
    display_name: str
    room_type: str
    participant_count: int
    has_agent: bool


class ActorRef(BaseModel):
    participant_id: str
    kind: str
    display_name: str
    avatar_url: str | None = None
    agent_id: str | None = None


class RoomRef(BaseModel):
    id: str
    display_name: str
    room_type: str
    parent_room_id: str | None = None


class LiveCallV3(LiveCall):
    recording: bool = False
    broadcast: bool = False
    floor_holder: ActorRef | None = None


class AgentActivity(BaseModel):
    message_id: str
    room_id: str
    room_name: str
    sender_id: str
    sender_name: str
    preview: str
    created_at: datetime


class RecentArtifact(BaseModel):
    id: str
    room_id: str
    room_name: str
    title: str
    kind: str
    author_kind: str
    updated_at: datetime


class RecentTranscript(BaseModel):
    id: str
    room_id: str
    room_name: str
    status: str
    created_at: datetime


class HomeCounts(BaseModel):
    unread_rooms: int
    mention_rooms: int
    approvals_pending: int
    agents_available: int
    people_online: int
    worker_last_seen_at: datetime | None


class HomeSummary(BaseModel):
    generated_at: datetime
    live_calls: list[LiveCall]
    agent_activity: list[AgentActivity]
    recent_artifacts: list[RecentArtifact]
    recent_transcripts: list[RecentTranscript]
    counts: HomeCounts


class NeedsYouRow(BaseModel):
    kind: Literal["approval", "mention", "dm", "agent_waiting", "invite"]
    actor: ActorRef
    room: RoomRef
    preview: str
    created_at: datetime
    action: Literal["approve", "reply", "open", "join"]
    stale: bool
    message_id: str | None = None


class CrewCard(BaseModel):
    agent_id: str
    participant_id: str
    display_name: str
    avatar_url: str | None = None
    status: str
    agent_mode: str | None = None
    current_task: str | None = None
    last_line: str | None = None
    since: datetime | None = None
    hub_room_id: str | None = None


class PoTaskRow(BaseModel):
    id: str
    title: str
    due_date: str | None = None
    status: str | None = None
    project_number: str | None = None
    url: str | None = None


class TodayMeeting(BaseModel):
    kind: Literal["standing", "recap"]
    id: str
    title: str
    at: datetime | None = None
    room_id: str | None = None
    slug: str | None = None
    summary: str | None = None


class TodayBlock(BaseModel):
    """``po_tasks`` / ``meetings`` are null when that source could not be
    reached. An empty list means the source answered and had nothing due."""

    po_tasks: list[PoTaskRow] | None = None
    meetings: list[TodayMeeting] | None = None


class HomeSummaryV3(HomeSummary):
    needs_you: list[NeedsYouRow]
    crew: list[CrewCard]
    today: TodayBlock | None
    live_calls: list[LiveCallV3]


class HomeSectionPrefs(BaseModel):
    order: list[str]
    collapsed: dict[str, bool]


class HomeSectionPrefsBody(BaseModel):
    order: list[str] | None = None
    collapsed: dict[str, bool] | None = None


def mention_rooms_statement(participant_id: uuid.UUID):
    """Rooms where this member's durable mention flag is set.

    The old count scanned message text with ``ILIKE '%@username%'``, which
    disagreed with the sidebar (that reads ``room_members.has_unread_mention``).
    """
    return (
        select(func.count())
        .select_from(RoomMember)
        .join(Room, Room.id == RoomMember.room_id)
        .where(
            RoomMember.participant_id == participant_id,
            RoomMember.has_unread_mention.is_(True),
            Room.is_archived.is_(False),
        )
    )


def clip(text: str | None, limit: int = 140) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def is_stale(created_at: datetime, now: datetime) -> bool:
    return aware(now) - aware(created_at) > STALE_AFTER


def classify_attention(
    *,
    room_type: str,
    created_by: str | None,
    caller_id: str,
    last_read_is_none: bool,
    role: str,
    unread: bool,
    mention: bool,
    brigade_agent_id: str | None,
) -> str | None:
    """One room → one needs-you kind. Approvals are separate rows."""
    if mention:
        return "mention"
    agent_room = room_type == RoomType.AGENT_HUB.value or bool(brigade_agent_id)
    if unread and agent_room and room_type in {RoomType.DM.value, RoomType.AGENT_HUB.value, RoomType.GROUP_DM.value}:
        return "agent_waiting"
    if unread and room_type in {RoomType.DM.value, RoomType.GROUP_DM.value} and not agent_room:
        return "dm"
    if (
        not unread
        and last_read_is_none
        and role not in {MemberRole.OWNER.value, "owner"}
        and created_by
        and created_by != caller_id
        and room_type == RoomType.CHANNEL.value
    ):
        return "invite"
    return None


def pick_actor(
    members: list[dict[str, Any]],
    *,
    caller_id: str,
    kind: str,
    sender: dict[str, Any] | None,
    creator_id: str | None,
) -> dict[str, Any]:
    def as_actor(member: dict[str, Any]) -> dict[str, Any]:
        ptype = member.get("participant_type") or "human"
        if ptype == "agent":
            actor_kind = "agent"
        elif ptype == "guest":
            actor_kind = "guest"
        else:
            actor_kind = "human"
        name = (member.get("display_name") or "").strip() or "Someone"
        return {
            "participant_id": str(member.get("participant_id") or "unknown"),
            "kind": actor_kind,
            "display_name": name,
            "avatar_url": member.get("avatar_url"),
            "agent_id": member.get("agent_id"),
        }

    others = [m for m in members if str(m.get("participant_id")) != caller_id]
    if kind in {"mention", "approval"} and sender:
        return as_actor(sender)
    if kind == "agent_waiting":
        agent = next((m for m in others if m.get("participant_type") == "agent"), None)
        if agent:
            return as_actor(agent)
    if kind == "invite" and creator_id:
        creator = next((m for m in members if str(m.get("participant_id")) == creator_id), None)
        if creator:
            return as_actor(creator)
    human = next((m for m in others if m.get("participant_type") != "agent"), None)
    if human:
        return as_actor(human)
    if others:
        return as_actor(others[0])
    return {
        "participant_id": "unknown",
        "kind": "human",
        "display_name": "Someone",
        "avatar_url": None,
        "agent_id": None,
    }


def finalize_needs_you(items: list[dict[str, Any]], now: datetime) -> list[NeedsYouRow]:
    rows: list[NeedsYouRow] = []
    for item in items:
        created = aware(item["created_at"])
        kind = item["kind"]
        rows.append(
            NeedsYouRow(
                kind=kind,
                actor=ActorRef(**item["actor"]),
                room=RoomRef(**item["room"]),
                preview=clip(item.get("preview") or ""),
                created_at=created,
                action=ACTION_FOR[kind],
                stale=is_stale(created, now),
                message_id=item.get("message_id"),
            )
        )
    rows.sort(key=lambda row: (URGENCY[row.kind], -row.created_at.timestamp()))
    return rows[:NEEDS_YOU_CAP]


def floor_holder(participants: list[Any]) -> ActorRef | None:
    """The LiveKit participant the SFU reports as speaking. Nobody speaking → null."""
    speaking = [p for p in participants if getattr(p, "is_speaking", False)]
    if not speaking:
        return None
    person = speaking[0]
    identity = str(getattr(person, "identity", "") or "")
    name = str(getattr(person, "name", "") or "").strip() or identity or "Someone"
    is_agent = identity.startswith("agent-")
    return ActorRef(
        participant_id=identity or "unknown",
        kind="agent" if is_agent else "human",
        display_name=name,
        avatar_url=None,
        agent_id=identity.removeprefix("agent-") if is_agent else None,
    )


def agent_id_from_sub(sub: str | None) -> str | None:
    if not sub:
        return None
    if sub.startswith("brigade:"):
        return sub[len("brigade:") :]
    if sub.startswith("agent-"):
        return sub[len("agent-") :]
    return None


def current_task_from_event(event_type: str, data: dict[str, Any] | None) -> str | None:
    payload = data if isinstance(data, dict) else {}
    for key in ("current_task", "task", "title"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return clip(value.strip(), 140)
    if event_type == "tool_call":
        tool = payload.get("tool")
        if isinstance(tool, str) and tool.strip():
            return clip(tool.strip(), 140)
    return None


def parse_due_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if "T" in text:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def assignee_email(task: dict[str, Any]) -> str | None:
    for key in ("assignedTo", "assignee", "assigned_to"):
        value = task.get(key)
        if isinstance(value, dict):
            email = value.get("email")
            if isinstance(email, str) and email.strip():
                return email.strip().lower()
    for key in ("assigneeEmail", "assigned_to_email"):
        email = task.get(key)
        if isinstance(email, str) and email.strip():
            return email.strip().lower()
    return None


def task_url(task: dict[str, Any], dashboard_url: str) -> str | None:
    existing = task.get("url") or task.get("task_url")
    if isinstance(existing, str) and existing.startswith("https://"):
        return existing
    project = task.get("project") if isinstance(task.get("project"), dict) else {}
    project_id = task.get("projectId") or task.get("project_id") or project.get("id")
    base = (dashboard_url or "").strip().rstrip("/")
    if project_id and base.startswith("https://"):
        return f"{base}/dashboard/projects/{project_id}"
    return None


def select_due_tasks(
    tasks: list[dict[str, Any]],
    *,
    today: date,
    trusted_caller: bool,
    caller_email: str | None,
    dashboard_url: str,
) -> list[PoTaskRow] | None:
    """Tasks assigned to the caller and due on or before tomorrow.

    ``trusted_caller`` is the caller's own Project-Ops token (``list_my_tasks``
    is already their queue). The service JWT's queue is kept only when each
    row names the caller's email. If those rows do not say who they belong to,
    the block is null — an empty list would claim the caller has nothing due.
    """
    horizon = today + timedelta(days=1)
    if not trusted_caller:
        wanted = (caller_email or "").strip().lower()
        if not wanted:
            return None
        attributed: list[dict[str, Any]] = []
        saw_assignee = False
        for task in tasks:
            email = assignee_email(task)
            if email:
                saw_assignee = True
            if email == wanted:
                attributed.append(task)
        if not saw_assignee:
            return None
        tasks = attributed
    rows: list[PoTaskRow] = []
    for task in tasks:
        status = str(task.get("status") or "").upper()
        if status in DONE_TASK_STATUSES:
            continue
        due = parse_due_date(task.get("dueDate") if task.get("dueDate") is not None else task.get("due_date"))
        if due is None or due > horizon:
            continue
        task_id = task.get("id") or task.get("taskId") or task.get("task_id")
        if not task_id:
            continue
        title = task.get("title") or task.get("name") or "Untitled task"
        project = task.get("project") if isinstance(task.get("project"), dict) else {}
        project_number = (
            task.get("projectNumber") or task.get("project_number") or project.get("projectNumber")
        )
        rows.append(
            PoTaskRow(
                id=str(task_id),
                title=str(title)[:200],
                due_date=due.isoformat(),
                status=status or None,
                project_number=str(project_number) if project_number else None,
                url=task_url(task, dashboard_url),
            )
        )
    rows.sort(key=lambda row: (row.due_date or "", row.title))
    return rows


def as_dict_list(value: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in keys:
            nested = value.get(key)
            found = as_dict_list(nested, keys)
            if found or isinstance(nested, list):
                return found
    return []


def parse_instant(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return aware(value)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        return aware(datetime.fromisoformat(text))
    except ValueError:
        return None


def recaps_from_payload(payload: Any, now: datetime) -> list[TodayMeeting]:
    items = as_dict_list(payload, ("sessions", "meetings", "items", "data", "results", "recaps"))
    cutoff = aware(now) - RECAP_WINDOW
    rows: list[TodayMeeting] = []
    for item in items:
        at = parse_instant(
            item.get("ended_at") or item.get("updated_at") or item.get("created_at") or item.get("started_at")
        )
        if at is None or at < cutoff:
            continue
        recap_id = item.get("id") or item.get("session_id") or item.get("sessionId")
        if not recap_id:
            continue
        title = item.get("title") or item.get("name") or "Meeting"
        summary = item.get("summary") or item.get("recap")
        if isinstance(summary, dict):
            summary = summary.get("summary") or summary.get("text")
        if not isinstance(summary, str):
            summary = None
        rows.append(
            TodayMeeting(
                kind="recap",
                id=str(recap_id),
                title=str(title)[:200],
                at=at,
                room_id=None,
                slug=None,
                summary=clip(summary, 180) or None,
            )
        )
    rows.sort(key=lambda row: row.at.timestamp() if row.at else 0, reverse=True)
    return rows[:12]


def standing_meetings(catalog: list[tuple[str, str, str]], rooms_by_name: dict[str, Any]) -> list[TodayMeeting]:
    rows: list[TodayMeeting] = []
    for slug, title, _description in catalog:
        room = rooms_by_name.get(slug)
        rows.append(
            TodayMeeting(
                kind="standing",
                id=slug,
                title=title,
                at=None,
                room_id=str(room.id) if room is not None else None,
                slug=slug,
                summary=None,
            )
        )
    return rows


def assemble_meetings(
    standing: list[TodayMeeting], recaps: list[TodayMeeting] | None
) -> list[TodayMeeting] | None:
    """Null when Meeting-Ops could not be read. Standing rooms ride along only
    on a real answer so a failure is not disguised as 'no recaps'."""
    if recaps is None:
        return None
    return [*standing, *recaps]


def build_today(
    po_tasks: list[PoTaskRow] | None, meetings: list[TodayMeeting] | None
) -> TodayBlock | None:
    if po_tasks is None and meetings is None:
        return None
    return TodayBlock(po_tasks=po_tasks, meetings=meetings)


def normalize_section_prefs(raw: object) -> dict[str, Any]:
    order_in: list[Any] = []
    collapsed_in: dict[Any, Any] = {}
    if isinstance(raw, dict):
        if isinstance(raw.get("order"), list):
            order_in = raw["order"]
        if isinstance(raw.get("collapsed"), dict):
            collapsed_in = raw["collapsed"]
    order: list[str] = []
    for item in order_in:
        if item in HOME_SECTION_IDS and item not in order:
            order.append(item)
    for item in HOME_SECTION_IDS:
        if item not in order:
            order.append(item)
    collapsed = {item: collapsed_in.get(item) is True for item in HOME_SECTION_IDS}
    return {"order": order, "collapsed": collapsed}


def _cache_get(bucket: dict[str, tuple[float, Any]], key: str) -> tuple[Any, bool]:
    hit = bucket.get(key)
    if hit is None or hit[0] < time.monotonic():
        return None, False
    return hit[1], True


def _cache_put(bucket: dict[str, tuple[float, Any]], key: str, value: Any) -> None:
    ttl = _CACHE_HIT_S if value is not None else _CACHE_MISS_S
    bucket[key] = (time.monotonic() + ttl, value)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        return token or None
    return None


def _extract_mcp(payload: dict[str, Any]) -> Any:
    if "error" in payload:
        raise RuntimeError("mcp error")
    result = payload.get("result")
    if isinstance(result, dict):
        for key in ("structuredContent", "structured_content"):
            if key in result:
                return result[key]
        content = result.get("content")
        if isinstance(content, list):
            texts = [
                item.get("text")
                for item in content
                if isinstance(item, dict) and isinstance(item.get("text"), str)
            ]
            if texts:
                import json

                try:
                    return json.loads("\n".join(texts))
                except json.JSONDecodeError:
                    return {"text": "\n".join(texts)}
        return result
    return payload


def _mcp_payload(text: str) -> dict[str, Any]:
    import json

    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data and data != "[DONE]":
                parsed = json.loads(data)
                if isinstance(parsed, dict):
                    return parsed
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise RuntimeError("mcp payload")
    return parsed


async def _mcp_call(url: str, token: str, name: str, arguments: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=FEDERATION_TIMEOUT) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )
    if response.status_code >= 400:
        raise RuntimeError(f"http {response.status_code}")
    return _extract_mcp(_mcp_payload(response.text))


async def fetch_caller_tasks(
    *,
    mcp_url: str,
    caller_bearer: str | None,
    service_jwt: str,
    caller_email: str | None,
    today: date,
    dashboard_url: str,
    cache_key: str,
) -> list[PoTaskRow] | None:
    cached, ok = _cache_get(_PO_CACHE, cache_key)
    if ok:
        return cached
    result: list[PoTaskRow] | None = None
    if caller_bearer:
        try:
            raw = await _mcp_call(mcp_url, caller_bearer, "list_my_tasks", {"limit": 100})
            result = select_due_tasks(
                as_dict_list(raw, ("tasks", "items", "data", "result")),
                today=today,
                trusted_caller=True,
                caller_email=caller_email,
                dashboard_url=dashboard_url,
            )
            _cache_put(_PO_CACHE, cache_key, result)
            return result
        except Exception:
            logger.info("home_project_ops_caller_unreachable", error="caller_token")
    if not (service_jwt or "").strip():
        _cache_put(_PO_CACHE, cache_key, None)
        return None
    try:
        raw = await _mcp_call(mcp_url, service_jwt, "list_my_tasks", {"limit": 100})
    except Exception:
        logger.info("home_project_ops_unreachable")
        _cache_put(_PO_CACHE, cache_key, None)
        return None
    result = select_due_tasks(
        as_dict_list(raw, ("tasks", "items", "data", "result")),
        today=today,
        trusted_caller=False,
        caller_email=caller_email,
        dashboard_url=dashboard_url,
    )
    _cache_put(_PO_CACHE, cache_key, result)
    return result


async def fetch_recaps(settings: Settings, now: datetime) -> list[TodayMeeting] | None:
    """Read Meeting-Ops through the same URL / PAT / org the transcript adapter uses."""
    cache_key = (settings.meeting_ops_org_slug or "").strip() or "default"
    cached, ok = _cache_get(_RECAP_CACHE, cache_key)
    if ok:
        return cached
    if not meeting_ops_configured(settings):
        _cache_put(_RECAP_CACHE, cache_key, None)
        return None
    base = (settings.meeting_ops_url or "").strip().rstrip("/")
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {(settings.meeting_ops_api_key or '').strip()}",
        "X-MeetingOps-Org": (settings.meeting_ops_org_slug or "").strip(),
        "User-Agent": "unicorn-stable-home/1.0",
    }
    try:
        async with httpx.AsyncClient(timeout=FEDERATION_TIMEOUT) as client:
            response = await client.get(f"{base}/api/v1/sessions", params={"limit": 30}, headers=headers)
        if response.status_code >= 400:
            raise RuntimeError(f"http {response.status_code}")
        payload = response.json()
    except Exception:
        logger.info("home_meeting_ops_unreachable")
        _cache_put(_RECAP_CACHE, cache_key, None)
        return None
    rows = recaps_from_payload(payload, now)
    _cache_put(_RECAP_CACHE, cache_key, rows)
    return rows


def _room_ref(room: Room) -> dict[str, Any]:
    return {
        "id": str(room.id),
        "display_name": room.display_name or room.name,
        "room_type": room.room_type.value,
        "parent_room_id": str(room.parent_room_id) if room.parent_room_id else None,
    }


def _member_dict(participant: Participant) -> dict[str, Any]:
    return {
        "participant_id": str(participant.id),
        "participant_type": participant.participant_type.value,
        "display_name": participant.display_name or participant.username,
        "avatar_url": participant.avatar_url,
        "agent_id": agent_id_from_sub(participant.keycloak_sub),
    }


async def _needs_you(
    db: AsyncSession, participant_id: uuid.UUID, now: datetime
) -> list[NeedsYouRow]:
    memberships = (
        await db.execute(
            select(RoomMember, Room)
            .join(Room, Room.id == RoomMember.room_id)
            .where(
                RoomMember.participant_id == participant_id,
                Room.is_archived.is_(False),
            )
        )
    ).all()
    if not memberships:
        room_by_id: dict[uuid.UUID, Room] = {}
    else:
        room_by_id = {room.id: room for _member, room in memberships}

    unread_rows = (
        await db.execute(
            select(Message.room_id)
            .join(
                RoomMember,
                and_(
                    RoomMember.room_id == Message.room_id,
                    RoomMember.participant_id == participant_id,
                ),
            )
            .where(
                Message.is_deleted.is_(False),
                Message.sender_id != participant_id,
                or_(
                    RoomMember.last_read_at.is_(None),
                    Message.created_at > RoomMember.last_read_at,
                ),
            )
            .group_by(Message.room_id)
        )
    ).all()
    unread_ids = {row[0] for row in unread_rows}
    caller_id = str(participant_id)

    classified: list[tuple[str, Room, RoomMember]] = []
    for membership, room in memberships:
        meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
        brigade = meta.get("brigade_agent_id")
        brigade_id = brigade if isinstance(brigade, str) and brigade else None
        if room.room_type == RoomType.AGENT_HUB and not brigade_id:
            brigade_id = room.name
        role = membership.role.value if hasattr(membership.role, "value") else str(membership.role)
        kind = classify_attention(
            room_type=room.room_type.value,
            created_by=str(room.created_by) if room.created_by else None,
            caller_id=caller_id,
            last_read_is_none=membership.last_read_at is None,
            role=role,
            unread=room.id in unread_ids,
            mention=bool(membership.has_unread_mention),
            brigade_agent_id=brigade_id,
        )
        if kind:
            classified.append((kind, room, membership))

    approval_rows = (
        await db.execute(
            select(Message, Room, Participant)
            .join(Room, Room.id == Message.room_id)
            .join(
                RoomMember,
                and_(
                    RoomMember.room_id == Message.room_id,
                    RoomMember.participant_id == participant_id,
                    RoomMember.role.in_([MemberRole.OWNER, MemberRole.ADMIN]),
                ),
            )
            .join(Participant, Participant.id == Message.sender_id)
            .join(AgentConfig, AgentConfig.participant_id == Participant.id)
            .where(
                Message.content_type == ContentType.AGENT_ACTION,
                Message.is_deleted.is_(False),
                Participant.participant_type == ParticipantType.AGENT,
                or_(
                    Message.metadata_.is_(None),
                    Message.metadata_["decision"].as_string().is_(None),
                ),
            )
            .order_by(Message.created_at.desc())
            .limit(20)
        )
    ).all()

    room_ids = [room.id for _kind, room, _m in classified]
    room_ids.extend(room.id for _msg, room, _sender in approval_rows)
    members_by_room: dict[Any, list[dict[str, Any]]] = {}
    latest_by_room: dict[Any, tuple[Message, Participant | None]] = {}
    if room_ids:
        member_rows = (
            await db.execute(
                select(RoomMember, Participant)
                .join(Participant, Participant.id == RoomMember.participant_id)
                .where(RoomMember.room_id.in_(room_ids))
            )
        ).all()
        for membership, participant in member_rows:
            members_by_room.setdefault(membership.room_id, []).append(_member_dict(participant))
        latest_rows = (
            await db.execute(
                select(Message, Participant)
                .join(Participant, Participant.id == Message.sender_id, isouter=True)
                .where(
                    Message.room_id.in_(room_ids),
                    Message.is_deleted.is_(False),
                    Message.sender_id != participant_id,
                )
                .distinct(Message.room_id)
                .order_by(Message.room_id, Message.created_at.desc())
            )
        ).all()
        for message, sender in latest_rows:
            latest_by_room[message.room_id] = (message, sender)

    items: list[dict[str, Any]] = []
    for message, room, sender in approval_rows:
        sender_dict = _member_dict(sender)
        items.append(
            {
                "kind": "approval",
                "actor": pick_actor(
                    members_by_room.get(room.id, []),
                    caller_id=caller_id,
                    kind="approval",
                    sender=sender_dict,
                    creator_id=str(room.created_by) if room.created_by else None,
                ),
                "room": _room_ref(room),
                "preview": message.content,
                "created_at": message.created_at,
                "message_id": str(message.id),
            }
        )
    for kind, room, _membership in classified:
        latest = latest_by_room.get(room.id)
        sender_dict = _member_dict(latest[1]) if latest and latest[1] is not None else None
        created = latest[0].created_at if latest else (_membership.joined_at or now)
        preview = latest[0].content if latest else (
            "You were added and haven't opened this yet." if kind == "invite" else ""
        )
        items.append(
            {
                "kind": kind,
                "actor": pick_actor(
                    members_by_room.get(room.id, []),
                    caller_id=caller_id,
                    kind=kind,
                    sender=sender_dict,
                    creator_id=str(room.created_by) if room.created_by else None,
                ),
                "room": _room_ref(room),
                "preview": preview,
                "created_at": created,
                "message_id": str(latest[0].id) if latest else None,
            }
        )
    return finalize_needs_you(items, now)


def _event_matches(identity: str, agent_id: str, username: str, sub: str) -> bool:
    ident = (identity or "").strip().lower()
    keys = {
        agent_id.lower(),
        username.lower(),
        sub.lower(),
        f"brigade:{agent_id}".lower(),
        f"agent-{agent_id}".lower(),
    }
    keys.discard("")
    return ident in keys


async def _crew(
    db: AsyncSession, participant_id: uuid.UUID, now: datetime
) -> list[CrewCard]:
    def caller_rooms():
        return select(RoomMember.room_id).where(RoomMember.participant_id == participant_id)

    rows = (
        await db.execute(
            select(Participant, RoomMember, Room)
            .join(RoomMember, RoomMember.participant_id == Participant.id)
            .join(Room, Room.id == RoomMember.room_id)
            .where(
                Participant.participant_type == ParticipantType.AGENT,
                Room.is_archived.is_(False),
                Room.id.in_(caller_rooms()),
            )
        )
    ).all()
    grouped: dict[str, dict[str, Any]] = {}
    for participant, membership, room in rows:
        key = str(participant.id)
        slot = grouped.get(key)
        if slot is None:
            meta_agent = agent_id_from_sub(participant.keycloak_sub) or participant.username
            slot = {
                "participant": participant,
                "agent_id": meta_agent,
                "agent_mode": membership.agent_mode,
                "hub_room_id": None,
                "score": 0,
            }
            grouped[key] = slot
        mode = membership.agent_mode
        is_hub = room.room_type == RoomType.AGENT_HUB
        score = (2 if is_hub else 0) + (1 if mode else 0)
        if score >= slot["score"]:
            slot["score"] = score
            slot["agent_mode"] = mode if mode else slot["agent_mode"]
            if is_hub:
                slot["hub_room_id"] = str(room.id)
            room_meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
            brigade = room_meta.get("brigade_agent_id")
            if isinstance(brigade, str) and brigade:
                slot["agent_id"] = brigade

    if not grouped:
        return []

    agent_pids = [uuid.UUID(key) for key in grouped]
    line_rows = (
        await db.execute(
            select(Message)
            .where(
                Message.sender_id.in_(agent_pids),
                Message.is_deleted.is_(False),
                Message.room_id.in_(caller_rooms()),
            )
            .distinct(Message.sender_id)
            .order_by(Message.sender_id, Message.created_at.desc())
        )
    ).scalars().all()
    last_line = {str(message.sender_id): clip(message.content, 140) for message in line_rows}

    identities = []
    for slot in grouped.values():
        participant = slot["participant"]
        identities.extend(
            [
                slot["agent_id"],
                participant.username,
                participant.keycloak_sub,
                f"agent-{slot['agent_id']}",
            ]
        )
    identities = [item for item in identities if item]
    events: list[AgentEvent] = []
    if identities:
        events = (
            await db.execute(
                select(AgentEvent)
                .where(
                    AgentEvent.agent_identity.in_(identities),
                    AgentEvent.received_at > now - timedelta(hours=6),
                )
                .order_by(AgentEvent.received_at.desc())
                .limit(300)
            )
        ).scalars().all()

    cards: list[CrewCard] = []
    for key, slot in grouped.items():
        participant = slot["participant"]
        task: str | None = None
        since: datetime | None = None
        fresh_heartbeat = False
        for event in events:
            if not _event_matches(
                event.agent_identity, slot["agent_id"], participant.username, participant.keycloak_sub
            ):
                continue
            occurred = aware(event.occurred_at)
            found = current_task_from_event(event.event_type, event.event_data)
            if found and aware(now) - occurred <= TASK_FRESH and task is None:
                task = found
                since = occurred
            if (
                event.event_type == "worker_heartbeat"
                and aware(now) - occurred <= HEARTBEAT_FRESH
                and not fresh_heartbeat
            ):
                fresh_heartbeat = True
                if since is None:
                    since = occurred
        status = participant.status.value if hasattr(participant.status, "value") else str(participant.status)
        if fresh_heartbeat and status == ParticipantStatus.OFFLINE.value:
            status = ParticipantStatus.ONLINE.value
        cards.append(
            CrewCard(
                agent_id=slot["agent_id"],
                participant_id=key,
                display_name=participant.display_name or participant.username,
                avatar_url=participant.avatar_url,
                status=status,
                agent_mode=slot["agent_mode"],
                current_task=task,
                last_line=last_line.get(key),
                since=since,
                hub_room_id=slot["hub_room_id"],
            )
        )

    def crew_sort(card: CrewCard) -> tuple[int, float, str]:
        hot = 0 if card.current_task or card.since else 1
        stamp = -card.since.timestamp() if card.since else 0
        return (hot, stamp, card.display_name.lower())

    cards.sort(key=crew_sort)
    return cards[:CREW_CAP]


async def _standing_index(db: AsyncSession) -> list[TodayMeeting]:
    from app.api.rooms import CONFERENCE_ROOMS

    names = [slug for slug, _title, _desc in CONFERENCE_ROOMS]
    rooms = (
        await db.execute(select(Room).where(Room.name.in_(names), Room.is_archived.is_(False)))
    ).scalars().all()
    return standing_meetings(list(CONFERENCE_ROOMS), {room.name: room for room in rooms})


async def _enrich_live(
    db: AsyncSession, built: list[tuple[LiveCall, list[Any]]]
) -> list[LiveCallV3]:
    room_ids = [uuid.UUID(call.room_id) for call, _parts in built]
    recording: set[str] = set()
    broadcasting: set[str] = set()
    if room_ids:
        now = datetime.now(timezone.utc)
        rec_rows = (
            await db.execute(
                select(CallEgress.room_id).where(
                    CallEgress.room_id.in_(room_ids),
                    CallEgress.status.in_(ACTIVE_EGRESS_STATUSES),
                )
            )
        ).scalars().all()
        recording = {str(room_id) for room_id in rec_rows if room_id}
        cast_rows = (
            await db.execute(
                select(BroadcastToken.room_id).where(
                    BroadcastToken.room_id.in_(room_ids),
                    BroadcastToken.revoked_at.is_(None),
                    BroadcastToken.expires_at > now,
                )
            )
        ).scalars().all()
        broadcasting = {str(room_id) for room_id in cast_rows if room_id}
    return [
        LiveCallV3(
            room_id=call.room_id,
            display_name=call.display_name,
            room_type=call.room_type,
            participant_count=call.participant_count,
            has_agent=call.has_agent,
            recording=call.room_id in recording,
            broadcast=call.room_id in broadcasting,
            floor_holder=floor_holder(participants),
        )
        for call, participants in built
    ]


@router.get("/home/summary", response_model=None)
async def get_home_summary(
    request: Request,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    v: Annotated[int, Query(ge=1, le=3)] = 1,
) -> Any:
    """Home summary. ``v=3`` adds needs_you, crew, and today.

    Federated blocks are null when Project-Ops or Meeting-Ops cannot be read.
    """
    participant_id = uuid.UUID(str(user["participant_id"]))
    now = datetime.now(timezone.utc)
    po_fut: asyncio.Task[list[PoTaskRow] | None] | None = None
    recap_fut: asyncio.Task[list[TodayMeeting] | None] | None = None
    if v >= 3:
        email = user.get("email") if isinstance(user.get("email"), str) else None
        po_fut = asyncio.create_task(
            fetch_caller_tasks(
                mcp_url=settings.projectops_mcp_url,
                caller_bearer=_bearer(request),
                service_jwt=settings.projectops_service_jwt,
                caller_email=email,
                today=now.date(),
                dashboard_url=settings.projectops_dashboard_url,
                cache_key=str(participant_id),
            )
        )
        recap_fut = asyncio.create_task(fetch_recaps(settings, now))

    try:
        summary, occupancy = await _base_summary(participant_id, db, livekit, now)
        if v < 3:
            return summary.model_dump(mode="json")
        needs = await _needs_you(db, participant_id, now)
        crew = await _crew(db, participant_id, now)
        live_calls = await _enrich_live(db, occupancy)
        standing = await _standing_index(db)
    except Exception:
        pending = [fut for fut in (po_fut, recap_fut) if fut is not None]
        for fut in pending:
            fut.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        raise

    po_tasks = await po_fut if po_fut is not None else None
    recaps = await recap_fut if recap_fut is not None else None
    today = build_today(po_tasks, assemble_meetings(standing, recaps))
    return HomeSummaryV3(
        generated_at=summary.generated_at,
        live_calls=live_calls,
        agent_activity=summary.agent_activity,
        recent_artifacts=summary.recent_artifacts,
        recent_transcripts=summary.recent_transcripts,
        counts=summary.counts,
        needs_you=needs,
        crew=crew,
        today=today,
    ).model_dump(mode="json")


async def _base_summary(
    participant_id: uuid.UUID,
    db: AsyncSession,
    livekit: LiveKitService,
    now: datetime,
) -> tuple[HomeSummary, list[tuple[LiveCall, list[Any]]]]:
    member_rooms = select(RoomMember.room_id).where(RoomMember.participant_id == participant_id)
    room_rows = (
        await db.execute(select(Room).where(Room.id.in_(member_rooms), Room.is_archived.is_(False)))
    ).scalars().all()
    room_by_lk = {r.livekit_room_name: r for r in room_rows}
    occupancy: list[tuple[LiveCall, list[Any]]] = []
    for lk_room in await livekit.list_rooms(names=list(room_by_lk)):
        count = int(getattr(lk_room, "num_participants", 0) or 0)
        if count < 1:
            continue
        room = room_by_lk.get(lk_room.name)
        if room is None:
            continue
        probed = await livekit.get_room(lk_room.name)
        participants = probed["participants"]
        call = LiveCall(
            room_id=str(room.id),
            display_name=room.display_name,
            room_type=room.room_type.value,
            participant_count=count,
            has_agent=any(str(getattr(p, "identity", "")).startswith("agent-") for p in participants),
        )
        occupancy.append((call, list(participants)))

    activity_rows = (
        await db.execute(
            select(Message, Room.display_name, Participant.display_name)
            .join(Room, Room.id == Message.room_id)
            .join(
                RoomMember,
                and_(RoomMember.room_id == Message.room_id, RoomMember.participant_id == participant_id),
            )
            .join(Participant, Participant.id == Message.sender_id)
            .where(Participant.participant_type == ParticipantType.AGENT, Message.is_deleted.is_(False))
            .order_by(Message.created_at.desc())
            .limit(20)
        )
    ).all()
    agent_activity = [
        AgentActivity(
            message_id=str(m.id),
            room_id=str(m.room_id),
            room_name=room_name,
            sender_id=str(m.sender_id),
            sender_name=sender_name,
            preview=(m.content[:140] + ("…" if len(m.content) > 140 else "")),
            created_at=m.created_at,
        )
        for m, room_name, sender_name in activity_rows
    ]

    artifact_rows = (
        await db.execute(
            select(Artifact, Room.display_name, ArtifactVersion.author_kind)
            .join(Room, Room.id == Artifact.room_id)
            .join(
                RoomMember,
                and_(RoomMember.room_id == Artifact.room_id, RoomMember.participant_id == participant_id),
            )
            .outerjoin(ArtifactVersion, ArtifactVersion.id == Artifact.current_version_id)
            .order_by(Artifact.updated_at.desc())
            .limit(10)
        )
    ).all()
    artifacts = [
        RecentArtifact(
            id=str(a.id),
            room_id=str(a.room_id),
            room_name=room_name,
            title=a.title,
            kind=a.kind.value,
            author_kind=(author_kind.value if author_kind else "human"),
            updated_at=a.updated_at,
        )
        for a, room_name, author_kind in artifact_rows
    ]

    transcript_rows = (
        await db.execute(
            select(TranscriptExport, Room.display_name)
            .join(Room, Room.id == TranscriptExport.room_id)
            .join(
                RoomMember,
                and_(
                    RoomMember.room_id == TranscriptExport.room_id,
                    RoomMember.participant_id == participant_id,
                ),
            )
            .order_by(TranscriptExport.created_at.desc())
            .limit(5)
        )
    ).all()
    transcripts = [
        RecentTranscript(
            id=str(t.id),
            room_id=str(t.room_id),
            room_name=room_name,
            status=t.status,
            created_at=t.created_at,
        )
        for t, room_name in transcript_rows
    ]

    unread = (
        await db.execute(
            select(func.count(func.distinct(Message.room_id)))
            .join(
                RoomMember,
                and_(RoomMember.room_id == Message.room_id, RoomMember.participant_id == participant_id),
            )
            .where(
                Message.is_deleted.is_(False),
                Message.sender_id != participant_id,
                or_(RoomMember.last_read_at.is_(None), Message.created_at > RoomMember.last_read_at),
            )
        )
    ).scalar_one()
    mention = (await db.execute(mention_rooms_statement(participant_id))).scalar_one()
    approvals = (
        await db.execute(
            select(func.count(Message.id))
            .join(
                RoomMember,
                and_(
                    RoomMember.room_id == Message.room_id,
                    RoomMember.participant_id == participant_id,
                    RoomMember.role.in_([MemberRole.OWNER, MemberRole.ADMIN]),
                ),
            )
            .where(
                Message.content_type == ContentType.AGENT_ACTION,
                Message.is_deleted.is_(False),
                or_(Message.metadata_.is_(None), Message.metadata_["decision"].as_string().is_(None)),
            )
        )
    ).scalar_one()
    agents_available = (
        await db.execute(
            select(func.count(Participant.id)).where(
                Participant.participant_type == ParticipantType.AGENT,
                Participant.status != ParticipantStatus.OFFLINE,
            )
        )
    ).scalar_one()
    people_online = (
        await db.execute(
            select(func.count(Participant.id)).where(
                Participant.participant_type == ParticipantType.HUMAN,
                Participant.status == ParticipantStatus.ONLINE,
            )
        )
    ).scalar_one()
    worker_last_seen = (
        await db.execute(
            select(func.max(AgentEvent.received_at)).where(AgentEvent.event_type == "worker_heartbeat")
        )
    ).scalar_one_or_none()

    summary = HomeSummary(
        generated_at=now,
        live_calls=[call for call, _parts in occupancy],
        agent_activity=agent_activity,
        recent_artifacts=artifacts,
        recent_transcripts=transcripts,
        counts=HomeCounts(
            unread_rooms=unread,
            mention_rooms=mention,
            approvals_pending=approvals,
            agents_available=agents_available,
            people_online=people_online,
            worker_last_seen_at=worker_last_seen,
        ),
    )
    return summary, occupancy


def _read_section_prefs(participant: Participant | None) -> HomeSectionPrefs:
    meta = participant.metadata_ if participant is not None and isinstance(participant.metadata_, dict) else {}
    normalized = normalize_section_prefs(meta.get("home_sections"))
    return HomeSectionPrefs(**normalized)


@router.get("/home/section-prefs", response_model=HomeSectionPrefs)
async def get_section_prefs(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> HomeSectionPrefs:
    """Dashboard section order and collapse flags.

    Stored on the participant metadata document, the same record as
    ``/users/me/preferences``, so the layout follows the account across devices.
    """
    participant = await db.get(Participant, user["participant_id"])
    return _read_section_prefs(participant)


@router.put("/home/section-prefs", response_model=HomeSectionPrefs)
async def put_section_prefs(
    body: HomeSectionPrefsBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> HomeSectionPrefs:
    participant = await db.get(Participant, user["participant_id"])
    if participant is None:
        raise HTTPException(status_code=404, detail="Participant not found")
    current = _read_section_prefs(participant).model_dump()
    if body.order is not None:
        current["order"] = body.order
    if body.collapsed is not None:
        merged = dict(current["collapsed"])
        merged.update(body.collapsed)
        current["collapsed"] = merged
    normalized = normalize_section_prefs(current)
    meta = dict(participant.metadata_ or {})
    meta["home_sections"] = normalized
    participant.metadata_ = meta
    await db.commit()
    return HomeSectionPrefs(**normalized)
