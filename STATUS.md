# STATUS.md — current code state (2026-10-04)

This file describes behavior present in this checkout.

## Deployment shapes

- A single deployment is one Compose project described by `docker-compose.selfhost.yml`.
- `install.sh` requires Docker with the Compose plugin, writes `.env` and rendered configuration, and by default starts `docker-compose.selfhost.yml`; it waits for backend `/live`, backend `/health`, and the web root.
- The self-host bundle defines PostgreSQL, Redis, LiveKit, the FastAPI backend, the web client, optional bundled Keycloak, and an optional agent-runtime profile (`docker-compose.selfhost.yml`).
- `deploy/per-org/provision-org.sh` renders a separate stack directory and organization UUID for one organization. A process has one optional organization id (`STABLE_ORG_ID`). Empty means a community deployment, with no organization filter on browse or self-join. Many organizations as tenants of one process are not implemented. Browse and self-join still hide another organization's rows when those rows are in the same database (`deploy/per-org/provision-org.sh`, `server/app/config.py`, `server/app/api/rooms.py`).

## Rooms and messages

- Persisted rooms have the types `channel`, `group_dm`, `dm`, and server-created `agent_hub` (`server/app/models/room.py`, `server/app/services/room_service.py`).
- A channel has `public` or `private` visibility. `GET /api/v1/rooms/browse` returns unarchived public channels that the caller has not joined. On a per-organization deployment it also keeps that organization's channels and organization-less channels. DMs, group DMs, and agent hubs are excluded (`server/app/models/room.py`, `server/app/api/rooms.py`).
- Private channels are invite-only, and a caller cannot self-join a private channel. A member of a thread's parent can open that thread (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- An agent hub is the one room for a human-agent pair. `ensure_agent_hub` finds or creates it. Conversation threads are child rooms that inherit the parent room type, organization, visibility, and recording policy and kind (`server/app/services/room_service.py`, `server/app/models/room.py`).
- On a per-organization deployment, room creation stamps `settings.instance_org_id`. Browse and self-join allow that organization and an organization-less channel, and refuse another organization's channel. An empty instance organization setting does not apply that filter (`server/app/models/room.py`, `server/app/api/rooms.py`, `server/app/config.py`, `server/app/services/room_service.py`).
- Message search accepts `from`, `has`, `before`, and `after` on `GET /api/v1/rooms/{room_id}/messages/search` and `GET /api/v1/search/messages`. The global route also accepts `in` and searches only rooms the caller belongs to. The room route ignores `in` because the room is already in the path (`server/app/api/messages.py`).

## Home, Crew, and seat settings

- `GET /api/v1/home/summary` returns live calls, agent activity, recent artifacts, recent transcripts, and counts. `v=3` adds `needs_you`, `crew`, and `today`. The web client requests `v=3`. On a desktop the page puts the composer first, then the caller's own seats, then only the needs-you, live, today, and recent zones that contain rows. On a phone the composer is pinned above the tab bar and the scroll starts with the seats (`server/app/api/home.py`, `web/src/components/Home/homeClient.ts`, `web/src/components/Home/HomeDashboard.tsx`).
- `GET /api/v1/crew` ranks the caller's own seats, then house agents with a message in the last 14 days, then partner seats, then the remaining house agents by name. Guest agents and integrations are excluded (`server/app/api/crew.py`, `server/app/services/crew.py`).
- By default the rail destinations are Home, one Conversations list, and Directory, with Home, Chats, Crew, Calls, and Me tabs on a phone. Me opens an account sheet and is not a rail destination. `stable_nav_v2=0` restores the five-view shell (`web/src/stores/navStore.ts`, `web/src/components/Layout/PhoneTabBar.tsx`, `web/src/components/Layout/MeSheet.tsx`).
- A runner seat's conversation can store a model and effort override in `metadata.seats[agent_id]`. The server accepts null or the effort values `low`, `medium`, `high`, and `max`. Only that seat's owner can change it, and the seat must be a runner member of a live room (`server/app/services/room_class.py`, `server/app/services/room_service.py`, `web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`).

## Calls, faces, and recording

- When the room flag `voice_relay_video` is enabled, the voice relay starts `PuppetVideo`, which publishes the rendered agent face as a LiveKit `SOURCE_CAMERA` track. The grid, broadcast page, and egress can receive that track. The flag defaults off (`web/src/components/Room/VoiceSettingsModal.tsx`, `agents/voice_relay/agent.py`, `agents/agent_runtime/puppet_video.py`).
- A room recording policy is `off`, `on_request`, or `always`, and its configured capture kind is `audio`, `composite`, or `track`. The manual start route accepts only `audio` and `composite` (`server/app/models/room.py`, `server/app/schemas/room.py`, `server/app/api/recording.py`).
- Manual start and manual stop require the `stable-recorder` role, a room policy other than `off`, and the instance switch `CALL_RECORDING_ENABLED`. An `always` room auto-starts on the first non-service participant join without that joiner's recorder role, while the switch is on. Stopping an `always` room also requires the room owner or a room admin. An entitled caller's `record_my_calls` preference can auto-start a call they start in an `on_request` room (`server/app/services/recording_policy.py`, `server/app/services/call_recording.py`, `server/app/api/recording.py`, `server/app/api/webhooks.py`).
- Every room member can see the recording state and recording list. The room owner, a room admin, or the recording starter can download a stored recording. The same people can delete it, except a row under `legal_hold`, which answers 423 (`server/app/api/recording.py`, `server/app/services/recording_policy.py`).
- The recording list marks which rows the caller may download. `GET /api/v1/rooms/{room_id}/recordings/{recording_id}/download` returns a presigned link when storage is configured and the caller passes the file-access rule. The link lifetime defaults to 900 seconds (`server/app/api/recording.py`, `server/app/services/recording_storage.py`, `server/app/config.py`).
- Transcript exports are committed to `transcript_exports` before any forward, and can be forwarded to the optional Meeting-Ops ingest. Stored export statuses are `pending`, `delivering`, `blocked`, `delivered`, `failed`, and `local_only`. Recording audio handoff statuses written by the service are `none`, `pending`, `blocked`, `delivering`, `delivered`, and `failed`. An attempt the forwarder marks retryable is stored as `pending` again until the attempt limit, then `failed` (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/models/call_egress.py`, `server/app/services/meeting_ops.py`, `server/app/services/transcript_outbox.py`, `server/app/services/call_recording.py`).

## Broadcast links

- An owner can mint one OBS browser-source credential for one participant and opt audio in with `allow_audio` (default false). The copy menu labels are Camera, Camera with audio, Screen, and Screen with audio. Camera versus screen is the copied URL's `source` query, not a field on the token (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`).
- `GET /api/v1/broadcast/active` is readable by room members and reports the participant, audio permission, expiry, and viewer count. The count is null when LiveKit cannot be listed. The web warning is `One of these links has more than one viewer. Revoke it if that is not you.` (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/hooks/useRoomBroadcasts.ts`).
- The broadcast page renders the named participant's camera or screen with no login, so the token is a credential rather than a link. The server stores only its SHA-256 hash, returns the raw value once at mint, uses `secrets.token_urlsafe(32)` entropy, scopes it to one room and one participant identity, applies a default eight-hour TTL capped at twenty-four hours (minimum one hour), revokes it immediately when `revoked_at` is set, logs only the prefix, and grants LiveKit subscribe-only hidden access (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- LiveKit grants subscribe at room granularity, so the page's named-participant selection is client-side rather than an enforcement boundary. A link holder running their own client could subscribe to other publishers in that room. This path does not use LiveKit's server-side subscription-permission API (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).

## Agent gateway keys

- Gateway keys are bound to one agent identity, store only a SHA-256 hash, and return the raw key once. `allowed_rooms` defaults to `["*"]` (any room). It can instead list room slugs or LiveKit room names, or include `@member` (`server/app/models/agent_gateway_key.py`, `server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`).
- Minting a gateway key requires exactly one expiry choice: `expires_in_days` (1 through 366), an absolute `expires_at`, or `no_expiry=true`. It also requires a history choice of `full`, `from_mint`, or a timestamp that is not in the future. Message and context reads use the resulting `history_from` as a lower bound on `messages.created_at` (`server/app/api/gateway.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`, `server/app/services/message_service.py`).
- The gateway rejects expired keys. A patch of a key that is not revoked can change its expiry and history floor. A revoked key answers 409, and the patch body has no field that clears `revoked_at` (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).

## Not there yet

- Many organizations as tenants of one process are not implemented. The settings object holds one organization id, or none for a community deployment (`deploy/per-org/provision-org.sh`, `server/app/config.py`).
- SCIM and SAML provisioning are not implemented. The installer configures Keycloak OIDC (`install.sh`).
- Native phone and desktop applications are not implemented. The client is the web application under `web/` (`web/src/stores/navStore.ts`, `web/src/components/Home/HomeDashboard.tsx`).
- A general approval prompt before an agent takes a risky action is not implemented in the gateway path (`server/app/api/gateway.py`).
- Published load-test numbers are not present in the repository's application or deployment artifacts (`server/`, `install.sh`).
- The `track` recording kind is accepted by room policy and schema but is not accepted by manual recording start. An automatic start whose room kind is `track` records `audio` instead (`server/app/schemas/room.py`, `server/app/api/recording.py`, `server/app/services/recording_policy.py`, `server/app/services/call_recording.py`).
- Meeting-Ops does not expose an in-progress call session audit. The current integration is post-call through the outbox (`server/app/services/meeting_ops.py`, `server/app/models/room.py`).
- Calling a runner seat from Crew is disabled until the house-voice capability exists. The control's title is `Voice for seats comes with the house-voice key` (`web/src/components/Sidebar/CrewSection.tsx`).
