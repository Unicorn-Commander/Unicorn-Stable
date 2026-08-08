# Stable usage conventions — rooms, visibility, agents

Written 2026-08-08, after the UX-wave deploy. This is the answer to "when do I
use a DM vs a channel, and who can see what." Update it when the model changes.

## The visibility model (facts, from the code)

There are exactly three room types (`server/app/models/room.py`), and **there
is no private channel**:

| Type | Who can see it | Who can join |
|---|---|---|
| `channel` | **Every logged-in member of the instance** — channels appear in the channel browser (`GET /rooms/discover`), org-scoped on per-org installs | Anyone in the instance, self-serve |
| `group_dm` | Members only. Invisible to everyone else | Invite by a member |
| `dm` (incl. agent DMs) | The two participants only | Nobody |

Corollaries:

- A "1:1-looking" **channel** (e.g. `Claude Code ↔ Aaron`) is readable and
  joinable by every other human on the instance. If the content is sensitive,
  it is in the wrong room type.
- Knowledge bases attached to a room follow the room's membership.
- **Agent activity** on Home shows agent-authored messages in rooms *you are a
  member of* — including **other people's agents** posting in shared rooms.
  That is intentional (their message is in your space, and often @-mentions
  you); the row is labeled with the owning workspace's agent name.

## Decision table — where does a conversation live?

| Situation | Use |
|---|---|
| 1:1 with an agent (a Claude Code session, chatting with Majik) | **Agent DM** |
| Private work with one person | **DM** |
| Private multi-party — people + agents (e.g. Aaron + Shafen + Claudes) | **Group DM** |
| Status/alerts/approvals the whole workspace benefits from (GM Alerts, Email-Ops Approvals) | **Channel** |
| Credentials, incidents in progress, finances, anything need-to-know | **DM / group DM — never a channel** |
| One-off run logs (overnight runs, lane sessions) | Post into **one standing program channel** (e.g. `#overnight-ops`) instead of minting a channel per run. If a run truly needs its own room, **archive it at completion** |

## Bridge etiquette (terminal Claude Code sessions ↔ Stable)

- **One canonical room per human ↔ bridge pair.** The bridge must reuse the
  existing room, never mint a near-duplicate (we currently have both
  `Claude Code ↔ Aaron` and `Aaron ↔ Claude Code` — consolidate to one and
  archive the other).
- Bridge conversations default to work-log content → channel is acceptable on
  a high-trust instance, but the moment a thread carries secrets or personnel
  matters it belongs in a DM. Backlog: teach the bridge to open a
  `group_dm` instead of a channel so bridge threads are private by default.
- Ephemeral "session" channels (Night Shift, overnight runs) should be
  archived when the run ends — the archive UI ships with the
  `feat/agent-chat-lifecycle-51ef589d` branch.

## Known follow-ups tracked from this doc

- Bridge: room-type choice + duplicate-room reuse (see above).
- Agent activity: optional "only my agents" filter + rank own agents above
  shared-room agents.
- Send failures must surface a toast + retry (silent optimistic loss observed
  2026-08-08).
