# Unicorn Stable — per-org provisioning (offering C)

One hardened stack per organization. Physical isolation (own DB, redis,
LiveKit, uploads, secrets, org UUID, domains) instead of an app-layer
multi-tenant rewrite. This is the primary go-to-market shape for Stable.

## Why per-org (not multi-tenant SaaS)

A single shared instance would need every request path to enforce tenant
isolation perfectly — the security audit (2026-07-07) found that boundary was
fiction. Per-org sidesteps it: each org's data lives in a separate stack, so a
bug in one can't leak another. The app-layer `org_id` stamping (B5/B6) is
defense-in-depth on top, not the only wall.

The blockers that made shared-instance a NO-GO are fixed regardless (they ship
in every deployment): B1 secret split, B2 internal-edge deny, B4 stored-XSS
guard, B7 rate limits, plus the §3 hardening. So a per-org instance is
launchable now.

## What one stack is

6 services (`docker-compose.yml`): `livekit` (SFU) · `postgres 16` · `redis 7`
· `backend` (FastAPI) · `agent-runtime` (LiveKit Agents) · `web` (nginx).
Shared platform: Traefik `web` network, Brigade (agents), GPU fleet (TTS
kokoro-ha, STT parakeet), Keycloak `uchub`, metering gateway.

## Files here

| File | Role |
|---|---|
| `provision-org.sh` | Render a new org's artifacts (secrets, ports, compose, env, livekit.yaml) + print the manual runbook. `--deploy` also brings it up + smoke-tests. |
| `render_compose.py` | Derives the per-org compose from the canonical base `docker-compose.yml` (no template drift — one source of truth). |
| `env.tmpl` | The per-org `.env` template (placeholders filled by the provisioner). |
| `deprovision-org.sh` | Tear down (keeps data by default; `--purge` deletes volumes + artifacts). |
| `instances/<slug>/` | Generated per-org artifacts (git-ignored; contains secrets). |

## The one hard constraint: LiveKit media ports

Every org's LiveKit needs its OWN media ports — UDP 7882-equivalent especially
cannot be shared across instances on one host. The provisioner allocates a free
3-port block (7890, 7900, …) and the firewall must open the UDP port. This caps
how many orgs fit on one host; past that, add a host.

## Procedure

```bash
# 1. Render artifacts + get the runbook (safe, deterministic, no external calls)
deploy/per-org/provision-org.sh acme

# 2. Do the manual steps it prints:
#    - Cloudflare DNS: acme / acme-livekit / acme-turn .stable.unicorncommander.ai -> host
#    - Keycloak: client `stable-acme` in uchub (or per-org realm), paste secret into .env
#    - Firewall: open the allocated UDP/TCP LiveKit ports
#    - Brigade: scope the roster (accessPolicy) + set BRIGADE_API_KEY; set METERING_KEY

# 3. Deploy + smoke-test
deploy/per-org/provision-org.sh acme --deploy
```

Metering already flows per org: `STABLE_METERING_ORG_ID=<slug>` tags usage to
the billing gateway, so revenue tracking is automatic.

## Open decisions (Aaron / platform) — these gate a repeatable pipeline

1. **Keycloak: per-org realm vs shared realm + per-org client.** Ties to
   `project_per_org_sso_design`. Shared-realm + client is faster to stand up;
   per-org realm gives BYO-IdP + full user isolation. The template defaults to a
   `stable-<slug>` client in `uchub` — change if the SSO design lands on realms.
2. **Brigade: shared roster (scoped via accessPolicy) vs per-org Brigade.**
   Shared is cheaper and the accessPolicy API exists; per-org Brigade is full
   isolation. Start shared+scoped, revisit if isolation is insufficient.
3. **Host capacity.** LiveKit port blocks + GPU contention set orgs-per-host.
   Decide the cap and the add-a-host trigger before selling past it.

## Community instance (offering B) — the delta

A shared community/individual instance is the SAME codebase with
`STABLE_ORG_ID` LEFT EMPTY (ownership-based isolation: each user sees only their
own KBs + room-shared ones; public channels are browsable) and signup enabled
in Keycloak. It additionally leans on B5/B6/B7 (already shipped) because
multiple untrusted users share one stack. Stand it up with the same provisioner
minus the org UUID, plus a signup-enabled realm.
