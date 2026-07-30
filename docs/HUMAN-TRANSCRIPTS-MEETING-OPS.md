# feat/human-transcripts-meeting-ops

P-00115 / Meeting-Ops session `77fd49a9` — live human call captions + Send to Meeting-Ops.

## What works

### Live captions for humans (not only agents)
1. **Agent in the call (existing path, unchanged):**  
   `TranscriptPublisher` + Parakeet/Amanuensis STT still publishes human interim/final + agent replies on LiveKit topic `stable` → `VoiceProvider` → `callUiStore` → `TranscriptPanel`.
2. **No agent (new):**  
   Browser **Web Speech API** captions the **local human** mic (`web/src/lib/humanTranscript.ts`), ingests into the same store, and publishes on the same data channel so peers see speaker-labeled lines. Stops automatically when an agent joins; restarts if the agent leaves.
3. Agent voice path is untouched (additive only).

### Send to Meeting-Ops
1. **Per-session toggle** on the live transcript panel header row (“Send to Meeting-Ops”).
2. **Default preference** in Settings → Notifications → “Call transcripts” (“Send call transcripts to Meeting-Ops by default”). Defaults **ON**. Stored in `localStorage` (`stable.meeting-ops.transcript.default.v1`).
3. **Send now** button exports final lines mid-call without hanging up.
4. **Hang-up auto-export** when the session toggle is on and there is at least one final line.
5. **Backend**  
   - `POST /api/v1/rooms/{room_id}/transcripts/export` — structured payload, room-member auth.  
   - `GET /api/v1/transcripts/meeting-ops/status` — whether a remote URL is configured (no secrets).  
   - Durable forward via `MEETING_OPS_URL` + `MEETING_OPS_API_KEY` + `MEETING_OPS_ORG_SLUG`. Incomplete configuration returns `meeting_ops.status=blocked` and retains the export for later delivery.

## Env (no secrets committed)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEETING_OPS_URL` | _(empty)_ | Meeting-Ops base URL; required for delivery |
| `MEETING_OPS_INGEST_PATH` | `/api/v1/sessions/ingest` | Path appended to base |
| `MEETING_OPS_API_KEY` | _(empty)_ | Meeting-Ops PAT (`mops_pat_…`); required for delivery |
| `MEETING_OPS_ORG_SLUG` | _(empty)_ | Explicit target Meeting-Ops organization; required for delivery |
| `MEETING_OPS_ENABLED` | `true` | Master switch |

Documented in `.env.example` and wired in `docker-compose.yml` for the backend service.

## How to test

### Captions
1. Open Stable, join a room, start a call with **no** agent (or remove agent).  
2. Allow mic. Speak — local captions should stream (interim italic → final solid) in the CC panel. Chromium recommended (Web Speech API).  
3. Invite Majik — browser STT should stop; agent STT + agent reply captions should continue as before.  
4. Hang up agent / agent leaves — browser STT resumes for local speech.  
5. Optional: `?devtranscript` + Seed button still works for UI-only checks.

### Meeting-Ops toggle / export
1. Settings → Notifications → confirm “Send call transcripts to Meeting-Ops by default” is on; toggle off/on and reload — preference persists.  
2. Start a call; transcript panel shows the session checkbox seeded from that default.  
3. With sample/final lines present, click **Send now** — expect a delivered deep link, queued status, or a truthful blocked status when configuration is incomplete.
4. Hang up with toggle on + final lines → network tab should show `POST …/transcripts/export` (200).  
5. With Meeting-Ops configured on a deploy box: set URL, PAT, and organization, redeploy backend, re-export → status progresses to `delivered` and includes `remote_session_url`.

### Backend smoke (local)
```bash
# status (auth required)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/api/v1/transcripts/meeting-ops/status"

# export (auth + room membership)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"lines":[{"participant_id":"u1","name":"You","text":"hello","ts":1710000000000,"is_final":true}],"send_to_meeting_ops":true}' \
  "$API/api/v1/rooms/$ROOM_ID/transcripts/export"
```

## Still blocked / residual risks

1. **Meeting-Ops ingest contract** is implemented at `POST /api/v1/sessions/ingest`. It uses PAT auth, `X-MeetingOps-Org`, and `Idempotency-Key`; the adapter is isolated in `server/app/services/meeting_ops.py`.
2. **Web Speech API** quality/language depends on the browser; Safari/Firefox support is weaker than Chromium. No browser STT ⇒ human-only calls need an agent for captions.  
3. **Remote humans** without this client build (or without speech recognition) are not captioned unless an agent is in the room running STT.  
4. Stable persists finalized exports in `transcript_exports` before delivery. The outbox retries transient failures with bounded exponential backoff, recovers interrupted claims, and retains blocked exports until the complete Meeting-Ops target is configured.
5. **Not deployed** by this branch; production roll-out is a separate step.

## Files changed (high level)

- `web/src/lib/humanTranscript.ts` (new)  
- `web/src/lib/meetingOpsPrefs.ts` (new)  
- `web/src/components/Room/TranscriptPanel.tsx`  
- `web/src/contexts/VoiceProvider.tsx`  
- `web/src/stores/callUiStore.ts`  
- `web/src/services/api.ts`  
- `web/src/components/Layout/SettingsModal.tsx`  
- `web/src/lib/roomDataProtocol.ts`, `web/src/lib/devTranscript.ts` (comments)  
- `server/app/api/transcripts.py` (new)  
- `server/app/services/meeting_ops.py` (new)  
- `server/app/config.py`, `server/app/main.py`  
- `docker-compose.yml`, `.env.example`  
- `SUMMARY.md` (this file)
