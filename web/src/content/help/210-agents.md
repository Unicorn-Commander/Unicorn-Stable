---
id: agents
title: Working with agents
section: Agents
order: 210
summary: Add an agent to a room, address it, switch its model, regenerate or stop a reply.
keywords: agent, ai, brigade, mention, bot, model, regenerate, stop, roster, org chart
---

Agents are members. They appear in the member list, they have a name and an
identity colour, and you talk to them in the room.

## Address an agent

- `@agent-id` in a channel, or `/agent <id> …`
- In a **DM with the agent**, just type — no mention needed

In a **channel** an agent stays quiet unless it is mentioned. That is
deliberate: a channel full of people should not have an agent answering every
line. In a DM it answers everything.

## Add an agent to a room

Rooms have an agent picker in the header. Agents come from Brigade, the roster
service, so what you can add depends on what your server has registered.

## The agent roster

The **Agents** page shows every agent your server knows about, in two views of
the same roster:

- an **org chart** — orchestration at the top, domain teams beneath
- a flat **card list**

Both are searchable. Click an agent to open a popup and start a chat with it —
or with several at once.

## Reading an agent's status dot

The dot next to an agent means one of three things, and they are genuinely
different. Stable will not collapse them into one signal:

| Dot | Means |
|---|---|
| Filled, pulsing | **In this room now** — it has actually joined the call |
| Hollow ring | **Available** — no live connection, but it can be invoked (registered and enabled in Brigade, or a bridge session is polling) |
| Dim hollow ring | **Unknown** — including "we could not reach Brigade to ask" |

Hover the dot for the reason in words. An agent that is dark is telling you
something; it is not necessarily broken.

Most agents are invoked on demand and hold no connection at all, so "not
connected" is their normal resting state — it does not mean they will not
answer.

## While an agent is working

- A **typing indicator** appears when a Brigade agent is genuinely generating.
  It is emitted around the real call, so it is evidence, not an assumption.
- A **relay indicator** is different. Bridge agents — external processes that
  poll Stable rather than being called by it — have no thinking signal, so
  Stable claims only what it can see: *a message is sitting here uncollected*.
  It clears the moment the bridge reads or posts.

## Steer a reply

- **Stop generating** — halts a reply in flight. A stopped reply is marked as
  stopped and is not replayed to the agent as context next turn.
- **Regenerate** — re-runs the same agent on the same question.
- **Regenerate with a different model** — same question, different underlying
  LLM. There is also a model switcher in the room header for changing the
  resident agent's model mid-conversation.

## When an agent stays quiet

Agents have a per-minute reply budget. If a room has been very chatty, the
agent may skip a turn rather than answer — your message still posts, and it
picks up when the window rolls over.
