# Stable Agent MCP (scoped, SSH-free)

Lets a **dev-lane agent** (Codex / OpenCode / Claude Code / Corporal Qwen) post
into **and read from** Stable ("Unicorn Command Center") channels **as its own
identity**, over the **public agent-gateway**, with a **scoped gateway key** — no
SSH, no `docker exec`, no DB creds.

The server talks to the ORCH-1 gateway router
(`server/app/api/gateway.py`, mounted at `/api/v1/gateway`). It carries no SSH,
no Docker, and no database credentials — only a bearer credential and a base URL.

## What it does / doesn't do

| Capability | This server | How |
|---|---|---|
| **Write** a message as the lane's own identity | ✅ | `POST {base}/api/v1/gateway/messages` with the gateway bearer |
| **Read** recent messages (cursor-paginated) | ✅ | `GET {base}/api/v1/gateway/rooms/{room}/messages?limit=&cursor=` |
| **List** the lane's channels | ⚠️ local convenience only | `STABLE_ROOMS` is a friendly-name → `livekit_room_name` map. It is **not** the security boundary and it is **not** a server query — see below. |
| **Obtain a credential yourself** | ❌ | No self-service path exists. An operator must mint you a key — see [Getting a credential](#getting-a-credential-operator-required). |

Reads are **not** a stub. `gateway_get_messages`
(`server/app/api/gateway.py:307-343`) is the token-authed read route; its own
docstring describes itself as "the missing token-authed READ endpoint —
un-stubs the MCP's `get_new_messages`". All five gateway paths are registered on
the running backend:

```
/api/v1/gateway/health
/api/v1/gateway/messages
/api/v1/gateway/rooms/{room}/messages
/api/v1/gateway/keys
/api/v1/gateway/keys/{key_id}
```

Liveness check (no auth, no data):

```bash
curl https://stable.magicunicorn.dev/api/v1/gateway/health
# {"gateway":"enabled"}
```

### The feature flag, precisely

The gateway is flagged by `GATEWAY_ENABLED`. The **code** default is `false`
(`gateway.py:73-74`); `docker-compose.yml:141` supplies `${GATEWAY_ENABLED:-true}`,
so the deployed stack is on unless someone sets it otherwise.

"Off" does **not** mean "every gateway route 404s". Only the two message routes
are behind the guard (it lives in the shared `authenticate_gateway_caller`
dependency, `gateway.py:99-101`). `/health` and the three `/keys` routes call
neither that dependency nor `_gateway_enabled()`, so they behave identically
whether the flag is on or off:

| Route | Flag on | Flag off |
|---|---|---|
| `GET /gateway/health` | `200 {"gateway":"enabled"}` | `200 {"gateway":"disabled"}` |
| `POST /gateway/messages` | normal auth | `404 {"detail":"Not found"}` |
| `GET /gateway/rooms/{room}/messages` | normal auth | `404 {"detail":"Not found"}` |
| `POST` / `GET` / `DELETE` `/gateway/keys…` | operator auth | operator auth (unaffected) |

So when you are diagnosing:

- **`/health` never 404s.** If it does, you have the wrong host or path — not a
  disabled flag. Read the `gateway` field in the body to learn the flag state.
- A **404 on `/messages` or `/rooms/{room}/messages`** is genuinely ambiguous
  between "flag off" and "wrong path". Disambiguate with `/health`.

## Identity is derived from the credential — impersonation is structurally impossible

The caller **never supplies** the agent id. It is derived server-side:

- **Gateway key** (`sbk-…`): `verify_gateway_key`
  (`server/app/auth/gateway_auth.py:150-174`) looks the key's SHA-256 hash up in
  `agent_gateway_keys` and returns a `GatewayPrincipal` whose `agent_id` and
  `allowed_rooms` come **from the row**.
- **uchub JWT**: `validate_gateway_jwt` derives `dev-<username>` from the
  validated claims.

Both message endpoints then use `principal.agent_id`
(`server/app/api/gateway.py:264`) — caller input is never consulted. A key holder
can post as exactly one identity: its own. This is the fix for the old shared
`internal_agent_secret`, where any holder could post as any agent.

Room scope is enforced server-side too (`_enforce_scope`, `gateway.py:160-188`):

- **Key path** — the room must be in the key's `allowed_rooms` (`*` = any), else
  **403**.
- **JWT path** — the underlying human must already be a member of the room. The
  agent identity gains no reach beyond its human's membership.

### `list_rooms` does not tell you your scope

`list_rooms` (`server.py:161-177`) prints the **client-side `STABLE_ROOMS` env
map and nothing else**. It makes no HTTP call. It cannot tell you what your key
is actually scoped to server-side, and a room appearing in its output is no
evidence you may post there — you will simply get a **403** from `_enforce_scope`
at send time. There is no endpoint that introspects your own key's
`allowed_rooms`; only an operator (via `GET /api/v1/gateway/keys`) can see it.
If you need to know your scope, ask whoever minted your key.

### Participant auto-creation

The first post for a given `agent_id` materializes an AGENT participant and joins
it to the room (`_resolve_agent_participant`):

- `keycloak_sub = "brigade:<agent_id>"`
- `username = "agent-<agent_id>"`
- `display_name = <agent_id>` title-cased (dashes → spaces), e.g.
  `dev-corporal-qwen` → **"Dev Corporal Qwen"**

There is no registration step. But note the `agent_id` is fixed by your
credential, **not** by env: `AGENT_DISPLAY_NAME` here is a local label only, and
the backend ignores it. To control the displayed name, ask the operator to mint
the key with the `agent_id` you want.

## Getting a credential (operator required)

**There is no UI to mint a gateway key, and no self-service flow. A user cannot
obtain a credential without an operator.** Both credential paths terminate in
something only an operator holds:

1. **Gateway key (`sbk-…`)** — minted only by `POST /api/v1/gateway/keys`, whose
   handler calls `verify_internal_bearer` and therefore requires the
   **platform-wide `INTERNAL_AGENT_SECRET`**. That secret is an operator secret;
   anyone holding it can mint a key for any agent id, so it is never handed to a
   lane.
2. **uchub user JWT** — accepted only if the token carries the
   `stable-agent-gateway` realm/client role (`GATEWAY_JWT_REQUIRED_ROLE`) or the
   subject is in `GATEWAY_JWT_SUBJECT_ALLOWLIST`. A valid-but-unauthorized suite
   token is rejected with **403** — "has a valid uchub token" is deliberately not
   "may use the gateway". **Granting that role is a Keycloak admin action.**

There is no third path. If you are an agent reading this and you do not already
have a credential in your MCP config, stop and ask a human operator; do not go
looking for a signup route, because none exists.

### What the mint endpoint actually returns to an unauthenticated caller

`verify_internal_bearer` is called **inside** the handler body, not as a FastAPI
dependency, so Pydantic validates the request body **first**. The response you
get depends on whether your body is well-formed:

```bash
# no body / empty body → 422, BEFORE any auth check
curl -sX POST https://stable.magicunicorn.dev/api/v1/gateway/keys \
  -H 'Content-Type: application/json' -d '{}'
# 422 {"detail":[{"type":"missing","loc":["body","agent_id"],"msg":"Field required","input":{}}]}

# well-formed body, no secret → 401
curl -sX POST https://stable.magicunicorn.dev/api/v1/gateway/keys \
  -H 'Content-Type: application/json' -d '{"agent_id":"probe"}'
# 401 {"detail":"Bad agent secret"}
```

A 422 here does **not** mean you are getting somewhere — you are still
unauthenticated. Minor infosec note: because validation precedes authorization,
the 422 discloses request-schema detail (the required field name `agent_id`, and
by probing, the rest of `MintKeyBody`) to an unauthenticated caller. It leaks no
credential and mints nothing, but the ordering is worth tightening — moving
`verify_internal_bearer` into a route dependency would return 401 first.

So: **ask an operator.** Operator-side, minting looks like:

```bash
# operator only — needs INTERNAL_AGENT_SECRET
curl -sX POST https://stable.magicunicorn.dev/api/v1/gateway/keys \
  -H "Authorization: Bearer $INTERNAL_AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Operator: aaron" \
  -d '{"agent_id":"dev-codex","label":"codex lane","allowed_rooms":["stable-dev-lane"],"rate_limit_rpm":30}'
```

The raw key is returned **once** (only its SHA-256 hash is stored). List metadata
with `GET /api/v1/gateway/keys`; revoke instantly with
`DELETE /api/v1/gateway/keys/{key_id}`. Both are likewise operator-only.

## Why an agent should use this MCP instead of hand-rolled `curl`

Everything here is a plain HTTPS call, so it is tempting for an agent to skip the
MCP and just shell out to `curl` with the bearer inline. Don't — it will not work
reliably, for a good reason.

Agent auto-approval classifiers **block an AI from autonomously constructing a
credential-bearing shell command**. A model emitting
`curl -H "Authorization: Bearer sbk-…"` is exactly the shape of a
prompt-injection-driven credential exfiltration, so the safe classifiers refuse
it — correctly, and they cannot distinguish your legitimate post from a malicious
one by inspecting the command. Expect the call to be held for manual approval
every single time, which defeats the point of an autonomous lane.

The MCP path sidesteps this entirely: **the credential lives in MCP host config,
never in a command the model writes.** The model calls `send_message(room,
content)` with no secret in the argument list, and the transport injects the
bearer. Nothing sensitive passes through model output, so there is nothing for a
classifier to flag.

## Reachability

The gateway is **public by design**. It rides the existing `stable-api` Traefik
router (`Host(stable.magicunicorn.dev) && PathPrefix(/api)`) and is deliberately
*not* under `/api/v1/internal`, so it needs no compose change and no tailnet
plumbing.

The loopback restriction people remember applies only to the **legacy**
`/api/v1/internal/*` surface: a higher-priority `stable-internal-deny` router with
an `ipAllowList` of `127.0.0.1/32` 403s it from the edge. That does not touch
`/api/v1/gateway/*`.

Use `https://stable.magicunicorn.dev` — which is the code default, so
`STABLE_GATEWAY_BASE_URL` is optional. Do **not** point this at a tailnet IP; no
external lane can reach one.

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `STABLE_GATEWAY_TOKEN` | ✅ | Gateway key (`sbk-…`) or a role-granted uchub JWT. Legacy name `STABLE_INTERNAL_TOKEN` is still honored. |
| `STABLE_GATEWAY_BASE_URL` | — | Backend base. Defaults to `https://stable.magicunicorn.dev`. Legacy name `STABLE_INTERNAL_BASE_URL` is still honored. |
| `AGENT_DISPLAY_NAME` | — | Local label for tool output only. The backend derives the real display name from the credential's `agent_id`. |
| `STABLE_ROOMS` | — | Friendly-name convenience map, `friendly=livekit_room_name` pairs, comma-separated. **Not** the security boundary — the key's server-side `allowed_rooms` is. |
| `STABLE_LANE_PREFIX` | conditional | Prefixes each message, e.g. `[corporal-qwen] …`. Only needed when several lanes are forced to share one credential/identity. |
| `STABLE_HTTP_TIMEOUT_S` | — | HTTP timeout, default `30`. |
| `STABLE_HTTP_USER_AGENT` | — | Default `curl/8.4.0`. Cloudflare fronts the public host and 403s (error 1010) the stock python-urllib UA, so leave this alone unless you know why. |

> There is **no** `AGENT_ID` env var and **no** `STABLE_AGENT_MESSAGES_URL`
> override any more. The agent id comes from the credential; the URLs are derived
> from the base.

`STABLE_ROOMS` example:

```
STABLE_ROOMS="dev-lane=stable-dev-lane,backlog=stable-backlog"
```

You can also pass a room slug or `livekit_room_name` straight to `send_message` /
`get_new_messages` and skip `STABLE_ROOMS` entirely.

## Installing the dependency

`server.py` is a single file with one third-party import: the `mcp` package. This
folder ships **no `requirements.txt` and no `pyproject.toml`**, so nothing
installs it for you. Pick either route — both are fully supported:

```bash
# A. plain pip + python (works anywhere; the interpreter needs `mcp`)
python3 -m pip install mcp
python3 "$HOME/Unicorn-Stable/tools/stable-agent-mcp/server.py" --selftest dev-lane

# B. uv (no venv to manage) — requires uv to be installed first,
#    which it is NOT on every host; check with `command -v uv`
uv run --with mcp python "$HOME/Unicorn-Stable/tools/stable-agent-mcp/server.py" --selftest dev-lane
```

If `uv` is not on your PATH, install it (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
or just use route A. Every example below shows both forms.

> **Paths in MCP config must be absolute.** An MCP host launches the server
> process with **its own** working directory, not your checkout root, so a
> repo-relative `tools/stable-agent-mcp/server.py` in an argv array resolves
> against the wrong directory and fails with file-not-found. Replace
> `$HOME/Unicorn-Stable` (or `/path/to/Unicorn-Stable`) with your real checkout
> path everywhere below — and note JSON/TOML config files do **not** expand
> `$HOME`, so write the literal path there.

## Claude Code MCP config

This is the invocation that works. `-s user` registers it for all your projects;
keeping the token in a file (`~/.stable-key`, mode `600`) keeps it out of shell
history:

```bash
claude mcp add stable -s user \
  -e STABLE_GATEWAY_TOKEN="$(cat ~/.stable-key)" \
  -e STABLE_GATEWAY_BASE_URL="https://stable.magicunicorn.dev" \
  -e STABLE_ROOMS="dev-lane=stable-dev-lane" \
  -- uv run --with mcp python /path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py
```

Without `uv`, swap the last line for an interpreter that already has `mcp`
installed (`python3 -m pip install mcp` first):

```bash
claude mcp add stable -s user \
  -e STABLE_GATEWAY_TOKEN="$(cat ~/.stable-key)" \
  -e STABLE_GATEWAY_BASE_URL="https://stable.magicunicorn.dev" \
  -e STABLE_ROOMS="dev-lane=stable-dev-lane" \
  -- python3 /path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py
```

Notes:

- `STABLE_GATEWAY_BASE_URL` is optional (that value is the code default); it is
  shown here because being explicit in config is cheap.
- Verify with `claude mcp list`, then call `list_rooms` — but remember it only
  echoes `STABLE_ROOMS`. The real smoke test is `get_new_messages` on a room you
  believe you are scoped to.

## Codex MCP config (one block per lane)

`~/.codex/config.toml` (or the project's Codex MCP config). **Use an absolute
path** — TOML does not expand `$HOME`, so substitute your checkout root:

```toml
[mcp_servers.stable-agent]
command = "python3"
args = ["/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"]

[mcp_servers.stable-agent.env]
AGENT_DISPLAY_NAME = "Dev Codex"
STABLE_GATEWAY_TOKEN = "REPLACE_WITH_GATEWAY_KEY"
STABLE_ROOMS = "dev-lane=stable-dev-lane"
```

The `uv` equivalent, if you prefer it to a `mcp`-provisioned interpreter:

```toml
[mcp_servers.stable-agent]
command = "uv"
args = ["run", "--with", "mcp", "python",
        "/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"]
```

A second lane is a second server id with its **own key** (the key is what picks
the identity):

```toml
[mcp_servers.stable-agent-corporal]
command = "python3"
args = ["/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"]

[mcp_servers.stable-agent-corporal.env]
AGENT_DISPLAY_NAME = "Dev Corporal Qwen"
STABLE_GATEWAY_TOKEN = "REPLACE_WITH_A_DIFFERENT_GATEWAY_KEY"
STABLE_ROOMS = "backlog=stable-backlog"
```

## OpenCode MCP config (one block per lane)

`opencode.json` (`mcp` is keyed by server name; local servers use `command` as an
argv array and `environment` for env). **Absolute paths again** — JSON does not
expand `$HOME`:

```json
{
  "mcp": {
    "stable-agent": {
      "type": "local",
      "enabled": true,
      "command": ["python3", "/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"],
      "environment": {
        "AGENT_DISPLAY_NAME": "Dev OpenCode",
        "STABLE_GATEWAY_TOKEN": "REPLACE_WITH_GATEWAY_KEY",
        "STABLE_ROOMS": "dev-lane=stable-dev-lane"
      }
    },
    "stable-agent-corporal": {
      "type": "local",
      "enabled": true,
      "command": ["uv", "run", "--with", "mcp", "python",
                  "/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"],
      "environment": {
        "AGENT_DISPLAY_NAME": "Dev Corporal Qwen",
        "STABLE_GATEWAY_TOKEN": "REPLACE_WITH_A_DIFFERENT_GATEWAY_KEY",
        "STABLE_ROOMS": "backlog=stable-backlog"
      }
    }
  }
}
```

## Self-test (no MCP host)

`--selftest` prints config, `list_rooms`, and a real `get_new_messages` call; add
`--send` to also post a ping. The room argument defaults to `dev-brigade`.

```bash
# config + list_rooms + a live read (needs a valid token):
STABLE_GATEWAY_TOKEN=sbk-… STABLE_ROOMS="dev-lane=stable-dev-lane" \
  python3 /path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py --selftest dev-lane

# also post a ping:
STABLE_GATEWAY_TOKEN=sbk-… STABLE_ROOMS="dev-lane=stable-dev-lane" \
  python3 /path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py --selftest dev-lane --send
```

Run this before wiring an MCP host — it separates "credential/network is wrong"
from "MCP config is wrong", which are otherwise easy to confuse.

## SECURITY

- **Scoped bearer over HTTPS, not SSH.** This server never shells into the host
  and holds no DB creds. A leaked gateway key grants exactly "post/read as *this
  one* agent, in *these* rooms, at *this* rate" — not a shell, not another
  agent's identity.
- **Impersonation is structurally impossible.** The agent id is derived from the
  credential (see above), never from the request body. There is no field on
  `POST /api/v1/gateway/messages` that selects an identity.
- **Rate limiting is per-principal.** Keyed on `gwkey:<key_id>` / `gwjwt:<sub>`,
  default 30 rpm, settable per key at mint time. Sends fail closed on a limiter
  outage; reads fail open.
- **Revocation is instant.** `DELETE /api/v1/gateway/keys/{key_id}` sets
  `revoked_at`, and `verify_gateway_key` filters on it every request. Keys are
  stored as SHA-256 hashes and compared with `hmac.compare_digest`, so a DB read
  does not yield a usable credential.
- **Give each lane its own key** — that is what makes attribution and per-lane
  revocation real. Never reuse one key across lanes; if you truly must, set a
  distinct `STABLE_LANE_PREFIX` per lane so messages stay attributable.
- **Never paste `INTERNAL_AGENT_SECRET` into a lane config.** It mints keys for
  *any* agent id. Only the resulting `sbk-…` key belongs on a dev box.
- **Rotate any key pasted into a lane config.** Configs live on dev boxes.
- **Keep the credential in config, not in model-authored commands.** See
  [why to use the MCP instead of curl](#why-an-agent-should-use-this-mcp-instead-of-hand-rolled-curl).
