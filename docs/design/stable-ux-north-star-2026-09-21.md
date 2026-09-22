# Stable UX North Star — design + lane plan (2026-09-21)

Author: Persephone (Claude Fable 5.1), from Aaron's 09-21 notes plus the 09-09/09-10 phone notes already on P-00115.
Surveyed against `origin/main` @ `7f4ea9b` (web ~80.5k LOC, server ~34k, agents ~9.3k, runner `~/Projects/stable-agent-runner`).
Status: DESIGN. Nothing here is built. Lanes are listed in §10; Persephone owns §9 (contracts) and integration/deploy.

## 0. Thesis

Stable is where the crew meets. Every face in the room is someone you recognize; every conversation has one home; every voice knows whose turn it is; and nothing that matters is more than one tap away.

Five principles, each with a test:
1. **Faces, not initials.** A person shows their photo, an agent its puppet, an app its logo. Test: zero `Avatar` sites render initials for a participant who has a picture anywhere in the suite.
2. **One home per relationship.** One DM per person, one hub per agent; threads inside, never rooms sprouting. Test: "Chat with Majik" ×54 cannot happen again.
3. **Agents are present, not summoned.** They hear the room; they speak when addressed or when it is theirs to answer; they never talk over each other. Test: an agent named mid-call answers with the call so far in context.
4. **The room shapes the screen.** Chat, stage, transcript, tasks are panels; any panel can close, float or pop out; the stage takes what is left. Test: hide chat → stage is full width, on phone and desktop.
5. **Show the receipts.** Recording, broadcasting, listening and who-brought-whom are visible to everyone in the room. Test: nobody can be recorded without a red pill on their screen.

## 1. What is true today (measured, not assumed)

| Area | Fact | Where |
|---|---|---|
| Needs-you rows | render `<Avatar name=…>` with no `src`/`id` → always initials | `web/src/components/Home/HomeDashboard.tsx:731`, `widgets/ConversationsCard.tsx:179` |
| Initials sites | one generator (`lib/avatar.ts:123`), ~30 call sites, 9 with the correct agent ladder, 2 with none, the rest human-only | web survey §2 |
| Room types | `CHANNEL / GROUP_DM / DM` only; **no private channel** — every channel is browsable and self-joinable by any signed-in member | `server/app/models/room.py:23`, `api/rooms.py:469-511` |
| Agent chats | every "New chat" mints a room; sidebar folds them per agent; "thread" means both sibling rooms and message replies | `RoomList.tsx:1023-1205`, `ThreadPanel.tsx` |
| Agent text context | Brigade responder: last **10** top-level messages, room-wide, no join/mention floor, thread replies excluded | `server/app/services/agent_chat_responder.py:1089-1119` |
| Runner seats (Persephone, Rook, Astra, Grok, Zen) | receive **only the triggering messages**; history only for `builtin-llm`; a cold seat never sees anything before its @mention | `runner/watcher.py:67-78, 211-223`, `stable_client.py:196-202` |
| Text activation | DM → always reply; channel → only on `@id`; no listen/mute mode; voice has `name/window/always/ptt/off` | `agent_chat_responder.py:1069-1086`, `api/rooms.py:1211` |
| Voice dispatch | exists (name addressing, 30 s sticky, floor lease, nobody-class) but **process-local** in the agents container | `agents/agent_runtime/voice_dispatch.py:58-68, 352-361` |
| Voice scenario 3 | two people on one mic → `human_count==1` → solo-human exception → agents answer human-to-human talk; second speaker persisted under the first's name | `voice_dispatch.py:437-447`, `voice_relay/agent.py:1416-1442` |
| Voice scenario 4 | per-device attribution correct; but a worker's own STT hears only its linked human, and Web-Speech captions stop when a specific mic is chosen | `brigade_backed/agent.py:491-494`, `voice_relay/agent.py:70-78` |
| Chat in a call (desktop) | already a `SplitPane`, hideable, stage takes full width when hidden | `CallRoomLayout.tsx:243-261`, `callUiStore.ts:180` |
| Chat in a call (phone) | Video/Split/Chat modes; chat is a bottom sheet that overlays the stage in Split; message previews float over video | `CallRoomLayout.tsx:448-546` |
| Pop-out | real second windows via React portal (one JS context, one LiveKit room); feeds + People + Saved use it; chat/transcript/canvas do not | `components/Room/popout/*`, `ui/panelPopout.tsx` |
| Recording | one global switch `CALL_RECORDING_ENABLED`; audio-only OGG per call → Meeting-Ops attach; no policy, no indicator, no consent, files never deleted | `services/call_recording.py`, `config.py:385` |
| Broadcast | owner-minted token → hidden subscribe-only viewer page for OBS; `GET /broadcast/active` is the consent surface | `api/broadcast.py` |
| Dashboard | 7-tile strip + Needs you + Conversations + Live now + Agent activity + People + Fleet + Knowledge; `mention_rooms` computed with a raw `ILIKE '%@user%'` that disagrees with the sidebar | `api/home.py:149-155` |
| Project-Ops | inbound webhook → static assignee→room map; outbound promote-message-to-task; **no project rooms** | `api/project_ops.py`, `MessageBubble.tsx:1050` |
| Mobile audit | 12 findings from 08-07, all still open (push only on @mentions, Enter sends, safe-areas, pinch-zoom) | `docs/audit-2026-08-07/mobile-usability-audit.md` |
| Tests | web 49 vitest files, all pure logic, **zero component tests**; server 440+ in-image; agents 302 | surveys |

## 2. Identity everywhere

One primitive, one resolver, everywhere.

- `web/src/components/ui/Identity.tsx` — `<Identity kind="human|agent|app|guest" id name src ring presence size="20|24|32|40|56|96" subtitle />`. Renders photo/puppet/logo; ring by kind (agent = amber per the puppet manifest convention; external-vendor agents = grey ring; app/webhook = square tile with logo; guest = dashed). Presence dot. Initials are the last rung for humans only, and self gets a one-time "Add your photo" nudge instead.
- `web/src/lib/identity.ts` — `resolveIdentity(input: Participant | AgentRosterEntry | Room | MessageSender)`; humans: Stable override → Keycloak picture → initials; agents: bundled puppet → Brigade roster → procedural unicorn (never initials); apps: logo map (`Project-Ops`, `Meeting-Ops`, `webhook-*`).
- Migrate every `Avatar` site in the survey list (30 sites) to `Identity`. Needs-you and Conversations rows pass the counterpart participant (DM) or the agent (hub) — the data is already in `room.members`.
- Push/OS notifications and the in-call tile name plates use the same URL.
- Server: `GET /rooms` gains `counterpart {participant_id, kind, display_name, avatar_url, agent_id}` for dm/agent_hub rows so the sidebar never guesses. Fix `/avatars/*` soft-404 (task 269bc176). Avatar federation (task 1b421248): Keycloak `picture` mapper from Ops-Center, Brigade roster `avatar_url` synced from Brand-Ops manifests nightly, reconciler logs coverage (agents N/M, humans N/M) to the health strip.
- One identity per agent, many transports: the terminal bridge and the seat post as the same participant with `metadata.via = seat|bridge|voice`; UI shows one face and a small "via terminal" badge. (Fixes the two-Persephone confusion in #persephone.)

## 3. Conversation model — Direct · Channels · Threads

Vocabulary in the UI (three words, no "room"):
- **Direct** — people and agents, 1:1 and small groups. Each agent row is a **hub**.
- **Channels** — named spaces: `#public` or `🔒 private`; a **project channel** is a channel bound to a Project-Ops project (`P-00115`).
- **Threads** — child conversations inside a hub or a channel. Message-level replies are called **Replies** everywhere (rename in `ThreadPanel`, cheatsheet, menus).

Rules:
- One DM per person (exists: `dm_pair`). One hub per (you, agent): `room_type = agent_hub`, unique on `metadata.agent_hub = {human_id, agent_id}`.
- "New thread" (⌘⇧N, or the + on a hub/channel) creates a child room with `parent_room_id`; it inherits the parent's `room_type` (so a thread under a hub auto-answers; a thread under a channel answers when named) and seeds members: creator + the parent's bound agents (+ mentioned people). Own title (auto-titled after the first exchange — exists), own unread, own calls and voice settings.
- Hubs open on the latest thread; the Threads panel lists the rest (search, archive, pin). Threads auto-archive after 14 idle days and unarchive on a new message.
- Channels get `visibility`: `public` (browse + self-join, org-scoped) or `private` (invite-only, not listed, lock icon). Default for new channels: **public**; project channels default **private**.
- Invites: a people picker (humans + agents, with each agent's mode chip) and **invite links** (`/join/<token>`, expiry 7 d default, max uses, role). Guest links (no account) stay a separate, clearly labelled thing ("for people outside Unicorn Commander; history starts now").
- Group DM → "Convert to private channel" (explicit, names it). "Start a group with…" on a 1:1 stays (task a0947448).
- Project channels: "New → Project channel → pick from Project-Ops" ensures `p-<number>-<slug>` (private), header chip shows number · status · due, right panel **Tasks** lists the project's open tasks (server proxy over the existing Project-Ops JWT), promote-message-to-task pre-fills that project, and the Project-Ops webhook routes task events to the project channel when one exists (falls back to today's assignee map).
- Backfill: every existing agent chat room becomes a thread under a new hub for (creator, agent). Group DMs with more than one human are left alone.

Agent presence per room (replaces the hard-coded dm/channel split, and the text/voice split):
- `room_members.agent_mode` for agent members: `answers_all | when_named | listening | muted`. Hub/thread default `answers_all`; channel default `when_named`.
- Same field drives voice: `answers_all` in a call = the room's co-host (explicit `primary`, never last-invited); `when_named` = speaks only when addressed; `listening` = transcribes/remembers, never speaks; `muted` = ignores the room.
- Shown as a chip on the member row, in the @-popover, and on the call tile ("Answers everyone" / "When named" / "Listening" / "Muted"); owner/admin/trusted can change it in one tap.

## 4. Context — agents understand the conversation they walk into

- One server-side **context builder**: `GET /rooms/{id}/context?budget_tokens=6000&for=<participant_id>&since=<message_id>` → `{summary, watermark, entries[]}`. Entries are the room stream in order: messages (all senders), reply-thread messages inline (`↳ reply to …`), voice lines (`via=voice`, speaker attributed), and system events (joined, call started/ended, recording on/off, invite). Token-budgeted (default ~6k tokens ≈ 60–100 messages; `room_members.context_depth` overrides), never filtered by join time or mention time.
- **Rolling room summary**: every ~50 messages (or on demand) a local lane (bigboy `qwen3.6-35b-long-batch`) writes `metadata.context_summary = {text, watermark}`; the builder prepends it so long rooms fit the budget. Never customer names off-box: summaries run on our hardware only.
- Brigade responder uses the builder instead of `_HISTORY_LIMIT = 10`.
- Runner seats: `wants_history` becomes the default for every harness. Cold session (no `session_id`, or last turn older than 6 h, or delta > 40 messages) → full context in the turn prompt; warm session → only the delta since the seat's last reply. Thread replies included.
- Listening mode = the seat advances its watermark on every batch (no LLM call); memory-bearing seats may fold the delta into memory on a budget (off by default).
- Voice: the call transcript is already persisted as messages, so an agent dispatched mid-call gets the call so far through the same builder.
- The gateway mirrors it: `GET /gateway/rooms/{room}/context`.

## 5. Voice — the turn model

Who is in the call decides the rules; the rules are the same in text and voice.

| Scenario | Behaviour | Needs |
|---|---|---|
| 1 human + 1 agent | agent answers everything, full duplex, barge-in both lanes; every spoken line lands in chat | port relay barge-in to the Brigade lane |
| 1 human + N agents | name addressing ("Rook, …"), sticky 30 s to the last-addressed, explicit co-host answers the unaddressed, everyone else waits to be named; floor lease = exactly one voice; agents never answer agents unless a human hands off ("Rook, ask Persephone"); raise-hand for proactive input | shared floor/sticky state in Redis; `primary` explicit; raise-hand UI |
| N humans on ONE device + N agents | the participant flips **"We're sharing this mic"** (call bar toggle → participant metadata `shared_mic`); dispatcher treats human_count ≥ 2 → addressing required, nobody-class default; transcript lines carry `speaker_hint` from diarization/voiceprint when available, else "Aaron's room · speaker 2" | `shared_mic` flag; diarization hook (Amanuensis v2, P-00176); voiceprint enrolment in Settings → Voice shared with Meeting-Ops |
| N humans on N devices + N agents | attribution by LiveKit identity (works); the elected captioner runs STT for **every** human track; each agent has an owner ("brought by Aaron"), trusted humans get full hands, others get answer-only (runner tiers exist) and the tile says so | multi-track STT in the captioner; owner badge on tiles |

TTS: one floor lease across all agents (Redis), sentence chunks, barge-in by any human, per-room spoken length (`voice_relay_max_spoken_chars`: hub/DM unlimited, channel 900), "the rest is in chat" only when truncated, no voiced "⚙️ On it" acks (task 05f79338). Text-only participants read the spoken lines as messages (exists).

Every dispatch decision is logged (`agent_events.voice_dispatch`: inputs, rule, winner) — this is the eval set for the classifier tier later (spec §3).

## 6. Dashboard v3 — an inbox, not a directory

Sections, in order, every actor a face, every row a verb:
1. **Needs you** — approvals (Approve / Decline inline), @mentions, unread DMs, agents waiting on your answer, pending invites. Row = face · who · what · where · when · action. Sorted by urgency then time; stale (>14 d) folded.
2. **Live now** — calls (Join), recording/broadcast pills, agents working (name · task · since, from agent events + heartbeats).
3. **Your crew** — agent cards: face, mode chip, status, last line. Tap = hub; ⋯ = New thread / Call / Change mode.
4. **Recent** — last 12 conversations you touched, humans first, draft pencil where a draft exists.
5. **Today** — Project-Ops tasks due for you, Meeting-Ops recaps from the last 24 h, standing meetings. Federated; hidden when unreachable, never faked.

Gone: the number tiles (counts move into section headers), People online widget (lives in the People drawer), Fleet directory (lives on Agents). Added: skeletons on cold load, first-run hero, sections collapsible and reorderable (server prefs, follows the user across devices). Server: `GET /home/summary?v=3` adds typed `needs_you[]`, `crew[]`, `today{}`; `mention_rooms` reads `has_unread_mention`, not `ILIKE`.

## 7. Layout, panels, windows

- **Panel model**: `panelChromeStore` becomes the registry — `panels[id] = {mode: docked|floating|popped|hidden, dock: left|right|bottom, geometry}` for `chat, replies, members, transcript, canvas, tasks, threads, stage`. One `PanelHost` renders docked/floating/popped through the existing `panelPopout` portal. Sizes persist per room per device.
- **In a call**: the stage owns the main area. Chat docks right (360 px default) or hides; **hidden → stage is full width**. Toggle = call-bar button + `c` + remembered per room. Tiles never overlap chat on desktop. On phone, Video mode hides chat completely (previews become a 1-line toast pill, tap to open the sheet); Split keeps the sheet below the stage, not over it.
- **Layout presets** (call bar): **Focus** (stage only), **Studio** (stage + chat + transcript), **Text** (chat main, stage PiP), **Show** (every panel popped to its own window for OBS — uses the broadcast-page composition per tile). Presets are just panel states, so users can save their own.
- Pop-out extends to chat, transcript, canvas, members, tasks (the two known blockers from task ea8d6cab: no `SplitPane` inside a pop, and popped panels read state through the portal).
- Room header is type-aware: face + presence for a DM, facepile for a group, `#`/`🔒` for a channel, project chip for a project channel; then Call ▾ (Voice / Video), Record, Broadcast, Members, Threads, Pop-out, ⋯.

## 8. Recording — policy, capture, receipts

- **Policy**: `rooms.recording_policy = off | on_request | always` (owner/admin). `record_my_calls` personal default (Aaron + Shafen on). Server-side recording requires the Keycloak role `stable-recorder` (granted in Ops-Center). Guests see a consent line on join when the room records; agents receive a system message so they can say so.
- **Receipts**: red pill `● REC 12:04 · started by Aaron` in the call bar for everyone, a chime and a system message on start/stop, `recording_state` WS event, and the fact (not the file) visible to every room member afterwards.
- **Capture kinds**: `audio` (exists → Meeting-Ops attach); **`composite`** video = LiveKit room-composite egress rendering our own layout template — the broadcast page — so the recording looks exactly like the show feed (MP4 → Studio Storage/Garage, attached to the Meeting-Ops session; one call = one session, task 9bc0cc15); `track` ISO recording for show nights later.
- **Retention**: local egress files deleted after upload (today they are never unlinked); 30 days hot then archive; `legal_hold` flag; who can view/download/delete = room owner/admin + the recorder.
- **Capacity**: composite egress runs headless Chrome. Run the egress worker on a host with headroom (centerdeep measured 92 % idle 08-08; verify before choosing), cap concurrent composites at 2, measure CPU per stream on the first real call before enabling `always` on any room.
- **Surfaces**: Record button in the call bar (entitled users), room settings "Recording: off / ask / always", Meetings → Recordings list with playback via Meeting-Ops.

## 9. Contracts (Persephone owns; lanes build against these)

Migrations (all additive):
- `021_conversation_model`: `ALTER TYPE room_type_enum ADD VALUE 'agent_hub'`; `rooms.parent_room_id UUID NULL FK`, `rooms.visibility TEXT NOT NULL DEFAULT 'public'`, `rooms.project_number TEXT NULL` (+ indexes); `room_members.agent_mode TEXT NULL`, `room_members.context_depth INT NULL`; table `room_invites(id, room_id, token_hash UNIQUE, token_prefix, created_by, role, expires_at, max_uses, use_count, revoked_at, created_at)`.
- `022_agent_hubs_backfill`: hubs for every (creator, agent) pair; existing agent chats → threads. Idempotent, logged.
- `023_recording_policy`: `rooms.recording_policy`, `rooms.recording_kind`; `call_egresses.kind`, `started_by`, `storage_url`, `retention_until`, `legal_hold`.

Endpoints:
- `POST /agents/{agent_id}/hub` (ensure), `POST /rooms/{id}/threads`, `GET /rooms/{id}/threads`, `PATCH /rooms/{id}` (+visibility, project_number, recording_policy), `POST /rooms/for-project {project_number}`, `GET /rooms/{id}/tasks`.
- `POST|GET|DELETE /rooms/{id}/invites`, `GET /invites/{token}`, `POST /invites/{token}/accept`.
- `PATCH /rooms/{id}/members/{participant_id} {agent_mode, context_depth}`.
- `GET /rooms/{id}/context`, `GET /gateway/rooms/{room}/context`.
- `PATCH /rooms/{id}/voice-settings` accepts the DB-only keys too (`source, agent_id, aliases, primary_agent_id, face_shape, face_plate, max_spoken_chars`). `PATCH /rooms/{id}/call/me {shared_mic}`.
- `POST /rooms/{id}/recording/start|stop`, `GET /rooms/{id}/recordings`.
- `GET /home/summary?v=3`.
- `GET /rooms` rows gain `counterpart`, `parent_room_id`, `visibility`, `project_number`, `thread_count`, `agent_mode` (own agent members).

WS events: `thread_created`, `room_visibility`, `invite_created`, `member_mode`, `recording_state`, `voice_dispatch` (room-scoped, for the raise-hand/floor UI).

Web primitives: `ui/Identity.tsx` + `lib/identity.ts`; `stores/panelChromeStore` registry + `PanelHost`; `navStore` views `home|direct|channels|meetings|agents`; `sidebarModel` with hubs → threads; `NewSheet`.

Runner: `wants_history` default on; cold/warm context rule; `agent_mode` honoured (`listening` = watermark only).

## 10. Lanes

House rule: engineering lanes on the non-Claude harnesses (Codex/Astra, Grok, free OpenCode, local Qwen); Persephone designs, freezes contracts, integrates, verifies and deploys. Lanes never deploy, never touch `main`, never mint credentials. Split by directory so branches merge clean (server/ · web/ · agents/ · runner). Every lane: branch off `origin/main`, PR on Forgejo, CI green on the **right job**, receipts on its Project-Ops task via `po_mcp.call('add_task_comment', …)`.

| # | Lane | Dirs | Seat | Est. | Depends on |
|---|---|---|---|---|---|
| L0 | Contracts: migrations 021–023, schemas, stub endpoints, OpenAPI, tests | server/ | **Persephone** | 1.5 d | — |
| L1 | Identity everywhere: primitive + resolver + 30-site migration + notification icons | web/ | Astra (Codex) | 2.5 d | L0 (`counterpart`) |
| L1b | Avatar federation: Keycloak picture mapper, Brand-Ops → Brigade avatar sync, reconciler, `/avatars` 404 fix | ops + server | Persephone (KC admin) + Grok (sync script) | 1 d | — |
| L2 | Conversation model, server: hubs, threads, visibility, invites, project channels, agent_mode, backfill, responder uses agent_mode | server/ | Astra (Codex) | 4 d | L0 |
| L3 | Conversation model, web: rail/sidebar taxonomy, hub + Threads panel, New sheet, invite links, private channels, project chip + Tasks panel | web/ | Astra (Codex) | 5 d | L0 contracts (mock until L2 lands) |
| L4 | Context builder + listen mode: server builder, responder swap, gateway mirror, runner cold/warm rule, room summary job | server/ + agents/ + runner | Codex (server, runner) · local Qwen for the summary prompt | 3 d | L0 |
| L5 | Voice turn model: Redis floor/sticky, explicit primary, `shared_mic`, multi-track STT in the captioner, Brigade-lane barge-in, per-room spoken length, dispatch log, raise-hand event | agents/ + server (small) | Codex | 5 d | L0 |
| L6 | Panels & layouts: registry, PanelHost, chat hide = full-width stage (phone too), presets, pop-out for chat/transcript/canvas/members/tasks | web/ (Layout, Room/popout, Call) | Grok | 3 d | — |
| L7 | Dashboard v3: home summary v3 (server) + sections rewrite (web), skeletons, first-run, prefs | server/api/home.py + web/Home | Grok | 3 d | L1 |
| L8 | Recording: policy + entitlement + composite egress via broadcast template + retention + receipts (server, infra); call-bar/room-settings/Recordings UI (web) | server/ + deploy/ + web (small) | Codex (server) · Astra (web) · Persephone (egress host, storage) | 5 d | L0 |
| L9 | QA harness: renew uishot `stable` profile, Playwright captures of 12 surfaces at 390×844 and 1440×900 in CI, a11y sweep, first component tests | web/ tests + CI | free OpenCode (nemotron) | 2 d | — |
| L10 | Mobile shell: bottom tabs, call sheet rules, the 12 open mobile findings (push on DMs/calls, Enter = newline, safe-areas, pinch-zoom) | web/ | Astra (Codex) | 3 d | L3, L6 |

Waves: **W0** L0 + L1b (Persephone, first 2 days). **W1** in parallel: L1, L2, L4, L6, L8-server, L9. **W2**: L3, L5, L7, L8-web, L10. Seat availability (09-21): Codex/Astra is out on usage limit until 09-23, so W1 starts on Grok (L6, L7, L1) and free OpenCode (L9); Astra picks up L2/L3/L4/L8 on 09-23. Grok lanes run through `~/Projects/persephone-bin/grok_lane.sh` (push allowed, deploy denied); Codex lanes cannot push or reach Project-Ops from the sandbox, so Persephone pushes and posts for them. Integration by Persephone after each wave on `integ/ux-north-star-<date>`: dogfood → Aaron on the phone → flagship. Roughly 38 lane-days; two to three weeks wall clock with four seats.

Definition of done for the programme: the five principle tests in §0 pass on dogfood; the 09-21 notes and the 09-09/09-10 phone notes are each traceable to a shipped item; Playwright captures show every primary surface at both widths with no console errors.

## 11. Decisions for Aaron (recommendation attached)

1. Threads as child rooms (recommended) vs. message-level threads for agent conversations. Child rooms reuse every existing message/call/voice path and make the backfill mechanical.
2. Dispatcher state in Redis now, full server move later (recommended) vs. rewrite in the server first. Same module, shared state, one week sooner.
3. Video recording = composite of the broadcast page (recommended). One layout for OBS and for the archive; needs an egress host with CPU headroom.
4. New channels default public inside the org, project channels default private (recommended). Matches how the crew already uses channels vs. client work.
5. Kick-off: Persephone starts W0 now; W1 lanes launch on your word.

## 12. Out of scope here (tracked elsewhere)

iOS/Android wrap (PROJ-2026-000216), native macOS client (7fe7f57f), VRM avatars (942f1510), comms relays (e5f08e77), voice classifier tier (4cc99d05), per-org tenancy (P-00115 security tasks).
