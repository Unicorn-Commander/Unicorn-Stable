# Changelog

All notable changes to Unicorn Stable. Versions are tags on `main`;
areas below group the ~240 commits between tags into human-readable form.

## v0.2.0 — 2026-08-08

The wave from v0.1.1 to today: the app grew a real home, honest agents,
conferencing that survives navigation, a hardened edge — and became
self-hostable by an end user from a fresh clone.

### Self-hosting & release
- **One-command installer**: `./install.sh` + `docker-compose.selfhost.yml`
  bring up Postgres, Redis, LiveKit, backend, web and a **bundled Keycloak**
  (realm, PKCE web client, backend service account, first admin user imported
  automatically). Every published port is remappable; re-runs preserve
  secrets; health-gated startup with honest diagnostics.
- Bundled Keycloak is served on the app origin under `/auth`, so the browser,
  backend JWKS fetch, and OIDC issuer agree on one URL and the CSP stays
  same-origin. Fixed a proxy-header bug that stripped the port from the
  issuer, and the backend no longer pins a stale OIDC discovery document
  after a failed JWKS refresh.
- `.env.example` rewritten as a complete, honest reference (required core vs
  optional Brigade / voice / RAG / Meeting-Ops / email / push / Sentry).
- **License corrected to AGPL-3.0** (the file previously carried MIT text);
  README/docs refreshed to match reality. Version bumped to 0.2.0 across
  web, server, and agents.

### Home & catch-up
- Dashboard v2: priority inbox and conversation tabs, ranked agent-activity
  feed with markdown-stripped previews, knowledge rail, honest health strip,
  truthful `/home/summary` from the backend, stat tiles that open the right
  surface, stale tail collapsed behind a count, zero-states gated on data
  actually loading.
- Catch-up system: persisted mentions, an activity inbox, jump-to-first-unread
  chip for cold backlogs, draft indicators on sidebar rows, and one source of
  truth for unread badges.

### Rooms & messaging
- Room archiving (filtered listings + archive UI) and auto-titled agent DMs.
- Message search operators (`from:`, `in:`, `has:`, dates) honored on both
  search endpoints; keyboard navigation in every search surface; search lands
  on the message.
- Sidebar organization: folders, collapsible sections, people view, DMs above
  channels, type-aware DM headers, server rail with per-server logos and
  admin-editable branding.
- Human typing indicators; honest failure toasts (edit/delete/topic/leave)
  that keep your draft; a ConfirmDialog primitive replacing `window.confirm`.
- Idempotent human-DM creation (`ensureHumanDm`) that opens pure 1:1s only;
  JIT provisioning links Keycloak identities to existing participants by
  email.
- Room-type visibility model documented (`docs/stable-usage-conventions.md`):
  there is no private channel type; bridge sessions belong in DMs/group DMs.

### Calls & conferencing
- Persistent call across navigation; PiP; multi-screen-share; every remote
  feed can pop out into its own window (with sane position persistence);
  hide video/chat panes; resizable in-call layout.
- Direct 1:1 ringing with a real receive side, incoming-call banner, web
  push, ring tones, and "Calling…" cleared when the peer answers.
- Live human captions with correct speaker attribution (bound to LiveKit
  senders); optional durable Meeting-Ops transcript export (at-least-once
  outbox with retention/legal-hold controls).
- Mobile call modes (Video/Split/Chat), keyboard-viewport fixes for the iOS
  composer, chat pill moved off the control dock, auto-recovery of stale
  screen-share chunks, mic/camera header icons kept in sync.

### Agents & org chart
- Org chart renders the hierarchy Brigade states (no client-side re-deriving),
  with pop-out, zoom-to-agent, viewport controls, chain-of-command tier
  ordering, and readable zoom defaults.
- Honest agent presence and status: online means online (Redis-derived),
  availability is a distinct fact, no fake "thinking", and the responding
  agent is named.
- Room-scoped approval center; append-only agent audit trail; ORCH-1 public
  agent gateway (role-gated JWTs, scoped keys, non-spoofable derived agent
  identity); text-reply path through the Brigade chat API when voice plugins
  are unavailable. All Brigade integration remains optional.
- Artifact/Canvas live delivery over the room socket (no call required),
  without destroying unsaved edits or the reader's scroll position.

### Avatars & talking faces
- Every resident agent got real art: portrait pipeline, on-style rerolls,
  full-size portraits in DM intros, one shared AgentPortrait component with a
  real failure path.
- Talking-face ladder: procedural animated avatars → VRM muppet-mouth that
  moves with the voice; agent tiles always show a face on calls (and stopped
  publishing blank camera tracks).
- Dropped the Gravatar fallback (broken images + email-hash leak); header
  avatar reconciled at login.

### Knowledge bases
- Real citations in agent answers with honest retrieval states — an outage is
  never passed off as an empty answer, and rooms without documents are not
  "searched".
- KB management: delete, indexing-status feedback, retry; stranded-indexing
  recovery on boot; per-user document/byte quotas.

### Reliability: WebSockets & auth
- First-frame WebSocket authentication — tokens left the URL (real tokens
  overflow uvicorn's silent ~8 KiB header cliff); browser-shaped upgrade
  probe added as a CI regression gate.
- Dedicated `stable-ws.*` bypass host routed around the CDN (HTTP/3 extended
  CONNECT stalls), HTTP/1.1-only ALPN, cookie + extension stripping on the
  /ws proxy, oversized legacy URLs fail fast with 414.
- Token refresh before every WS connect, bounded failure paths, no reconnect
  storms on expired tokens, stale outage banners can't outlive recovery, and
  session recovery is escalated on rejected handshakes.

### Security hardening
- Secret split: `GATEWAY_KEY_ADMIN_SECRET` separates gateway key minting from
  the internal agent bearer; `UPLOAD_URL_SECRET` signs attachment URLs (the
  public static /uploads mount is gone).
- Internal agent surface (`/api/v1/internal/*`) denied at the edge on BOTH
  entrypoints — closing a port-80 bypass — with the constant-time bearer kept
  as defense in depth.
- Production startup guard refuses world-known default LiveKit secrets;
  WebSocket query strings (which carried tokens) removed from access logs;
  enterprise readiness gates (`/ready`) cover schema, identity, audit
  credential, observability, and build provenance.

### Deploy & ops
- `scripts/deploy.sh`: dirty-tree refusal, git-SHA provenance stamped into
  images, rollback tags before replacement, CPU-capped builds, readiness +
  external-URL + served-artifact gates (the server rail file is asserted,
  not assumed).
- Per-org provisioner (offering C): one hardened stack per organization with
  allocated LiveKit port blocks; cross-stack de-aliasing (container-name
  dialing) after the shared-network alias collision outage.

### Landing & mobile polish
- Logged-out marketing front door (rotating headlines, real product capture,
  pricing/security pages, OG share card) that never blocks login or deep
  links.
- The mobile audit batch: 44px touch targets, notch/keyboard honoring,
  reachable controls, clickable reactions, working read-aloud.

## v0.1.1 — 2026-07-13

Baseline tag: LiveKit rooms with chat/voice/video, Keycloak OIDC auth,
Brigade-backed agents, knowledge bases, uploads, presence, and the
conferencing-parity call UI, deployed single-tenant.
