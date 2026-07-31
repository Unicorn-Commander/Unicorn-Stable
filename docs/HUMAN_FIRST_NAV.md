# Human-first navigation (feat/human-first-nav)

Branch work that re-orients Stable around people, standing meetings, and durable call work objects — without rebuilding Meeting-Ops or inventing legal-hold chrome.

## How to flag off view-based nav

Default on this branch: **on**.

| Mechanism | Values | Effect |
|-----------|--------|--------|
| `localStorage.stable_nav_v1` | `"0"` / `"false"` | Force classic sidebar (People / Groups / Channels tree) |
| `localStorage.stable_nav_v1` | `"1"` / `"true"` | Force view switcher shell |
| `VITE_NAV_V1` | `"0"` / `"false"` | Build-time default off (overridden by localStorage) |
| (unset) | — | **Default on** |

Console one-liner (reload after):

```js
localStorage.setItem("stable_nav_v1", "0"); // classic
localStorage.setItem("stable_nav_v1", "1"); // nav v1
// or:
localStorage.removeItem("stable_nav_v1");   // fall through to env / default
```

Implementation: `web/src/stores/navStore.ts` → `isNavV1Enabled()`, `NAV_V1_FLAG_KEY`.

## Slice status

| Slice | Status | What shipped |
|-------|--------|--------------|
| **1 — People / ensure DM** | Done | Idempotent `POST /api/v1/dms/ensure` + client `ensureHumanDm`; global People drawer; Create-DM multi-pick left as group path |
| **2 — View shell** | Done | Home / Chats / Channels / Meetings / Agents switcher; `roomsForView` shared by list + Alt+↑/↓; deep-link `viewForRoom` |
| **3 — Focused unreads** | Done | Focused vs All filter; mark-section-read; mention + DM badge model |
| **4 — Home dashboard** | Done | Live/rejoin call, mentions & priority, favorites online, recent human chats; agents only when actionable |
| **5 — Mobile call modes** | Done | Video / Split / Chat intent modes on narrow viewports (separate from desktop grid/focus modes) |
| **6 — Meeting work objects + durable Meeting-Ops** | Done (this audit) | Standing conference rooms; hang-up / Send-now export into durable outbox; Meetings rail polish |

## Slice 6 — Meeting-Ops durable delivery (audit)

### Server (already on enterprise integrate path)

- **Model:** `TranscriptExport` (`transcript_exports`) — payload, idempotency key, status, attempt backoff, remote session ids, payload retention/redaction.
- **Accept path:** `POST /api/v1/rooms/{room_id}/transcripts/export` persists the outbox row **first**, returns immediately with `meeting_ops.status` ∈ `{pending, blocked, local_only, delivering, delivered, failed}`, then schedules a **background** first attempt (`BackgroundTasks` → `deliver_export_now`). Does **not** await remote Meeting-Ops success on the request path.
- **Worker:** `run_transcript_outbox` (started from `main.py`) claims rows with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, recovers stale `delivering` claims, promotes `blocked` → pending when config becomes complete.
- **Status / retry:** `GET …/exports/{id}`, `POST …/exports/{id}/retry`, `GET /api/v1/transcripts/meeting-ops/status` (no secrets).
- **Adapter:** `server/app/services/meeting_ops.py` — PAT + org slug + idempotency; config validation fails closed in production when enabled misconfigured.

### Hang-up does not block on Meeting-Ops

1. **Client** (`VoiceProvider.disconnect`): fire-and-forget `void (async () => api.exportCallTranscript(…))()` **before** LiveKit `disconnect()` and UI teardown. Errors are `console.warn` only — hang-up never waits on Stable or Meeting-Ops HTTP.
2. **Stable API**: commit outbox → return; delivery is background/worker-owned.
3. **Meeting-Ops**: only contacted by the outbox worker / background task. Browser never talks to Meeting-Ops.

Mid-call **Send now** (`TranscriptPanel`) may poll export status for a few seconds to surface a deep link; that is optional UX on an explicit action and still does not couple hang-up to remote success.

### Web Meetings surface

- Nav view filters `room.is_conference` (`metadata.conference`).
- Standing catalog: `GET /rooms/conference/catalog` + `POST /rooms/conference/{slug}/enter` (lazy create-or-get).
- Meetings rail: joined standing rooms, **Return to call / Rejoin** when a LiveKit call is active, catalog CTAs for rooms not yet joined, empty-state copy.
- Home also surfaces live rejoin + recent conference activity.

### Env (no secrets in repo)

See `.env.example` and `docs/HUMAN-TRANSCRIPTS-MEETING-OPS.md`. Critical: `MEETING_OPS_ENABLED`, `MEETING_OPS_URL`, `MEETING_OPS_API_KEY`, `MEETING_OPS_ORG_SLUG`. Incomplete config → export `status=blocked`, retained for later delivery.

## What remains (later epic — not this branch)

- **Scheduled meetings** calendar objects, invites, RSVP, start-at chrome.
- **Recording / consent** UI (banner, policy, legal hold operator surface beyond existing server retention flags).
- **Richer export history** in-room list of past `TranscriptExport` rows (API GET list not shipped).
- **Remote peer captions** without agent when browser STT unavailable; multi-language STT policy.
- **Meeting-Ops bidirectional** (pull summaries / action items back into Stable rooms).
- **Per-org conference catalog** beyond the fixed Main Conference / War Room seeds.
- **Production deploy + secret wiring** for Meeting-Ops on commander (ops, not product code).
- **Ad-hoc call rooms** that are not `metadata.conference` still hang-up-export correctly but do not appear under Meetings — intentional; product may want a “recent calls” strip later.

## Related docs

- `docs/HUMAN-TRANSCRIPTS-MEETING-OPS.md` — live captions + export smoke tests.
- Config: `server/app/config.py` (`meeting_ops_*`), `server/app/services/transcript_outbox.py`, `server/app/api/transcripts.py`.
