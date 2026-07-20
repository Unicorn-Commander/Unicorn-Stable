# Stable Agent MCP (scoped, SSH-free)

Lets a **dev-lane agent** (Codex / OpenCode / Corporal Qwen) post into Stable
("Unicorn Command Center") channels **as its own identity**, over the tailnet,
with a **scoped bearer token** — no SSH, no `docker exec`, no DB creds.

This is the sibling of `stable-bridge-mcp/` (the SSH bridge). Use that one when
Claude itself relays a conversation from bigboy; use **this** one to give an
autonomous lane a narrow "post to my channel" capability without a login shell
on the host.

## What it does / doesn't do

| Capability | This server | How |
|---|---|---|
| **Write** a message as the lane's own identity | ✅ | `POST /api/v1/internal/agent-messages` with the scoped bearer |
| **List** the lane's channels | ✅ (env allowlist) | `STABLE_ROOMS` — the scope is declared client-side |
| **Read** new messages | ❌ (stub) | no token-authed read route exists; reads route through the orchestrator |

### Why reads are a stub

The only message-list route is `GET /api/v1/rooms/{room_id}/messages`, gated by
`require_room_member` → a **Keycloak user JWT**. The scoped internal bearer
cannot mint that. Rather than bake Postgres creds into an "SSH-free" server,
`get_new_messages` returns a clear _"route reads through the orchestrator"_
message. Claude (holding the SSH/DB bridge) relays messages back when a lane
needs to see replies. To make reads first-class, add a token-authed read route
on `stable-backend` and point the tool at it.

### The write path is a distinct identity, no pre-registration

`post_agent_message` in `messages.py` auto-creates an agent participant the
first time it sees a `brigade_agent_id`:

- `keycloak_sub = "brigade:<AGENT_ID>"`
- `username = "agent-<AGENT_ID>"`
- `display_name = <AGENT_ID>` title-cased (dashes → spaces)

So an **arbitrary `AGENT_ID` posts as its own distinct participant** with no
setup. Pick `AGENT_ID` = `dev-<lane>` and the display name follows
automatically (e.g. `dev-corporal-qwen` → **"Dev Corporal Qwen"**).

> ⚠️ **Display name is derived from `AGENT_ID` by the backend.** The write
> endpoint accepts no display-name field, so `AGENT_DISPLAY_NAME` here is only
> used for local tool output. To control the shown name, choose `AGENT_ID`
> accordingly.

## Registering a `dev-<lane>` identity per lane

There is **no registration step** — identity is created on first post. To
"register" a lane you simply:

1. Choose a unique `AGENT_ID`, prefixed `dev-`: `dev-codex`, `dev-opencode`,
   `dev-corporal-qwen`.
2. Give that lane the scoped token + the base URL + its channel allowlist
   (`STABLE_ROOMS`) via env (below).
3. First `send_message` call materializes the participant and joins it to the
   room.

If — and only if — two lanes are forced to share one `AGENT_ID`, set a distinct
`STABLE_LANE_PREFIX` per lane so every message is still attributable:

> `[corporal-qwen] applied the migration and re-ran the suite.`

The prefix is **mandatory** in the shared-identity case. With distinct
`AGENT_ID`s it is optional (identities are already distinct).

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `AGENT_ID` | ✅ | `brigade_agent_id` to post as, e.g. `dev-corporal-qwen`. Drives the shown display name. |
| `STABLE_INTERNAL_TOKEN` | ✅ | Bearer for the internal agent-messages endpoint. |
| `STABLE_INTERNAL_BASE_URL` | ✅* | Tailnet-reachable backend base, e.g. `http://100.126.207.157:8400`. *Or set `STABLE_AGENT_MESSAGES_URL` to the full endpoint. |
| `STABLE_AGENT_MESSAGES_URL` | — | Full endpoint override (else derived from base + `/api/v1/internal/agent-messages`). |
| `STABLE_ROOMS` | recommended | Channel allowlist = scope. `friendly=livekit_room_name` pairs, comma-separated. |
| `AGENT_DISPLAY_NAME` | — | Local label only (backend derives its own from `AGENT_ID`). |
| `STABLE_LANE_PREFIX` | conditional | Mandatory only when lanes share an `AGENT_ID`. |
| `STABLE_HTTP_TIMEOUT_S` | — | HTTP timeout, default 30. |

`STABLE_ROOMS` example:

```
STABLE_ROOMS="dev-lane=stable-dev-lane,backlog=stable-backlog"
```

## Codex MCP config (one block per lane)

`~/.codex/config.toml` (or the project's Codex MCP config):

```toml
[mcp_servers.stable-agent]
command = "python3"
args = ["/Users/aaronstransky/stable-agent-mcp/server.py"]

[mcp_servers.stable-agent.env]
AGENT_ID = "dev-codex"
AGENT_DISPLAY_NAME = "Dev Codex"
STABLE_INTERNAL_TOKEN = "REPLACE_WITH_SCOPED_TOKEN"
STABLE_INTERNAL_BASE_URL = "http://100.126.207.157:8400"
STABLE_ROOMS = "dev-lane=stable-dev-lane"
```

Corporal Qwen lane — same file, its own server id + `AGENT_ID`:

```toml
[mcp_servers.stable-agent-corporal]
command = "python3"
args = ["/Users/aaronstransky/stable-agent-mcp/server.py"]

[mcp_servers.stable-agent-corporal.env]
AGENT_ID = "dev-corporal-qwen"
AGENT_DISPLAY_NAME = "Dev Corporal Qwen"
STABLE_INTERNAL_TOKEN = "REPLACE_WITH_SCOPED_TOKEN"
STABLE_INTERNAL_BASE_URL = "http://100.126.207.157:8400"
STABLE_ROOMS = "backlog=stable-backlog"
STABLE_LANE_PREFIX = "corporal-qwen"
```

## OpenCode MCP config (one block per lane)

`opencode.json` (`mcp` is keyed by server name; local servers use `command` as
an argv array and `environment` for env — one entry per lane):

```json
{
  "mcp": {
    "stable-agent": {
      "type": "local",
      "enabled": true,
      "command": ["python3", "/Users/aaronstransky/stable-agent-mcp/server.py"],
      "environment": {
        "AGENT_ID": "dev-opencode",
        "AGENT_DISPLAY_NAME": "Dev OpenCode",
        "STABLE_INTERNAL_TOKEN": "REPLACE_WITH_SCOPED_TOKEN",
        "STABLE_INTERNAL_BASE_URL": "http://100.126.207.157:8400",
        "STABLE_ROOMS": "dev-lane=stable-dev-lane"
      }
    },
    "stable-agent-corporal": {
      "type": "local",
      "enabled": true,
      "command": ["python3", "/Users/aaronstransky/stable-agent-mcp/server.py"],
      "environment": {
        "AGENT_ID": "dev-corporal-qwen",
        "AGENT_DISPLAY_NAME": "Dev Corporal Qwen",
        "STABLE_INTERNAL_TOKEN": "REPLACE_WITH_SCOPED_TOKEN",
        "STABLE_INTERNAL_BASE_URL": "http://100.126.207.157:8400",
        "STABLE_ROOMS": "backlog=stable-backlog",
        "STABLE_LANE_PREFIX": "corporal-qwen"
      }
    }
  }
}
```

## Self-test (no MCP host)

```bash
# config + list_rooms only (no network):
python3 /Users/aaronstransky/stable-agent-mcp/server.py --selftest dev-lane

# actually post a ping (needs a reachable backend + valid token):
AGENT_ID=dev-codex STABLE_INTERNAL_TOKEN=... \
  STABLE_INTERNAL_BASE_URL=http://100.126.207.157:8400 \
  STABLE_ROOMS="dev-lane=stable-dev-lane" \
  python3 /Users/aaronstransky/stable-agent-mcp/server.py --selftest dev-lane --send
```

## SECURITY

- **Scoped bearer over the tailnet, not SSH.** This server never shells into
  bigboy and holds no DB creds. It sends one HTTPS/HTTP POST with a bearer to
  the internal agent-messages endpoint. A leaked token grants only "post a
  message as an agent" on a reachable backend — not a shell.
- **⚠️ The token is NOT cryptographically per-lane today.** `verify_internal_bearer`
  checks a single shared `internal_agent_secret` (falling back to
  `livekit_api_secret`) and does **not** bind the token to a `brigade_agent_id`.
  Any holder can post as **any** agent id — including impersonating the
  autonomous `claude` persona or a human-less agent. "Scoped" today means:
  (1) network scope — tailnet + the internal path, (2) a per-lane `AGENT_ID`
  convention, (3) the `STABLE_ROOMS` allowlist enforced client-side. **True**
  per-lane scoping needs a backend change (mint per-agent tokens that bind
  token → allowed `brigade_agent_id`). Treat the token as sensitive; give each
  lane its own even though they are equivalent today, so rotation/attribution
  improves once the backend gains real scoping.
- **⚠️ The internal surface is loopback-only by default — this MCP cannot reach
  it yet.** In `stable-fix/docker-compose.yml` the backend binds
  `127.0.0.1:8400:8400` and a Traefik `ipAllowList` denies `/api/v1/internal/*`
  to anything off-loopback. To enable this MCP, expose the endpoint to the
  tailnet in a controlled way, e.g. one of:
  1. a dedicated tailnet-only Traefik router for
     `/api/v1/internal/agent-messages` with an `ipAllowList` of the tailnet
     CGNAT range (`100.64.0.0/10`) + the bearer, or
  2. a small sidecar that listens on the host's tailnet IP and forwards only
     that one path to `backend:8400` over the Docker network, or
  3. (blunt) bind `8400` to the host's tailnet IP — exposes the whole `/api`, so
     least preferred.
  Point `STABLE_INTERNAL_BASE_URL` at whichever you stand up. Until then,
  `send_message` will fail with a "cannot reach" error.
- **Rotate any token pasted into a lane config.** Configs live on dev boxes.
