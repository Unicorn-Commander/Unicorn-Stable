# Stable — call recording (design §8): policy, composite video, storage, retention

Server lane L8s (branch `feat/ux-l8-recording-server`). What ships, what an
operator must provision, the deploy step that keeps dogfood recording, and
what to measure on the first real call. Nothing here deploys itself.

## What changed, in one paragraph

Before: `CALL_RECORDING_ENABLED=true` recorded the audio of EVERY call on the
instance (room-composite OGG → Meeting-Ops attach) and never deleted a file.
Now the **room** decides — `rooms.recording_policy = off | on_request | always`
(owner/admin via `PATCH /rooms/{id}`), server-side recording needs the Keycloak
realm role **`stable-recorder`**, `record_my_calls` is a personal default, guests
get a consent line, everyone in the room gets a `recording_state` frame and a
system message on every start/stop, **composite video** (MP4 of our broadcast
page) exists next to audio, finished files go to S3-compatible storage
(Garage / Studio Storage), local files are deleted after upload, and a sweep
enforces 30-day retention unless `legal_hold` is set. `CALL_RECORDING_ENABLED`
stays as the instance-wide master kill-switch. Audio recording itself is
byte-for-byte the previous lane (same `stable-call-<room>-<stamp>.ogg`, same
Meeting-Ops chunked `action=attach`).

## Deploy step — DO THIS on any instance that had CALL_RECORDING_ENABLED=true

Migration `023_recording_policy` defaults every room to `off`. On its own that
silently stops dogfood recording. Right after the migration, from the backend
container, keep today's behaviour on purpose:

```sh
docker compose exec backend python scripts/set_recording_policy.py \
    --policy always --kind audio --all-active            # add --dry-run first
```

`--all-active` = every non-archived room; `--room <uuid>` (repeatable) for a
subset; `--kind` omitted keeps each room's kind. Every changed room gets an
append-only `agent_events` row (`event_type=recording_policy_changed`) naming
the actor and the before/after values. The same function is
`POST /api/v1/admin/recording/policy {policy, kind, rooms: "all_active" | [ids],
dry_run}` for instance admins (`STABLE_ADMIN_ROLES`, the agent-access gate).

Then grant the realm role `stable-recorder` in Keycloak (uchub realm) to the
people who may press Record (Aaron, Shafen); `always` rooms record without it.

## The policy matrix

| policy | entitled (`stable-recorder`) | `record_my_calls` | manual start | auto-start on first join | manual stop |
|---|---|---|---|---|---|
| off | any | any | 403 | no | 403 |
| on_request | no | any | 403 | no | 403 |
| on_request | yes | off | start (started_by = caller) | no | stop |
| on_request | yes | on | start | start **iff the joiner started the call** (started_by = them) | stop |
| always | no | any | 403 | start (started_by NULL) | 403 |
| always | yes | any | start | start (started_by NULL) | owner/admin only |

Also: already recording → 409; nothing recording → 409 on stop; master switch
off → 503; composite capacity full → 429; egress service silent → 503.
Delete (`DELETE /rooms/{id}/recordings/{id}`) and download links: room
owner/admin or whoever started it; `legal_hold` → 423.

The engine is `server/app/services/recording_policy.py` (pure functions, the
whole table is unit-tested). The webhook path has no JWT, so the role is
mirrored onto `participants.metadata->>'stable_recorder'` at sign-in.

## Endpoints and events

- `POST /api/v1/rooms/{id}/recording/start {kind?: audio|composite}` → 202 + state
- `POST /api/v1/rooms/{id}/recording/stop` → 202 + state
- `GET  /api/v1/rooms/{id}/recording` → `{active, policy, kind, started_by, started_at, recording_id, can_record}`
- `GET  /api/v1/rooms/{id}/recordings` → rows: `kind, status, started_by(+name), started_at, duration_seconds, storage_url, mo_session_id/url, retention_until, legal_hold, can_delete, can_download`
- `GET  /api/v1/rooms/{id}/recordings/{id}/download` → presigned URL (15 min)
- `DELETE /api/v1/rooms/{id}/recordings/{id}` → 204
- `POST /api/v1/admin/recording/policy` → bulk (admins)
- Guest join (`/guest/redeem`, `/guest/me`) gains `recording: {active, policy, kind, started_by, started_at}` — the consent line.
- WS `recording_state` on `room:{id}` — payload `{room_id, active, kind, started_by:{id,display_name}|null, started_at, recording_id, reason}`.
- A persisted system message (`content_type=system`, `sender_type=system`) in the room: "Recording started by Aaron" / "Video recording started by …" / "Recording started (this room always records)" / "Recording stopped".

## Composite video — how it works and the web contract

**Which page gets rendered — `CALL_RECORDING_COMPOSITE_TEMPLATE` (2026-09-24):**
`livekit` (default) renders the grid template the egress container ships —
every participant's camera tile with its name, nothing of ours has to be
reachable, `CALL_RECORDING_COMPOSITE_LAYOUT` = grid | speaker | single-speaker.
`stable` renders our page at `/broadcast/{room}/composite` with a recorder
token, exactly as the rest of this section describes. That page is in the web
app (a 1280×720 grid, name plates inside the tile, every subscribed audio
track playing, `START_RECORDING` / `END_RECORDING`). Leave the default at
`livekit` until an operator flips it on a host whose egress can reach the
page; shipping the page does not flip the flag.

A composite is a LiveKit **room-composite egress** with `custom_base_url` =
our broadcast page carrying a **recorder token**:

```
<base>/broadcast/{room_id}/composite?rt=<recorder token>     ← what the backend hands LiveKit
…&url=<ws url>&token=<LiveKit JWT>&layout=grid               ← what the egress worker appends
```

`<base>` = `CALL_RECORDING_COMPOSITE_BASE_URL`, default `PUBLIC_BASE_URL`. The
recorder token is a `broadcast_tokens` row (`participant_identity='*'`,
`created_by='system:recorder'`, `allow_audio=true`, TTL = `CALL_RECORDING_MAX_HOURS`,
revoked when the egress ends). `POST /broadcast/join` with it returns the same
subscribe-only, hidden LiveKit grant every OBS feed gets, plus `mode: "composite"`.
It is deliberately absent from `GET /broadcast/active` — the recording has its
own consent surface.

**Web contract for `/broadcast/{room}/composite`:**
1. read `rt` from the query (NOT `token` — LiveKit overwrites that one);
2. `POST /api/v1/broadcast/join {token: rt}` with a bare fetch (no Keycloak
   header). Require `mode: "composite"`, then render every publisher's camera
   in a 1280×720 grid. A publisher with no live camera gets an initials tile,
   not an empty cell. `object-fit: contain` keeps the frame uncropped and the
   name plate sits fully inside the tile. The `layout` query
   (`grid` | `speaker` | `single-speaker`) is accepted and does not change the
   grid. If `rt` is absent but LiveKit's `url` and `token` are both present,
   connect with those instead of the exchange;
3. play every subscribed audio track (humans and agents). The egress records
   the page's audio;
4. wait up to two seconds after connect for already-published (and any newly
   subscribed) media; video must render a first frame, while audio only needs
   to be subscribed. Then requestAnimationFrame and log
   `console.log("START_RECORDING")` once. A video track is not required — an
   audio-only call still records. `console.log("END_RECORDING")` is logged
   once only after START, for room deletion, participant removal, pagehide, or
   refusal of a later recorder-token exchange;
5. keep one LiveKit connection for the recording. LiveKit server refreshes its
   token; there is no timed re-exchange. If an unexpected disconnect occurs,
   livekit-client stops and detaches the old audio/video tracks before reporting
   the disconnect, so the page may briefly show initials tiles and have no
   audio. It re-exchanges `rt` and reconnects with 1, 2, 4, 8, then 10 second
   backoff; the replacement session attaches its newly subscribed media.

The MP4 lands on the shared `/egress-out` volume, is uploaded to storage, is
attached to the call's Meeting-Ops session (`content_type video/mp4`, same
chunked `action=attach` path), then the local file is deleted.

## Capacity: where the egress worker runs

A composite egress is a **headless Chrome + x264 encode**. LiveKit's own
guidance is ~2 cores per 720p30 composite; audio-only needs ~1. The cap is
`RECORDING_MAX_COMPOSITE` (default 2), enforced instance-wide by a Redis
sorted-set semaphore (`stable:recording:composite_slots`; slots expire with
`CALL_RECORDING_MAX_HOURS`, and the 2-minute sweep reconciles them against
rows still in flight). A third composite answers **429** with a plain message;
a policy-driven start at capacity falls back to audio and says so in the log.

**Run the egress worker on a host with CPU headroom, not the LiveKit host.**
The SFU is latency-sensitive; a Chrome encode next to it shows up as jitter
on every call. To move it:

1. On the egress host, run `livekit/egress:v1.14.1` with an `egress.yaml`
   (template `server/egress.yaml.example`) whose `redis` is THIS stack's redis
   (that redis is the egress dispatch bus — a different one means StartEgress
   sits forever) and whose `ws_url` is a route the egress host has to the SFU
   (the public `wss://` works). Set `cpu_cost.room_composite_cpu_cost: 2.0` and
   `max_concurrent_web: 2` there; give the container `shm_size: 1g` and
   `cpus: 2 + 2×RECORDING_MAX_COMPOSITE`.
2. Share `/egress-out` between that host and the backend (NFS or a bind on the
   same box). The backend reads the finished file from that path to upload and
   to attach; an unshared volume shows up as `audio file missing` on the row.
   (Follow-up: LiveKit can write straight to S3 via `EncodedFileOutput.s3`,
   which would drop the shared-volume requirement for the storage copy.)
3. The broadcast page origin must be reachable from the egress host and its
   TLS must verify in Chrome (no self-signed dogfood certs).
4. Keep `stable-net` reachability for redis or expose it with auth over the LAN.

Candidate from the design: centerdeep (measured 92 % idle on 08-08) — verify
before choosing.

**Decision 2026-09-24 (N3):** the worker stays on the application host for now, next to the
SFU, with `EGRESS_CPUS=5.0` and the `cpu_cost` block above in its
`egress.yaml`. Measured that morning: the host had 24 cores, 75 % idle, CPU PSI
0.00, 69 GB available; centerdeep 8 cores (a VM with ~6 % steal). Moving the
worker means exposing the stack's redis over the LAN and sharing
`/egress-out` by NFS, which is a project of its own; do it if the first
composite proof shows jitter on calls (`docker stats stable-egress` during a
call is the number to watch). ⚠️ Until the `cpu_cost` block existed, the
egress logged `not enough cpu for some egress types … available: 2` at start
and would have refused every video composite: its default cost for a room
composite is 3–4 CPU, above a 2-CPU container.

## When the hand-off has no session, and when the egress dies

Measured on dogfood 2026-09-24: four of the last ten recordings sat as
`handoff_status=no_session` — the call's Meeting-Ops session is created by a
browser's transcript export, and when nobody exported (or the ±window missed)
the finished file had nowhere to attach. Now, after
`CALL_RECORDING_SESSION_WAIT_SECONDS` (default 30 min) with no matching
export, the hand-off uploads the file to Meeting-Ops as `action=transcribe`:
MO creates the session from the media and runs its own STT + summary, and the
row records the session it landed in (`mo_session_id`) when MO has assigned
it. `no_session` therefore no longer happens on a healthy MO; it remains in
the vocabulary for old rows. (MO's transcript-ingest endpoint cannot do this:
it refuses an export with zero lines.)

An egress that ends with nothing captured ("Start signal not received",
0 bytes, 1.2 s after StartEgress in the measured case) in a room whose policy
is `always` is retried once automatically — only while a human is still in
the LiveKit room, and at most two failures per room per three minutes so a
broken egress cannot loop. The failed row's `error` names its replacement.
A failure that is not retried is loud: a system line in the room
("Recording failed: …") and an `agent_events` row (`recording_failed`).
The 2-minute sweep asks LiveKit (`list_egress`) about a row whose
`egress_ended` webhook never arrived before calling it lost.

## Storage and retention

`RECORDING_S3_*` point at Garage / Studio Storage (path-style by default). One
object per recording: `<prefix><room_id>/<row_id>.<ogg|mp4>`; `storage_url` on
the row is the canonical URL; downloads are presigned GETs
(`RECORDING_DOWNLOAD_LINK_SECONDS`). The signer is SigV4 over httpx
(`services/recording_storage.py`, verified against the AWS worked examples),
no boto3. With no endpoint configured nothing uploads and files stay local.

Pipeline per finished recording (durable outbox, every worker):
storage upload → Meeting-Ops attach → delete local file once both are settled.
A failing upload holds the attach back and retries with backoff (one visibly
stuck row, not a delivered session with a missing file).

Retention: `retention_until = ended + CALL_RECORDING_RETENTION_DAYS` (30). The
2-minute sweep deletes the storage object and any local file of expired rows;
`legal_hold=true` rows are never touched. Manual delete purges immediately and
marks the row `deleted`.

## Environment (backend)

| Name | Default | Notes |
|---|---|---|
| `CALL_RECORDING_ENABLED` | false (compose: true) | master kill-switch; the room policy decides |
| `CALL_RECORDING_OUTPUT_DIR` | `/egress-out` | shared with the egress worker |
| `CALL_RECORDING_COMPOSITE_BASE_URL` | `` (= `PUBLIC_BASE_URL`) | broadcast page origin, reachable from the egress host |
| `CALL_RECORDING_COMPOSITE_PRESET` | `H264_720P_30` | LiveKit EncodingOptionsPreset; raise after measuring |
| `RECORDING_MAX_COMPOSITE` | 2 | concurrent composites, instance-wide |
| `CALL_RECORDING_MAX_HOURS` | 6 | recorder-token TTL, slot TTL, stale sweep |
| `CALL_RECORDING_RETENTION_DAYS` | 30 | |
| `RECORDING_S3_ENDPOINT` | `` | `https://…`; empty = no upload |
| `RECORDING_S3_BUCKET` | `` | |
| `RECORDING_S3_ACCESS_KEY` / `RECORDING_S3_SECRET_KEY` | `` | Vaultwarden, `.env` only, never logged |
| `RECORDING_S3_REGION` | `garage` | Garage accepts its configured region name |
| `RECORDING_S3_PATH_STYLE` | true | |
| `RECORDING_S3_PREFIX` | `stable-recordings/` | |
| `RECORDING_DOWNLOAD_LINK_SECONDS` | 900 | |
| `EGRESS_CPUS` (compose) | 2.0 | raise on the composite host |
| `STABLE_ADMIN_ROLES` | `stable-admin,realm-admin,admin` | existing; gates the bulk endpoint |

## What Persephone must provision before the first live proof

1. **Keycloak**: realm role `stable-recorder`; grant to Aaron + Shafen.
   ✅ 2026-09-24: role created in the configured realm on the configured auth host
   and granted to Aaron (Shafen when he says so). The role is mirrored onto
   `participants.metadata` at sign-in, so a fresh sign-in is needed once.
2. **Storage**: a Garage bucket (e.g. `stable-recordings`) and a key scoped to
   that bucket only (read/write/delete); store in Vaultwarden with owner + expiry;
   put endpoint/bucket/key/secret/region in the dogfood `.env`.
3. **Egress host**: pick the host (not the LiveKit host), run the worker as above,
   share `/egress-out`, confirm `redis` and `ws_url` reach the stack.
4. **Web**: the composite page is in the repo at `/broadcast/{room}/composite`
   (contract above). Flip `CALL_RECORDING_COMPOSITE_TEMPLATE=stable` only once
   the egress host can reach `PUBLIC_BASE_URL` (or the override) and Chrome
   trusts its TLS. Until that flip, recordings keep LiveKit's own grid.
5. **Policy**: after 023, run `scripts/set_recording_policy.py --policy always
   --kind audio --all-active` on dogfood; set one test room to
   `on_request`/`composite` for the proof.

## First real call — what to measure and post on the task

1. Start a call with two livekit-cli publishers (or two browsers) in the test room; press Record (composite).
2. In the room: the `recording_state` frame arrived (devtools WS), the REC pill shows `started by …`, the system message is in the transcript, a guest's `/guest/me` shows `recording.active=true`.
3. `docker stats stable-egress` during the call: CPU % and memory per composite (this decides `RECORDING_MAX_COMPOSITE` and the host). Note the preset.
4. Stop: row → `complete`, `retention_until` = +30 d, `storage_url` set, object present in Garage (`aws s3 ls` or the Garage UI), file size and bitrate, upload duration from the log (`recording_storage_uploaded`), local file gone from `/egress-out`, recorder token revoked (`GET /broadcast/tokens` shows `kind: recorder`, inactive).
5. Meeting-Ops: the call's session has the MP4 attached (`call_recording_handoff_delivered` with `kind=composite`).
6. Start a third composite while two run: 429 with the plain message.

## Secrets and logging

Nothing logs the recorder token, the template URL, storage keys or presigned
links. `egress_info.room_composite.custom_base_url` in LiveKit's webhook
payload contains the recorder token — never dump raw egress webhooks to logs.
