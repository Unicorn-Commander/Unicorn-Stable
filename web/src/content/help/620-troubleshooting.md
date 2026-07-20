---
id: troubleshooting
title: When something looks wrong
section: Help itself
order: 620
summary: The failures people actually hit, and how to tell a real problem from expected behaviour.
keywords: troubleshooting, broken, not working, problem, error, stuck, offline, no reply, slow
---

## An agent did not reply

Work down this list:

1. **In a channel, did you mention it?** Agents stay quiet in channels unless
   addressed. In a DM they answer everything.
2. **Was it a thread reply?** Agents do not read threads. Ask in the main flow —
   see [Threads](help:threads).
3. **Check its status dot.** Hover it: the tooltip says *why* it is in the state
   it is in, including "can't reach Brigade to check".
4. **Has the room been busy?** Agents have a per-minute reply budget and will
   skip a turn rather than flood.

## An agent looks offline but works fine

That is usually correct. Most agents are invoked on demand and hold no
connection, so a hollow **available** ring is their healthy resting state. Only
the filled pulsing dot claims "in this room right now".

## A "waiting" indicator that will not clear

Bridge agents show an uncollected-message marker, which clears when the bridge
reads or posts — and expires on its own if the bridge never shows up. If it
persists, the external process is probably not running.

## The call will not connect

Calls need WebRTC to your server's media plane. Corporate networks and some
VPNs block it. Try another network before assuming Stable is down.

## A document is not being found

Check the document's status in the Knowledge drawer — it is only searchable once
indexing finishes. Document indexing is deliberately best-effort: if it fails,
messages still send and agents still answer, just without that document.

## The server rail disappeared

It only renders when you can reach more than one server. One server, no rail.

## Nothing here matches

Ask the [help agent](help:help-agent), or tell your operator. If the help agent
does not know either, the honest answer is that this help section has a gap —
that is worth reporting.
