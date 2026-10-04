# Stable usage conventions

These conventions describe the room, agent, call, recording, and broadcast behavior implemented in this checkout.

## Room types and visibility

- Persisted rooms use `channel`, `group_dm`, `dm`, or server-created `agent_hub` (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Channels support `public` and `private` visibility; `GET /rooms/browse` returns only unarchived public channels that the caller has not joined (`server/app/models/room.py`, `server/app/api/rooms.py`).
- A private channel is invite-only and is not returned by the channel browser (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- DMs, group DMs, and agent hubs are membership-scoped, and the channel browser excludes DMs and group DMs (`server/app/models/room.py`, `server/app/api/rooms.py`).
- The room-creation schema accepts `channel`, `group_dm`, and `dm`; the service creates an `agent_hub` for a canonical human-agent relationship (`server/app/schemas/room.py`, `server/app/services/room_service.py`).
- A thread is a child room that keeps its parent's room type, organization, visibility, and recording settings (`server/app/models/room.py`, `server/app/services/room_service.py`).
- On a per-organization deployment, browsing and self-join are filtered to the deployment organization or an organization-less community channel (`server/app/config.py`, `server/app/api/rooms.py`, `server/app/services/room_service.py`).

## Choosing a room

- Use a `dm` for a direct human-to-human conversation because the room is membership-scoped (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Use a `group_dm` when several invited members need a membership-scoped conversation (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Use a public `channel` when the room should be available in the channel browser to callers allowed by the deployment organization filter (`server/app/api/rooms.py`).
- Use a private `channel` when the channel should be invite-only and absent from the channel browser (`server/app/api/rooms.py`).
- Use an `agent_hub` for the canonical human-agent room and create conversation threads under it (`server/app/services/room_service.py`, `server/app/models/room.py`).
- Use a thread when the conversation should remain under an existing room while retaining its parent room contract (`server/app/services/room_service.py`, `server/app/api/rooms.py`).

## Home, Crew, and navigation

- Home's current client presents a composer first, then the caller's own seats, then only populated needs-you, live, today, and recent zones (`web/src/components/Home/HomeDashboard.tsx`).
- The Home composer waits for the Crew roster and preferences, selects a seat, creates or reopens the seat's hub, writes the chosen seat model and effort, and starts a thread or shared-room conversation (`web/src/components/Home/HomeComposer.tsx`, `web/src/lib/homeComposer.ts`, `web/src/lib/seatSettings.ts`).
- `GET /crew` returns own seats, house agents, partner seats, and remaining agents with presence and seat capabilities; guest agents and integrations are excluded (`server/app/api/crew.py`, `server/app/services/crew.py`).
- The desktop sidebar places Crew above the Conversations list, and the phone navigation exposes Home, Chats, Crew, Calls, and Me (`web/src/components/Sidebar/CrewSection.tsx`, `web/src/stores/navStore.ts`).
- A partner seat opens the shared room and has no New conversation, Call, or Settings action from the Crew row (`web/src/components/Sidebar/CrewSection.tsx`).

## Seat settings

- A runner seat's per-conversation brain is stored as `metadata.seats[agent_id] = {model, effort}` (`server/app/services/room_class.py`, `web/src/lib/seatSettings.ts`).
- The seat settings UI offers the seat-announced models and efforts, falls back to `low`, `medium`, `high`, and `max` when no effort list is announced, and treats null model and effort as the seat defaults (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`).
- Only the owner of a seat can change its model or effort; a partner's seat is displayed read-only (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`, `server/app/api/rooms.py`).
- Agent behavior in a room is separately represented by `answers_all`, `when_named`, `listening`, or `muted` (`server/app/models/room.py`, `server/app/services/room_class.py`).

## Agent gateway keys

- A gateway key is bound to one agent identity, stores only a hash, and returns the raw value once at mint (`server/app/models/agent_gateway_key.py`, `server/app/api/gateway.py`).
- `allowed_rooms` may use `@member` to follow the agent's current room membership and human owner, `*` for any room, or explicit room names (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
- Minting requires one expiry choice—relative days, an absolute timestamp, or no expiry—and one history choice of `full`, `from_mint`, or a timestamp (`server/app/api/gateway.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`).
- Gateway message and context reads enforce the selected history floor, and an expired key is rejected (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`).

## Calls, recording, and meeting notes

- When `voice_relay_video` is enabled, the voice relay publishes the rendered agent face as a LiveKit camera track; the call grid, broadcast page, and egress can receive that track (`web/src/components/Room/VoiceSettingsModal.tsx`, `agents/voice_relay/agent.py`, `agents/agent_runtime/puppet_video.py`).
- A room recording policy is `off`, `on_request`, or `always`, with configured kind `audio`, `composite`, or `track` (`server/app/models/room.py`, `server/app/schemas/room.py`).
- Manual recording currently accepts `audio` and `composite`; the `stable-recorder` entitlement, room policy, and instance recording switch all apply (`server/app/api/recording.py`, `server/app/services/recording_policy.py`).
- In an `always` room, the first participant join starts recording and only the owner or an admin can stop it; in an `on_request` room, `record_my_calls` can auto-start a call started by an entitled caller (`server/app/services/recording_policy.py`, `server/app/services/call_recording.py`).
- Every room member can see that a call was recorded, while the owner, an admin, or the recording starter can download or delete the stored file (`server/app/api/recording.py`).
- A recording download returns a short-lived presigned storage link when a stored copy and storage configuration are available (`server/app/api/recording.py`, `server/app/services/recording_storage.py`).
- Transcript exports are durable outbox records and can be forwarded to the optional Meeting-Ops meeting-notes service; the forwarding path can report blocked or retryable delivery (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/services/meeting_ops.py`).

## Broadcast links for OBS

- An owner creates one credential for one participant and chooses camera or screen, with audio as an opt-in variant (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`).
- The copy menu offers Camera, Camera with audio, Screen, and Screen with audio, and the broadcast page renders the named participant's publication (`web/src/lib/broadcast.ts`, `web/src/components/Broadcast/BroadcastPage.tsx`).
- Room members can see who has an active feed and its viewer count, and the web client warns exactly: `One of these links has more than one viewer. Revoke it if that is not you.` (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`, `web/src/lib/broadcast.ts`).
- A broadcast token renders a human live camera with no login, so treat it as a credential rather than a link (`server/app/api/broadcast.py`).
- The server stores only SHA-256, returns the raw value once at mint, uses `secrets.token_urlsafe(32)` entropy, scopes the token to one room and one participant identity, applies a default eight-hour TTL capped at twenty-four hours, supports instant `revoked_at` revocation, logs only the prefix, and grants LiveKit subscribe-only hidden access (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The link holder's LiveKit grant is room-scoped: the page's named-participant choice is client-side, so a holder running their own client could subscribe to other publishers in that room. LiveKit has no server-side control that narrows this: only a track's own publisher can restrict its subscribers (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The feed remains hidden from the call UI, while the active-broadcast fact is exposed to room members as the consent surface (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`).
