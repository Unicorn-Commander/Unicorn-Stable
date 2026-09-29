# Stable Nav v3 — crew-first messenger (2026-09-28)

Aaron, 2026-09-28 evening: "I'm not happy with the main navigation of Stable. It's not easy to
find an agent that I want to DM, in a new conversation, not attached to other conversations. I
can't start a new chat with Persephone. I should be able to change from Fable 5.1 to a different
model for the Claude-only runners, and thinking level; Rook is Opus 5.5 by default or something.
The agent I talk to about things is a different model/thinking level than the ones I want to take
action. When I talk to Persephone in Stable or on my kitchen panel or uc1-tv panel I should have
full access to tools and permissions. It shows just a bunch of Claude Code under my crew. It should
be more like ChatGPT, Open-WebUI and other chat/messenger apps — and if not like them, better.
This should basically be the best in the world."

This document continues `stable-ux-north-star-2026-09-21.md` (§3 conversation model, §6 dashboard).
It does not replace it. Everything under "What is true today" was measured on 2026-09-28 against
dogfood (`bea62cd`) and the Mac Studio runner (`feat/crew-harnesses`).

## 0. Thesis

A messenger is a list of *people you talk to*. Stable's left rail is a list of *rooms*, and the
agents Aaron actually works with (Persephone, Rook, Astra, Grok, Zen, Flow) are not first-class in
it: they are runner seats bolted on beside a Brigade roster, reachable only through rooms that were
hand-provisioned in YAML on the Mac Studio. The fix is not another sidebar rearrangement. It is to
make **a seat follow its human**: wherever Aaron opens a conversation with Persephone, Persephone is
there, with the hands and the brain Aaron chose for that conversation.

Four things, in order:

1. **Crew** — one first-class roster of the agents you can talk to, pinned like contacts.
2. **Seat follows the human** — a runner seat discovers its hub, its threads and every room it is
   added to, and answers there under the room's policy. No YAML edit, no key re-scope.
3. **Brain per conversation** — model and thinking effort are a property of the conversation
   (hub, thread, DM), set from the room header, applied by the runner on every turn.
4. **Voice reaches the seat** — the kitchen wall and uc1-tv "Persephone" is the same seat with the
   same hands, not a local model wearing her voice.

## 1. What is true today (measured 2026-09-28)

**1.1 "I can't start a new chat with Persephone" — structurally true, not a UI bug.**

- New → *Talk to an agent* lists Brigade's roster plus a fixed two-entry allowlist
  (`_BRIDGE_CREW_AGENTS` in `server/app/api/brigade.py`: `claude-code` = Rook, `persephone`).
  Astra, Grok, Zen, Flow, Claude are not in the picker at all.
- Picking Persephone calls `POST /api/v1/agents/persephone/hub` → her hub exists
  (`hub-fa65c5631810`, backfilled by migration 022, 2 members).
- The runner (`~/Projects/stable-agent-runner`) watches **only** the rooms listed in
  `~/.stable-agent-runner/profiles/persephone.yaml` (`persephone`, `persephone-desk`,
  `build-in-public-live`, `aaron-shafen-claudes`, `apparel-pad`, `charlotte-trip`, `codex-astra`,
  `texts-inbox`, `jordan-medical`). The hub is not listed. Her gateway key (`e2d8b6eb`) is scoped to
  the same 13 names. So the hub, and any thread started under it
  (`hub-fa65c5631810-t-xxxxxxxx`), is **dead air**: unwatched and out of key scope.
- The runner has no room-discovery call at all (`runner/stable_client.py`: messages, context,
  leave; no rooms list). `runner/main.py:147` builds one `RoomWatcher` per YAML entry at start.
- `POST /brigade/agents/spawn` refuses runner seats with 409 "new runner rooms require
  provisioning". That sentence is the whole problem.

**1.2 Model and thinking level are not reachable from the app.**

- `model:` and `effort:` live in the seat YAML (`persephone.yaml`: `claude-fable-5-1`, `high`;
  `claude-dev.yaml` Rook: `claude-fable-5-1`, `medium`). The runner passes them as
  `--model` / `--effort` on every turn (`runner/adapters/claude_code.py:186-188`), one process per
  turn — so a per-turn override is cheap.
- The room header's *Model* menu (`ModelSwitcher.tsx`) writes a client-side `modelOverrides[roomId]`
  read by `useChat` (Brigade chat requests) and `VoiceProvider`. It never reaches a runner seat.
  In a seat room it is a menu that does nothing.

**1.3 The kitchen wall and uc1-tv "Persephone" is not Persephone.**

- `panel-ops/voice-hub/hub.py`: the `persephone` / `hey_persephone` persona has `backend: llm`
  (gateway alias `strix-qwen3.6-35b`, no tools). Only Majik/Gunny/Harmony route to Brigade.
- The seat path is already designed on P-00210 task `85ac6d4b` (voice → her Stable seat, spoken
  "on it", confirm-before-mutate). It is blocked on one room-scoped gateway key.
- The kitchen touch page links the *text* path correctly
  (`service/app.py`: `persephone` → `stable.magicunicorn.dev/c/82b7876a…`, her canonical DM).

**1.4 "A bunch of Claude Code under my crew" — the data says so.**

- `/home/summary` v3 builds `crew` as **every agent participant that shares a non-archived room
  with the caller** (`server/app/api/home.py::_crew`). Aaron shares rooms with 65 agent participants.
- Seven of them are `webhook-*` integrations, every one displayed as "Claude Code" with the same
  `claude-code.webp` puppet (webhook-dev-stable, -dev-contact-ops, -dev-customer-ops,
  -dev-landing-pages, -dev-meeting-ops, -main-conference, -dev-overnight-20260716). Add "Claude Dev",
  "Dev Shafen Z13" (claude-code puppet), "Claude", and Rook whose username is `agent-claude-code`.
- Nothing in the model distinguishes *a seat Aaron can talk to* from *an integration that once
  posted*. `crew_sort` ranks by "has a task/heartbeat", then name — alphabetical Claude Codes.

**1.5 Navigation has six doors to the same place.**

Home · Direct · Channels · Meetings · Agents (rail pills / phone tabs), a People drawer, a New
sheet with six steps, folders, filters, a Directory URL, and nav v2 behind a localStorage flag
(`stable_nav_v2`, on by default since N1 merged at `671a3a0`). Rooms are the unit everywhere;
the agent you want is never the unit.

## 2. Target — what "best in the world" means here

Benchmarks, honestly: ChatGPT (one contact, many conversations, model picker in the header),
iMessage/WhatsApp (contacts first, presence, one list), Slack (channels + DMs + threads, ⌘K),
Open-WebUI (per-chat model, tools toggles). Stable can beat all four on one axis none of them
have: the agent is a **teammate with hands**, present in voice and video, with a per-conversation
brain and a per-room permission tier that the human can see. So the design keeps their idioms and
adds the seat.

**2.0 Five kinds of agent — the model must say which is which (Aaron, 09-28: "there's a
difference between Brigade agents, our runners on our computers, and other users' agents or
models they bring in — like how Shafen and I have our agents talk to each other").**

| kind | what it is | identity facts | hands | in your Crew? |
|---|---|---|---|---|
| **Brigade agent** | house persona hosted on the server (Majik, Sidekick, The General, the GM staff) | `metadata.backend = brigade`, no owner | Brigade's tool registry only, never a shell | yes — the house roster you're entitled to |
| **Your seat** | a Claude Code / Codex / Grok / OpenCode process on *your* computer, posting through a gateway key you hold | `backend = runner`, `metadata.owner = <your username>`, `crew = true`, live key | per-room tier (full in your private rooms) | yes — first, pinned |
| **Partner's seat** | another member's seat (Shafen's Flow, ShOX, Okapi…) that you share rooms with | `backend = runner`, `owner = shafen` | its owner's rules; acts on *your* messages only when its owner listed you as trusted | as **Partners**, when you share a room |
| **Guest agent** | an outside account's agent let in through a scoped key or stable-guest-mcp (a customer's assistant, a guest's Claude Code) | `kind = guest_agent`, key scoped to named rooms, history-floored | none of ours | no — visible only inside the room roster, marked guest |
| **Integration** | webhooks, relays, probes, smoke identities | `kind = integration` | none | never; never people-like anywhere |

Two consequences run through every contract below. **Ownership decides privacy**: a room with
you, Persephone and Rook is still *your* private room (both seats are yours), a room with you
and Flow is shared. **Trust between agents is explicit and per owner**: Shafen's seat acts on
Aaron's messages only because Shafen listed Aaron as trusted, and vice versa (the 09-03 trusted
tier); nothing in Nav v3 loosens that. The Crew rail groups by kind: **Your seats · House
(Brigade) · Partners**, with "All agents" for the directory; guests appear only in rooms.

**2.1 Crew (rail section, phone tab).** Pinned at the top of the left rail, above Conversations.
Each row: face, name, presence dot (runner heartbeat / Brigade worker), and a small chip with the
conversation's brain ("Fable · high"). Tap → the agent's hub. ⋮ → New conversation · Call ·
Settings. "All agents →" opens the directory (today's Agents page, demoted from a destination to
a page under Crew).

Membership of Crew = participants with `metadata.crew = true` **and** a live gateway key
(runner seats) **or** Brigade agents the caller has a hub or DM with. Integrations, probes and
relays (`metadata.kind = integration`) never appear. Ranking: your own seats, then agents with a
thread in the last 14 days, then the rest under a collapsed "More".

**2.2 One conversation with an agent = its hub; new conversations = threads.** Exactly as the
North Star §3 says; the difference is that it now *works for seats*. The hub header carries
"**New conversation**" (creates a thread, titled from the first message, becomes the active
view — ChatGPT's "New chat" but the contact stays one contact). Threads list on the hub's Threads
panel and nest under the hub in Conversations. A thread is the "conversation not attached to
other conversations" Aaron asked for; the hub's own timeline is the ongoing DM.

**2.3 Seat follows the human (runner discovery).** The runner asks the gateway which rooms its
seat is a member of and watches all of them. Policy comes from a **room class** the server
computes, not from a YAML list:

| room_class | definition | default hands (Persephone) | reply |
|---|---|---|---|
| `private` | exactly one human member, and every agent member is a Brigade agent or a seat *owned by that human* (a hub, a thread under it, a 1:1 DM, you + Persephone + Rook) | full | always |
| `shared` | two or more humans, or a seat owned by someone else, or a guest agent | answer (trusted only for explicitly listed senders) | when named |
| `channel` | `room_type = channel` | answer | when named |

Explicit `rooms:` entries in the profile keep winning by name (the show room, the trusted rooms).
Everything else gets the class default. The private hub with Aaron gets the same hands as
`#persephone` today — that is the rule Aaron set on 2026-09-03 ("private chats can do the same
thing as what you can"), applied automatically instead of by hand.

**2.4 Brain per conversation.** Room metadata `seat = {model, effort}` on a hub, thread or DM.
The room header shows the chip; clicking it opens a popover: Model (the seat's harness list),
Effort (low · medium · high · max), Mode (answers all · when named · listening · muted — the
existing `agent_mode`). "Default" = the seat's profile values, shown by name so Aaron always knows
what the default is. The runner applies the override on each turn. Rook on Opus 5.5 by default is
one line in `claude-dev.yaml` (Aaron's call, §6).

**2.5 Voice reaches the seat.** Kitchen wall and uc1-tv: "Hey Persephone" → hub STT → post into
her private hub thread "Voice · kitchen" via a room-scoped key → spoken "on it" → her final reply
spoken in af_heart. Mutations require a spoken confirm. Same seat, same memory, same hands as the
app. Text on the panels keeps opening the hub in the panel browser.

**2.6 Phone.** Tabs: Home · Chats · Crew · Calls · Me. (L10 mobile shell task carries the rest.)

## 3. Contracts (lanes build against these; Persephone owns changes)

### C1 — Gateway: seat room list + `@member` key scope (server)

`GET /api/v1/gateway/rooms` (gateway key auth) → rooms where the key's agent participant is a
non-archived member:

```json
[{"id": "…", "name": "hub-fa65c5631810", "livekit_room_name": "stable-hub-fa65c5631810",
  "display_name": "Persephone", "room_type": "agent_hub", "parent_room_id": null,
  "room_class": "private", "humans": 1, "agent_seats": 0,
  "agent_mode": "answers_all", "seat": {"model": null, "effort": null},
  "updated_at": "…"}]
```

- `room_class` as in §2.3, computed from ownership: `foreign_seats` counts runner-backed agent
  members whose `metadata.owner` is not the room's single human (or is missing), `guests`
  counts `kind = guest_agent` members; either > 0 makes the room `shared`. `own_seats` counts
  the human's other seats, so a seat can still tell "me and Aaron" from "me, Aaron and Rook"
  (both private).
- Key scope: `allowed_rooms` accepts the token `"@member"` = any room where the key's agent
  participant is a member. `_check_room_scope` resolves it against `room_members` (the JWT path
  already does a membership check — same shape). Names and `stable-` names keep working.
  Minting/patching a key with `["@member"]` is the operator's explicit choice; `"*"` stays what it
  is.
- `GET /rooms/{room}/context` gains `room_class` and `seat` (same values).
- `PUT /api/v1/gateway/me` (key auth) body `{"harness": "claude-code", "default_model": "…",
  "default_effort": "high", "models": [{"id","label"}], "efforts": ["low","medium","high","max"]}`
  → stored on the seat participant as `metadata.seat_capabilities` (validated, ≤ 24 models).
  Runners announce themselves at start and every hour. Web reads it via the crew list.

### C2 — Seat settings on a room (server + web)

- `metadata.seat` becomes client-mutable through `PATCH /rooms/{id}` (extend
  `CLIENT_MUTABLE_METADATA_KEYS`), validated: `model` matches `^[a-z0-9][a-z0-9.:_/-]{0,80}$` or
  null, `effort` ∈ {low, medium, high, max} or null. Allowed for the room owner, or any human
  member when `room_class = private`. Rejected (409) on rooms with no runner-backed seat member.
- Web: `SeatSettings` popover from the room header chip on rooms with a seat member; models and
  efforts come from the seat's `seat_capabilities`; "Default (Fable 5.1 · high)" is the null
  state. The existing `ModelSwitcher` stays for Brigade rooms and is hidden on seat rooms.

### C3 — Crew (server + web)

- `GET /api/v1/crew` → `[{agent_id, participant_id, display_name, avatar_url, role_line,
  backend, kind, owner, group, presence, hub_room_id, seat_capabilities, last_line, last_at,
  unread}]` where `group` ∈ {`own_seat`, `house`, `partner`} (§2.0), ranked own seats → house
  agents with a recent thread → partners → the rest. Guest agents and integrations are never
  listed. `/home/summary` `crew` reuses it (cap stays).
- Membership rules in §2.1. `metadata.kind = integration` excludes; `metadata.crew = true`
  opts a runner seat in. One-off SQL (Persephone, on deploy) flags the seven `webhook-*` rows,
  `agent-texts-relay`, `agent-taxsq-dryrun`, `agent-deploy2-smoke` as integrations; sets
  `owner = aaron` + `crew = true` on persephone, claude-code, codex-astra, grok, zen, claude,
  deepseek-flash, producer, osprey, tern, perry; sets `owner = shafen` + `crew = true` on
  shafen-claude-code, dev-shafen-z13, shox, okapi-grok, gerenuk-codex, kudu-sonnet, oryx-gpt,
  dikdik-haiku, eland-qwen (Shafen's seats show under **Partners** for Aaron and as **Your
  seats** for Shafen).
- New → *Talk to an agent* lists `/crew` (not the two-entry allowlist); the allowlist is deleted
  once `/crew` is live.
- Sidebar: Crew section above Conversations (desktop), Crew tab (phone). Rows per §2.1.
- Hub header: "New conversation" button → `POST /rooms/{hub}/threads` → navigate to the thread.

### C4 — Runner: discovery + class policy + per-turn brain (runner)

- Every `discovery_interval_s` (30) the runner calls `GET /gateway/rooms`; a new room gets a
  `RoomWatcher` with a `RoomSpec` derived from `room_class` (profile keys `class_policy:
  {private: {tier: full, reply: always}, shared: {tier: answer, reply: mention}, channel: {tier:
  answer, reply: mention}}`; explicit `rooms:` win by name). Archived/left rooms stop their watcher.
- Per turn: `seat.model` / `seat.effort` from the room's context override the profile's
  `--model` / `--effort` when the value is in the profile's `models_allowed` (default: the four
  Claude models) / the effort enum; otherwise log and use the profile default.
- At start and hourly: `PUT /gateway/me` with the profile's harness, defaults and lists.
- Existing prime-seen rule holds: a newly discovered room is primed, never answered from history.
- No runner restart by a lane. Persephone restarts on Aaron's word.

### C5 — Voice → seat (panel-ops, existing task 85ac6d4b)

Unchanged from the task text; the room becomes a thread under Persephone's hub named
"Voice · <panel>", created once per panel and reused; the key is scoped `["@member"]` on a
dedicated agent identity `house-voice` that the profile lists as a trusted sender in private
rooms only. Needs Aaron's approval to mint (new identity — tier 2).

## 4. Lanes

| lane | scope | owner | branch |
|---|---|---|---|
| A · server | C1 + C2 server + C3 server (`/crew`, home reuse) | Claude subagent | `feat/nav-v3-server` |
| B · runner | C4 | Claude subagent | runner `feat/seat-discovery` |
| C · web | C2 web + C3 web (Crew section/tab, New picker, hub New conversation, seat popover) | Claude subagent | `feat/nav-v3-web` |
| D · voice | C5 | after Aaron's key approval | panel-ops |
| E · mobile | L10 (existing fb67c5ec) | existing | — |

Each lane: tests on the merged tree, adversarial review, fix lane, then Persephone integrates on
`integ/nav-v3-<date>` and deploys dogfood on Aaron's word.

## 5. Acceptance (what Aaron sees)

1. Open Stable on the phone → Crew tab → Persephone → "New conversation" → type "what's on my
   board?" → a reply from Persephone in that thread within a turn, with full hands (she can read
   Project-Ops). No YAML touched.
2. Header chip says "Fable 5.1 · high"; tap → Opus 5.5 · medium → next reply carries the change
   (runner log shows `--model claude-opus-5-5 --effort medium` for that turn only).
3. Crew shows Persephone, Rook, Astra, Grok, Zen, Claude, Flow, Majik…; zero rows named "Claude
   Code"; integrations gone.
4. Kitchen wall: "Hey Persephone, what's the fleet look like?" → spoken "on it" → her real answer.
   "Restart the runner" → "say confirm to restart the runner on the Mac Studio."

## 6. Decisions for Aaron (recommendation attached)

1. **Rook's default brain** — recommend `claude-opus-5-5` · `medium` for the seat (Fable stays in
   the terminal for the cut). One line in `claude-dev.yaml`; say the word.
2. **Persephone seat default** — keep Fable 5.1 · high; per-thread override covers "max when it
   matters".
3. **`@member` scope on the seat keys** — recommend re-scoping `e2d8b6eb` (Persephone) and
   `ccd6b62b` (Rook) to `["@member"]` at deploy; the runner's class policy is the guard, not the
   key list.
4. **`house-voice` key** for C5 — new identity, tier 2: approve and I mint it scoped `@member`,
   Vaultwarden, 1-year rotation task.
5. **Phone tabs** Home · Chats · Crew · Calls · Me — say if you want Channels back as a tab.
