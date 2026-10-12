# Stable — architecture & deployment topology

This file captures the **internal vs public** split for Stable. Skim it before
inviting non-employees or standing up a second instance.

## Two intended deployments

```
            ┌──────────────────────────────┐    ┌──────────────────────────────┐
            │  INTERNAL Stable              │    │  PUBLIC Stable                │
            │  *.internal.example.com      │    │  *.public.example.com         │
            ├──────────────────────────────┤    ├──────────────────────────────┤
 Realm      │  internal (team deployment)  │    │  stable-public (multi-tenant) │
 Auth       │  Internal SSO + employee      │    │  Self-serve register +        │
            │  Google/Microsoft via Keycloak│    │  workspace-scoped invites     │
 Network    │  WebSocket via Cloudflare;    │    │  Same WSS path; WebRTC media  │
            │  WebRTC media via Tailscale   │    │  via TURN (coturn) or          │
            │  (no port forward needed)     │    │  LiveKit Cloud                 │
 Voice      │  Tailnet members only         │    │  Anyone in any browser         │
 Use case   │  You + the team + customers   │    │  Demos, prospects, partners,   │
            │  who already use UC-1 Hub     │    │  inter-org collaboration       │
            └──────────────────────────────┘    └──────────────────────────────┘
```

## Today (2026-06)

- ✅ INTERNAL is live on the deployment's configured domains, with its configured
  Keycloak realm and Tailscale-only voice.
- ❌ PUBLIC instance does not exist yet. When it does, mirror the same
  containers with a different `.env` and a new realm.

## Voice topology

Speech-to-Text (Whisper via amanuensis) and Text-to-Speech (Kokoro via orator)
run on the configured voice appliance (use `WHISPER_BASE_URL` and
`KOKORO_BASE_URL`; no address is committed here):

- **amanuensis:** Whisper STT on port 9000
- **orator:** Kokoro TTS on port 8880

Both are reachable from the application host and the stable-agents container via
the deployment's private network.
Environment variables `WHISPER_BASE_URL` and `KOKORO_BASE_URL` point agents to
these endpoints. See `DEPLOYMENT.md` for voice services troubleshooting.

## Decision points the public instance has to answer

1. **Identity.** Workspaces? Single-realm with workspace-scoped roles, or one
   realm per customer? Tooling burden vs. blast radius.
2. **Voice.** TURN server (coturn on a small VPS with public IP) or LiveKit
   Cloud. Self-hosted is cheaper at scale; cloud is faster to ship.
3. **Billing.** Paywall channel limits, agent minutes, file storage. Not
   needed day-1 but bake the schema in early so you don't migrate later.
4. **Compliance.** SOC 2 / HIPAA-adjacent paths. Affects hosting region,
   audit log retention, export endpoints.
5. **Brigade access.** Does a public-Stable user get access to your Brigade
   agents (and which ones)? Or do they bring their own Brigade instance via
   our OpenAI-compat adapter?

## Things to NOT bake into INTERNAL that PUBLIC will need

These are flagged so we don't paint ourselves into a corner.

- **Hard-coded `keycloak_realm: uchub`** in code. Should be env-only.
- **Brigade-as-fixed-LLM** assumption. PUBLIC may want Bring-Your-Own-Key
  (already half-supported via the OpenAI-compat adapter).
- **Single email sender** (`support@example.com`). PUBLIC needs
  per-workspace branding or a generic `noreply@stable.app` domain.
- **Tailscale-IP-as-WebRTC-candidate**. PUBLIC must `use_external_ip: true`
  AND have a TURN deployment; flip the toggle in `livekit.yaml` per instance.
- **Tailscale-only voice.** PUBLIC will need amanuensis/orator reachable from
  browsers (either co-hosted on the public instance or behind a reverse proxy).

## Migration path (when PUBLIC needs to ship)

1. Stand up new compose stack on a separate host (or new docker project on
   the same host with different prefixes/networks).
2. New Keycloak realm `stable-public`, fresh client `stable-web`, register
   social IdPs (Google, Microsoft, GitHub).
3. Deploy coturn (1 VPS w/ public IP) or sign up for LiveKit Cloud; set
   `LIVEKIT_PUBLIC_URL` accordingly.
4. Deploy amanuensis/orator on the public instance or point to a shared voice
   appliance accessible from the internet.
5. New DNS subdomains under the public deployment's configured domain.
6. Copy the same backend image, point it at the new Postgres + Keycloak.
7. The ONLY code change should be making the realm name, voice endpoints,
   and whether to use Tailscale-IP-as-WebRTC-candidate configurable. If you
   find yourself writing more, stop and refactor.

## Cross-reference

- `DEPLOYMENT.md` — operational runbook for THIS instance (internal).
- `CLAUDE.md` — developer quick-start and env var docs.
- `server/livekit.yaml` — switch `use_external_ip` + `node_ip` per deployment.
- `server/app/config.py` — all per-deployment settings live here.
