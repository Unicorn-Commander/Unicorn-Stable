# STATUS.md — Stable Current State (2026-06-14)

## Deployment status

**INTERNAL instance is live and healthy.**

- **URL:** stable.magicunicorn.dev (web), livekit.magicunicorn.dev (signaling)
- **Realm:** uchub (Keycloak)
- **Network:** Tailscale (internal only)

### Running services (bigboy)

| Container | Port | Status |
| --- | --- | --- |
| stable-web | 8401 | Running (nginx, React 19) |
| stable-backend | 8400 | Running (FastAPI) |
| stable-livekit | 7880–7882 | Running (SFU) |
| stable-agents | — | Running (LiveKit Agents SDK) |
| stable-postgres | 5433 | Running (PostgreSQL 16) |
| stable-redis | 6380 | Running (Redis 7) |

### Voice services (uc-1)

| Service | Port | Status |
| --- | --- | --- |
| amanuensis (Whisper STT) | 9000 | Live (self-hosted) |
| orator (Kokoro TTS) | 8880 | Live (self-hosted) |
| livekit appliance | — | Live |

## Box topology

```
bigboy (100.74.75.67)
├─ stable-web, stable-backend, stable-livekit
├─ stable-agents (uses voice services below)
├─ stable-postgres, stable-redis
└─ infinity (embeddings/reranking, used indirectly by Brigade)

uc-1 (100.78.236.160 Tailscale)
├─ amanuensis (port 9000)
├─ orator (port 8880)
└─ livekit appliance
```

## Known gaps

1. **LiveKit in-room agents** being finished — agents can join rooms and
   transcribe, but "show your work" stage video and multi-tool dispatch are
   work-in-progress.

2. **Voice pipeline rewired** — just moved from cloud (Deepgram/ElevenLabs)
   to self-hosted Whisper/Kokoro; env vars `WHISPER_BASE_URL` and
   `KOKORO_BASE_URL` being wired into stable-agents now. Test with real
   multi-participant rooms to confirm.

3. **PUBLIC multi-tenant instance** not built yet. INTERNAL is single-tenant.
   When shipping PUBLIC, mirror the containers with a new Keycloak realm
   and a new .env. See `ARCHITECTURE.md` for the roadmap.

4. **Backend authz & rate-limiting hardening** in progress — identity-aware
   scoping and per-user rate limits not yet enforced.

5. **Brigade entitlement scoping** for agents — agents inherit the calling
   user's tool permissions, but scope filtering is incomplete.

## Last verified

- 2026-06-14: All six stable-* containers running, voice services on uc-1,
  internal Stable instance healthy.

See `CLAUDE.md` for dev quick-start, `DEPLOYMENT.md` for ops runbook.
