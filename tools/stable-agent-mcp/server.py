#!/usr/bin/env python3
"""Stable Agent MCP — a SCOPED, SSH-free bridge that lets a dev-lane agent
(Codex / OpenCode / Corporal Qwen / Claude) post into and READ from Stable
("Unicorn Command Center") channels AS ITS OWN identity, over the public
agent-gateway (ORCH-1), using a scoped gateway key.

Unlike the older ssh + `docker exec` bridge it replaces (that server is no longer
in this repo), THIS server carries no SSH, no docker, no DB creds — only a
scoped gateway key and a public base URL:

  * STABLE_GATEWAY_TOKEN  -> a scoped gateway key (`sbk-…`). Bound server-side to
                             ONE agent identity + a room allowlist; the caller
                             CANNOT choose which agent it posts as (no impersonation).
                             A Keycloak user JWT with the `stable-agent-gateway` role
                             also works.
  * STABLE_GATEWAY_BASE_URL -> the public backend, e.g. https://example.com

Contract (ORCH-1 gateway, app/api/gateway.py):

  WRITE  -> POST {base}/api/v1/gateway/messages
            headers: Authorization: Bearer <STABLE_GATEWAY_TOKEN>
            json:    {room, content, parent_id?, via?}
            The gateway DERIVES the agent identity from the token (a key's bound
            agent_id, or `dev-<username>` for a JWT) — `room` is a livekit_room_name
            or slug. Scope (room allowlist / membership) enforced server-side.

  READ   -> GET {base}/api/v1/gateway/rooms/{room}/messages?limit=&cursor=
            headers: Authorization: Bearer <STABLE_GATEWAY_TOKEN>
            The token-authed read endpoint (finally) — so get_new_messages works.

  VOICE  -> POST {base}/api/v1/gateway/tts   (suite Kokoro / Orator)
            POST {base}/api/v1/gateway/stt   (suite Amanuensis / Parakeet)

  EXIT   -> POST   {base}/api/v1/gateway/rooms/{room}/leave
            DELETE {base}/api/v1/gateway/rooms/{room}/brigade-agents/{id}
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP

# --- config (env-driven; NO secrets baked in) --------------------------------
AGENT_DISPLAY_NAME = os.environ.get("AGENT_DISPLAY_NAME", "").strip()

# The scoped gateway key (sbk-…) or a Keycloak JWT. Back-compat: honor the old name.
GATEWAY_TOKEN = (
    os.environ.get("STABLE_GATEWAY_TOKEN", "").strip()
    or os.environ.get("STABLE_INTERNAL_TOKEN", "").strip()
)

# Public backend base URL. Back-compat: honor the old internal-base name.
BASE_URL = (
    os.environ.get("STABLE_GATEWAY_BASE_URL", "").strip()
    or os.environ.get("STABLE_INTERNAL_BASE_URL", "").strip()
    or "http://localhost"
).rstrip("/")

GATEWAY_MESSAGES_URL = f"{BASE_URL}/api/v1/gateway/messages"
GATEWAY_TTS_URL = f"{BASE_URL}/api/v1/gateway/tts"
GATEWAY_STT_URL = f"{BASE_URL}/api/v1/gateway/stt"


def _gateway_read_url(room: str, limit: int, cursor: str) -> str:
    q = {"limit": str(limit)}
    if cursor:
        q["cursor"] = cursor
    return (
        f"{BASE_URL}/api/v1/gateway/rooms/"
        f"{urllib.parse.quote(room, safe='')}/messages?{urllib.parse.urlencode(q)}"
    )


def _gateway_leave_url(room: str) -> str:
    return (
        f"{BASE_URL}/api/v1/gateway/rooms/"
        f"{urllib.parse.quote(room, safe='')}/leave"
    )


def _gateway_remove_agent_url(room: str, agent_id: str) -> str:
    return (
        f"{BASE_URL}/api/v1/gateway/rooms/"
        f"{urllib.parse.quote(room, safe='')}/brigade-agents/"
        f"{urllib.parse.quote(agent_id, safe='')}"
    )


# Optional lane prefix for attribution when several lanes share one identity.
LANE_PREFIX = os.environ.get("STABLE_LANE_PREFIX", "").strip()

# Optional client-side convenience allowlist mapping friendly->livekit_room_name.
# The gateway enforces the REAL scope server-side (the key's allowed_rooms); this
# is just a nicety so lanes can use friendly names. Comma-separated:
#   STABLE_ROOMS="dev-lane=stable-dev-lane,backlog=stable-backlog"
_RAW_ROOMS = os.environ.get("STABLE_ROOMS", "").strip()

HTTP_TIMEOUT = float(os.environ.get("STABLE_HTTP_TIMEOUT_S", "30"))
# Voice synthesis/transcription can take longer on cold GPU.
VOICE_HTTP_TIMEOUT = float(os.environ.get("STABLE_VOICE_HTTP_TIMEOUT_S", "120"))

mcp = FastMCP("stable-agent")


def _parse_rooms(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" in chunk:
            name, lk = (p.strip() for p in chunk.split("=", 1))
        else:
            lk = chunk
            name = lk[len("stable-"):] if lk.startswith("stable-") else lk
        if lk:
            out[name] = lk
    return out


_ROOMS = _parse_rooms(_RAW_ROOMS)


def _resolve_room(room: str) -> str:
    """Map a friendly name to a livekit_room_name if configured, else pass through.
    The gateway accepts either a livekit_room_name or a room slug directly."""
    room = (room or "").strip()
    if not room:
        raise ValueError("room is required")
    if room in _ROOMS:
        return _ROOMS[room]
    return room


def _auth_headers(*, content_type: str | None = "application/json") -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {GATEWAY_TOKEN}",
        # Cloudflare fronts the public hosts and 403s (error 1010) the default
        # python-urllib User-Agent; present a curl UA so lanes work through CF.
        "User-Agent": os.environ.get("STABLE_HTTP_USER_AGENT", "curl/8.4.0"),
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _request(
    url: str,
    *,
    method: str,
    payload: dict | None = None,
    timeout: float | None = None,
    raw_body: bool = False,
) -> dict:
    if payload is not None:
        data: bytes | None = json.dumps(payload).encode()
        headers = _auth_headers(content_type="application/json")
    elif method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
        # Empty body (leave/kick). Avoid Content-Type: application/json with no body.
        data = b""
        headers = _auth_headers(content_type=None)
    else:
        data = None
        headers = _auth_headers(content_type=None)
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )
    to = HTTP_TIMEOUT if timeout is None else timeout
    try:
        with urllib.request.urlopen(req, timeout=to) as resp:
            raw_bytes = resp.read()
            status = resp.status
            content_type = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return {"status": e.code, "detail": e.read().decode(errors="replace")[:400]}
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"cannot reach {url}: {e.reason}. Confirm STABLE_GATEWAY_BASE_URL is "
            "reachable and the gateway is enabled."
        ) from e
    if raw_body:
        return {
            "status": status,
            "content_type": content_type,
            "raw": raw_bytes,
        }
    raw = raw_bytes.decode() if raw_bytes else ""
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        body = {}
    return {"status": status, "body": body}


def _multipart_post(
    url: str,
    *,
    fields: dict[str, str],
    file_field: str,
    filename: str,
    file_bytes: bytes,
    content_type: str,
    timeout: float | None = None,
) -> dict:
    """Minimal multipart/form-data POST without third-party deps."""
    boundary = "----StableAgentBoundary7MA4YWxkTrZu0gW"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        )
        chunks.append(value.encode())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode()
    )
    chunks.append(file_bytes)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)

    headers = _auth_headers(content_type=f"multipart/form-data; boundary={boundary}")
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    to = VOICE_HTTP_TIMEOUT if timeout is None else timeout
    try:
        with urllib.request.urlopen(req, timeout=to) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        return {"status": e.code, "detail": e.read().decode(errors="replace")[:400]}
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"cannot reach {url}: {e.reason}. Confirm STABLE_GATEWAY_BASE_URL is "
            "reachable and the gateway is enabled."
        ) from e
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = {"text": raw}
    return {"status": status, "body": parsed}


def _require_config() -> str | None:
    missing = []
    if not GATEWAY_TOKEN:
        missing.append("STABLE_GATEWAY_TOKEN")
    if not BASE_URL:
        missing.append("STABLE_GATEWAY_BASE_URL")
    return "Missing required env: " + ", ".join(missing) if missing else None


def _apply_prefix(content: str) -> str:
    return f"[{LANE_PREFIX}] {content}" if LANE_PREFIX else content


# --- MCP tools ---------------------------------------------------------------
@mcp.tool()
def list_rooms() -> str:
    """List the Stable channels this lane is configured for.

    The REAL scope is the gateway key's server-side room allowlist. This lists the
    optional client-side friendly-name map (STABLE_ROOMS); you can also pass a
    livekit_room_name or slug straight to send_message / get_new_messages.
    """
    if not _ROOMS:
        return (
            "No friendly-name map configured (STABLE_ROOMS). Pass a room slug or "
            "livekit_room_name directly to send_message / get_new_messages — the "
            "gateway enforces your key's room scope server-side."
        )
    lines = [f"{'name':<24} livekit_room_name"]
    for name, lk in sorted(_ROOMS.items()):
        lines.append(f"{name:<24} {lk}")
    return "\n".join(lines)


@mcp.tool()
def send_message(room: str, content: str) -> str:
    """Post a message into a Stable channel AS this lane's own agent identity.

    Posts over the public gateway with the scoped key (no SSH). The gateway
    DERIVES the agent identity from the token — you cannot post as another agent.

    Args:
        room: a friendly name from list_rooms, a room slug, or a livekit_room_name.
        content: the message text (markdown ok).
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    try:
        room_ref = _resolve_room(room)
    except ValueError as e:
        return f"FAILED: {e}"
    res = _request(
        GATEWAY_MESSAGES_URL,
        method="POST",
        payload={"room": room_ref, "content": _apply_prefix(content)},
    )
    if res.get("status", 0) >= 300:
        return f"FAILED to post (status {res.get('status')}): {res.get('detail')}"
    who = AGENT_DISPLAY_NAME or (res.get("body", {}).get("sender_name")) or "this agent"
    return f"Sent to {room_ref} as {who} (status {res['status']})."


@mcp.tool()
def get_new_messages(room: str, since: str = "", limit: int = 30) -> str:
    """Fetch recent messages in a Stable channel (token-authed read via the gateway).

    Args:
        room: a friendly name, room slug, or livekit_room_name.
        since: optional opaque cursor from a prior call (forward pagination).
        limit: max messages to return (1-100).
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    try:
        room_ref = _resolve_room(room)
    except ValueError as e:
        return f"FAILED: {e}"
    limit = max(1, min(int(limit or 30), 100))
    res = _request(_gateway_read_url(room_ref, limit, since), method="GET")
    if res.get("status", 0) >= 300:
        return f"FAILED to read (status {res.get('status')}): {res.get('detail')}"
    body = res.get("body", {})
    msgs = body.get("messages", [])
    if not msgs:
        return f"No messages in {room_ref}."
    lines = [f"# {room_ref} — {len(msgs)} message(s), newest first"]
    for m in msgs:
        who = m.get("sender_name") or "?"
        when = (m.get("created_at") or "")[:19].replace("T", " ")
        lines.append(f"[{when}] {who}: {m.get('content', '')}")
    cursor = body.get("cursor")
    if cursor and body.get("has_more"):
        lines.append(f"\n(more available — pass since={cursor!r})")
    return "\n".join(lines)


@mcp.tool()
def speak_text(
    text: str,
    voice: str = "",
    agent: str = "",
    out_path: str = "",
    speed: float = 1.0,
) -> str:
    """Synthesize speech via suite TTS (Kokoro / Orator) through the Stable gateway.

    Returns a short summary and either writes mp3 bytes to ``out_path`` or
    includes a base64 prefix of the audio so callers can save it.

    Args:
        text: words to speak (max ~4000 chars; emoji-only text is rejected).
        voice: optional Kokoro voice id (e.g. af_heart). Overrides agent map.
        agent: optional brigade agent id / display name for preset voice.
        out_path: if set, write the mp3 here; otherwise return base64 (truncated).
        speed: 0.5–2.0 playback rate (default 1.0).
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    if not (text or "").strip():
        return "FAILED: text is required"
    payload: dict = {"text": text, "speed": float(speed or 1.0)}
    if voice:
        payload["voice"] = voice
    if agent:
        payload["agent"] = agent
    res = _request(
        GATEWAY_TTS_URL,
        method="POST",
        payload=payload,
        timeout=VOICE_HTTP_TIMEOUT,
        raw_body=True,
    )
    if res.get("status", 0) >= 300:
        return f"FAILED to synthesize (status {res.get('status')}): {res.get('detail')}"
    audio: bytes = res.get("raw") or b""
    if not audio:
        return "FAILED: empty audio response"
    if out_path:
        path = pathlib.Path(out_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(audio)
        return (
            f"Spoke {len(text)} chars → {len(audio)} byte mp3 written to {path} "
            f"(content-type={res.get('content_type') or 'audio/mpeg'})."
        )
    b64 = base64.b64encode(audio).decode()
    preview = b64 if len(b64) <= 200 else b64[:200] + "…"
    return (
        f"Spoke {len(text)} chars → {len(audio)} byte mp3 "
        f"(content-type={res.get('content_type') or 'audio/mpeg'}). "
        f"base64_preview={preview} (pass out_path to save full audio)."
    )


@mcp.tool()
def transcribe_audio(
    path: str,
    language: str = "",
    model: str = "",
) -> str:
    """Transcribe an audio file via suite STT (Amanuensis / Parakeet) through the gateway.

    Args:
        path: local filesystem path to an audio file (wav/mp3/webm/m4a/ogg/flac).
        language: optional BCP-47 / ISO language hint (e.g. en).
        model: optional model name (default whisper-1; suite ignores if single-model).
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    p = pathlib.Path(path).expanduser()
    if not p.is_file():
        return f"FAILED: file not found: {p}"
    data = p.read_bytes()
    if not data:
        return "FAILED: empty audio file"
    # Guess content-type from suffix.
    suffix = p.suffix.lower()
    ctype = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
        ".mp4": "audio/mp4",
    }.get(suffix, "application/octet-stream")
    fields: dict[str, str] = {}
    if language:
        fields["language"] = language
    if model:
        fields["model"] = model
    res = _multipart_post(
        GATEWAY_STT_URL,
        fields=fields,
        file_field="file",
        filename=p.name,
        file_bytes=data,
        content_type=ctype,
    )
    if res.get("status", 0) >= 300:
        return f"FAILED to transcribe (status {res.get('status')}): {res.get('detail')}"
    body = res.get("body") or {}
    text = body.get("text") if isinstance(body, dict) else None
    if text is None:
        return f"Transcribed (raw): {body!r}"
    lang = body.get("language") if isinstance(body, dict) else None
    extra = f" language={lang}" if lang else ""
    return f"Transcript{extra}:\n{text}"


@mcp.tool()
def leave_room(room: str) -> str:
    """Leave a Stable room as this lane's agent identity (clean bridge exit).

    Removes the agent from the room member strip and best-effort-evicts LiveKit
    so the channel no longer shows a stuck agent after the MCP session ends.

    Args:
        room: friendly name, room slug, or livekit_room_name.
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    try:
        room_ref = _resolve_room(room)
    except ValueError as e:
        return f"FAILED: {e}"
    res = _request(_gateway_leave_url(room_ref), method="POST", payload=None)
    status = res.get("status", 0)
    # 204 No Content is success; urllib may surface it as status 204 with empty body.
    if status and status >= 300:
        return f"FAILED to leave (status {status}): {res.get('detail')}"
    return f"Left room {room_ref} as this agent. Member strip should clear shortly."


@mcp.tool()
def close_bridge_session(room: str = "", remove_agents: str = "") -> str:
    """Close out a Stable Bridge session cleanly.

    Prefer calling this when the human is done with the bridge conversation:
      1. Optionally kick stuck agents listed in ``remove_agents`` (comma-separated
         brigade agent ids, e.g. ``claude,majik``).
      2. Leave the room as this lane's own identity (if ``room`` is set).

    Args:
        room: room to leave (friendly name / slug / livekit_room_name). Empty skips leave.
        remove_agents: comma-separated brigade agent ids to kick first.
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    lines: list[str] = []
    room_ref = ""
    if room:
        try:
            room_ref = _resolve_room(room)
        except ValueError as e:
            return f"FAILED: {e}"

    for agent_id in [a.strip() for a in (remove_agents or "").split(",") if a.strip()]:
        if not room_ref:
            lines.append(f"skip kick {agent_id}: room required")
            continue
        res = _request(
            _gateway_remove_agent_url(room_ref, agent_id),
            method="DELETE",
            payload=None,
        )
        status = res.get("status", 0)
        if status and status >= 300:
            lines.append(f"kick {agent_id}: FAILED ({status}) {res.get('detail')}")
        else:
            lines.append(f"kick {agent_id}: ok")

    if room_ref:
        res = _request(_gateway_leave_url(room_ref), method="POST", payload=None)
        status = res.get("status", 0)
        if status and status >= 300:
            lines.append(f"leave {room_ref}: FAILED ({status}) {res.get('detail')}")
        else:
            lines.append(f"leave {room_ref}: ok")
    elif not lines:
        return (
            "Nothing to do — pass room=... and/or remove_agents=agent1,agent2. "
            "After this returns, you can stop the MCP client process."
        )

    lines.append("Bridge session closed. Safe to stop the MCP client.")
    return "\n".join(lines)


@mcp.tool()
def remove_room_agent(room: str, brigade_agent_id: str) -> str:
    """Remove a stuck Brigade agent from a room this key is scoped to.

    Args:
        room: friendly name, room slug, or livekit_room_name.
        brigade_agent_id: e.g. claude, majik, sgt-swift (not the agent- prefix).
    """
    err = _require_config()
    if err:
        return f"NOT CONFIGURED: {err}"
    try:
        room_ref = _resolve_room(room)
    except ValueError as e:
        return f"FAILED: {e}"
    agent_id = (brigade_agent_id or "").strip().removeprefix("agent-")
    if not agent_id:
        return "FAILED: brigade_agent_id required"
    res = _request(
        _gateway_remove_agent_url(room_ref, agent_id),
        method="DELETE",
        payload=None,
    )
    status = res.get("status", 0)
    if status and status >= 300:
        return f"FAILED to remove (status {status}): {res.get('detail')}"
    return f"Removed agent {agent_id} from {room_ref}."


# --- self-test / entrypoint --------------------------------------------------
def _selftest(room: str, do_send: bool) -> None:
    print("== config ==")
    print(f"BASE_URL={BASE_URL!r} display={AGENT_DISPLAY_NAME!r} prefix={LANE_PREFIX!r}")
    print(f"GATEWAY_MESSAGES_URL={GATEWAY_MESSAGES_URL!r}")
    print(f"token_set={bool(GATEWAY_TOKEN)}")
    err = _require_config()
    print(f"config_ok={err is None} ({err or 'ok'})")
    print("\n== list_rooms ==")
    print(list_rooms())
    print(f"\n== get_new_messages({room!r}) ==")
    print(get_new_messages(room, limit=5))
    if do_send:
        print(f"\n== send_message({room!r}) ==")
        print(send_message(room, "Self-test ping from stable-agent MCP (ignore)."))


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        _selftest(args[0] if args else "dev-brigade", do_send="--send" in sys.argv)
    else:
        mcp.run()
