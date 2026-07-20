---
id: servers
title: Move between servers
section: Getting started
order: 20
summary: The far-left rail lists every Stable server you can reach, and shows which ones have unread messages.
keywords: rail, federation, instance, switch server, add server, hide rail, logo, directory
---

Stable is federated: one client, many servers. The **server rail** on the far
left is how you move between them.

> The rail only appears when you can reach **more than one** server. On a
> single-server setup it renders nothing at all — that is correct, not broken.

## Switch server

Click a server's icon in the rail. Everything retargets at once — rooms,
messages, uploads, knowledge — so you are never looking at one server's sidebar
next to another server's messages.

Each icon shows that server's own logo, set by that server's admin. Unread
activity on a server you are *not* currently in shows on its icon.

## Find a server by name

Open the **server switcher** (the search control in the rail). It lists every
reachable server with its full description, and is the only place descriptions
are readable without a mouse.

The room quick switcher (`Cmd/Ctrl K`) also lists servers, and carries a
**Browse servers** row that opens the same directory. There is deliberately no
second keyboard shortcut for the rail — one palette, one chord.

## Add a server

**+** in the rail. You give it an origin (for example
`https://stable.example.com`); Stable verifies it can sign you in and read your
rooms there before adding it.

## Hide the rail

The collapse toggle hides the rail and leaves a real reveal **button** behind —
not a hover target — so it works on a touch screen.
