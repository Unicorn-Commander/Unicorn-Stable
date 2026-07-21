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
                             A uchub user JWT with the `stable-agent-gateway` role
                             also works.
  * STABLE_GATEWAY_BASE_URL -> the public backend, e.g. https://stable.magicunicorn.dev

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
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP

# --- config (env-driven; NO secrets baked in) --------------------------------
AGENT_DISPLAY_NAME = os.environ.get("AGENT_DISPLAY_NAME", "").strip()

# The scoped gateway key (sbk-…) or a uchub JWT. Back-compat: honor the old name.
GATEWAY_TOKEN = (
    os.environ.get("STABLE_GATEWAY_TOKEN", "").strip()
    or os.environ.get("STABLE_INTERNAL_TOKEN", "").strip()
)

# Public backend base URL. Back-compat: honor the old internal-base name.
BASE_URL = (
    os.environ.get("STABLE_GATEWAY_BASE_URL", "").strip()
    or os.environ.get("STABLE_INTERNAL_BASE_URL", "").strip()
    or "https://stable.magicunicorn.dev"
).rstrip("/")

GATEWAY_MESSAGES_URL = f"{BASE_URL}/api/v1/gateway/messages"


def _gateway_read_url(room: str, limit: int, cursor: str) -> str:
    q = {"limit": str(limit)}
    if cursor:
        q["cursor"] = cursor
    return (
        f"{BASE_URL}/api/v1/gateway/rooms/"
        f"{urllib.parse.quote(room, safe='')}/messages?{urllib.parse.urlencode(q)}"
    )


# Optional lane prefix for attribution when several lanes share one identity.
LANE_PREFIX = os.environ.get("STABLE_LANE_PREFIX", "").strip()

# Optional client-side convenience allowlist mapping friendly->livekit_room_name.
# The gateway enforces the REAL scope server-side (the key's allowed_rooms); this
# is just a nicety so lanes can use friendly names. Comma-separated:
#   STABLE_ROOMS="dev-lane=stable-dev-lane,backlog=stable-backlog"
_RAW_ROOMS = os.environ.get("STABLE_ROOMS", "").strip()

HTTP_TIMEOUT = float(os.environ.get("STABLE_HTTP_TIMEOUT_S", "30"))

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


def _request(url: str, *, method: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GATEWAY_TOKEN}",
            # Cloudflare fronts the public hosts and 403s (error 1010) the default
            # python-urllib User-Agent; present a curl UA so lanes work through CF.
            "User-Agent": os.environ.get("STABLE_HTTP_USER_AGENT", "curl/8.4.0"),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        return {"status": e.code, "detail": e.read().decode()[:400]}
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"cannot reach {url}: {e.reason}. Confirm STABLE_GATEWAY_BASE_URL is "
            "reachable and the gateway is enabled."
        ) from e
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        body = {}
    return {"status": status, "body": body}


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
