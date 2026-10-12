# Unicorn Stable — Deployment Guide

Two supported paths, two compose files — pick the one that matches who you are:

| You are… | Use | Compose file |
| --- | --- | --- |
| **Self-hosting Stable for your own team** | [`install.sh`](#1-self-host-installsh) | `docker-compose.selfhost.yml` |
| **Operating the Unicorn Commander fleet** (or a per-org instance) | [`scripts/deploy.sh`](#2-operator--production-path) | `docker-compose.yml` + `deploy/per-org/` |

Facts that apply to every path:

* **Migrations run in the backend entrypoint.** Every backend boot runs
  `alembic upgrade head` before uvicorn starts; a migration failure is fatal
  and the container exits rather than serve an unknown schema. Deploying a new
  backend **is** the schema upgrade — there is no separate migration step.
* **`/live` vs `/health`.** `/live` is process-liveness only (container restart
  decisions). `/health` (= `/ready`) returns 200 only when Postgres, Redis,
  LiveKit, **and the Keycloak JWKS** are all reachable — it is the deploy gate.
* **Auth is Keycloak OIDC, full stop.** There is no local-account or no-auth
  mode. The backend boots without Keycloak but stays `not_ready`
  (`identity: unavailable`) and nobody can sign in. See
  [Identity](#3-identity-keycloak--required).

---

## 1. Self-host (`install.sh`)

### Requirements

* Linux or macOS host with **Docker + the compose plugin** (v2)
* ~4 GB RAM free for the stack; more with the agent runtime
* An address browsers can reach the box on (LAN IP or DNS name — **not**
  `localhost`; containers must be able to reach the same address)

### Install

```bash
git clone <this repo>
cd Unicorn-Stable
./install.sh              # interactive
# or CI/non-interactive:
./install.sh --yes --host example.com
```

What it does, in order:

1. checks docker/compose and that the chosen TCP ports are free
   (`--web-port`, `--livekit-ws-port`, … remap everything; defaults
   8401 / 8400 / 7880-7882 / 5433 / 6381),
2. writes a complete `.env` (marker line + `chmod 600`; **re-runs preserve
   every existing secret**),
3. renders `deploy/selfhost/livekit.yaml` (LiveKit keys, ports, host
   address), `deploy/selfhost/instances.json` (how the SPA finds the API +
   Keycloak at runtime — no rebuild needed), and the Keycloak realm import,
4. creates the `keycloak` database inside the bundled Postgres,
5. `docker compose -f docker-compose.selfhost.yml -p <project> up -d --build`,
6. waits on `/live`, the realm's OIDC discovery document, `/health`, and the
   web root — then prints the URL plus your sign-in and Keycloak-admin
   credentials.

The bundled Keycloak is served **through the web nginx under `/auth` on the
app origin** (`http://HOST:8401/auth`). That single-origin design is load-
bearing: `KEYCLOAK_URL` is both the backend's JWKS fetch base **and** the
expected token issuer, and the browser must use the same URL — one origin
satisfies all three, and keeps the strict CSP free of third-party auth hosts.

Sign in at the printed URL. Add more users in the Keycloak admin console
(`http://HOST:8401/auth/admin/` → realm `stable` → Users).

### Day-2 operations

All commands from the repo root; `-p` is your project name
(default `stable-selfhost`).

**Upgrade**

```bash
git pull
./install.sh --yes            # re-renders configs, rebuilds, restarts
# or, by hand:
docker compose -f docker-compose.selfhost.yml -p stable-selfhost up -d --build
```

The new backend applies its own migrations on boot (see above). Watch:
`docker compose -p stable-selfhost logs -f backend` — a migration failure
exits the container with `FATAL: alembic upgrade failed`.

**Rollback**

Roll back code, not the database: schema migrations are forward-only in
practice, so the safe sequence is (1) restore the pre-upgrade `pg_dump` if the
upgrade migrated the schema, (2) `git checkout <previous tag>`,
(3) `./install.sh --yes`. Take the backup **before** upgrading:

**Backup**

```bash
# Database (the one thing you cannot regenerate) — run before every upgrade
# and on a cron. Postgres is published loopback-only on STABLE_POSTGRES_PORT.
docker compose -p stable-selfhost exec -T postgres \
  pg_dump -U stable -d stable | gzip > stable-$(date +%F).sql.gz

# Keycloak realm db (bundled mode: users live here)
docker compose -p stable-selfhost exec -T postgres \
  pg_dump -U stable -d keycloak | gzip > keycloak-$(date +%F).sql.gz

# Uploaded attachments (named volume <project>_backend_uploads)
docker run --rm -v stable-selfhost_backend_uploads:/data -v "$PWD":/backup \
  alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .

# And keep .env somewhere safe — it holds every secret.
```

Restore: `gunzip -c dump.sql.gz | docker compose -p … exec -T postgres psql -U stable -d stable`
into a **fresh** database, then start the matching code version.

**Stop / wipe**

```bash
docker compose -p stable-selfhost down        # stop, keep data
docker compose -p stable-selfhost down -v     # stop and DELETE all data
```

### TLS / going internet-facing

The self-host default is plain HTTP on a LAN. Before exposing Stable to the
internet:

1. put a TLS reverse proxy (Caddy, nginx, Traefik) in front of the **web
   port** for `https://stable.example.com` — proxy `/`, `/api`, `/ws`
   (WebSocket upgrade!) and `/auth` to it,
2. re-run `./install.sh --host stable.example.com` so issuer/CORS/CSP move
   with you, then edit `.env`: `PUBLIC_BASE_URL`/`CORS_ORIGINS`/`KEYCLOAK_URL`
   to the `https://` forms (and the realm's redirect URIs in Keycloak),
3. LiveKit media: browsers on the internet need `wss://` signaling and
   reachable media ports — forward TCP 7881 + UDP 7882 to the box, set
   `LIVEKIT_PUBLIC_URL=wss://…`, and consider enabling TURN in
   `deploy/selfhost/livekit.yaml` (the production reference for a
   TLS-terminated TURN setup is in `server/livekit.yaml.example`),
4. in Keycloak, set the realm's SSL requirement back to "external requests"
   (the bundled import relaxes it for LAN HTTP).

A LAN-only install needs none of this: media works because LiveKit advertises
your host address (`node_ip`) and the ports are published 1:1.

### What still degrades on a minimal self-host

Honest list — the stack is healthy and chat/calls/uploads work, but:

* **Agent replies need a model.** Brigade unset + no provider keys means agent
  invites/DMs surface errors when used. Wire `BRIGADE_*` or provider keys and
  enable the `agents` profile (`./install.sh --with-agents`).
* **Read-aloud / transcribe buttons** error without `KOKORO_BASE_URL` /
  `WHISPER_BASE_URL` endpoints.
* **Knowledge-base retrieval (RAG)** stays off without Qdrant + an embeddings
  service (`RAG_ENABLED=false` is the self-host default).
* **Email invites / web push** are silently disabled without `MS_GRAPH_*` /
  `VAPID_*`.
* **LiveKit media across NAT** may need TURN (see TLS section). Signaling and
  same-LAN media work out of the box.

---

## 2. Operator / production path

The fleet path — production compose (`docker-compose.yml`) expects the shared
Traefik `web` network, the `uchub` Keycloak realm, Brigade, the GPU voice
fleet, and per-instance `.env` files. Do **not** run `install.sh` on a fleet
box (it refuses to touch a `.env` it didn't create).

**Deploy** with `scripts/deploy.sh` — never bare `docker compose up` — because
it encodes the discipline: refuses dirty trees, stamps git-SHA provenance into
the image (labels + `STABLE_GIT_SHA`), rollback-tags the current `:latest`
first, CPU-caps the build, recreates only the target service, then gates on
in-container `/ready`, the external URL, and the served `instances.json`
server-rail artifact:

```bash
scripts/deploy.sh backend          # build + deploy + verify backend
scripts/deploy.sh web              # web (also asserts the server rail mount)
scripts/deploy.sh backend web
PROJECT=unicorn-stable EXTERNAL_URL=https://example.com/ scripts/deploy.sh backend
```

**Rollback:** every deploy prints its rollback tag
(`<project>-backend:rollback-<stamp>`). Re-tag it to `:latest` and
`docker compose -p <project> up -d --no-deps --force-recreate backend`.

**Per-org instances** (offering C — one hardened stack per organization) are
provisioned with `deploy/per-org/provision-org.sh <slug>`: it allocates a port
block (LiveKit UDP cannot be shared), renders the org's compose/env/livekit
config from the canonical base, and prints the runbook. Artifacts land in
`deploy/per-org/instances/<slug>/` (git-ignored — they contain secrets). See
`deploy/per-org/README.md`.

---

## 3. Identity: Keycloak — REQUIRED

Why it's required: API auth verifies Keycloak-issued RS256 JWTs against the
realm's JWKS (`server/app/auth/keycloak.py`), the SPA drives a keycloak-js
PKCE flow, and `/health` gates on the JWKS being loaded. The only auth-free
mode is the Vite **dev server's** mock user (`npm run dev` without
`VITE_KEYCLOAK_URL`), which never exists in a production build.

The bundled self-host Keycloak needs **zero manual setup** — the realm import
creates everything below. If you bring your own
(`./install.sh --no-keycloak --keycloak-url https://auth.example.com …`),
replicate this in your realm:

**1. Public browser client** (goes in `instances.json` via
`KEYCLOAK_WEB_CLIENT_ID`):

```json
{
  "clientId": "stable-web",
  "publicClient": true,
  "standardFlowEnabled": true,
  "redirectUris": ["https://stable.example.com/*"],
  "webOrigins": ["https://stable.example.com"],
  "attributes": { "pkce.code.challenge.method": "S256",
                  "post.logout.redirect.uris": "https://stable.example.com/*" }
}
```

**2. Confidential backend client** (`KEYCLOAK_CLIENT_ID` /
`KEYCLOAK_CLIENT_SECRET`) — its **service account** needs `realm-management`
roles `view-users` + `query-users` for the people directory (degrades to
empty search results without them).

The API accepts tokens whose `aud` includes `account` **or** this client id —
and a minimal realm mints tokens with **no `aud` at all** (every API call
then 401s even though login succeeds). Guarantee the audience with an
**audience protocol mapper on `stable-web`** (Client scopes → dedicated →
Add mapper → Audience → included client audience: `stable-backend`); the
bundled realm import ships exactly that. Realms whose users carry the
default `account` roles also pass, but the mapper is the deterministic fix:

```json
{ "clientId": "stable-backend", "publicClient": false,
  "serviceAccountsEnabled": true, "secret": "<KEYCLOAK_CLIENT_SECRET>" }
```

**3. A realm role for server admins** — instance branding/admin surfaces
require one of the roles in `STABLE_ADMIN_ROLES`
(default `stable-admin,realm-admin,admin`); grant `stable-admin` to your
admins.

**4. The one URL constraint:** `KEYCLOAK_URL` must be simultaneously
(a) the URL in tokens' `iss` claim, i.e. the browser-facing URL, and
(b) reachable **from inside the backend container** for the JWKS fetch.
Public HTTPS IdPs satisfy both trivially. Split-horizon setups that give
containers a different URL for the same IdP will fail issuer validation —
don't.

**5. Plain-HTTP installs and Web Crypto:** browsers expose `crypto.randomUUID`
and `crypto.subtle` only in secure contexts (https:// or localhost), and
keycloak-js 26 requires both — on a plain-HTTP LAN origin it would refuse to
initialize at all ("Web Crypto API is not available"). The web client ships a
tiny shim (`web/src/lib/insecureContextCrypto.ts`) that fills exactly those
two members from `getRandomValues` + a pure-JS SHA-256 in insecure contexts,
so the full PKCE S256 flow works on LAN HTTP too and the bundled realm keeps
PKCE **enforced**. Native implementations are never shadowed on https. TLS
remains the recommended deployment for anything beyond a trusted LAN.

---

## 4. Smoke tests (any path)

```bash
BASE=http://127.0.0.1:8401           # or your configured https:// origin

curl -s  $BASE/api/v1/health | python3 -m json.tool   # "status": "ready"
curl -sI $BASE/ | head -1                             # SPA serves
curl -s  $BASE/auth/realms/stable/.well-known/openid-configuration \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["issuer"])'
curl -s  $BASE/instances.json                         # the rail artifact
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/v1/rooms   # 401/403 = auth enforced
```

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/health` stuck at `identity: unavailable` | Backend can't fetch JWKS from `KEYCLOAK_URL` | `docker compose -p … exec backend curl -s $KEYCLOAK_URL/realms/<realm>/.well-known/openid-configuration`; check the container→host "hairpin" isn't firewalled |
| Sign-in loop / "Invalid parameter: redirect_uri" | Realm's client redirect URIs don't match the origin you're browsing | Update the `stable-web` client in Keycloak; happens after changing `--host` (realm import is skipped once the realm exists) |
| Sign-in works, API replies 401 | Token issuer ≠ backend `KEYCLOAK_URL` (browser used a different host than `.env`) | Browse via the exact printed origin; keep one canonical URL |
| Backend exits immediately, log says `Refusing to start in production: LIVEKIT_API_SECRET…` | Startup secret guard: unset/default LiveKit secret | Set a strong `LIVEKIT_API_SECRET` (install.sh does) and matching `deploy/selfhost/livekit.yaml` |
| `FATAL: alembic upgrade failed` on boot | Schema migration failed | Read the migration error; restore the pre-upgrade dump if you must roll back |
| Calls connect but no audio/video off-box | Media ports not reachable / NAT | Forward TCP 7881 + UDP 7882; check `node_ip` in `deploy/selfhost/livekit.yaml`; consider TURN |
| Voice agent joins then leaves silently | `agents` profile without STT/TTS/provider config | Set provider keys + `WHISPER_BASE_URL`/`KOKORO_BASE_URL`, or disable the profile |
| Keycloak container restarts with DB errors | `keycloak` database missing (profile enabled after first init) | Re-run `./install.sh` — it creates the DB idempotently |
| nginx serves the app but `/instances.json` is `[]` or a directory | The instances mount was lost / file missing | Re-run `./install.sh` (renders it); operator path: see the server-rail note in `docker-compose.yml` |
