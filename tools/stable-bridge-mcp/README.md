# Stable Bridge (MCP)

Continue a Claude Code conversation **inside** the Unicorn Command Center ("Stable")
chat. The Claude you're talking to in Claude Code becomes the relay: it reads your
messages from a Stable room and posts replies back, so the conversation literally
continues there. Leave the Claude Code window open and it keeps going.

## How it works

Three hops, all over the operator-configured SSH access:

- **Write** → `POST /api/v1/internal/agent-messages` on `stable-backend`, authed by the
  `LIVEKIT_API_SECRET` that already lives inside the container. The secret never
  leaves the application host; message content is base64'd through an env var so arbitrary text
  can't break shell quoting.
- **Read** → query the `stable` Postgres directly for new messages (returned as JSON,
  so quotes/newlines round-trip cleanly).
- The bridge posts as a **distinct identity** — `claude-code`, shown as **"Claude Code"** —
  so it never collides with the autonomous `claude` Brigade persona.

**No secrets on this Mac. No Keycloak. No token expiry.** It relies only on your SSH key.

## Use a channel, not a DM

Use the bridge in a **channel**. A channel only triggers an autonomous Brigade reply
on an explicit `@`-mention, so normal conversation produces **no** competing agent
response — the bridge is the sole responder. (A DM auto-replies to everything, which
would fight the bridge.) Don't `@claude-code` in the bridge channel; just talk.

## Tools

| Tool | What it does |
|------|--------------|
| `start_session(display_name, opener, name="", timeout_seconds=150)` | **The one-shot.** Create/reuse a topic channel, post the opener as "Claude Code", and wait for the first reply. Use this the moment Aaron asks to continue in Stable. |
| `create_channel(display_name, name="")` | Create (or reuse) a channel for the conversation, **owned by Aaron** (real LiveKit room, shows in his sidebar). `name` auto-slugs from `display_name`. |
| `list_rooms()` | List rooms you can bridge into (name, type, message count). |
| `send_message(room, content)` | Post into `room` as "Claude Code". |
| `get_new_messages(room, since_iso="")` | Non-blocking check for new messages (excludes the bridge's own). |
| `wait_for_reply(room, since_iso="", timeout_seconds=120)` | Block until a new non-bridge message appears, then return it. |
| `send_and_wait(room, content, timeout_seconds=120)` | Post a reply **and** wait for the next message — one call per bridge turn. |
| `speak_text(text, voice="", agent="", out_path="", speed=1.0)` | Suite **TTS** (Kokoro / Orator) via in-container `Settings.kokoro_base_url`. |
| `transcribe_audio(path, language="", model="")` | Suite **STT** (Amanuensis / Parakeet) via `Settings.whisper_base_url`. |
| `leave_room(room)` | Remove the bridge agent (`claude-code`) from the room (clean exit). |
| `remove_room_agent(room, brigade_agent_id)` | Kick a stuck Brigade agent membership from the room. |
| `close_bridge_session(room="", remove_agents="")` | Kick optional agents, leave as bridge, clear local poll state — then stop MCP. |

`room` is a channel name (e.g. `claude`) or its `livekit_room_name`. Channels are
created exactly the way the app does (`room_service.create_room`) — real LiveKit
room, Aaron added as OWNER — so there's no schema drift and they just work.

### Voice + clean exit

TTS/STT run **inside** `stable-backend` (same Settings the browser proxies use).
No API keys or LAN hostnames need to live on the Mac — only SSH.

When you are done bridging:

1. Call `close_bridge_session(room="…", remove_agents="stuck-agent-id")` (or
   `leave_room` alone).
2. Stop the MCP client process / close the Claude Code session.

That removes the ghost “Claude Code” (and any listed stuck agents) from the
participant strip so the channel does not look occupied forever.

## Knowledge-base tools

Agents can manage Stable's knowledge bases (document collections for RAG) directly —
same key-free, in-container pattern as channel creation (drives `knowledge_service`
inside `stable-backend`, no Keycloak token needed). Indexing is the full default
profile: contextual chunking + hybrid dense+sparse retrieval + bge-reranker.

| Tool | What it does |
|------|--------------|
| `list_knowledge_bases()` | List KBs with document counts and ids. |
| `create_knowledge_base(name, description="")` | Create a KB (owned by Aaron). |
| `add_document(knowledge_base, filename, text)` | Add + index a text/markdown doc (synchronous — returns once searchable). `knowledge_base` is a KB name or id. |
| `search_knowledge(knowledge_base, query, k=5)` | Hybrid + reranked search; returns top excerpts with scores. |
| `attach_kb_to_room(room, knowledge_base)` | Attach a KB to a room so its agents ground replies in it (idempotent). |
| `detach_kb_from_room(room, knowledge_base)` | Detach a KB from a room. |
| `list_room_knowledge(room)` | List KBs attached to a room. |

So "spin up a KB called *Deploy Runbooks*, drop these notes in, and wire it to
#ops" is a few tool calls — no UI, no upload, no token.

## Setup

Registered in Claude Code user config (`~/.claude.json`) as:

```
claude mcp add stable-bridge -s user -- uv run --with mcp python /Users/aaronstransky/stable-bridge-mcp/server.py
```

The tools load when a Claude Code session **starts**, so after first registering (or
editing the server) start a fresh session to pick them up — then leave it open.

Remove with: `claude mcp remove stable-bridge -s user`

## Using it

You don't pre-make anything. Just talk in Claude Code, then say:

> *"Can we pick this up in the Unicorn Command Center?"*

Claude calls `start_session(...)` — derives a channel title from what you're
discussing, **creates the channel** (owned by you, in your sidebar), posts an opener
as "Claude Code", and waits. You switch to Stable, find the new channel, reply there,
and the conversation continues — Claude reading and answering via the bridge while
the window stays open. Each topic gets its own channel.

## Config (env overrides)

`STABLE_SSH_HOST` (default `localhost`), `STABLE_BACKEND_CONTAINER` (`stable-backend`),
`STABLE_DB_CONTAINER` (`stable-postgres`), `STABLE_DB_USER`/`STABLE_DB_NAME` (`stable`),
`STABLE_BRIDGE_AGENT_ID` (`claude-code`), `STABLE_POLL_INTERVAL_S` (`3`).

Backend (on the host, not this Mac) must expose voice Settings used by the
proxies / in-container scripts:

| Backend env | Default | Purpose |
|---|---|---|
| `KOKORO_BASE_URL` | unset | Orator / Kokoro TTS front |
| `TTS_DEFAULT_VOICE` | `af_heart` | Default Kokoro voice |
| `WHISPER_BASE_URL` | unset | Amanuensis / Parakeet STT (`/v1` suffix) |
| `WHISPER_MODEL` | `whisper-1` | Model field sent to OpenAI-compatible STT |

Public API (user JWT) and gateway (scoped key) equivalents:

- `POST /api/v1/tts` · `POST /api/v1/stt`
- `POST /api/v1/gateway/tts` · `POST /api/v1/gateway/stt`
- `POST /api/v1/gateway/rooms/{room}/leave`
- `DELETE /api/v1/gateway/rooms/{room}/brigade-agents/{id}`

## Self-test

```
python3 server.py --selftest <channel>        # list/resolve/read (read-only)
python3 server.py --selftest --send <channel> # also posts a test message
python3 server.py --kb list_kb '{}'           # exercise the KB path directly (no MCP)
python3 server.py --kb search '{"collection_ids":["<id>"],"query":"..."}'
```
