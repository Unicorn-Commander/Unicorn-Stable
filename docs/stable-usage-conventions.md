# Stable usage conventions

These conventions describe the room, agent, call, recording, and broadcast behavior implemented in this checkout.

## Room types and visibility

- Persisted rooms use `channel`, `group_dm`, `dm`, or server-created `agent_hub` (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Channels support `public` and `private` visibility. `GET /api/v1/rooms/browse` returns unarchived public channels that the caller has not joined (`server/app/models/room.py`, `server/app/api/rooms.py`).
- A private channel is invite-only and is not returned by the channel browser. A member of a thread's parent can open that thread (`server/app/api/rooms.py`, `server/app/services/room_service.py`).
- DMs, group DMs, and agent hubs are membership-scoped. The channel browser excludes them because it lists only public channels (`server/app/models/room.py`, `server/app/api/rooms.py`).
- The room-creation schema accepts `channel`, `group_dm`, and `dm`. `ensure_agent_hub` finds or creates the one `agent_hub` for a human-agent pair (`server/app/schemas/room.py`, `server/app/services/room_service.py`).
- A thread is a child room that keeps its parent's room type, organization, visibility, and recording policy and kind (`server/app/models/room.py`, `server/app/services/room_service.py`).
- On a per-organization deployment, browsing and self-join allow the deployment organization or an organization-less community channel, and refuse another organization's channel. An empty instance organization setting does not apply that filter (`server/app/config.py`, `server/app/api/rooms.py`, `server/app/services/room_service.py`).
- Listing and searching the knowledge collections attached to a room require room membership. Search returns `{"results": []}` when the room has no collections or nothing matched, and 503 when the retrieval plane is unreachable (`server/app/api/knowledge.py`).

## Choosing a room

- Use a `dm` for a direct human-to-human conversation because the room is membership-scoped (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Use a `group_dm` when several invited members need a membership-scoped conversation (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Use a public `channel` when the room should appear in the channel browser for callers allowed by the deployment organization filter (`server/app/api/rooms.py`).
- Use a private `channel` when the channel should be invite-only and absent from the channel browser (`server/app/api/rooms.py`).
- Use an `agent_hub` for the one human-agent room. `ensure_agent_hub` reuses that room. Create conversation threads under it (`server/app/services/room_service.py`, `server/app/models/room.py`).
- Use a thread when the conversation should remain under an existing room while retaining its parent room contract. A member of a parent that is not archived can create one. A thread cannot be nested under another thread (`server/app/services/room_service.py`, `server/app/api/conversation.py`).

## Home, Crew, and navigation

- On a desktop, Home puts the composer first, then the caller's own seats, then the needs-you, live, today, and recent zones that contain rows. On a phone the composer is pinned above the tab bar and the scroll starts with the seats (`web/src/components/Home/HomeDashboard.tsx`).
- The Home composer waits for the Crew roster, and for preferences unless that request has already failed. For a house agent or a seat that opens a hub, it creates or reopens the hub and starts a thread. It writes `metadata.seats` only when the chosen model or effort is not null. A partner seat posts into the shared room (`web/src/components/Home/HomeComposer.tsx`, `web/src/lib/homeComposer.ts`, `web/src/lib/seatSettings.ts`).
- `GET /api/v1/crew` returns presence, seat capabilities, hub id, last line, and unread. Rank order is the caller's own seats, then house agents with a message in the last 14 days, then partner seats, then the remaining house agents by name. Guest agents and integrations are excluded (`server/app/api/crew.py`, `server/app/services/crew.py`).
- The desktop sidebar places Crew above the Conversations list. Phone tabs are Home, Chats, Crew, Calls, and Me. Me opens an account sheet and is not a rail destination (`web/src/components/Sidebar/CrewSection.tsx`, `web/src/stores/navStore.ts`, `web/src/components/Layout/PhoneTabBar.tsx`, `web/src/components/Layout/MeSheet.tsx`).
- A partner seat opens the newest shared room and has no New conversation, Call, or Settings action from the Crew row (`web/src/components/Sidebar/CrewSection.tsx`, `web/src/lib/crew.ts`).

## Seat settings

- A runner seat's per-conversation brain is stored as `metadata.seats[agent_id] = {model, effort}` (`server/app/services/room_class.py`, `web/src/lib/seatSettings.ts`).
- The seat settings UI offers the seat-announced models and efforts, falls back to `low`, `medium`, `high`, and `max` when no effort list is announced, and treats null model and effort as the seat defaults (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`).
- Only the owner of a seat can change its model or effort, and the seat must be a runner member of a live room. A partner's seat is displayed read-only. Changing an agent member's mode is a different control. A room owner, a room admin, or a room-control gateway key may set it with `PATCH /api/v1/rooms/{room_id}/members/{participant_id}` (`web/src/lib/seatSettings.ts`, `web/src/components/Room/SeatSettings.tsx`, `server/app/services/room_service.py`, `server/app/api/conversation.py`).
- Agent behavior in a room is `answers_all`, `when_named`, `listening`, or `muted`. Null keeps the pre-contract rule: a DM answers, and a channel answers when named (`server/app/models/room.py`).

## Agent gateway keys

- A gateway key is bound to one agent identity, stores only a SHA-256 hash, and returns the raw value once at mint. Minting is operator-only (`server/app/models/agent_gateway_key.py`, `server/app/api/gateway.py`).
- `allowed_rooms` defaults to `["*"]`, which is any room. An explicit entry matches the room slug or the LiveKit room name. `@member` matches only a room that is not archived, where the agent is a member and the seat's human owner is also a current member. A seat with no owner matches nothing (`server/app/auth/gateway_auth.py`, `server/app/api/gateway.py`).
- Minting requires exactly one expiry choice: `expires_in_days` from 1 through 366, an absolute `expires_at` that is not in the past, or `no_expiry=true`. It also requires one history choice of `full`, `from_mint`, or a timestamp that is not in the future (`server/app/api/gateway.py`, `server/alembic/versions/025_gateway_key_expiry_floor.py`).
- Gateway message and context reads use `history_from` as a lower bound on `messages.created_at`. When that floor is set, context withholds the rolling room summary. An expired key is rejected with 401 `Gateway key expired`. A revoked key cannot be patched (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`, `server/app/services/message_service.py`, `server/app/services/context_builder.py`).

## Calls, recording, and meeting notes

- `voice_relay_video` defaults off. When it is enabled, the voice relay publishes the rendered agent face as a LiveKit `SOURCE_CAMERA` track. The call grid, broadcast page, and egress can receive that track (`web/src/components/Room/VoiceSettingsModal.tsx`, `agents/voice_relay/agent.py`, `agents/agent_runtime/puppet_video.py`).
- A room recording policy is `off`, `on_request`, or `always`, with configured kind `audio`, `composite`, or `track` (`server/app/models/room.py`, `server/app/schemas/room.py`).
- Manual recording start accepts `audio` and `composite`. It checks the `stable-recorder` entitlement, a room policy other than `off`, and the instance switch `CALL_RECORDING_ENABLED`. An automatic start whose room kind is `track` records `audio` instead (`server/app/api/recording.py`, `server/app/services/recording_policy.py`, `server/app/services/call_recording.py`).
- In an `always` room, the first non-service participant join starts recording while the instance switch is on, without that joiner's recorder role. Stopping it requires the recorder role and the room owner or a room admin. In an `on_request` room, `record_my_calls` can auto-start a call that an entitled caller starts (`server/app/services/recording_policy.py`, `server/app/services/call_recording.py`, `server/app/api/webhooks.py`).
- Every room member can see the recording state and the recording list. The owner, an admin, or the recording starter can download or delete the stored file. A row under `legal_hold` answers 423 on delete (`server/app/api/recording.py`, `server/app/services/recording_policy.py`).
- `GET /api/v1/rooms/{room_id}/recordings/{recording_id}/download` returns a presigned storage link when a stored copy exists and the caller may view the file. The link lifetime defaults to 900 seconds (`server/app/api/recording.py`, `server/app/services/recording_storage.py`, `server/app/config.py`).
- Transcript exports are committed to `transcript_exports` before any forward and can be forwarded to the optional Meeting-Ops ingest. Stored export statuses are `pending`, `delivering`, `blocked`, `delivered`, `failed`, and `local_only`. An attempt the forwarder marks retryable is stored as `pending` again until the attempt limit, then `failed` (`server/app/api/transcripts.py`, `server/app/models/room.py`, `server/app/services/meeting_ops.py`, `server/app/services/transcript_outbox.py`).

## Broadcast links for OBS

- An owner mints one credential for one participant. Audio is opt-in through `allow_audio`, which defaults to false. Camera versus screen is the copied URL's `source` query, not a field on the token (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`, `web/src/components/Room/VoiceVideoBar.tsx`).
- The copy menu offers Camera, Camera with audio, Screen, and Screen with audio. The broadcast page renders the named participant's camera or screen publication (`web/src/lib/broadcast.ts`, `web/src/components/Broadcast/BroadcastPage.tsx`).
- Room members can read `GET /api/v1/broadcast/active`, which reports the participant, audio permission, expiry, and viewer count. The count is null when LiveKit cannot be listed. The web client warns exactly: `One of these links has more than one viewer. Revoke it if that is not you.` (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`, `web/src/lib/broadcast.ts`).
- A broadcast token renders the named participant's camera or screen with no login, so treat it as a credential rather than a link (`server/app/api/broadcast.py`).
- The server stores only SHA-256, returns the raw value once at mint, uses `secrets.token_urlsafe(32)` entropy with prefix `sbt-`, scopes the token to one room and one participant identity, applies a default eight-hour TTL with a one-hour minimum and a twenty-four-hour cap, supports instant `revoked_at` revocation, logs only the prefix, and grants LiveKit subscribe-only hidden access (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The link holder's LiveKit grant is room-scoped. The page's named-participant choice is client-side, so a holder running their own client could subscribe to other publishers in that room. This path does not use LiveKit's server-side subscription-permission API (`server/app/api/broadcast.py`, `server/app/models/broadcast_token.py`).
- The feed remains hidden from the call UI. The active-broadcast fact is exposed to room members as the consent surface (`server/app/api/broadcast.py`, `web/src/hooks/useRoomBroadcasts.ts`).
