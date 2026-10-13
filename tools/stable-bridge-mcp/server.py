#!/usr/bin/env python3
"""Stable Bridge — an MCP server that lets Claude Code continue a conversation
inside the Unicorn Command Center ("Stable") chat rooms.

The model talking to Aaron in Claude Code IS the relay: it reads Aaron's
messages from a Stable room and posts replies back, so this conversation
literally continues there. Leave the Claude Code window open and it keeps going.

Design (no secrets on this machine, no Keycloak, no token expiry):
  * WRITE  -> POST /api/v1/internal/agent-messages on stable-backend, authed by
             the LIVEKIT_API_SECRET that already lives inside the container. The
             secret never leaves the application host; the payload is base64'd through an env
             var so arbitrary message content can't break shell quoting.
  * READ   -> query the `stable` Postgres directly for new messages, returned as
             JSON (so content with quotes/newlines round-trips cleanly).
  * Both hops run over the operator-configured SSH access.

The bridge posts as a DISTINCT agent identity ("Claude Code", id `claude-code`)
so it never collides with the autonomous `claude` Brigade persona. Use it in a
CHANNEL: a channel only auto-replies on an explicit @-mention, so normal
conversation triggers no Brigade response and the bridge is the sole responder.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shlex
import subprocess
import time
from typing import Any

from mcp.server.fastmcp import FastMCP

# --- config (env-overridable) ------------------------------------------------
SSH_HOST = os.environ.get("STABLE_SSH_HOST", "localhost")
BACKEND_CONTAINER = os.environ.get("STABLE_BACKEND_CONTAINER", "stable-backend")
DB_CONTAINER = os.environ.get("STABLE_DB_CONTAINER", "stable-postgres")
DB_USER = os.environ.get("STABLE_DB_USER", "stable")
DB_NAME = os.environ.get("STABLE_DB_NAME", "stable")
BRIDGE_AGENT_ID = os.environ.get("STABLE_BRIDGE_AGENT_ID", "claude-code")
# Participant who owns bridge-created channels (so they appear in their sidebar).
CREATOR_ID = os.environ.get(
    "STABLE_BRIDGE_CREATOR_ID", "c0cf018d-f9d4-4638-a43b-23914024aad4"  # Aaron Stransky
)
INTERNAL_URL = os.environ.get(
    "STABLE_INTERNAL_URL", "http://localhost:8400/api/v1/internal/agent-messages"
)
POLL_INTERVAL_S = float(os.environ.get("STABLE_POLL_INTERVAL_S", "3"))

SSH_BASE = [
    "ssh",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=120s",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    SSH_HOST,
]

_ROOM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")  # guards SQL interpolation
_room_cache: dict[str, dict] = {}
_last_seen: dict[str, str] = {}  # room_id -> ISO timestamp of newest msg we've shown

mcp = FastMCP("stable-bridge")


# --- low-level helpers -------------------------------------------------------
def _ssh(remote_cmd: str, *, payload_env: str | None = None, timeout: int = 45) -> str:
    """Run one command on the configured host over SSH. Returns stdout (raises on failure)."""
    env_prefix = f"PAYLOAD={shlex.quote(payload_env)} " if payload_env is not None else ""
    full = env_prefix + remote_cmd
    proc = subprocess.run(
        [*SSH_BASE, full], capture_output=True, timeout=timeout, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh command failed (rc={proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout


def _psql_json(sql: str, *, timeout: int = 30) -> Any:
    """Run a single-value JSON-returning query and parse it."""
    remote = (
        f"docker exec {shlex.quote(DB_CONTAINER)} psql -U {shlex.quote(DB_USER)} "
        f"-d {shlex.quote(DB_NAME)} -tAc {shlex.quote(sql)}"
    )
    out = _ssh(remote, timeout=timeout).strip()
    return json.loads(out) if out else None


def _resolve_room(room: str) -> dict:
    """Resolve a room name (or livekit_room_name) to its row. Cached."""
    room = room.strip()
    if not _ROOM_RE.match(room):
        raise ValueError(f"invalid room identifier: {room!r}")
    if room in _room_cache:
        return _room_cache[room]
    sql = (
        "SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ("
        "SELECT id::text AS id, name, display_name, livekit_room_name, room_type "
        "FROM rooms WHERE "
        f"name = '{room}' OR livekit_room_name = '{room}' OR livekit_room_name = 'stable-{room}' "
        "ORDER BY created_at DESC LIMIT 1) t"
    )
    rows = _psql_json(sql) or []
    if not rows:
        raise ValueError(
            f"no room named {room!r}. Call list_rooms() to see available rooms, "
            "or create a channel in Stable first."
        )
    _room_cache[room] = rows[0]
    return rows[0]


def _baseline(room_id: str) -> str:
    """Newest existing message timestamp in the room (so we don't replay history)."""
    sql = (
        "SELECT to_json(coalesce(max(created_at), now())) FROM messages "
        f"WHERE room_id = '{room_id}'::uuid"
    )
    return str(_psql_json(sql))


def _fetch_new(room_id: str, since_iso: str) -> list[dict]:
    """Messages in the room newer than since_iso, excluding the bridge's own posts."""
    safe_since = since_iso.replace("'", "")  # ISO timestamps never contain quotes
    sql = (
        "SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ("
        "SELECT m.id::text AS id, m.created_at::text AS created_at, "
        "coalesce(p.display_name, 'unknown') AS sender, "
        "coalesce(p.keycloak_sub, '') AS sub, m.content "
        "FROM messages m LEFT JOIN participants p ON p.id = m.sender_id "
        f"WHERE m.room_id = '{room_id}'::uuid AND m.is_deleted = false "
        f"AND m.created_at > '{safe_since}'::timestamptz "
        f"AND coalesce(p.keycloak_sub, '') <> 'brigade:{BRIDGE_AGENT_ID}' "
        "ORDER BY m.created_at ASC) t"
    )
    return _psql_json(sql) or []


# in-container poster: reads base64 JSON {room, content} from $PAYLOAD, signs with
# the in-container internal-agent secret (falling back to the LiveKit secret to
# match the backend's _expected_internal_secret()), posts as the bridge agent.
# The secret never leaves the configured host. Single-quoted only.
_POST_SCRIPT = (
    "import os,base64,json,httpx;"
    "from app.config import Settings;"
    "s=Settings();"
    "d=json.loads(base64.b64decode(os.environ['PAYLOAD']));"
    f"r=httpx.post('{INTERNAL_URL}',"
    "headers={'Authorization':'Bearer '+(getattr(s,'internal_agent_secret',None) or s.livekit_api_secret)},"
    "json={'livekit_room_name':d['room'],'brigade_agent_id':d['agent'],'content':d['content']},"
    "timeout=30);"
    "print(json.dumps({'status':r.status_code,"
    "'created_at':(r.json() or {}).get('created_at') if r.headers.get('content-type','').startswith('application/json') else None,"
    "'detail':None if r.status_code<300 else r.text[:300]}))"
)


def _post_as_bridge(livekit_room_name: str, content: str) -> dict:
    payload = base64.b64encode(
        json.dumps({"room": livekit_room_name, "agent": BRIDGE_AGENT_ID, "content": content}).encode()
    ).decode()
    remote = (
        f"docker exec -e PAYLOAD {shlex.quote(BACKEND_CONTAINER)} "
        f"python3 -c {shlex.quote(_POST_SCRIPT)}"
    )
    out = _ssh(remote, payload_env=payload, timeout=45).strip()
    return json.loads(out)


def _fmt_msgs(msgs: list[dict]) -> str:
    if not msgs:
        return "(no new messages)"
    return "\n".join(f"[{m['created_at']}] {m['sender']}: {m['content']}" for m in msgs)


def _slug(s: str) -> str:
    """Turn a free-form topic into a valid room name (^[a-z0-9][a-z0-9-]*$)."""
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    if not s:
        return "claude-bridge"
    if not s[0].isalnum():
        s = "c-" + s
    return s[:60]


# In-container script (piped via stdin → python3 -). Reads ROOM_NAME / ROOM_DISPLAY
# / CREATOR_ID from env, then creates a channel the SAME way the app's API does
# (real LiveKit room + creator as OWNER), or reuses + ensures membership if it
# already exists. Prints one JSON line.
_CREATE_SCRIPT = r"""
import os, json, uuid, asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from redis.asyncio import Redis
from livekit.api import LiveKitAPI
from app.config import get_settings
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService
from app.services.room_service import RoomService
from app.models.room import Room, RoomMember, MemberRole

async def main():
    name = os.environ["ROOM_NAME"]; display = os.environ["ROOM_DISPLAY"]
    creator = uuid.UUID(os.environ["CREATOR_ID"])
    s = get_settings()
    engine = create_async_engine(s.database_url, pool_pre_ping=True)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    redis = Redis.from_url(s.redis_url, decode_responses=False)
    lk_api = LiveKitAPI(url=s.livekit_api_url, api_key=s.livekit_api_key, api_secret=s.livekit_api_secret)
    lk = LiveKitService(lk_api, s.livekit_url)
    presence = PresenceService(redis)
    out = {}
    try:
        async with sf() as db:
            existing = (await db.execute(select(Room).where(Room.name == name))).scalar_one_or_none()
            if existing is not None:
                m = (await db.execute(select(RoomMember).where(
                    RoomMember.room_id == existing.id,
                    RoomMember.participant_id == creator))).scalar_one_or_none()
                if m is None:
                    db.add(RoomMember(room_id=existing.id, participant_id=creator, role=MemberRole.OWNER))
                    await db.commit()
                out = {"ok": True, "reused": True, "id": str(existing.id),
                       "name": existing.name, "livekit_room_name": existing.livekit_room_name}
            else:
                svc = RoomService(db=db, livekit=lk, presence=presence)
                room = await svc.create_room(name=name, display_name=display,
                    room_type="channel", creator_id=creator, max_participants=50)
                out = {"ok": True, "reused": False, "id": str(room.id),
                       "name": room.name, "livekit_room_name": room.livekit_room_name}
    except Exception as e:
        out = {"ok": False, "error": type(e).__name__ + ": " + str(e)[:300]}
    finally:
        for closer in (getattr(lk_api, "aclose", None), getattr(redis, "aclose", None), getattr(engine, "dispose", None)):
            try:
                if closer: await closer()
            except Exception:
                pass
    print(json.dumps(out))

asyncio.run(main())
"""


def _ensure_channel(display_name: str, name: str = "") -> dict:
    slug = _slug(name or display_name)
    display = (display_name or "").strip()[:255] or slug
    remote = (
        f"ROOM_NAME={shlex.quote(slug)} ROOM_DISPLAY={shlex.quote(display)} "
        f"CREATOR_ID={shlex.quote(CREATOR_ID)} "
        f"docker exec -i -e ROOM_NAME -e ROOM_DISPLAY -e CREATOR_ID "
        f"{shlex.quote(BACKEND_CONTAINER)} python3 -"
    )
    proc = subprocess.run(
        [*SSH_BASE, remote], input=_CREATE_SCRIPT.encode(), capture_output=True, timeout=60
    )
    stdout = proc.stdout.decode().strip()
    if not stdout:
        raise RuntimeError(
            f"channel create failed (rc={proc.returncode}): {proc.stderr.decode().strip()[:300]}"
        )
    res = json.loads(stdout.splitlines()[-1])
    if res.get("ok"):
        _room_cache[res["name"]] = {
            "id": res["id"], "name": res["name"], "display_name": display,
            "livekit_room_name": res["livekit_room_name"], "room_type": "channel",
        }
    return res


# --- knowledge-base control (in-container, key-free like channel create) -----
# One piped script that dispatches on $ACTION, reading a base64 JSON $PAYLOAD.
# Drives the SAME knowledge_service the app's REST API uses, but in-container so
# it needs no Keycloak token (mirrors the create_channel pattern). Always prints
# one JSON line: {"ok": bool, ...} or {"ok": false, "error": "..."}.
_KB_SCRIPT = r"""
import os, json, uuid, base64, asyncio
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.config import get_settings
from app.services.knowledge_service import knowledge_service
from app.models.knowledge import KnowledgeCollection, KnowledgeDocument, RoomKnowledge
from app.models.room import Room

ACTION = os.environ["ACTION"]
P = json.loads(base64.b64decode(os.environ["PAYLOAD"])) if os.environ.get("PAYLOAD") else {}

async def main():
    s = get_settings()
    engine = create_async_engine(s.database_url, pool_pre_ping=True)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    out = {}
    try:
        async with sf() as db:
            if ACTION == "list_kb":
                rows = (await db.execute(
                    select(KnowledgeCollection).order_by(KnowledgeCollection.created_at.desc())
                )).scalars().all()
                items = []
                for c in rows:
                    n = (await db.execute(select(func.count()).select_from(KnowledgeDocument)
                        .where(KnowledgeDocument.collection_id == c.id))).scalar() or 0
                    items.append({"id": str(c.id), "name": c.name,
                                  "description": c.description, "documents": int(n)})
                out = {"ok": True, "collections": items}
            elif ACTION == "create_kb":
                creator = uuid.UUID(P["created_by"]) if P.get("created_by") else None
                c = await knowledge_service.create_collection(
                    db, name=P["name"], description=P.get("description"), created_by=creator)
                await db.commit()
                out = {"ok": True, "id": str(c.id), "name": c.name}
            elif ACTION == "add_doc":
                cid = uuid.UUID(P["collection_id"])
                filename = P["filename"]; content_type = P.get("content_type") or "text/markdown"
                ext = os.path.splitext(filename)[1] or ".md"
                stored = uuid.uuid4().hex + ext
                os.makedirs(s.upload_dir, exist_ok=True)
                with open(os.path.join(s.upload_dir, stored), "w", encoding="utf-8") as f:
                    f.write(P["text"])
                doc = KnowledgeDocument(collection_id=cid, filename=filename,
                    content_type=content_type, stored_name=stored, status="indexing", chunk_count=0)
                db.add(doc); await db.commit()
                n = await knowledge_service.index_kb_document(
                    s, db, cid, doc.id, stored, filename, content_type)
                await db.refresh(doc)
                out = {"ok": True, "id": str(doc.id), "filename": filename,
                       "chunks": int(n), "status": doc.status}
            elif ACTION == "search":
                cids = [str(x) for x in (P.get("collection_ids") or [])]
                res = await knowledge_service.search_knowledge(
                    s, cids, P["query"], int(P.get("k", 5)))
                out = {"ok": True, "results": res}
            elif ACTION == "attach_room":
                room = (await db.execute(select(Room).where(Room.name == P["room"]))).scalar_one_or_none()
                if room is None:
                    out = {"ok": False, "error": "no room named " + str(P["room"])}
                else:
                    cid = uuid.UUID(P["collection_id"])
                    existing = (await db.execute(select(RoomKnowledge).where(
                        RoomKnowledge.room_id == room.id,
                        RoomKnowledge.collection_id == cid))).scalar_one_or_none()
                    if existing is None:
                        db.add(RoomKnowledge(room_id=room.id, collection_id=cid)); await db.commit()
                    out = {"ok": True, "room": room.name, "collection_id": str(cid),
                           "reused": existing is not None}
            elif ACTION == "detach_room":
                room = (await db.execute(select(Room).where(Room.name == P["room"]))).scalar_one_or_none()
                if room is None:
                    out = {"ok": False, "error": "no room named " + str(P["room"])}
                else:
                    cid = uuid.UUID(P["collection_id"])
                    rk = (await db.execute(select(RoomKnowledge).where(
                        RoomKnowledge.room_id == room.id,
                        RoomKnowledge.collection_id == cid))).scalar_one_or_none()
                    if rk is not None:
                        await db.delete(rk); await db.commit()
                    out = {"ok": True, "room": room.name, "collection_id": str(cid)}
            elif ACTION == "list_room_kb":
                room = (await db.execute(select(Room).where(Room.name == P["room"]))).scalar_one_or_none()
                if room is None:
                    out = {"ok": False, "error": "no room named " + str(P["room"])}
                else:
                    rks = (await db.execute(select(RoomKnowledge).where(
                        RoomKnowledge.room_id == room.id))).scalars().all()
                    items = []
                    for rk in rks:
                        c = await db.get(KnowledgeCollection, rk.collection_id)
                        if c:
                            items.append({"id": str(c.id), "name": c.name, "description": c.description})
                    out = {"ok": True, "room": room.name, "collections": items}
            else:
                out = {"ok": False, "error": "unknown action " + ACTION}
    except Exception as e:
        out = {"ok": False, "error": type(e).__name__ + ": " + str(e)[:300]}
    finally:
        try:
            await engine.dispose()
        except Exception:
            pass
    print(json.dumps(out))

asyncio.run(main())
"""


def _kb_exec(action: str, payload: dict | None = None, timeout: int = 120) -> dict:
    """Run one KB action in the backend container (key-free). Returns the parsed dict."""
    p = base64.b64encode(json.dumps(payload or {}).encode()).decode()
    remote = (
        f"ACTION={shlex.quote(action)} PAYLOAD={shlex.quote(p)} "
        f"docker exec -i -e ACTION -e PAYLOAD {shlex.quote(BACKEND_CONTAINER)} python3 -"
    )
    proc = subprocess.run(
        [*SSH_BASE, remote], input=_KB_SCRIPT.encode(), capture_output=True, timeout=timeout
    )
    stdout = proc.stdout.decode().strip()
    if not stdout:
        raise RuntimeError(
            f"kb exec failed (rc={proc.returncode}): {proc.stderr.decode().strip()[:300]}"
        )
    return json.loads(stdout.splitlines()[-1])


def _resolve_kb_id(ref: str) -> str:
    """Resolve a KB reference (id or name) to its collection id."""
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("knowledge base name or id required")
    cols = (_kb_exec("list_kb").get("collections")) or []
    for c in cols:  # exact id first
        if c["id"] == ref:
            return c["id"]
    for c in cols:  # then case-insensitive name
        if (c.get("name") or "").lower() == ref.lower():
            return c["id"]
    raise ValueError(
        f"no knowledge base matching {ref!r}. Call list_knowledge_bases() "
        "or create_knowledge_base() first."
    )


# --- MCP tools ---------------------------------------------------------------
@mcp.tool()
def list_rooms() -> str:
    """List the Stable chat rooms you can bridge into (name, type, message count).

    Use this to find or confirm the channel to continue a conversation in. Prefer
    a CHANNEL (room_type=channel) for bridging so normal chat won't trigger an
    autonomous agent reply.
    """
    sql = (
        "SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ("
        "SELECT r.name, r.display_name, r.room_type, "
        "(SELECT count(*) FROM messages m WHERE m.room_id = r.id AND m.is_deleted=false) AS messages "
        "FROM rooms r ORDER BY r.updated_at DESC LIMIT 40) t"
    )
    rows = _psql_json(sql) or []
    if not rows:
        return "No rooms found."
    lines = [f"{'name':<26} {'type':<10} msgs  display"]
    for r in rows:
        lines.append(
            f"{r['name']:<26} {r['room_type']:<10} {r['messages']:>4}  {r['display_name']}"
        )
    return "\n".join(lines)


@mcp.tool()
def send_message(room: str, content: str) -> str:
    """Post a message into a Stable room AS the 'Claude Code' bridge participant.

    Args:
        room: the channel name (e.g. "claude") or its livekit_room_name.
        content: the message text (markdown ok; arbitrary content is safe).
    """
    r = _resolve_room(room)
    res = _post_as_bridge(r["livekit_room_name"], content)
    if res.get("status", 0) >= 300:
        return f"FAILED to post (status {res.get('status')}): {res.get('detail')}"
    if res.get("created_at"):
        _last_seen[r["id"]] = res["created_at"]  # don't echo our own message back
    return f"Sent to #{r['name']} as Claude Code (status {res['status']})."


@mcp.tool()
def get_new_messages(room: str, since_iso: str = "") -> str:
    """Fetch messages in a room newer than `since_iso` (excludes the bridge's own posts).

    With no `since_iso`, returns messages since the last time the bridge looked at
    this room (or, on first look, only messages from now on). Use this for a quick
    non-blocking check; use wait_for_reply to block until Aaron responds.
    """
    r = _resolve_room(room)
    since = since_iso or _last_seen.get(r["id"]) or _baseline(r["id"])
    msgs = _fetch_new(r["id"], since)
    if msgs:
        _last_seen[r["id"]] = msgs[-1]["created_at"]
    return _fmt_msgs(msgs)


@mcp.tool()
def wait_for_reply(room: str, since_iso: str = "", timeout_seconds: int = 120) -> str:
    """Block until a new (non-bridge) message appears in the room, then return it.

    This is the heart of the bridge loop: post your reply with send_message (or
    send_and_wait), then call this to wait for Aaron's next message. If it times
    out with nothing, just call it again to keep waiting (the window stays open).
    """
    r = _resolve_room(room)
    since = since_iso or _last_seen.get(r["id"]) or _baseline(r["id"])
    deadline = time.monotonic() + max(5, int(timeout_seconds))
    while time.monotonic() < deadline:
        msgs = _fetch_new(r["id"], since)
        if msgs:
            _last_seen[r["id"]] = msgs[-1]["created_at"]
            return _fmt_msgs(msgs)
        time.sleep(POLL_INTERVAL_S)
    return (
        f"No reply in #{r['name']} within {timeout_seconds}s. "
        "Call wait_for_reply again to keep waiting, or get_new_messages to check."
    )


@mcp.tool()
def send_and_wait(room: str, content: str, timeout_seconds: int = 120) -> str:
    """Post a reply AND wait for Aaron's next message in one call (the bridge turn).

    Use this once a conversation is flowing: it posts `content` as Claude Code,
    then blocks until Aaron replies (or times out), returning his message.
    """
    sent = send_message(room, content)
    if sent.startswith("FAILED"):
        return sent
    reply = wait_for_reply(room, timeout_seconds=timeout_seconds)
    return f"{sent}\n\n--- waiting for reply ---\n{reply}"


@mcp.tool()
def create_channel(display_name: str, name: str = "") -> str:
    """Create (or reuse) a Stable CHANNEL to continue this conversation in.

    The channel is owned by Aaron (shows up in his sidebar) with a real LiveKit
    room, created exactly the way the app does. Use this when Aaron says something
    like "let's pick this up in the Command Center" — derive a `display_name` from
    what you're discussing (e.g. "Claude · Knowledge Bases"); `name` is auto-slugged
    from it if omitted.

    Args:
        display_name: human title for the channel (what you're discussing).
        name: optional explicit channel slug; auto-derived from display_name if "".
    """
    res = _ensure_channel(display_name, name)
    if not res.get("ok"):
        return f"FAILED to create channel: {res.get('error')}"
    verb = "Reusing existing" if res.get("reused") else "Created"
    return (
        f"{verb} channel #{res['name']} (\"{display_name}\"), owned by Aaron. "
        f"Use room=\"{res['name']}\" with send_message / wait_for_reply."
    )


@mcp.tool()
def start_session(display_name: str, opener: str, name: str = "", timeout_seconds: int = 150) -> str:
    """Begin a bridged session in ONE call: create/reuse a topic channel, post the
    opener as "Claude Code", then wait for Aaron's first reply.

    Use this the moment Aaron asks to continue in the Command Center / Stable.

    Args:
        display_name: channel title derived from the conversation topic.
        opener: the first message to post into the channel (greet + carry context).
        name: optional explicit channel slug (auto-derived if "").
        timeout_seconds: how long to wait for the first reply before returning.
    """
    res = _ensure_channel(display_name, name)
    if not res.get("ok"):
        return f"FAILED to create channel: {res.get('error')}"
    room = res["name"]
    sent = send_message(room, opener)
    if sent.startswith("FAILED"):
        return f"Channel ready (#{room}) but {sent}"
    reply = wait_for_reply(room, timeout_seconds=timeout_seconds)
    return (
        f"Bridged session live in #{room} (\"{display_name}\"). {sent}\n\n"
        f"--- waiting for Aaron's reply ---\n{reply}"
    )


# --- knowledge-base tools ----------------------------------------------------
@mcp.tool()
def list_knowledge_bases() -> str:
    """List the knowledge bases (document collections) in Stable, with doc counts.

    Use this to find a KB's name/id before adding docs, searching, or attaching it
    to a room. KBs are global (not room-scoped); a room "sees" a KB only once it's
    attached via attach_kb_to_room.
    """
    res = _kb_exec("list_kb")
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    cols = res.get("collections") or []
    if not cols:
        return "No knowledge bases yet. Create one with create_knowledge_base(name)."
    lines = [f"{'name':<28} {'docs':>4}  id"]
    for c in cols:
        lines.append(f"{(c['name'] or '')[:28]:<28} {c['documents']:>4}  {c['id']}")
        if c.get("description"):
            lines.append(f"    {c['description'][:80]}")
    return "\n".join(lines)


@mcp.tool()
def create_knowledge_base(name: str, description: str = "") -> str:
    """Create a new knowledge base (document collection) in Stable.

    Owned by Aaron (created_by). After creating, add content with add_document,
    then attach_kb_to_room to make a room/agent able to retrieve from it.

    Args:
        name: short KB title (e.g. "Stable Architecture").
        description: optional one-line description of what it holds.
    """
    res = _kb_exec("create_kb", {
        "name": name.strip(), "description": (description or "").strip() or None,
        "created_by": CREATOR_ID,
    })
    if not res.get("ok"):
        return f"FAILED to create KB: {res.get('error')}"
    return f"Created knowledge base \"{res['name']}\" (id {res['id']})."


@mcp.tool()
def add_document(knowledge_base: str, filename: str, text: str) -> str:
    """Add a text/markdown document to a knowledge base and index it (sync).

    The text is chunked, contextualized, embedded (hybrid dense+sparse) and made
    searchable immediately — this call returns once indexing finishes. Great for
    pasting notes, docs, or transcripts an agent should be able to recall.

    Args:
        knowledge_base: KB name or id (see list_knowledge_bases).
        filename: a name for the doc (e.g. "deploy-runbook.md"); sets the title.
        text: the document body (plain text or markdown).
    """
    cid = _resolve_kb_id(knowledge_base)
    res = _kb_exec("add_doc", {
        "collection_id": cid, "filename": filename.strip() or "document.md",
        "text": text, "content_type": "text/markdown",
    })
    if not res.get("ok"):
        return f"FAILED to add document: {res.get('error')}"
    if res.get("status") != "ready":
        return (f"Added \"{res['filename']}\" but indexing status={res.get('status')} "
                f"(chunks={res.get('chunks')}). It may have no extractable text.")
    return f"Indexed \"{res['filename']}\" into the KB ({res['chunks']} chunks, ready)."


@mcp.tool()
def search_knowledge(knowledge_base: str, query: str, k: int = 5) -> str:
    """Search a knowledge base and return the top reranked excerpts.

    Hybrid retrieval (dense + sparse, RRF) + bge-reranker — the same path agents
    use at reply time. Use it to check what a KB will surface for a question.

    Args:
        knowledge_base: KB name or id.
        query: the question / search text.
        k: how many excerpts to return (1-20).
    """
    cid = _resolve_kb_id(knowledge_base)
    res = _kb_exec("search", {"collection_ids": [cid], "query": query, "k": max(1, min(20, k))})
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    hits = res.get("results") or []
    if not hits:
        return "No matches (KB may be empty or nothing relevant)."
    out = []
    for i, h in enumerate(hits, 1):
        out.append(f"[{i}] {h.get('filename','document')}  (score {h.get('score',0):.3f})\n"
                   f"    {(h.get('text') or '').strip()[:400]}")
    return "\n".join(out)


@mcp.tool()
def attach_kb_to_room(room: str, knowledge_base: str) -> str:
    """Attach a knowledge base to a room so its agents retrieve from it on reply.

    Idempotent. After this, any agent answering in that room can ground replies in
    the KB. Detach later with detach_kb_from_room.

    Args:
        room: the channel name (see list_rooms).
        knowledge_base: KB name or id (see list_knowledge_bases).
    """
    cid = _resolve_kb_id(knowledge_base)
    res = _kb_exec("attach_room", {"room": _resolve_room(room)["name"], "collection_id": cid})
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    verb = "already attached" if res.get("reused") else "attached"
    return f"KB {verb} to #{res['room']}."


@mcp.tool()
def detach_kb_from_room(room: str, knowledge_base: str) -> str:
    """Detach a knowledge base from a room (idempotent).

    Args:
        room: the channel name.
        knowledge_base: KB name or id.
    """
    cid = _resolve_kb_id(knowledge_base)
    res = _kb_exec("detach_room", {"room": _resolve_room(room)["name"], "collection_id": cid})
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    return f"KB detached from #{res['room']}."


@mcp.tool()
def list_room_knowledge(room: str) -> str:
    """List the knowledge bases attached to a room.

    Args:
        room: the channel name.
    """
    res = _kb_exec("list_room_kb", {"room": _resolve_room(room)["name"]})
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    cols = res.get("collections") or []
    if not cols:
        return f"No knowledge bases attached to #{res['room']}."
    lines = [f"Attached to #{res['room']}:"]
    for c in cols:
        lines.append(f"  - {c['name']} ({c['id']})")
    return "\n".join(lines)


# --- voice (suite TTS / STT via in-container Settings; no secrets on Mac) ----

# Call Kokoro from inside stable-backend (settings.kokoro_base_url). Payload is
# base64 JSON {text, voice?, agent?, speed?}. Returns base64 mp3 + meta JSON.
_TTS_SCRIPT = r"""
import os, base64, json, re, httpx
from app.config import Settings
from app.api.tts import AGENT_VOICES, AGENT_DEFAULT_VOICE, _normalize_agent
s = Settings()
d = json.loads(base64.b64decode(os.environ['PAYLOAD']))
text = re.sub(r'\s+', ' ', (d.get('text') or '')).strip()
text = re.sub(r'[\U00010000-\U0010ffff\u2600-\u27BF\uFE0F\u200D]+', ' ', text)
text = re.sub(r'\s+', ' ', text).strip()
if not text or not re.search(r'[A-Za-z0-9]', text):
    print(json.dumps({'ok': False, 'error': 'Nothing to speak'})); raise SystemExit
if d.get('voice'):
    voice = d['voice']
elif d.get('agent'):
    voice = AGENT_VOICES.get(_normalize_agent(d['agent']), AGENT_DEFAULT_VOICE)
else:
    voice = s.tts_default_voice
speed = float(d.get('speed') or 1.0)
r = httpx.post(
    f"{s.kokoro_base_url}/v1/audio/speech",
    json={'model': 'kokoro', 'input': text, 'voice': voice,
          'response_format': 'mp3', 'speed': speed},
    timeout=120,
)
if r.status_code != 200:
    print(json.dumps({'ok': False, 'error': f'TTS {r.status_code}: {r.text[:200]}'})); raise SystemExit
print(json.dumps({
    'ok': True, 'voice': voice, 'bytes': len(r.content),
    'audio_b64': base64.b64encode(r.content).decode(),
}))
"""

# Call Whisper/Parakeet from inside stable-backend. Payload: {audio_b64, filename, language?, model?}
_STT_SCRIPT = r"""
import os, base64, json, httpx
from app.config import Settings
s = Settings()
d = json.loads(base64.b64decode(os.environ['PAYLOAD']))
audio = base64.b64decode(d['audio_b64'])
base = (s.whisper_base_url or '').rstrip('/')
if not base:
    print(json.dumps({'ok': False, 'error': 'WHISPER_BASE_URL not configured'})); raise SystemExit
url = f"{base}/audio/transcriptions"
model = (d.get('model') or s.whisper_model or 'whisper-1').strip()
filename = d.get('filename') or 'audio.webm'
data = {'model': model}
if d.get('language'):
    data['language'] = d['language']
r = httpx.post(
    url, data=data,
    files={'file': (filename, audio, d.get('content_type') or 'application/octet-stream')},
    timeout=120,
)
if r.status_code != 200:
    print(json.dumps({'ok': False, 'error': f'STT {r.status_code}: {r.text[:200]}'})); raise SystemExit
try:
    body = r.json()
except Exception:
    body = {'text': r.text}
print(json.dumps({'ok': True, 'result': body}))
"""

# Remove brigade agent RoomMember + optional LiveKit eviction for leave/kick.
_LEAVE_SCRIPT = r"""
import os, base64, json, asyncio, uuid
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.config import get_settings
from app.models.participant import Participant, ParticipantType
from app.models.room import Room, RoomMember

d = json.loads(base64.b64decode(os.environ['PAYLOAD']))
room_ref = d['room']
agent_id = d['agent_id']

async def main():
    s = get_settings()
    engine = create_async_engine(s.database_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as db:
        room = (await db.execute(
            select(Room).where(
                (Room.livekit_room_name == room_ref) | (Room.name == room_ref)
            )
        )).scalar_one_or_none()
        if room is None:
            try:
                room = (await db.execute(
                    select(Room).where(Room.id == uuid.UUID(room_ref))
                )).scalar_one_or_none()
            except Exception:
                room = None
        if room is None:
            print(json.dumps({'ok': False, 'error': f'room not found: {room_ref}'}))
            return
        pseudo = f'brigade:{agent_id}'
        agent_p = (await db.execute(
            select(Participant).where(Participant.keycloak_sub == pseudo)
        )).scalar_one_or_none()
        removed = 0
        if agent_p is not None:
            res = await db.execute(
                delete(RoomMember).where(
                    RoomMember.room_id == room.id,
                    RoomMember.participant_id == agent_p.id,
                )
            )
            removed = res.rowcount or 0
            await db.commit()
        print(json.dumps({
            'ok': True,
            'room': room.livekit_room_name,
            'agent_id': agent_id,
            'memberships_removed': int(removed),
        }))
    await engine.dispose()

asyncio.run(main())
"""


def _voice_exec(script: str, payload: dict, timeout: int = 130) -> dict:
    blob = base64.b64encode(json.dumps(payload).encode()).decode()
    remote = (
        f"docker exec -e PAYLOAD {shlex.quote(BACKEND_CONTAINER)} "
        f"python3 -c {shlex.quote(script)}"
    )
    out = _ssh(remote, payload_env=blob, timeout=timeout).strip()
    # Script may print only the final JSON line.
    line = out.splitlines()[-1] if out else "{}"
    return json.loads(line)


@mcp.tool()
def speak_text(
    text: str,
    voice: str = "",
    agent: str = "",
    out_path: str = "",
    speed: float = 1.0,
) -> str:
    """Synthesize speech via suite TTS (Kokoro / Orator) inside stable-backend.

    No secrets leave the host: synthesis runs in-container against Settings.kokoro_base_url.

    Args:
        text: words to speak.
        voice: optional Kokoro voice id (e.g. af_heart).
        agent: optional brigade agent id for preset voice.
        out_path: if set, write mp3 bytes here.
        speed: 0.5–2.0 (default 1.0).
    """
    payload: dict[str, Any] = {"text": text, "speed": float(speed or 1.0)}
    if voice:
        payload["voice"] = voice
    if agent:
        payload["agent"] = agent
    try:
        res = _voice_exec(_TTS_SCRIPT, payload)
    except Exception as e:
        return f"FAILED: {e}"
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    audio = base64.b64decode(res["audio_b64"])
    if out_path:
        path = out_path
        # Avoid pathlib import at module top for this legacy script.
        import pathlib as _pl

        p = _pl.Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(audio)
        return f"Spoke {len(text)} chars → {len(audio)} byte mp3 @ {p} (voice={res.get('voice')})."
    return (
        f"Spoke {len(text)} chars → {len(audio)} byte mp3 (voice={res.get('voice')}). "
        "Pass out_path to save the audio file."
    )


@mcp.tool()
def transcribe_audio(path: str, language: str = "", model: str = "") -> str:
    """Transcribe a local audio file via suite STT (Amanuensis / Parakeet).

    Reads the file on this machine, ships base64 over SSH into stable-backend,
    and calls settings.whisper_base_url (OpenAI-compatible /audio/transcriptions).

    Args:
        path: local path to wav/mp3/webm/m4a/ogg/flac.
        language: optional language hint (e.g. en).
        model: optional model name (default whisper-1).
    """
    import pathlib as _pl

    p = _pl.Path(path).expanduser()
    if not p.is_file():
        return f"FAILED: file not found: {p}"
    data = p.read_bytes()
    if not data:
        return "FAILED: empty audio file"
    suffix = p.suffix.lower()
    ctype = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
    }.get(suffix, "application/octet-stream")
    payload: dict[str, Any] = {
        "audio_b64": base64.b64encode(data).decode(),
        "filename": p.name,
        "content_type": ctype,
    }
    if language:
        payload["language"] = language
    if model:
        payload["model"] = model
    try:
        res = _voice_exec(_STT_SCRIPT, payload)
    except Exception as e:
        return f"FAILED: {e}"
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    body = res.get("result") or {}
    text = body.get("text") if isinstance(body, dict) else None
    if text is None:
        return f"Transcribed (raw): {body!r}"
    return f"Transcript:\n{text}"


@mcp.tool()
def leave_room(room: str) -> str:
    """Remove the bridge agent (claude-code) from a room — clean session exit.

    Deletes the RoomMember row so the participant strip no longer shows a stuck
    Claude Code agent after the MCP process stops.

    Args:
        room: channel name or livekit_room_name.
    """
    r = _resolve_room(room)
    try:
        res = _voice_exec(
            _LEAVE_SCRIPT,
            {"room": r["livekit_room_name"] or r["name"], "agent_id": BRIDGE_AGENT_ID},
        )
    except Exception as e:
        return f"FAILED: {e}"
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    return (
        f"Left {res.get('room')} as {BRIDGE_AGENT_ID} "
        f"(memberships_removed={res.get('memberships_removed')})."
    )


@mcp.tool()
def remove_room_agent(room: str, brigade_agent_id: str) -> str:
    """Kick a stuck Brigade agent from a room (membership delete).

    Args:
        room: channel name or livekit_room_name.
        brigade_agent_id: e.g. claude, majik (without agent- prefix).
    """
    r = _resolve_room(room)
    agent_id = (brigade_agent_id or "").strip().removeprefix("agent-")
    if not agent_id:
        return "FAILED: brigade_agent_id required"
    try:
        res = _voice_exec(
            _LEAVE_SCRIPT,
            {"room": r["livekit_room_name"] or r["name"], "agent_id": agent_id},
        )
    except Exception as e:
        return f"FAILED: {e}"
    if not res.get("ok"):
        return f"FAILED: {res.get('error')}"
    return (
        f"Removed {agent_id} from {res.get('room')} "
        f"(memberships_removed={res.get('memberships_removed')})."
    )


@mcp.tool()
def close_bridge_session(room: str = "", remove_agents: str = "") -> str:
    """Close out Stable Bridge cleanly: kick stuck agents, leave as claude-code.

    Call this when the human is done with the bridged conversation, then stop
    the MCP client process.

    Args:
        room: channel to leave (name or livekit_room_name). Empty skips leave.
        remove_agents: comma-separated brigade agent ids to kick first.
    """
    lines: list[str] = []
    if room:
        r = _resolve_room(room)
        room_ref = r["livekit_room_name"] or r["name"]
        for agent_id in [a.strip().removeprefix("agent-") for a in (remove_agents or "").split(",") if a.strip()]:
            try:
                res = _voice_exec(_LEAVE_SCRIPT, {"room": room_ref, "agent_id": agent_id})
                if res.get("ok"):
                    lines.append(f"kick {agent_id}: ok (removed={res.get('memberships_removed')})")
                else:
                    lines.append(f"kick {agent_id}: FAILED {res.get('error')}")
            except Exception as e:
                lines.append(f"kick {agent_id}: FAILED {e}")
        # Always leave as the bridge identity last.
        try:
            res = _voice_exec(
                _LEAVE_SCRIPT, {"room": room_ref, "agent_id": BRIDGE_AGENT_ID}
            )
            if res.get("ok"):
                lines.append(
                    f"leave as {BRIDGE_AGENT_ID}: ok "
                    f"(removed={res.get('memberships_removed')})"
                )
            else:
                lines.append(f"leave: FAILED {res.get('error')}")
        except Exception as e:
            lines.append(f"leave: FAILED {e}")
    elif remove_agents:
        return "FAILED: room is required when remove_agents is set"
    else:
        return (
            "Nothing to do — pass room=... and/or remove_agents=id1,id2. "
            "After this returns, stop the MCP client."
        )
    lines.append("Bridge session closed. Safe to stop the MCP client.")
    # Clear local poll baseline so a later session doesn't skip messages.
    if room:
        try:
            rid = _resolve_room(room)["id"]
            _last_seen.pop(rid, None)
            _room_cache.clear()
        except Exception:
            pass
    return "\n".join(lines)


# --- self-test / entrypoint --------------------------------------------------
def _watch(room: str, since_iso: str, max_seconds: int) -> None:
    """Block until a new (non-bridge) message appears, print it as JSON, exit.

    Run BACKGROUNDED (`Bash run_in_background`) so the harness re-invokes Claude
    when a message lands — event-driven async with no held-open turn / spinner.
    On timeout it prints an empty batch (so the caller can relaunch).
    """
    r = _resolve_room(room)
    since = since_iso or _baseline(r["id"])
    deadline = time.monotonic() + max(5, int(max_seconds))
    while time.monotonic() < deadline:
        msgs = _fetch_new(r["id"], since)
        if msgs:
            print(json.dumps({"room": r["name"], "messages": msgs, "latest": msgs[-1]["created_at"]}))
            return
        time.sleep(POLL_INTERVAL_S)
    print(json.dumps({"room": r["name"], "messages": [], "latest": since, "timed_out": True}))


def _selftest(room: str, do_send: bool) -> None:
    print("== list_rooms ==")
    print(list_rooms())
    print(f"\n== resolve {room!r} ==")
    print(_resolve_room(room))
    print(f"\n== get_new_messages({room!r}) ==")
    print(get_new_messages(room))
    if do_send:
        print(f"\n== send_message({room!r}) ==")
        print(send_message(room, "Self-test ping from the bridge (safe to ignore)."))


if __name__ == "__main__":
    import sys

    if "--kb" in sys.argv:
        # --kb ACTION '<json payload>'  (direct exercise of the KB path, no MCP)
        i = sys.argv.index("--kb")
        action = sys.argv[i + 1]
        payload = json.loads(sys.argv[i + 2]) if len(sys.argv) > i + 2 else {}
        print(json.dumps(_kb_exec(action, payload), indent=2))
    elif "--selftest" in sys.argv:
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        _selftest(args[0] if args else "agent-test", do_send="--send" in sys.argv)
    elif "--watch" in sys.argv:
        a = sys.argv
        room = a[a.index("--watch") + 1]
        since = a[a.index("--since") + 1] if "--since" in a else ""
        maxs = int(a[a.index("--max-seconds") + 1]) if "--max-seconds" in a else 3000
        _watch(room, since, maxs)
    else:
        mcp.run()
