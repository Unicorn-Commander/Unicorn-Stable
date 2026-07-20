---
id: slash-commands
title: Slash commands
section: Conversations
order: 140
summary: The complete list of commands the composer actually implements.
keywords: slash, command, /me, /research, /council, /facilitate, /poll, /shrug, /agent
---

Type `/` at the start of the composer for an autocomplete menu. `↑` / `↓` pick,
`Enter` accepts.

This is the **complete** list — if it is not here, it is not implemented.

| Command | What it does |
|---|---|
| `/me <action>` | Posts as italic narration |
| `/shrug [message]` | Appends `¯\_(ツ)_/¯` |
| `/tableflip [message]` | Appends `(╯°□°）╯︵ ┻━┻` |
| `/unflip [message]` | Appends `┬─┬ ノ( ゜-゜ノ)` |
| `/agent <id> …` | Explicitly addresses an agent, same as `@agent-id` |
| `/research <question>` | Deep web research with citations, via Center Deep |
| `/facilitate <question>` | An orchestrator picks the best specialist agent and routes to it |
| `/council <question>` | Several models answer independently, then a synthesis |
| `/poll "Question?" a b c` | Posts an inline poll with vote buttons |
| `/help` | Opens the shortcuts cheatsheet |

`/research`, `/facilitate` and `/council` all go out to real agents and take
real time. `/council` in particular fans out to several models.
