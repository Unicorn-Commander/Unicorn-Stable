# Stable architecture

This document describes the components and flows implemented in this checkout.

## Deployment shapes

- A single deployment is one Compose project described by `docker-compose.selfhost.yml`.
- The self-host bundle contains PostgreSQL, Redis, LiveKit, the FastAPI backend, the web client, an optional bundled Keycloak profile, and an optional agent-runtime profile (`docker-compose.selfhost.yml`).
- `install.sh` writes `.env`, renders the self-host configuration, starts the self-host Compose project, and waits for `/live`, `/health`, and the web root (`install.sh`).
- `deploy/per-org/provision-org.sh` renders a separate stack directory with an organization UUID and separate runtime configuration for each organization; the tenancy shape is one deployment per organization, not many organizations inside one deployment (`deploy/per-org/provision-org.sh`, `server/app/config.py`).

## Components

- The web component is a React client served by the `web` Compose service, which also proxies API, WebSocket, and bundled-auth paths (`docker-compose.selfhost.yml`, `web/src/services/api.ts`).
- The API component is the FastAPI application that mounts the room, Home, Crew, recording, transcript, broadcast, and gateway routers (`server/app/main.py`, `server/app/api/rooms.py`, `server/app/api/home.py`, `server/app/api/crew.py`, `server/app/api/recording.py`, `server/app/api/transcripts.py`, `server/app/api/broadcast.py`, `server/app/api/gateway.py`).
- PostgreSQL stores rooms, memberships, messages, recording egress rows, transcript-export outbox rows, broadcast-token rows, and gateway-key rows (`docker-compose.selfhost.yml`, `server/app/models/room.py`, `server/app/models/call_egress.py`, `server/app/models/broadcast_token.py`, `server/app/models/agent_gateway_key.py`).
- Redis is used by the backend and by recording, presence, rate-limit, and worker paths (`docker-compose.selfhost.yml`, `server/app/services/recording_policy.py`, `server/app/services/crew.py`).
- LiveKit provides the call room and media transport used by human tracks, agent face tracks, broadcast viewers, and recording egress (`docker-compose.selfhost.yml`, `server/app/services/livekit_service.py`, `agents/agent_runtime/puppet_video.py`, `server/app/api/broadcast.py`, `server/app/services/call_recording.py`).
- Keycloak supplies the OIDC identity provider by default in the installer path, or an external OIDC provider can be configured with the installer flags (`install.sh`, `server/app/auth/`).
- Brigade, voice endpoints, document retrieval services, Meeting-Ops, email, push, and error reporting are optional integrations represented by the self-host environment configuration (`install.sh`, `docker-compose.selfhost.yml`, `server/app/config.py`).

## Browser and API flow

- `install.sh` selects the browser address, creates or preserves `.env` values, renders the bundled Keycloak import and LiveKit configuration, and starts the Compose services (`install.sh`).
- The web service serves the SPA and proxies `/api`, `/ws`, and bundled `/auth` traffic to the corresponding service (`docker-compose.selfhost.yml`).
- The browser API client sends authenticated requests to the API base and refreshes the OIDC token when required (`web/src/services/api.ts`, `web/src/services/auth.ts`).
- FastAPI dependencies authenticate the caller before routes that require a user or room membership (`server/app/deps.py`, `server/app/main.py`).
- LiveKit credentials are issued by the backend for browser calls, while the backend uses its internal LiveKit service for room and participant operations (`server/app/services/livekit_service.py`, `server/app/api/tokens.py`).

## Room, membership, and tenancy flow

- `Room` stores the room type, organization ID, parent thread ID, channel visibility, recording policy, and recording kind (`server/app/models/room.py`).
- The room creation schema accepts `channel`, `group_dm`, and `dm`; the service creates `agent_hub` rooms for canonical human-agent conversations (`server/app/schemas/room.py`, `server/app/services/room_service.py`).
- `GET /rooms/browse` lists only unarchived public channels that the caller has not joined, excludes DMs and group DMs, and applies the instance organization filter (`server/app/api/rooms.py`).
- `PATCH /rooms/{room_id}` is the room update path for owner/admin-controlled visibility and recording settings (`server/app/api/rooms.py`, `server/app/schemas/room.py`).
- A private channel is excluded from browse and self-join; membership is added through invitation or the room's permitted join path (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- A thread is a child room that keeps the parent's room type, organization, visibility, and recording settings, while the room list can return threads nested under their parent (`server/app/models/room.py`, `server/app/services/room_service.py`, `server/app/api/rooms.py`).
- On a per-organization deployment, room creation stamps the configured organization ID and browse/self-join checks compare it with the caller's deployment organization (`server/app/config.py`, `server/app/models/room.py`, `server/app/api/rooms.py`, `server/app/services/room_service.py`).

## Home, Crew, and navigation flow

- `GET /home/summary` returns the Home summary, and the `v=3` response adds `needs_you`, `crew`, and `today` data used by the current Home client (`server/app/api/home.py`, `web/src/components/Home/homeClient.ts`).
- Home renders the composer first, then the caller's own seats, then populated needs-you, live, today, and recent zones; its phone layout pins the composer above the tab bar (`web/src/components/Home/HomeDashboard.tsx`).
- `GET /crew` returns ranked own seats, house agents, partner seats, and remaining agents with presence, capabilities, hub, last-line, and unread fields (`server/app/api/crew.py`, `server/app/services/crew.py`).
- The desktop Crew section and phone Crew page use the same Crew model; a caller's seat or a house agent opens its hub, while a partner seat opens the shared room and cannot create a new conversation there (`web/src/components/Sidebar/CrewSection.tsx`, `web/src/components/Sidebar/sidebarModel.ts`).
- The navigation store defines Home, Conversations, Directory, Crew, Calls, and phone Me destinations, and treats Crew and Calls as phone tabs over the desktop Conversations list (`web/src/stores/navStore.ts`).
- A runner seat's per-conversation model and effort are written as `metadata.seats[agent_id]` through the room update path, and the server validates the model format and effort enum (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`, `server/app/services/room_class.py`, `server/app/api/rooms.py`).

## Calls and agent faces

- The voice relay creates a `PuppetVideo` instance when `voice_relay_video` is enabled and starts it in the LiveKit room (`agents/voice_relay/agent.py`).
- `PuppetVideo` creates a LiveKit `VideoSource`, captures rendered frames, and publishes a `SOURCE_CAMERA` track (`agents/agent_runtime/puppet_video.py`).
- The voice settings UI labels this feature `Faces on camera` and describes the face as available to the grid, broadcast pages, and OBS (`web/src/components/Room/VoiceSettingsModal.tsx`).
- The same call path carries human tracks, agent tracks, and voice-relay cast participants through LiveKit (`server/app/services/livekit_service.py`, `agents/voice_relay/agent.py`, `agents/voice_relay/cast.py`).

## Recording and meeting-notes flow

- Room recording settings use `off`, `on_request`, or `always` and select `audio`, `composite`, or `track` as the configured kind (`server/app/models/room.py`, `server/app/schemas/room.py`).
- Manual `POST /rooms/{room_id}/recording/start` accepts `audio` or `composite`, checks the room policy, the instance switch, and the `stable-recorder` entitlement, and creates a call-egress row (`server/app/api/recording.py`, `server/app/services/recording_policy.py`, `server/app/models/call_egress.py`).
- An `always` room starts on the first participant join and only the room owner or an admin can stop it; an `on_request` room can auto-start when an entitled caller with `record_my_calls` starts the call (`server/app/services/recording_policy.py`, `server/app/services/call_recording.py`).
- `GET /rooms/{room_id}/recordings` lists recording rows for members, while `GET /rooms/{room_id}/recordings/{recording_id}/download` returns a short-lived presigned storage URL for the owner, an admin, or the recording starter (`server/app/api/recording.py`, `server/app/services/recording_storage.py`).
- `POST /rooms/{room_id}/transcripts/export` commits a transcript export to the durable outbox and can forward it to the configured Meeting-Ops ingest path (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/services/meeting_ops.py`).
- Recording audio handoff and transcript forwarding happen after the call through worker/outbox paths and expose delivery or retry state (`server/app/services/call_recording.py`, `server/app/services/meeting_ops.py`).

## Broadcast flow and security boundary

- The broadcast router uses the `/broadcast` prefix; `POST /broadcast/tokens` mints one owner-controlled credential for one participant, `GET /broadcast/active` exposes the room consent surface to members, and `POST /broadcast/join` is the only raw-token exchange path (`server/app/api/broadcast.py`).
- The web broadcast page subscribes to the named participant, and the copy menu can select camera or screen plus optional audio for an OBS browser source (`web/src/components/Broadcast/BroadcastPage.tsx`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`).
- A broadcast token renders a human live camera with no login and is treated as a credential; only its SHA-256 hash is stored, the raw value is returned once, its entropy comes from `secrets.token_urlsafe(32)`, it is scoped to one room and one participant identity, its default TTL is eight hours with a twenty-four-hour cap, `revoked_at` revokes it immediately, and only the prefix is logged (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The LiveKit grant is subscribe-only and hidden with publishing and data publishing disabled (`server/app/api/broadcast.py`).
- LiveKit authorization is room-granular, so the page's named-participant selection is a client-side choice rather than enforcement; a holder running their own client could subscribe to other publishers in that room. LiveKit has no server-side control that narrows this: only a track's own publisher can restrict its subscribers (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The active-broadcast response reports the participant and viewer count to room members, and the web client totals viewers per participant while warning when one link has more than one viewer (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`, `web/src/lib/broadcast.ts`).

## Agent gateway flow

- The gateway router uses the `/gateway` prefix and authenticates a JWT or scoped gateway key before deriving the agent identity used for room reads and writes (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`).
- `POST /gateway/keys` requires an explicit expiry choice and an explicit history choice; the key model stores `expires_at` and `history_from`, and migration `025_gateway_key_expiry_floor` adds those columns (`server/app/api/gateway.py`, `server/app/models/agent_gateway_key.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`).
- `@member` in a key's room allowlist resolves against the agent's current room membership and its human owner, while `*` and explicit room names retain their separate meanings (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
- `GET /gateway/rooms/{room}/messages` and `GET /gateway/rooms/{room}/context` pass the key's `history_from` as a lower bound on message bodies (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`).
- Expired keys are rejected and a key patch can change expiry or history but cannot clear revocation (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
