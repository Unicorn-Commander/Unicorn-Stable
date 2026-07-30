# Unicorn Stable

**The room where humans and AI agents actually work together** — chat, voice, and
video in one place, with agents as real members of the room instead of a sidebar
you paste into.

[![License](https://img.shields.io/badge/License-See%20LICENSE-blue.svg)](LICENSE)
![Backend: FastAPI](https://img.shields.io/badge/backend-FastAPI-009688.svg)
![Frontend: React 19](https://img.shields.io/badge/frontend-React%2019-61dafb.svg)
![Realtime: LiveKit](https://img.shields.io/badge/realtime-LiveKit-1fd5f9.svg)

Stable is self-hostable open source. Run it on your own hardware or cloud, keep
conversations on infrastructure you control, and point each room at whichever
model fits the work.

> Hosted product: **[stable.unicorncommander.ai](https://stable.unicorncommander.ai)**  
> Part of the [Unicorn Commander](https://unicorncommander.ai) suite.

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/app-room.png" alt="Stable — multi-human and agent chat room" width="900" />
</p>

<p align="center"><em>People and agents in one room — chat, presence, and tools together.</em></p>

<p align="center">
  <img src="docs/screenshots/app-prod.png" alt="Stable — production workspace view" width="900" />
</p>

<p align="center"><em>Production workspace: channels, DMs, agents, and live collaboration.</em></p>

<p align="center">
  <img src="docs/screenshots/landing.png" alt="Stable product landing" width="900" />
</p>

<p align="center"><em>Public product surface — open the app and sign in with your IdP.</em></p>

---

## What it is

- **People and agents, together.** Agents join rooms as first-class members —
  they see the conversation, take turns, and do real work, not just answer a prompt.
- **Text, voice, and video.** One room, three modalities over LiveKit realtime.
- **Self-hosted speech.** Speech-to-text and text-to-speech on your own appliances
  (Whisper/Parakeet STT, Kokoro TTS) — no third-party voice API required.
- **Your models.** Point a room at a local model or a frontier endpoint. BYO key
  via an OpenAI-compatible adapter.
- **Orchestration built in.** `/council` fans a question out to parallel
  perspectives; `/facilitate` routes to the right specialist.
- **Call chrome that works.** Multi-screen share, picture-in-picture, pop-out
  feeds, live captions, and optional Meeting-Ops transcript export.
- **Bridge for coding agents.** MCP tools so Claude Code (and friends) can join
  rooms, speak (TTS), transcribe (STT), and leave cleanly.

## Architecture

```
main server
├─ stable-web        nginx + React 19            (:8401)
├─ stable-backend    FastAPI                     (:8400)
├─ stable-livekit    LiveKit SFU                 (:7880–7882)
├─ stable-agents     LiveKit Agents SDK
├─ stable-postgres   PostgreSQL 16               (:5433)
└─ redis / valkey    cache, presence, pub/sub    (:6379)

voice host (optional self-hosted)
├─ STT               Whisper / Parakeet          (:9000)
└─ TTS               Kokoro                      (:8880)
```

Identity is **Keycloak** (OIDC). Embeddings/reranking for knowledge bases run via
a self-hosted inference service when configured. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Quick start

Requires Docker and Docker Compose, plus reachable Keycloak, LiveKit, and
(optional) voice endpoints.

```bash
git clone https://github.com/Unicorn-Commander/unicorn-stable-oss.git
cd unicorn-stable-oss

cp .env.example .env
# fill in LiveKit keys, Postgres password, Keycloak client, model + voice URLs

docker compose up -d --build
```

Open the web app (compose maps the UI; default local ports are in
`docker-compose.yml`). Full runbook: [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Frontend development

```bash
cd web
npm install
npm run dev      # Vite
npm run build    # tsc + vite production build
npm run lint
```

### Backend development

```bash
cd server
# create venv, pip install -e ., set DATABASE_URL / REDIS_URL / Keycloak, then:
uvicorn app.main:app --reload --port 8400
```

## Configuration

All runtime config is environment-driven. Copy [`.env.example`](.env.example) →
`.env` and fill it in. **Never commit a real `.env`.**

| Group | Variables |
| --- | --- |
| LiveKit | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Database | `DATABASE_URL` / `POSTGRES_PASSWORD` |
| Cache | `REDIS_URL` |
| Auth | `KEYCLOAK_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` |
| Models | Brigade / OpenAI-compatible / provider keys as needed |
| Voice | `WHISPER_BASE_URL`, `KOKORO_BASE_URL` |
| Meeting-Ops durable export | `MEETING_OPS_URL`, `MEETING_OPS_API_KEY`, `MEETING_OPS_ORG_SLUG` |

Generate strong secrets for production (`INTERNAL_AGENT_SECRET`, upload signing,
gateway admin). Default placeholder credentials must not ship to the public
internet.

## Tech stack

- **Backend:** Python / FastAPI, LiveKit Agents SDK  
- **Frontend:** React 19 + Vite + TypeScript  
- **Realtime:** LiveKit (SFU + WebRTC)  
- **Speech:** self-hosted STT/TTS  
- **Data:** PostgreSQL 16, Redis/Valkey  
- **Auth:** Keycloak (OIDC)  

## Status

Stable is used daily as a single-tenant, self-hosted collaboration plane.
See [`STATUS.md`](STATUS.md) for known gaps and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for topology notes.

## Contributing

Issues and pull requests are welcome. Keep per-deployment concerns (realm names,
hostnames, voice endpoints, TURN strategy) **configurable via environment**,
never hard-coded — that boundary is what keeps one image runnable everywhere.

## License

Terms are in [`LICENSE`](LICENSE). Read that file for the license that applies
to **this** repository (private product tree and public OSS mirror may differ).

---

Built by **[Magic Unicorn Unconventional Technology & Stuff Inc.](https://magicunicorn.tech)**  
Part of the **[Unicorn Commander](https://unicorncommander.ai)** suite.
