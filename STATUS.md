# STATUS.md — Stable Current State (2026-08-08)

## Deployment status

**Two production instances live and healthy** (flagship + dogfood), deployed
from this tree via `scripts/deploy.sh`; self-host from a fresh clone works via
`./install.sh` (see `DEPLOYMENT.md`).

- **Flagship:** stable.unicorncommander.ai — Keycloak realm `uchub`
- **Dogfood:** stable.magicunicorn.dev — same realm, federated in the server rail
- WebSockets ride dedicated `stable-ws.*` bypass hosts (CDN stalls WS upgrades)

## What ships today (v0.2.0 — high level)

**Home & catch-up**
- Dashboard v2: priority inbox, ranked agent-activity feed, health strip,
  knowledge rail, honest zero-states, and a truthful `/home/summary` served by
  the backend (stale tail collapses behind a count)
- Catch-up system: persisted mentions, activity inbox, jump-to-first-unread
  for cold backlogs, draft indicators, unread badges with one source of truth

**Rooms & messaging**
- Channels / group DMs / DMs (visibility model documented in
  `docs/stable-usage-conventions.md` — there is no private channel type;
  bridge sessions belong in DMs/group-DMs, one canonical room per pair)
- Archive: archived-room filter + archive UI, auto-titled agent DMs
  (first-message guard), room metadata allowlist
- Message search with operators (`from:` `in:` `has:` dates) honored on both
  search endpoints; keyboard nav in all search surfaces
- Attachments with signed URLs; per-user KB/upload quotas; rate limits on the
  expensive paths

**Calls & realtime**
- Persistent call across navigation, PiP, multi-screen-share, pop-out feeds
  (every remote feed), direct 1:1 ringing, live human captions with correct
  speaker attribution, mobile Video/Split/Chat modes, chat pill off the
  control dock, stale-chunk auto-recovery
- First-frame WebSocket auth (tokens never in URLs), reconnect/stale-banner
  hardening, membership loss revokes live streams

**Agents**
- Agents as room members with honest presence/status (no fake "thinking"),
  full-size portraits, avatar art pipeline, talking-face (VRM muppet mouth)
- Org chart: renders Brigade's stated hierarchy with pop-out, zoom-to-agent,
  and viewport controls
- Room-scoped approval center; append-only agent audit trail; ORCH-1 public
  agent gateway (role-gated JWTs / scoped keys); text-reply path via Brigade
  chat API — **all Brigade integration is optional** (`BRIGADE_*` unset =
  agent surfaces degrade, everything else unaffected)

**Knowledge**
- Per-room knowledge bases with citations, honest retrieval states (an outage
  is never passed off as an empty answer), delete/status/retry
- Optional RAG (Qdrant + embeddings service, off by default on self-host)

**Self-host & release (this wave)**
- `install.sh` + `docker-compose.selfhost.yml`: one-command install with a
  bundled Keycloak (realm/clients/first-user imported), every port
  remappable, honest health gating; `.env.example` documents required vs
  optional truthfully; LICENSE corrected to AGPL-3.0; version 0.2.0

## Known gaps

1. **Bridge rooms default to public channels.** The convention (and the room
   picker) steer bridge/agent sessions to DMs and group DMs, but the bridge
   MCP `create_channel` tool still creates `channel`-type rooms —
   teaching it to open a `group_dm` by default is backlog.
2. **Self-host voice needs BYO endpoints.** TTS/STT buttons error without
   `KOKORO_BASE_URL` / `WHISPER_BASE_URL`; agent voice additionally needs
   provider keys. LiveKit TURN is off by default (LAN installs don't need it;
   internet-facing ones should enable it).
3. **Brigade entitlement scoping** for agent tool use is still coarse.
4. **RAG requires external services** (Qdrant + Infinity-style embeddings);
   there is no bundled vector store.
5. **Per-org LiveKit port blocks** cap instances per host (UDP cannot be
   shared) — see `deploy/per-org/README.md`.

## Last verified

- 2026-08-08: UX wave deployed to both instances; self-host installer
  validated in a clean room on macOS/Docker — fresh clone → `install.sh` →
  `/health` 200 (identity ready via the bundled Keycloak), web serving, and
  a real headless-browser sign-in through the imported realm to the
  authenticated dashboard (realtime connected, presence live), with all
  `BRIGADE_*` unset and every port remapped. Stack then wiped with
  `down -v`.
