---
id: help-agent
title: The help agent
section: Help itself
order: 610
summary: What the in-app help agent can answer, what it refuses, and why it costs nothing.
keywords: help agent, ask, assistant, local model, gpu, cost, free, scope, privacy
---

The **Ask** tab in Help is a small agent that answers questions about **Stable
itself** — this app, its features, and how to do things in it.

## What it will not do

It is scoped, on purpose. Ask it to write your code, summarize your channel, or
answer a general knowledge question and it will tell you that is out of scope
and point you at a real agent instead. Every other agent in Stable is better at
those things than it is.

It also only knows what is written in this help section. If the help section
does not cover something, the agent says so rather than inventing an answer. If
you catch it guessing, that is a bug — and the fix is usually to write the
missing help article.

## What it costs

**Nothing.** It runs on a model hosted on our own hardware, so there is no
per-message charge and nothing metered against you. The `$0` shown under an
answer is the real number, not a placeholder.

If your operator repoints it at a hosted model, the answer footer says so
instead of quoting a price Stable does not actually know.

## Why it is not always listening

The local model serves the whole fleet. The help agent is **on demand only** —
it runs when you ask it a question and not a moment before. It does not sit in
your rooms, it does not read your channels, and it does not have a presence dot,
because it is not a room member.

While it is genuinely working you see a working indicator, and that indicator is
tied to the actual in-flight request — the same rule every other status in
Stable follows. When it is idle it shows nothing, because nothing is happening.

## What it sees

Your question, the recent turns of your conversation with it, and the help
articles most relevant to what you asked. It is not given your messages, your
rooms, or your files.
