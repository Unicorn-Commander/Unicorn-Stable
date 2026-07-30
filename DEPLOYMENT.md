# Unicorn Stable — Deployment Runbook

End-to-end production checklist for deploying Stable. Last verified 2026-06-14.

## Architecture

```
Browser ───wss───► Cloudflare ──► Traefik (bigboy:443) ──► stable-web (nginx)
   │                                                       │
   │                                                       ▼
   │                                           stable-backend (FastAPI)
   │                                                       │
   └──── wss/WebRTC ───► livekit.magicunicorn.dev ──► stable-livekit
                                                           │
                                                           ▼
                                                    stable-agents (LiveKit Agents)
                                                           │
                                                    ┌──────┴──────┐
                                                    │             │
                                              Brigade    Voice Pipeline
                                             (LLM,         │
                                             memory,    uc-1 box
                                              tools)    ├─ amanuensis STT
                                                        │  (port 9000)
                                                        └─ orator TTS
                                                           (port 8880)
```

## Required services per host

| Host | Services | Notes |
| --- | --- | --- |
| commander | uchub-keycloak, traefik (public 443) | OIDC realm `uchub` |
| bigboy | stable-web, stable-backend, stable-livekit, stable-agents, stable-postgres, stable-redis, traefik, infinity (embeddings/reranking) | Compose file: `Unicorn-Stable/docker-compose.yml` |
| uc-1 | amanuensis (Whisper STT), orator (Kokoro TTS), livekit appliance | Voice services reachable at Tailscale IP 100.78.236.160 |

## Prerequisites (one-time)

### DNS (Cloudflare zone `magicunicorn.dev`)

| Host | Type | Target | Proxy |
| --- | --- | --- | --- |
| `stable.magicunicorn.dev` | A | bigboy WAN IP | Proxied (orange cloud) |
| `livekit.magicunicorn.dev` | A | bigboy WAN IP | **DNS-only (grey cloud)** |

`livekit.magicunicorn.dev` MUST be DNS-only because Cloudflare proxy doesn't pass UDP, and LiveKit needs UDP for low-latency media. Browser → Traefik → LiveKit signaling still works on TCP/443 once the cert provisions.

### Router / firewall

Ports forwarded to bigboy LAN IP:

| Port | Proto | Purpose |
| --- | --- | --- |
| 80 | TCP | Traefik HTTP → HTTPS redirect + ACME challenge |
| 443 | TCP | Traefik HTTPS (signaling for stable + livekit) |
| 7881 | TCP | LiveKit WebRTC TCP fallback |
| 7882 | UDP | LiveKit WebRTC primary |
| 50000-60000 | UDP | LiveKit WebRTC port range (configured in `livekit.yaml`) |

If you can't open the wide UDP range, set `port_range_start=port_range_end=7882` in `server/livekit.yaml` so all media muxes onto one UDP port.

### Keycloak — `uchub` realm

Two clients required (create via Keycloak admin console at `https://auth.unicorncommander.ai/admin/`):

#### `stable-web` (public PKCE — used by browser)

```json
{
  "clientId": "stable-web",
  "publicClient": true,
  "standardFlowEnabled": true,
  "redirectUris": ["https://stable.magicunicorn.dev/*", "http://localhost:5173/*"],
  "webOrigins": ["https://stable.magicunicorn.dev", "http://localhost:5173", "+"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "https://stable.magicunicorn.dev/*##http://localhost:5173/*"
  }
}
```

#### `stable` (confidential, service account — used by backend)

```json
{
  "clientId": "stable",
  "publicClient": false,
  "serviceAccountsEnabled": true,
  "secret": "<set in KEYCLOAK_CLIENT_SECRET>"
}
```

## .env

Copy `.env.example` → `.env` and set:

```bash
# Keycloak
KEYCLOAK_URL=https://auth.unicorncommander.ai
KEYCLOAK_REALM=uchub
KEYCLOAK_CLIENT_ID=stable
KEYCLOAK_CLIENT_SECRET=<from Keycloak `stable` client credentials tab>

# LiveKit — keep API key/secret matching `server/livekit.yaml`
LIVEKIT_URL=ws://livekit:7880
LIVEKIT_PUBLIC_URL=wss://livekit.magicunicorn.dev
LIVEKIT_API_KEY=APIStable2026
LIVEKIT_API_SECRET=<long random string>

# Voice services (uc-1 box, Tailscale)
WHISPER_BASE_URL=http://100.78.236.160:9000
KOKORO_BASE_URL=http://100.78.236.160:8880

# Brigade (optional — Brigade-backed agents need an admin/user key)
BRIGADE_BASE_URL=https://brigade.magicunicorn.dev/api/v1/openai/v1
BRIGADE_API_KEY=<your Brigade key>

# CORS — JSON array
CORS_ORIGINS=["https://stable.magicunicorn.dev"]

LOG_LEVEL=INFO
```

## Voice services

**STT (Speech-to-Text):** amanuensis (self-hosted Whisper)
- **Host:** uc-1 (Tailscale IP 100.78.236.160)
- **Port:** 9000 (HTTP)
- **URL:** `http://100.78.236.160:9000`
- **Used by:** stable-agents container (via `WHISPER_BASE_URL` env)

**TTS (Text-to-Speech):** orator (self-hosted Kokoro)
- **Host:** uc-1 (Tailscale IP 100.78.236.160)
- **Port:** 8880 (HTTP)
- **URL:** `http://100.78.236.160:8880`
- **Used by:** stable-agents container (via `KOKORO_BASE_URL` env)

Both services are on the internal Tailscale mesh and reachable from bigboy. If either is unreachable:
1. Check uc-1 is online: `ping 100.78.236.160`
2. Check port 9000/8880 are listening on uc-1: `ssh uc-1 'netstat -tlnp | grep -E :(9000|8880)'`
3. Check stable-agents env vars are set correctly
4. View agent logs: `docker logs stable-agents`

## Deploy

```bash
cd Unicorn-Stable
docker compose pull
docker compose up -d --build
```

The backend entrypoint runs `alembic upgrade head` automatically before starting
uvicorn. A migration failure is fatal; the server will not advertise liveness
against an unknown schema. Use `scripts/deploy.sh backend` for production so the
image is stamped with its source revision and the post-start `/ready` gate is
checked. `/live` is process-only and is intentionally used for container
restart decisions.

## Smoke tests

```bash
# 1. Public website loads
curl -sI https://stable.magicunicorn.dev | grep -E '^HTTP|server'

# 2. API requires auth
curl -s https://stable.magicunicorn.dev/api/v1/rooms | jq

# 3. Token mint works (using service account)
TOKEN=$(curl -s -X POST "https://auth.unicorncommander.ai/realms/uchub/protocol/openid-connect/token" \
  -d "grant_type=client_credentials&client_id=stable&client_secret=$KEYCLOAK_CLIENT_SECRET&scope=openid" \
  | jq -r .access_token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"room_name":"smoke-test","participant_name":"smoke"}' \
  https://stable.magicunicorn.dev/api/v1/tokens/livekit | jq

# 4. LiveKit signaling reachable from public internet
curl -sI https://livekit.magicunicorn.dev | grep -E '^HTTP|server'

# 5. Voice services reachable from bigboy
docker exec stable-backend curl -s http://100.78.236.160:9000/health | jq   # amanuensis
docker exec stable-backend curl -s http://100.78.236.160:8880/health | jq   # orator
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Sign-in shows "Client not found" | Wrong Keycloak / missing `stable-web` client | Add the client config above to the right Keycloak |
| Sign-in shows "Framing violates CSP" | Cloudflare adds `X-Frame-Options: SAMEORIGIN` | Don't use silent-iframe SSO. Already removed in `web/src/services/auth.ts` |
| `audience must be a string or None` | python-jose can't take a list audience | Already fixed in `server/app/auth/keycloak.py` (manual aud check) |
| `relation "participants" does not exist` | Migrations didn't run | Entrypoint runs them now; or run manually: `docker exec stable-backend alembic upgrade head` |
| `invalid input value for enum participant_type_enum: "HUMAN"` | SQLAlchemy enum sends names instead of values | Fixed via `values_callable` on Enum columns |
| Agent joins room then drops with `STT does not support streaming` | Missing VAD (voice activity detection) | Fixed — `silero.VAD.load()` is added in `agents/brigade_backed/agent.py` |
| WebRTC media stalls but signaling works | Router not forwarding 7881/7882 | Forward those to bigboy in router admin |
| Agent can't reach voice services (amanuensis/orator) | uc-1 offline or services not running | Ping 100.78.236.160; SSH to uc-1 and check service status; add health checks to smoke tests above |
