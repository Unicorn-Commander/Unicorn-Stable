# STATUS.md — current code state (2026-10-04)

This file describes behavior present in this checkout.

## Deployment shapes

- A single deployment is one Compose project described by `docker-compose.selfhost.yml`.
- `install.sh` requires Docker with the Compose plugin, writes `.env` and rendered configuration, and by default starts `docker-compose.selfhost.yml`; it waits for backend `/live`, backend `/health`, and the web root.
- The self-host bundle defines PostgreSQL, Redis, LiveKit, the FastAPI backend, the web client, optional bundled Keycloak, and an optional agent-runtime profile (`docker-compose.selfhost.yml`).
- `deploy/per-org/provision-org.sh` renders a separate stack directory and organization UUID; tenancy is one deployment per organization, not many organizations inside one deployment (`deploy/per-org/provision-org.sh`, `server/app/config.py`).

## Rooms and messages

- Persisted rooms have the types `channel`, `group_dm`, `dm`, and server-created `agent_hub` (`server/app/models/room.py`, `server/app/services/room_service.py`).
- A channel has `public` or `private` visibility; the channel browser returns unarchived public channels that the caller has not joined, while DMs and group DMs are excluded (`server/app/models/room.py`, `server/app/api/rooms.py`).
- Private channels are invite-only, and a caller cannot self-join a private channel (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- An agent hub is the canonical human-agent room, and conversation threads are child rooms that inherit the parent room type, organization, visibility, and recording settings (`server/app/services/room_service.py`, `server/app/models/room.py`).
- On a per-organization deployment, room organization IDs are stamped from the instance setting and used to filter channel browsing and self-join; an empty instance organization setting leaves rooms community-scoped (`server/app/models/room.py`, `server/app/api/rooms.py`, `server/app/config.py`).

## Home, Crew, and seat settings

- The Home summary includes live calls, counts, items needing attention, Crew cards, and the Today block; the web Home puts its composer first, then the caller's seats, then only zones that contain rows (`server/app/api/home.py`, `web/src/components/Home/homeClient.ts`, `web/src/components/Home/HomeDashboard.tsx`).
- `GET /crew` ranks the caller's own seats, recently heard house agents, partner seats, and the remaining agents; guest agents and integrations are excluded (`server/app/api/crew.py`, `server/app/services/crew.py`).
- The navigation model has Home, one Conversations list, and Directory destinations on the rail, with Home, Chats, Crew, Calls, and Me tabs on a phone (`web/src/stores/navStore.ts`, `web/src/components/Sidebar/CrewSection.tsx`).
- A runner seat's conversation can store a model and effort override in `metadata.seats[agent_id]`; the server accepts the four effort values `low`, `medium`, `high`, and `max`, and only the seat owner can change that seat's settings (`server/app/services/room_class.py`, `web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`).

## Calls, faces, and recording

- When the voice relay's `voice_relay_video` setting is enabled, `PuppetVideo` publishes the rendered agent face as a LiveKit camera track, so the track is available to the call grid, broadcast page, and egress (`web/src/components/Room/VoiceSettingsModal.tsx`, `agents/voice_relay/agent.py`, `agents/agent_runtime/puppet_video.py`).
- A room recording policy is `off`, `on_request`, or `always`, and its configured capture kind is `audio`, `composite`, or `track`; the manual start route currently accepts only `audio` and `composite` (`server/app/models/room.py`, `server/app/schemas/room.py`, `server/app/api/recording.py`).
- Starting and stopping a recording requires the `stable-recorder` entitlement, with the room policy and instance recording switch also applied; an entitled caller's `record_my_calls` preference can auto-start a call they start in an `on_request` room (`server/app/services/recording_policy.py`, `server/app/api/recording.py`).
- Every room member can see the recording state and recording list, while the room owner, an admin, or the recording starter can download or delete a stored recording (`server/app/api/recording.py`).
- The recording list returns a short-lived presigned download link only when storage is configured and the caller passes the file-access rule (`server/app/api/recording.py`, `server/app/services/recording_storage.py`).
- Transcript exports are committed to a durable outbox and can be forwarded to the optional Meeting-Ops meeting-notes service; recording handoff and transcript forwarding report queued, blocked, retryable, or delivered states instead of assuming remote delivery (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/services/meeting_ops.py`, `server/app/services/call_recording.py`).

## Broadcast links

- An owner can mint one OBS browser-source credential for one participant, choose camera or screen as the source, and opt audio in; the web copy menu exposes camera, camera-with-audio, screen, and screen-with-audio variants (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`).
- The active-broadcast consent surface is readable by room members and reports the participant, audio permission, expiry, and viewer count; the web warning is `One of these links has more than one viewer. Revoke it if that is not you.` (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/hooks/useRoomBroadcasts.ts`).
- A broadcast token renders a human's live camera with no login, so it is a credential rather than a link; the server stores only its SHA-256 hash, returns the raw value once at mint, uses `secrets.token_urlsafe(32)` entropy, scopes it to one room and one participant identity, applies a default eight-hour TTL capped at twenty-four hours with instant `revoked_at` revocation, logs only the prefix, and grants LiveKit subscribe-only hidden access (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- LiveKit grants subscribe at room granularity, so the page's named-participant selection is client-side rather than an enforcement boundary; a link holder running their own client could subscribe to other publishers in that room, and per-participant enforcement would require LiveKit's server-side subscription-permission API (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).

## Agent gateway keys

- Gateway keys are bound to one agent identity, store only a hash, return the raw key once, and can restrict rooms with an explicit allowlist or the `@member` scope (`server/app/models/agent_gateway_key.py`, `server/app/auth/gateway_auth.py`).
- Minting a gateway key requires exactly one expiry choice—relative days, an absolute timestamp, or no expiry—and a history choice of `full`, `from_mint`, or a timestamp; message and context reads apply the resulting history floor (`server/app/api/gateway.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`).
- The gateway rejects expired keys, and a key patch can change its expiry and history floor but cannot un-revoke it (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).

## Not there yet

- Many organizations inside one deployment are not implemented; the current deployment boundary is one deployment per organization (`deploy/per-org/provision-org.sh`, `server/app/config.py`).
- SCIM and SAML provisioning are not implemented; the installer configures Keycloak OIDC instead (`install.sh`).
- Native phone and desktop applications are not implemented; the client is the web application under `web/` (`web/src/stores/navStore.ts`, `web/src/components/Home/HomeDashboard.tsx`).
- A general approval prompt before an agent takes a risky action is not implemented in the gateway path (`server/app/api/gateway.py`).
- Published load-test numbers are not present in the repository's application or deployment artifacts (`server/`, `install.sh`).
- The `track` recording kind is accepted by room policy and schema but is not accepted by manual recording start (`server/app/schemas/room.py`, `server/app/api/recording.py`, `server/app/services/recording_policy.py`).
- Meeting-Ops does not expose an in-progress call session audit; the current integration is post-call through the outbox (`server/app/services/meeting_ops.py`, `server/app/models/room.py`).
- Calling a runner seat from Crew is disabled until the house-voice capability exists (`web/src/components/Sidebar/CrewSection.tsx`).
