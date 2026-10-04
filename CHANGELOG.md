# CHANGELOG

Entries are grouped by commit date and include the short commit that records the change.

## 2026-08

- 2026-08-09 — `89d3ce4` — Sends wait for server acknowledgement and expose pending, failed, and retry states.
- 2026-08-10 — `434a237` — Switching devices during a call uses a handoff.
- 2026-08-10 — `103b281` — The call views use the puppet face and live mouth signal.
- 2026-08-10 — `e02f060` — Per-user agent access control gates human paths that bind an agent.
- 2026-08-10 — `b279465` — A 1:1 DM can be converted explicitly into a group.
- 2026-08-11 — `3bfe504` — Face-style selection and group-call persona handling were added.
- 2026-08-11 — `320072c` — Face-style preferences, per-tile cycling, and group-call repair were added.
- 2026-08-11 — `fbd053f` — Ongoing-call state appears in sidebar badges, room banners, and call-started toasts.
- 2026-08-12 — `130ca37` — The server added OBS-ready single-participant broadcast feeds.
- 2026-08-12 — `1a9bf2f` — The web client added OBS-ready single-participant broadcast feeds.
- 2026-08-12 — `cc403d1` — Broadcast URL path components are percent-encoded.
- 2026-08-12 — `e4a2075` — A room can use guest access as an access mode.
- 2026-08-12 — `b0f3217` — Guest invites gained per-invite grants, expiry, and a history floor.
- 2026-08-12 — `8e81b66` — The web client added guest redemption and guest-scoped room views.
- 2026-08-12 — `96a0d5c` — Owners gained a guest-link minting and revocation console.
- 2026-08-17 — `82300af` — Call audio can be recorded through LiveKit egress and attached to a Meeting-Ops session.
- 2026-08-17 — `ed51456` — An unreadable audio handoff is treated as retryable.
- 2026-08-25 — `21e8998` — Calls gained persistent device switching and a prejoin check.
- 2026-08-27 — `2bbd54b` — Several agents can join one call with separate identities.
- 2026-08-27 — `4889a17` — Canonical DMs can be reclaimed when direct writers taint them.
- 2026-08-27 — `0ef4459` — A 1:1 DM refuses new members instead of becoming a group.
- 2026-08-27 — `5e17214` — Room owners and admins can moderate live-call participants.
- 2026-08-27 — `8a1197c` — Voice dispatch responds when an agent is addressed and stays out when it is not.
- 2026-08-29 — `75a1cf9` — Voice activation became a selectable room behavior.
- 2026-08-29 — `8f38c38` — Voice settings gained an API endpoint.
- 2026-08-29 — `33fe216` — Voice activation became a room setting selected by an owner or admin.
- 2026-08-29 — `5d9a0d2` — Spoken lines become chat only when they produce a reply.
- 2026-08-29 — `e5c7509` — The call UI shows when the agent can hear the caller.

## 2026-09

- 2026-09-01 — `56db060` — The voice relay gained one mouth, multiple voices, and a pedal that names the target.
- 2026-09-02 — `8a78507` — Each voice-relay agent seat can have its own participant, microphone, and puppet camera.
- 2026-09-03 — `2b13108` — Agent seats publish their faces on the wire and in the browser.
- 2026-09-10 — `b48a3e5` — Puppet faces gained server-side expression frames and manifest rig selection.
- 2026-09-11 — `87141d2` — Runner chats use canonical rooms selected by participant backend.
- 2026-09-12 — `1373040` — Voice and video are separate direct-call choices that connect immediately.
- 2026-09-13 — `a005c2c` — Long voice replies are sent in sentence chunks with barge-in.
- 2026-09-21 — `c045ba5` — The conversation model and recording policy migrations were added.
- 2026-09-21 — `a50fce9` — Hubs, threads, agent modes, context building, and related WebSocket events were added.
- 2026-09-21 — `c5861fa` — Conversation and recording contract routes were added.
- 2026-09-21 — `46ac1bd` — Recording policy, settings, and the recorder-role mirror were added.
- 2026-09-21 — `2be59ab` — Composite-recording capacity control and S3-compatible storage were added.
- 2026-09-21 — `ea77536` — Composite recording gained a recorder-token variant and egress request.
- 2026-09-21 — `7e75fd0` — Policy-driven capture, receipts, storage handoff, retention sweep, and recording endpoints were added.
- 2026-09-21 — `0c45189` — The web client gained the recording-pill reducer and recording API client.
- 2026-09-21 — `7dc5b70` — The web client gained Record, the REC pill, and the recordings list.
- 2026-09-21 — `a50fdfc` — The server added Home summary v3 and mention counts.
- 2026-09-21 — `649f2b0` — Home was rebuilt as the dashboard v3 inbox.
- 2026-09-21 — `f51dc98` — Voice floor sharing prevents a shared microphone from producing duplicate answers.
- 2026-09-21 — `a6d02ca` — Voice settings, shared microphone state, and dispatch fan-out were added.
- 2026-09-23 — `aa148de` — Runner chat routes to the canonical agent hub.
- 2026-09-23 — `86377dd` — An empty Home view is one line instead of several empty cards.
- 2026-09-23 — `4c1a330` — The Home rail lists Crew and recent conversations.
- 2026-09-24 — `eb0fdbf` — The web client gained the navigation v2 flag and one Conversations list model.
- 2026-09-24 — `8b6648b` — One Conversations list shipped on the rail.
- 2026-09-24 — `8261418` — Recording egress reconciliation attaches orphaned calls.
- 2026-09-24 — `659a5b1` — Orphaned or dead recordings now land, retry, or report failure.
- 2026-09-24 — `2a69967` — Recording handoff, bounded retry, egress-host choice, and recorder-role completion were documented in the implementation lane.
- 2026-09-24 — `3a3631b` — Composite video recording uses an egress template.
- 2026-09-24 — `ad7ea54` — Composite recording gained grid math and start/end signals.
- 2026-09-24 — `f3ec88f` — The composite recorder grid is rendered in the web client.
- 2026-09-24 — `f1c2846` — Composite viewers are marked as recorders.
- 2026-09-24 — `8d129dc` — Meeting-Ops receives every line of a call instead of the last limited batch.
- 2026-09-28 — `3ac5fa6` — Room classes and seat-setting rules for navigation v3 were added.
- 2026-09-28 — `4fa57e8` — Gateway `@member` scope, gateway room listing, gateway identity updates, and room class in context were added.
- 2026-09-28 — `cf6d4e2` — Per-seat metadata became client-mutable through the room update route.
- 2026-09-28 — `3111bfe` — `GET /crew`, Home reuse, and a Crew-seat new-chat picker were added.
- 2026-09-28 — `c6ce0f0` — Crew-first navigation, the Crew section/tab, the To picker, and hub new-conversation actions were added.
- 2026-09-28 — `28b0825` — Per-conversation seat settings gained a brain chip and popover.
- 2026-09-28 — `b2a4ec1` — Room-class decisions gained history coverage, a sticky floor, and per-seat settings.
- 2026-09-28 — `c10bea2` — `@member` follows the seat owner and only owners can add seats.
- 2026-09-28 — `45bfb7f` — Crew gained an owner-scoped hub, gateway-derived presence, and picker fallback behavior.
- 2026-09-28 — `07ab6db` — Crew rows gained partner-room targets, per-group caps, badges, and data-state handling.
- 2026-09-28 — `881548e` — Phone navigation gained Home, Chats, Crew, Calls, and Me drawer ownership.
- 2026-09-28 — `c9b3947` — The To box reaches every permitted agent and skips seats the caller cannot add.
- 2026-09-29 — `d345a1c` — Crew rows gained last-seen data, member metadata, shared floors, and thread seed lines.
- 2026-09-29 — `9956109` — The seat popover can choose a brain for a conversation that does not exist yet.
- 2026-09-29 — `a87e37a` — Home gained a composer that chooses its recipient, destination, and send sequence.
- 2026-09-29 — `19a87fa` — Home v4 puts a composer first, then the caller's seats, then populated zones.
- 2026-09-29 — `cd78d89` — Home refuses to post where the selected seat will not hear it and displays approvals readably.
- 2026-09-29 — `0ab3af3` — Home avoids empty conversations, duplicate posts, and unwanted navigation after send.
- 2026-09-29 — `c522e13` — Home's composer uses two rows at every width and keeps Send last.
- 2026-09-29 — `1b6120c` — Phone seat sheets became solid, and read-only chips identify themselves.
- 2026-09-29 — `15dae45` — The rail and Home use the same caller-seat rows without covering names with chips.
- 2026-09-29 — `a1f3410` — Home remembers the selected seat, waits through a failed Crew request, and offers starting prompts.

## 2026-10

- 2026-10-03 — `f1f00be` — Broadcast feeds can select camera or screen as the source.
- 2026-10-03 — `07dcc3a` — Recording downloads use signed links.
- 2026-10-03 — `f8ea19f` — Recording rows restore Meeting-Ops session links.
- 2026-10-03 — `8d12884` — The web client gained a broadcast source copy menu.
- 2026-10-03 — `7f4720d` — Rooms can choose a recording format.
- 2026-10-03 — `73edd46` — Gateway keys gained expiry and history-floor fields.
- 2026-10-03 — `383bac3` — Expired gateway keys are rejected.
- 2026-10-03 — `0917bdd` — Gateway message and context reads stop at `history_from`.
- 2026-10-03 — `5590aee` — Gateway key mint and patch require an explicit expiry choice.
- 2026-10-03 — `066515c` — Multiple viewers can use one broadcast token.
- 2026-10-03 — `94345db` — Recording downloads preserve the browser user gesture.
- 2026-10-03 — `808e0b4` — Fallback recording session IDs are quoted.
- 2026-10-03 — `e982ce7` — The server exposes broadcast viewer counts.
- 2026-10-03 — `5d03df4` — Gateway keys with a non-datetime lifetime are refused.
- 2026-10-03 — `68049d3` — The web client displays broadcast viewer counts.
- 2026-10-03 — `b71f66c` — Gateway key minting requires an explicit history choice.
- 2026-10-03 — `772f74f` — Broadcast viewer counts are totaled per participant and checked per link.
