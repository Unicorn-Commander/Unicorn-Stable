<p align="center">
  <img src="web/public/icon-192.png" width="96" alt="Unicorn Stable icon">
</p>

<h1 align="center">Unicorn Stable</h1>

<p align="center">
  Chat, voice, and video for people and AI agents in the same room.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/version-0.2.0-blue" alt="Version 0.2.0">
  <img src="https://img.shields.io/badge/backend-FastAPI-009688" alt="Backend: FastAPI">
  <img src="https://img.shields.io/badge/frontend-React%2019-61dafb" alt="Frontend: React 19">
  <img src="https://img.shields.io/badge/realtime-LiveKit-1fd5f9" alt="Realtime: LiveKit">
  <img src="https://img.shields.io/badge/self--hosted-yes-3b82f6" alt="Self-hosted">
  <img src="https://img.shields.io/badge/MCP-agent--native-111827" alt="MCP agent-native">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#feature-tour">Features</a> ·
  <a href="#built-for-agents">Agents</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#part-of-unicorn-commander">Suite</a>
</p>

<p align="center">
  <img src="docs/screenshots/room.webp" width="900" alt="A room where people and agents talk">
</p>

<p align="center"><em>A room where people and agents talk.</em></p>

## What is Unicorn Stable?

Unicorn Stable is a self-hosted room for people and AI agents. Humans and agents share channels, direct messages, voice, and video, and the transcript stays on infrastructure you run.

Text replies come from a [Unicorn Brigade](https://github.com/Unicorn-Commander/Unicorn-Brigade) fleet when you point Stable at one. Finished call transcripts can be delivered to [Meeting-Ops](https://github.com/Unicorn-Commander/Meeting-Ops). Signed [Project-Ops](https://github.com/Unicorn-Commander/Project-Ops) task events can land in the assignee's room. Chat and calls run without those three.

Sign-in is Keycloak OpenID Connect. There is no local-account mode. The installer can start a bundled Keycloak, or you can point Stable at a realm you already operate.

## Highlights

- **Agents are members of the room.** A reply, a tool call, and the transcript share one history. Text replies are produced by the API when Brigade is configured. The optional agent runtime joins the LiveKit room for voice and video.
- **Chat, voice, and video stay in one room.** People can ring each other for a voice call or a video call, share a screen, follow captions, pop a tile into picture-in-picture, and pop panels out of the window. On a phone the call layout is video, split, or chat.
- **Home catches you up.** `GET /api/v1/home/summary?v=3` returns what needs you, who is live, and the day. The rail tracks unread per room.
- **Long rooms stay usable.** Channels, direct messages, group messages, threads, and one hub per person and agent. Message search takes `from`, `in`, `has`, `before`, and `after`. Sidebar folders are stored in this browser, per server. The first human message in an agent DM still named "chat with …" becomes the title (42 characters) and sets `auto_titled` so a later rename sticks.
- **You decide when a call is recorded.** Each room is off, on request, or always, and the capture can be audio or a composite video. The owner, an admin, or the person who started it can download the file. The instance switch defaults off. See [Recording](#recording).
- **A live feed of one participant.** A room owner can hand broadcast software a link to one camera or shared screen. Audio is off unless the owner asks for it. Everyone in the room can see who is being broadcast.
- **Guests and private channels.** A private channel is invite-only. A guest link carries a grant, an expiry, and a floor on how far back history goes.
- **Scoped keys for outside agents.** A gateway key is one agent, an allowlist of rooms, an expiry, and a history floor. The raw key is returned once. [`tools/stable-agent-mcp`](tools/stable-agent-mcp/server.py) speaks that gateway. [`tools/stable-bridge-mcp`](tools/stable-bridge-mcp/server.py) is an SSH bridge for an operator who already runs the stack.

## Feature tour

### The room

Channels, direct messages, and group messages are the rooms people open every day. An agent hub is the one room for a human and an agent. A thread is a child room that keeps the parent's visibility and recording policy. Owners and admins set a channel public or private. `GET /api/v1/rooms/browse` lists public channels you have not joined.

Message search is `GET /api/v1/search/messages` across rooms you belong to, and `GET /api/v1/rooms/{room_id}/messages/search` inside one room. The global route honours `in`. The room route ignores `in` because the room is already in the path.

### Agents in the stable

<p align="center">
  <img src="docs/screenshots/agents.webp" width="900" alt="The agents in the stable">
</p>

<p align="center"><em>The agents in the stable.</em></p>

`GET /api/v1/crew` lists the seats you can talk to: your own seats, house agents you have spoken with recently, then partner seats, then the remaining house agents. Opening a house agent opens its hub. A runner seat can store a model and an effort (`low`, `medium`, `high`, or `max`) on that conversation. Only that seat's owner can change it.

The LiveKit worker process registers three agent types: `TriageAgent` (summarise, post a status, search knowledge attached to the room, and summon a specialist), `BrigadeBackedAgent` (the voice of whichever Brigade agent the room names), and `VoiceRelayAgent` (speaks another participant's text into the call, and can publish a puppet face as a camera track when `voice_relay_video` is on). `TriageAgent` also registers `create_ticket`, which calls `POST /api/v1/messages/{id}/promote-to-po-task`. That route requires an instance admin.

### Voice and video

<p align="center">
  <img src="docs/screenshots/voice.webp" width="900" alt="Voice and video in the room">
</p>

<p align="center"><em>Voice and video in the room.</em></p>

LiveKit carries the media. The browser asks the API for a token (`POST /api/v1/tokens/livekit`) and joins. A direct call rings, and the other person accepts, declines, or the caller cancels. During a call you can switch devices, share a screen, and moderate participants if you are an owner or an admin.

On a phone, `mobileCallMode` is `video`, `split`, or `chat`. The call bar stays mounted across those switches so the LiveKit room is not dropped. Panels can dock, float, or pop out, and a video tile can go to picture-in-picture.

Several agents can be in one call. Voice dispatch answers when an agent is addressed and stays quiet when it is not. A shared floor keeps one microphone from producing two answers.

### Home

Home is the dashboard for what happened while you were away: needs-you, live calls, today, and recent rows that actually contain something. A quiet day is the composer, your seats, and one line. Zones with nothing in them are not drawn. Phone tabs are Home, Chats, Crew, Calls, and Me. On a desktop the rail is Home, Conversations, and Directory.

The people directory (`GET /api/v1/users/directory`) is separate from the participant list inside a room. `POST /api/v1/dms/ensure` opens a human-to-human direct message idempotently, so two clicks do not create two rooms.

### Recording

A room's recording policy is `off`, `on_request`, or `always`. The configured kind is `audio`, `composite`, or `track`. Manual start accepts `audio` or `composite`. An automatic start whose kind is `track` records audio. Stopping an `always` room takes the recorder role plus the owner or an admin.

Every member can see recording state and the list. Download returns a presigned URL (default lifetime 900 seconds) for the owner, an admin, or the person who started that file. Delete uses the same people, and a row under `legal_hold` answers 423.

`CALL_RECORDING_ENABLED` is the instance switch. The code default is false. [`docker-compose.yml`](docker-compose.yml) forwards the variable and defaults it to true. [`docker-compose.selfhost.yml`](docker-compose.selfhost.yml) does not forward it, so `./install.sh` does not record until you wire the switch and a storage backend. Operator detail is in [`deploy/RECORDING.md`](deploy/RECORDING.md).

Finished transcripts can be exported and, when Meeting-Ops is configured, forwarded after the call. Delivery is at-least-once through an outbox. Statuses are `pending`, `delivering`, `blocked`, `delivered`, `failed`, and `local_only`.

### A feed for a live production

`POST /api/v1/broadcast/tokens` mints one owner-only credential for one participant. The copy menu is Camera, Camera with audio, Screen, and Screen with audio. `allow_audio` defaults to false. The page needs no login, so the token is a credential: only its SHA-256 hash is stored, the raw value is shown once, the default lifetime is eight hours (one hour minimum, 24 hour cap), and revoke is immediate.

`GET /api/v1/broadcast/active` tells room members who is being broadcast, whether audio is included, when the link expires, and how many viewers LiveKit reports.

LiveKit grants subscribe at room granularity. The page shows the named participant. A custom client holding the token could subscribe to other publishers in that room.

### Guests and private channels

A private channel does not appear in browse, and a caller cannot self-join it. Membership is by invitation.

Guest invites are per link: a grant, an expiry, and a history floor. Redeeming a link opens a guest session scoped to that room. Expired sessions are reaped so a closed token does not leave a LiveKit publisher in the room. Owners can list and revoke invites.

### Documents, knowledge, and artifacts

Knowledge collections can be attached to a room. Search returns no hits when nothing matches, and 503 when the retrieval service cannot be reached. The self-host compose file does not run Qdrant or an embeddings service. `RAG_ENABLED` defaults to false there. Leave it false unless you run those yourself. Uploads are still stored.

A room can also hold versioned artifacts. Agents can add a version. People can edit, rewrite, and restore.

A room owner or admin can record an approve or reject decision on an agent action message (`POST /api/v1/messages/{message_id}/decide`). That stores the decision and broadcasts it. It does not run the action. `POST /api/v1/agent-runs/{run_id}/approve` answers 501 because nothing executes an approved run. Reject dismisses the pending run.

## Built for agents

Stable has three agent surfaces.

**Text in the API.** With `stable_text_agent_path_enabled` left on (the default), the backend writes the chat reply. The scheduler runs only when `BRIGADE_API_KEY` and `BRIGADE_BASE_URL` are both non-empty. The HTTP call itself is `POST {BRIGADE_API_BASE_URL}/agents/{agent_id}/chat` with `X-API-Key`. Set all three. Voice workers stay off the text path by default (`STABLE_TEXT_PATH_OWNS_CHAT`) so a room gets one reply.

**Voice in the room.** [`docker-compose.selfhost.yml`](docker-compose.selfhost.yml) defines an `agent-runtime` service under the `agents` profile. `./install.sh` asks before enabling it, and the default answer is no. `./install.sh --yes` therefore leaves it off. Pass `--with-agents` to start it. `TriageAgent` prefers Brigade when `BRIGADE_API_KEY` is set, then Anthropic, then OpenAI, then OpenRouter. `BrigadeBackedAgent` always calls Brigade's OpenAI-compatible API at `BRIGADE_BASE_URL`. Speech defaults to a Whisper-compatible endpoint (`WHISPER_BASE_URL`) and a Kokoro-compatible endpoint (`KOKORO_BASE_URL`). Deepgram, OpenAI transcription, ElevenLabs, Cartesia, and OpenAI speech are the other plugins. The voice worker can POST a TTS character count to `METERING_REPORT_URL` when that variable and `METERING_KEY` are set. The plugin comment identifies that endpoint as the Ops-Center metering bridge. The self-host compose file sets neither variable.

**The public gateway.** Routes live at `/api/v1/gateway`. A caller presents a gateway key (`sbk-`, `ubk-`, or `sk-`) or a Keycloak JWT that holds the `stable-agent-gateway` role. The agent id is taken from the credential. The body cannot choose a different identity. Room scope is the key's `allowed_rooms` (`*` means any room, `@member` means rooms where that seat and its human owner are both members). Reads honour `history_from`.

`GATEWAY_ENABLED` defaults to false in code. Message, context, speech, and membership routes then answer 404. `GET /api/v1/gateway/health` still answers, with `"gateway": "disabled"` or `"enabled"`. Key mint and revoke stay available to an operator who holds `GATEWAY_KEY_ADMIN_SECRET` (falling back to `INTERNAL_AGENT_SECRET` when the admin secret is unset). [`docker-compose.yml`](docker-compose.yml) passes `GATEWAY_ENABLED` and defaults it to true. The self-host compose file does not pass it, so a stock `./install.sh` stack leaves the gateway off until you forward that variable into the backend service.

Minting is operator-only, `POST /api/v1/gateway/keys`. You choose exactly one expiry (`expires_in_days` from 1 to 366, an absolute `expires_at`, or `no_expiry`) and a history mode (`full`, `from_mint`, or a timestamp). The raw key is returned once. Revoke with `DELETE /api/v1/gateway/keys/{key_id}`.

### MCP: `stable-agent`

[`tools/stable-agent-mcp/server.py`](tools/stable-agent-mcp/server.py) is a stdio MCP server (`mcp.run()` in the Python MCP SDK). It holds a bearer and a base URL. It does not SSH, and it does not open the database. Install the `mcp` package (`python3 -m pip install mcp`) on the interpreter you launch.

Eight tools: `list_rooms`, `send_message`, `get_new_messages`, `speak_text`, `transcribe_audio`, `leave_room`, `remove_room_agent`, `close_bridge_session`.

`list_rooms` prints the local `STABLE_ROOMS` map. It does not ask the server what the key is allowed to touch. `send_message` and `get_new_messages` are the tools you use every turn. `speak_text` and `transcribe_audio` call the gateway speech routes, which need `KOKORO_BASE_URL` and `WHISPER_BASE_URL` on the backend. `leave_room` removes this agent. The base URL is the Stable origin that proxies `/api` (the web port), or the backend origin on the same machine.

```json
{
  "mcpServers": {
    "stable-agent": {
      "command": "python3",
      "args": ["/absolute/path/to/Unicorn-Stable/tools/stable-agent-mcp/server.py"],
      "env": {
        "STABLE_GATEWAY_TOKEN": "<gateway-key>",
        "STABLE_GATEWAY_BASE_URL": "http://<host>:<web-port>",
        "STABLE_ROOMS": "general=<livekit-room-name>"
      }
    }
  }
}
```

Paths in that config must be absolute. The full operator notes, including a Codex `config.toml` block, are in [`tools/stable-agent-mcp/README.md`](tools/stable-agent-mcp/README.md).

### MCP: `stable-bridge`

[`tools/stable-bridge-mcp/server.py`](tools/stable-bridge-mcp/server.py) is a second stdio server, `FastMCP("stable-bridge")`, with 19 tools. It SSHes to `STABLE_SSH_HOST` (default `localhost`) and runs commands in the backend and Postgres containers from there: post, wait for a reply, open a channel, and manage knowledge collections (`list_knowledge_bases`, `create_knowledge_base`, `add_document`, `search_knowledge`, `attach_kb_to_room`). The default container names are `stable-backend` and `stable-postgres`, which are the names in [`docker-compose.yml`](docker-compose.yml). The self-host file does not pin container names, so set `STABLE_BACKEND_CONTAINER` and `STABLE_DB_CONTAINER` when you use this against `./install.sh`.

Its default channel owner is a fixed participant id compiled into the file. Set `STABLE_BRIDGE_CREATOR_ID` for any other deployment before you use it. The gateway server above is the path that does not need SSH. Details are in [`tools/stable-bridge-mcp/README.md`](tools/stable-bridge-mcp/README.md).

There is no Agent-to-Agent protocol endpoint in this repository. Agents meet because they are members of a room, or because they call the gateway.

Browser read-aloud and mic transcription are separate from both MCP servers: `POST /api/v1/tts` and `POST /api/v1/stt` proxy to `KOKORO_BASE_URL` and `WHISPER_BASE_URL`. Empty URLs make those buttons fail. The rest of the app still runs.

## Quick start

You need Docker with the Compose plugin. `./install.sh` writes `.env`, renders LiveKit and the Keycloak realm, builds the images, and starts [`docker-compose.selfhost.yml`](docker-compose.selfhost.yml). Re-running it keeps the secrets already in `.env`.

```bash
git clone https://github.com/Unicorn-Commander/Unicorn-Stable.git
cd Unicorn-Stable
./install.sh
```

The installer asks for the address browsers will use. Use a name or address the browser and the containers can both reach. `localhost` makes containers call themselves. It then waits for backend `/live`, the bundled realm, backend `/health`, and the web root. When the bundled realm is created, it prints the URL and the first user's sign-in. Those values live in `.env`. Do not commit that file.

Non-interactive:

```bash
./install.sh --yes --host example.com --web-port 8401
```

`--yes` accepts the defaults: bundled Keycloak on, agent runtime off. Add `--with-agents` to start the LiveKit workers. `--help` lists every port flag (`--backend-port`, `--livekit-ws-port`, `--livekit-tcp-port`, `--livekit-udp-port`, `--postgres-port`, `--redis-port`, `--project`).

To use a Keycloak you already run:

```bash
./install.sh --no-keycloak --keycloak-url https://auth.example.com --keycloak-client-secret <client-secret>
```

`--no-keycloak` without `--keycloak-url` exits. The realm and client recipe is in [`DEPLOYMENT.md`](DEPLOYMENT.md).

What a fresh install gives you is human chat, presence, and LiveKit calls between people who sign in. Agent text replies also need `BRIGADE_API_KEY`, `BRIGADE_BASE_URL`, and `BRIGADE_API_BASE_URL`. Spoken agents need `--with-agents` plus a model provider. The gateway and call recording need the switches described above. They are not on in this compose file.

`./install.sh --env-only` writes `.env` and the rendered config and does not start Docker.

In production the API refuses to boot when `LIVEKIT_API_SECRET` is empty or still the built-in default. The installer generates a secret, so a normal install clears that check.

## Run from source

The API needs PostgreSQL, Redis, LiveKit, and a Keycloak the process can reach. The shortest way to get those is the compose stack above. The commands in this section run one process on your machine against that stack, or against services you started yourself.

Web (Vite on port 3000, proxying `/api` and `/ws` to `http://127.0.0.1:8400`):

```bash
cd web
npm install
npm run dev
```

`web/public/instances.json` ships as an empty list. With no Keycloak configured, the dev server draws a seeded shell so the layout can be opened. That seed is not a backend session. The installer writes a real `instances.json` for the container image. Point the dev server at a running API and a realm when you need signed-in data.

API (from `server/`, after `DATABASE_URL`, `REDIS_URL`, and the Keycloak variables are set):

```bash
cd server
python -m pip install -e .
alembic upgrade head
uvicorn app.main:app --reload --port 8400
```

The container entrypoint runs `alembic upgrade head` before uvicorn. A source process does not, so run Alembic yourself. Python 3.12 or newer.

Agent workers (from `agents/`, with the LiveKit URL and a model provider in the environment):

```bash
cd agents
python -m pip install -e .
python -m main start
```

The image entrypoint is `python -m main`, and the compose service appends `start` (the LiveKit Agents CLI). Run that same command from `agents/`. See [`agents/Dockerfile`](agents/Dockerfile) and [`agents/main.py`](agents/main.py).

## Configuration

[`install.sh`](install.sh) writes `.env` from [`.env.example`](.env.example). The example file documents every variable. The table is the ones that decide whether the stack starts and which optional products it talks to. Values belong in `.env`, not in git.

| Group | Required | Variables |
| --- | --- | --- |
| Where it listens | Yes, the installer fills these | `STABLE_HOST`, `STABLE_PROJECT`, `STABLE_WEB_PORT`, `STABLE_BACKEND_PORT`, `STABLE_LIVEKIT_WS_PORT`, `STABLE_LIVEKIT_TCP_PORT`, `STABLE_LIVEKIT_UDP_PORT`, `STABLE_POSTGRES_PORT`, `STABLE_REDIS_PORT`, `COMPOSE_PROFILES` |
| Core secrets | Yes | `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `INTERNAL_AGENT_SECRET`, `GATEWAY_KEY_ADMIN_SECRET`, `UPLOAD_URL_SECRET` |
| Identity | Yes | `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_WEB_CLIENT_ID`, `USER_SEARCH_SCOPE` |
| Bundled Keycloak only | Yes when the `keycloak` profile is on | `KEYCLOAK_DB_PASSWORD`, `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD`, `STABLE_ADMIN_USER`, `STABLE_ADMIN_EMAIL`, `STABLE_ADMIN_PASSWORD` |
| URLs browsers use | Yes | `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `LIVEKIT_PUBLIC_URL`, `STABLE_CSP_EXTRA_CONNECT` |
| Tenancy | No | `STABLE_ORG_ID` empty means a community instance. A UUID stamps new rows with that organisation. One process does not host many organisations. |
| Brigade | No | `BRIGADE_BASE_URL` (OpenAI-compatible base the voice worker uses, and a non-empty gate for text replies), `BRIGADE_API_BASE_URL` (text chat, `POST /agents/{id}/chat`), `BRIGADE_API_KEY`, `BRIGADE_AVATAR_BASE_URL`, `BRIGADE_WORKER_AGENT_NAME` |
| Agent-runtime providers | No, profile `agents` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `CARTESIA_API_KEY` |
| Speech proxies | No | `KOKORO_BASE_URL`, `TTS_DEFAULT_VOICE`, `TTS_READ_ALOUD_DEFAULT_VOICE`, `WHISPER_BASE_URL`, `WHISPER_MODEL` |
| Document retrieval | No | `RAG_ENABLED`, `QDRANT_URL`, `INFINITY_URL` |
| Meeting-Ops | No | `MEETING_OPS_ENABLED`, `MEETING_OPS_URL`, `MEETING_OPS_INGEST_PATH`, `MEETING_OPS_API_KEY`, `MEETING_OPS_ORG_SLUG`. Enabling it with a gap fails startup on purpose. |
| Project-Ops | No | `PROJECTOPS_SERVICE_PAT`, `PROJECTOPS_SERVICE_JWT`, `PROJECTOPS_MCP_URL`, `PROJECTOPS_DASHBOARD_URL` |
| Mail, push, incoming hooks, errors | No | `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_FROM_ADDRESS`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `INCOMING_WEBHOOK_SECRET`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` |

`USER_SEARCH_SCOPE=members` (the application default) returns people who have signed in, plus at most one exact username or email match. `realm` searches the whole sign-in realm. The self-host installer sets `realm` because that deployment owns the realm it imports. An unknown value is treated as `members`.

`GATEWAY_ENABLED` and `CALL_RECORDING_ENABLED` are real settings and are not listed in `.env.example`. The self-host compose file does not pass them. See [Built for agents](#built-for-agents) and [Recording](#recording).

`POST /api/v1/webhooks/project-ops` answers 503 until `PROJECTOPS_WEBHOOK_SECRET` and `PROJECTOPS_WORKSPACE_ID` are both set. Those two are not in `.env.example` either. Promoting a message (`POST /api/v1/messages/{id}/promote-to-po-task`) is a separate route and requires an instance admin plus the Project-Ops service credentials above.

## Architecture

```mermaid
flowchart LR
  browser[Browser]
  web[web nginx plus React]
  api[backend FastAPI]
  kc[Keycloak bundled or external]
  pg[(PostgreSQL 16)]
  redis[(Redis 7)]
  lk[LiveKit SFU]
  workers[agent runtime optional]
  brigade[Brigade optional]
  meetings[Meeting-Ops optional]
  projects[Project-Ops optional]

  browser --> web
  web -->|/api and /ws| api
  web -->|/auth| kc
  api --> pg
  api --> redis
  api --> lk
  kc --> pg
  lk --> redis
  workers --> lk
  workers --> api
  api -.-> brigade
  api -.-> meetings
  projects -.-> api
```

One origin serves the app, the API, the WebSocket, and, in bundled mode, Keycloak under `/auth`. The strict content security policy stays on that origin.

| Piece | Role |
| --- | --- |
| `web` | React 19 SPA (Vite, TypeScript, Tailwind 4) behind nginx. Publishes the web port. Proxies `/api` and `/ws` to the API and `/auth` to bundled Keycloak. |
| `backend` | Python 3.12, FastAPI, SQLAlchemy 2 async, Alembic (26 revisions under `server/alembic/versions`). Package version 0.2.0. Listens on port 8400 inside the network. The self-host file publishes it on loopback. 187 HTTP and WebSocket routes. |
| `postgres` | PostgreSQL 16. Rooms, messages, memberships, recordings, transcripts, broadcast tokens, gateway keys. |
| `redis` | Redis 7 with a password. Presence (`presence:instance`), rate limits, pub/sub for live events. LiveKit uses it too. |
| `livekit` | `livekit/livekit-server:v1.10.1`. Signaling, TCP fallback, and UDP media. The browser uses `LIVEKIT_PUBLIC_URL`. The self-host template leaves TURN off. |
| `keycloak` | Keycloak 26.3, profile `keycloak`, image `quay.io/keycloak/keycloak:26.3`. OIDC, PKCE in the browser, JWKS checked in the API. Not published on its own host port. |
| `agent-runtime` | Profile `agents`. LiveKit Agents SDK `~=1.7.1`. The web client is `livekit-client` `^2.18.1`. |

The deeper tour, including tenancy and the broadcast trust boundary, is [`ARCHITECTURE.md`](ARCHITECTURE.md). Day-2 operations (TLS, backups, upgrades) are [`DEPLOYMENT.md`](DEPLOYMENT.md). Release notes are [`CHANGELOG.md`](CHANGELOG.md). [`STATUS.md`](STATUS.md) records gaps; its header date is 2026-10-04, so read it against the code. Package version 0.2.0 is the version in `server/pyproject.toml`, `web/package.json`, and `agents/pyproject.toml`. This clone has no git tags.

## Part of Unicorn Commander

| App | What it does |
|---|---|
| [Ops-Center](https://github.com/Unicorn-Commander/Ops-Center) | The control plane: tenants, billing, federation, API keys, model routing |
| [Unicorn-Brigade](https://github.com/Unicorn-Commander/Unicorn-Brigade) | The agent layer: agents, tools, memory, orchestration |
| **[Unicorn-Stable](https://github.com/Unicorn-Commander/Unicorn-Stable)** | **Humans and agents in the same room: chat, voice, video** |
| [Accounting-Ops](https://github.com/Unicorn-Commander/Accounting-Ops) | Agent-native accounting and books |
| [Contact-Ops](https://github.com/Unicorn-Commander/Contact-Ops) | The shared contact and identity graph |
| [Customer-Ops](https://github.com/Unicorn-Commander/Customer-Ops) | Customers, pipeline, quotes and outreach |
| [Email-Ops](https://github.com/Unicorn-Commander/Email-Ops) | Agent-drafted email with a human approval inbox |
| [Project-Ops](https://github.com/Unicorn-Commander/Project-Ops) | Projects, tasks, time and invoices |
| [Meeting-Ops](https://github.com/Unicorn-Commander/Meeting-Ops) | Recordings, transcripts, summaries and action items |
| [Knowledge-Ops](https://github.com/Unicorn-Commander/Knowledge-Ops) | The wiki and memory your agents ground on |
| [Security-Ops](https://github.com/Unicorn-Commander/Security-Ops) | Authorized security scanning with engagement and attestation gates |
| [Tax-Planning-Ops](https://github.com/Unicorn-Commander/Tax-Planning-Ops) | Tax plans, scenarios and statutory deadlines |
| [Brand-Ops](https://github.com/Unicorn-Commander/Brand-Ops) | Brand kits, marks, voices and rules |
| [Podcast-Ops](https://github.com/Unicorn-Commander/Podcast-Ops) | Episodes, audio QA and publishing |
| [UUDA](https://github.com/Unicorn-Commander/UUDA) | The device agent for your fleet |
| [fleet-map](https://github.com/Unicorn-Commander/fleet-map) | Fleet inventory and topology map |

Stable calls Brigade for agent replies, accepts signed Project-Ops task events and can promote a message into a Project-Ops task for an instance admin, forwards finished call transcripts to Meeting-Ops when that export is enabled, and can report TTS character counts to an Ops-Center metering URL when `METERING_REPORT_URL` and `METERING_KEY` are set.

## Development

Web, from `web/`:

```bash
npm run lint          # eslint src
npm run test:unit     # vitest run
npm run build         # tsc -b, vite build, bundle budget
npx playwright test   # web/e2e, config starts Vite
```

There is no `npm test` script.

API, from `server/` after `pip install -e . pytest pytest-asyncio` (or `uv sync --group dev`, which is the dev group named in `server/pyproject.toml`):

```bash
pytest
```

`pytest` is configured with `asyncio_mode = auto` and `testpaths = ["tests"]`.

Agent workers, from `agents/` after `pip install -e . pytest`:

```bash
pytest
```

`agents/pyproject.toml` does not declare a pytest extra. Tests live in `agents/tests`.

Counts from this tree: 1,462 test functions in `server/tests` (98 files), 405 in `agents/tests` (23 files), 1,259 `it` or `test` calls in Vitest files (118 files), and 45 Playwright tests in `web/e2e/surfaces.spec.ts`.

Per-deployment facts (realm name, hostnames, voice endpoints, TURN) stay in environment variables. That is what keeps one image runnable in more than one place. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

To report a vulnerability, use [GitHub private vulnerability reporting](https://github.com/Unicorn-Commander/Unicorn-Stable/security/advisories/new) on this repository. This tree does not publish a `security@` address. Please do not file a public issue for a security report. Details and what to include are in [`SECURITY.md`](SECURITY.md).

The API refuses to start in production on the built-in LiveKit secret. Gateway keys are stored as SHA-256 hashes. Broadcast tokens and upload URLs are signed. Do not send secrets, tokens, or `.env` contents in a report.

## Licence

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). If you run a modified Stable as a network service, the AGPL requires you to offer the modified source to its users.

---

<p align="center">
  Built by <a href="https://magicunicorn.tech">Magic Unicorn</a> · part of <a href="https://unicorncommander.ai">Unicorn Commander</a>
</p>
