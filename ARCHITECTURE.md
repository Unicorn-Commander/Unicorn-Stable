# Stable architecture

This document describes the components and flows implemented in this checkout.

## Deployment shapes

- A single deployment is one Compose project described by `docker-compose.selfhost.yml`.
- The self-host bundle contains PostgreSQL, Redis, LiveKit, the FastAPI backend, the web client, an optional bundled Keycloak profile, and an optional agent-runtime profile (`docker-compose.selfhost.yml`).
- `install.sh` writes `.env` and renders the self-host configuration. By default it starts the Compose project and waits for Postgres, backend `/live`, the bundled Keycloak realm when that profile is used, backend `/health`, and the web root. `--env-only` writes the configuration and does not start the stack (`install.sh`).
- `deploy/per-org/provision-org.sh` renders a separate stack directory and organization UUID for one organization. A process has one optional organization id (`STABLE_ORG_ID`). Empty means a community deployment, with no organization filter on browse or self-join. Many organizations as tenants of one process are not implemented. Browse and self-join still hide another organization's rows when those rows are in the same database (`deploy/per-org/provision-org.sh`, `server/app/config.py`, `server/app/api/rooms.py`).

## Components

```
browser
   |
   v
web (nginx)
   |-- /api and /ws --> backend (FastAPI)
   |-- /auth ---------> keycloak          (optional profile)
backend --> postgres, redis, livekit
keycloak --> postgres
livekit --> redis
agent-runtime --> livekit, backend        (optional profile)
```

- The web component is a React client served by the `web` Compose service. Its nginx proxies `/api` and `/ws` to the backend and `/auth` to bundled Keycloak (`docker-compose.selfhost.yml`, `deploy/selfhost/nginx.selfhost.conf.template`, `web/src/services/api.ts`).
- The API component is the FastAPI application. It mounts the room, Home, Crew, recording, transcript, broadcast, and gateway routers at `/api/v1`. `/live` and `/health` are not under that prefix (`server/app/main.py`).
- PostgreSQL stores rooms, memberships, messages, recording egress rows, transcript-export outbox rows, broadcast-token rows, and gateway-key rows (`docker-compose.selfhost.yml`, `server/app/models/room.py`, `server/app/models/call_egress.py`, `server/app/models/broadcast_token.py`, `server/app/models/agent_gateway_key.py`).
- Redis backs instance presence on channel `presence:instance`, API rate limits, Crew presence and the Brigade role-line cache, and composite-recording slot accounting. The recording policy module does not use Redis (`server/app/services/presence_service.py`, `server/app/deps.py`, `server/app/services/crew.py`, `server/app/services/recording_capacity.py`, `docker-compose.selfhost.yml`).
- LiveKit provides the call room and media transport used by human tracks, agent face tracks, broadcast viewers, and recording egress. The self-host template sets `use_external_ip: false` and leaves TURN off. LiveKit in that template also uses Redis (`docker-compose.selfhost.yml`, `deploy/selfhost/livekit.selfhost.yaml.template`, `server/app/services/livekit_service.py`, `agents/agent_runtime/puppet_video.py`, `server/app/api/broadcast.py`, `server/app/services/call_recording.py`).
- Keycloak supplies the OIDC identity provider. Auth is Keycloak OIDC. The installer runs a bundled Keycloak by default, or an external Keycloak with `--no-keycloak` and `--keycloak-url` (`install.sh`, `docker-compose.selfhost.yml`, `server/app/auth/`).
- Brigade, voice endpoints, document retrieval, Meeting-Ops, email, push, and error reporting are optional integrations represented by the self-host environment configuration. That Compose file defaults `RAG_ENABLED` and `MEETING_OPS_ENABLED` to false and leaves `WHISPER_BASE_URL`, `KOKORO_BASE_URL`, and `QDRANT_URL` empty. It does not define a vector database. The Settings field `rag_enabled` defaults to true when the variable is unset outside that file (`install.sh`, `docker-compose.selfhost.yml`, `server/app/config.py`).
- Speech-to-text returns 503 with detail `STT service not configured` when `whisper_base_url` is empty (`server/app/api/stt.py`).

## Browser and API flow

- `install.sh` selects the browser address, creates or preserves `.env` values, and renders the bundled Keycloak import and LiveKit configuration. It starts the Compose services unless `--env-only` is set (`install.sh`).
- The web service serves the SPA and proxies `/api`, `/ws`, and bundled `/auth` traffic to the corresponding service (`docker-compose.selfhost.yml`, `deploy/selfhost/nginx.selfhost.conf.template`).
- The browser API client sends authenticated requests to the API base and refreshes the OIDC token when required (`web/src/services/api.ts`, `web/src/services/auth.ts`).
- FastAPI dependencies authenticate the caller before routes that require a user or room membership (`server/app/deps.py`, `server/app/main.py`).
- LiveKit credentials for browser calls are issued by `POST /api/v1/tokens/livekit`. The backend uses its LiveKit service for room and participant operations (`server/app/services/livekit_service.py`, `server/app/api/tokens.py`).

## Room, membership, and tenancy flow

- `Room` stores the room type, organization ID, parent thread ID, channel visibility, recording policy, and recording kind. Member roles are `owner`, `admin`, `member`, and `guest` (`server/app/models/room.py`).
- The room creation schema accepts `channel`, `group_dm`, and `dm`. `ensure_agent_hub` finds or creates the one `agent_hub` for a human-agent pair. The partial unique index is `uq_rooms_agent_hub` (`server/app/schemas/room.py`, `server/app/services/room_service.py`).
- `GET /api/v1/rooms/browse` lists unarchived public channels the caller has not joined. It excludes DMs, group DMs, private channels, and agent hubs. When an instance organization id is set, it keeps that organization's channels and organization-less channels (`server/app/api/rooms.py`).
- `PATCH /api/v1/rooms/{room_id}` updates owner-or-admin visibility and recording settings. A seat model or effort on that same route is a separate check: only the seat's owner may change it, and the seat must be a runner member of a live room (`server/app/api/rooms.py`, `server/app/schemas/room.py`, `server/app/services/room_service.py`).
- A private channel is excluded from browse, and a caller cannot self-join it. A member of a thread's parent can open that thread. Other membership is added by invitation (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- A thread is a child room that keeps the parent's room type, organization, visibility, and recording policy and kind. A member of a parent that is not archived can create one, and a thread cannot be created under another thread. The room list can return threads under their parent (`server/app/models/room.py`, `server/app/services/room_service.py`, `server/app/api/rooms.py`, `server/app/api/conversation.py`).
- On a per-organization deployment, room creation stamps `settings.instance_org_id`. Browse and self-join allow that organization and an organization-less channel, and refuse another organization's channel. An empty instance organization setting does not apply that filter (`server/app/config.py`, `server/app/models/room.py`, `server/app/api/rooms.py`, `server/app/services/room_service.py`).
- Listing and searching the knowledge collections attached to a room require room membership. Search returns `{"results": []}` when the room has no collections or nothing matched, and 503 when the retrieval plane is unreachable (`server/app/api/knowledge.py`).

## Home, Crew, and navigation flow

- `GET /api/v1/home/summary` returns live calls, agent activity, recent artifacts, recent transcripts, and counts. `v=3` adds `needs_you`, `crew`, and `today`. The web client requests `v=3` (`server/app/api/home.py`, `web/src/components/Home/homeClient.ts`).
- On a desktop, Home puts the composer first, then the caller's own seats, then the needs-you, live, today, and recent zones that contain rows. On a phone the composer is pinned above the tab bar and the scroll starts with the seats (`web/src/components/Home/HomeDashboard.tsx`).
- `GET /api/v1/crew` returns presence, seat capabilities, hub id, last line, and unread. Rank order is the caller's own seats, then house agents with a message in the last 14 days, then partner seats, then the remaining house agents by name. Guest agents and integrations are excluded (`server/app/api/crew.py`, `server/app/services/crew.py`).
- The desktop Crew section and the phone Crew page use the same Crew model. A house agent opens its hub. One of the caller's seats opens a hub only after that seat has announced `seat_capabilities`. A partner seat opens the newest shared room and has no New conversation action (`web/src/lib/crew.ts`, `web/src/components/Sidebar/CrewSection.tsx`, `web/src/components/Sidebar/sidebarModel.ts`).
- By default the rail destinations are Home, Conversations, and Directory. Phone tabs are Home, Chats, Crew, Calls, and Me. Crew and Calls read as Conversations on the desktop rail. Me opens an account sheet and is not a rail destination. `stable_nav_v2=0` restores the five-view shell while nav v1 is on (`web/src/stores/navStore.ts`, `web/src/components/Layout/PhoneTabBar.tsx`, `web/src/components/Layout/MeSheet.tsx`).
- A runner seat's per-conversation model and effort are written as `metadata.seats[agent_id]` through the room update path. The server accepts a model matching its pattern, or null, and an effort of null, `low`, `medium`, `high`, or `max` (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`, `server/app/services/room_class.py`, `server/app/api/rooms.py`).

## Calls and agent faces

- `voice_relay_video` is optional room metadata and defaults off. When it is on, the voice relay creates a `PuppetVideo` instance and starts it in the LiveKit room (`agents/voice_relay/agent.py`).
- `PuppetVideo` creates a LiveKit `VideoSource`, captures rendered frames, and publishes a `SOURCE_CAMERA` track. The grid, broadcast page, and egress can receive that track (`agents/agent_runtime/puppet_video.py`).
- The voice settings UI labels this feature `Faces on camera` (`web/src/components/Room/VoiceSettingsModal.tsx`).
- The same call path can carry human tracks, agent tracks, and voice-relay cast participants. Cast participants are the separate optional flag `voice_relay_multi`, which also defaults off (`server/app/services/livekit_service.py`, `agents/voice_relay/agent.py`, `agents/voice_relay/cast.py`).

## Recording and meeting-notes flow

- Room recording settings use `off`, `on_request`, or `always` and select `audio`, `composite`, or `track` as the configured kind (`server/app/models/room.py`, `server/app/schemas/room.py`).
- Manual `POST /api/v1/rooms/{room_id}/recording/start` accepts `audio` or `composite`, checks the room policy, the instance switch `CALL_RECORDING_ENABLED`, and the `stable-recorder` entitlement, and creates a call-egress row (`server/app/api/recording.py`, `server/app/services/recording_policy.py`, `server/app/models/call_egress.py`).
- An `always` room auto-starts on the first non-service participant join while the instance switch is on, without that joiner's recorder role. Stopping an `always` room requires the recorder role and the room owner or a room admin. An `on_request` room can auto-start when an entitled caller who has `record_my_calls` starts the call (`server/app/services/recording_policy.py`, `server/app/services/call_recording.py`, `server/app/api/webhooks.py`).
- `GET /api/v1/rooms/{room_id}/recordings` lists recording rows for every room member and marks which rows that caller may download or delete. `GET /api/v1/rooms/{room_id}/recordings/{recording_id}/download` returns a presigned storage URL for the owner, an admin, or the recording starter when a stored copy exists. The link lifetime defaults to 900 seconds. Delete uses the same people and answers 423 when the row is under `legal_hold` (`server/app/api/recording.py`, `server/app/services/recording_policy.py`, `server/app/services/recording_storage.py`, `server/app/config.py`).
- `POST /api/v1/rooms/{room_id}/transcripts/export` commits a transcript export to `transcript_exports` before any forward, and can forward it to the optional Meeting-Ops ingest (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/services/meeting_ops.py`).
- Stored export statuses are `pending`, `delivering`, `blocked`, `delivered`, `failed`, and `local_only`. Recording audio handoff statuses written by the service are `none`, `pending`, `blocked`, `delivering`, `delivered`, and `failed`. An attempt the forwarder marks retryable is stored as `pending` again until the attempt limit, then `failed`. Meeting-Ops has no in-progress call session record. The current integration is post-call (`server/app/models/room.py`, `server/app/models/call_egress.py`, `server/app/services/transcript_outbox.py`, `server/app/services/call_recording.py`, `server/app/services/meeting_ops.py`).

## Broadcast flow and security boundary

- The broadcast router is mounted at `/api/v1`. `POST /api/v1/broadcast/tokens` mints one owner-only credential for one participant. `GET /api/v1/broadcast/active` is the room consent surface for members. `POST /api/v1/broadcast/join` is the raw-token exchange (`server/app/api/broadcast.py`, `server/app/main.py`).
- The web broadcast page subscribes to the named participant's camera or screen. The copy menu labels are Camera, Camera with audio, Screen, and Screen with audio. Camera versus screen is the copied URL's `source` query. `allow_audio` is the token field and defaults to false (`web/src/components/Broadcast/BroadcastPage.tsx`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`, `server/app/api/broadcast.py`).
- A broadcast token renders the named participant's camera or screen with no login and is a credential. Only its SHA-256 hash is stored, the raw value is returned once, its entropy comes from `secrets.token_urlsafe(32)` with prefix `sbt-`, it is scoped to one room and one participant identity, its default TTL is eight hours with a one-hour minimum and a twenty-four-hour cap, `revoked_at` revokes it immediately, and only the prefix is logged. The LiveKit session token from join is at most 3600 seconds (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The LiveKit grant is subscribe-only and hidden, with publishing and data publishing disabled (`server/app/api/broadcast.py`).
- LiveKit grants subscribe at room granularity, so the page's named-participant selection is client-side. A link holder running their own client could subscribe to other publishers in that room. This path does not use LiveKit's server-side subscription-permission API (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- `GET /api/v1/broadcast/active` reports the participant, audio permission, expiry, and viewer count to room members. The count is null when LiveKit cannot be listed. The web client warns `One of these links has more than one viewer. Revoke it if that is not you.` (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`, `web/src/lib/broadcast.ts`).

## Agent gateway flow

- The gateway router is mounted at `/api/v1/gateway`. It authenticates a JWT or a scoped gateway key, then derives the agent identity used for room reads and writes (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`, `server/app/main.py`).
- `POST /api/v1/gateway/keys` is operator-only. It requires exactly one expiry choice: `expires_in_days` from 1 through 366, an absolute `expires_at` that is not in the past, or `no_expiry=true`. It also requires a history choice of `full`, `from_mint`, or a timestamp that is not in the future. The key row stores `expires_at` and `history_from`. Migration `025_gateway_key_expiry_floor` adds those nullable columns (`server/app/api/gateway.py`, `server/app/models/agent_gateway_key.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`).
- `allowed_rooms` defaults to `["*"]`, which is any room. An explicit entry matches the room slug or the LiveKit room name. `@member` matches only a room that is not archived, where the agent is a member and the seat's human owner is also a current member. A seat with no owner matches nothing. An empty allowlist matches nothing. A NULL allowlist on an existing row is treated as `["*"]` (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
- `GET /api/v1/gateway/rooms/{room}/messages` and `GET /api/v1/gateway/rooms/{room}/context` pass `history_from` as a lower bound on `messages.created_at`. When that floor is set, context also withholds the rolling room summary (`server/app/api/gateway.py`, `server/app/services/message_service.py`, `server/app/services/context_builder.py`).
- An expired key is rejected with 401 `Gateway key expired`. A patch of a key that is not revoked can change its expiry and history floor. A revoked key answers 409 before any change, and the patch body has no field that clears `revoked_at` (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
