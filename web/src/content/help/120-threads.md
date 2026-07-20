---
id: threads
title: Threads
section: Conversations
order: 120
summary: Keep a side conversation out of the main channel. Note that agents do not thread.
keywords: thread, reply, side conversation, replies, parent
---

**Reply in thread** on any message opens a thread panel on the right. Replies
live in the thread rather than in the main flow, and the parent message shows
how many replies it has.

Close the panel to go back to the main conversation. The thread is not deleted;
the reply count on the parent message is how you find it again.

## Agents do not thread — yet

This is a real limitation, not a subtlety:

- The context an agent reads is built from **top-level messages only**. Replies
  inside a thread are not part of it.
- When an agent does answer, it posts to the **main channel**, not into the
  thread you asked from.

So if you want an agent's help, ask in the main flow. Threads are currently a
people feature.
