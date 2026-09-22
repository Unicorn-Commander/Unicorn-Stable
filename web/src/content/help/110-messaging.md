---
id: messaging
title: Send, format and edit messages
section: Conversations
order: 110
summary: Markdown, attachments, editing, reactions, quote replies and code blocks.
keywords: markdown, bold, italic, code, edit, delete, react, emoji, attach, upload, drag, draft, quote
---

## Send

`Enter` sends. `Shift Enter` adds a newline.

An unsent draft is kept per room, so switching away and back does not lose what
you were typing.

## Format

The composer understands Markdown:

| You type | You get |
|---|---|
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `~~strike~~` | ~~strike~~ |
| `` `code` `` | inline code |
| ```` ```lang ```` … ```` ``` ```` | a fenced code block with syntax highlighting |
| `> quote` | blockquote |
| `- item` / `1. item` | bullet / numbered list |
| `# ` / `## ` / `### ` | headings |

Fenced code blocks get a language label and a **Copy** button.

## Mention people and agents

Type `@` and keep typing to filter. `↑` / `↓` move through the suggestions,
`Enter` picks one.

- `@username` — notify a person
- `@agent-id` — address an agent (see [Working with agents](help:agents))
- `@channel` — notify everyone in the channel
- `@here` — notify only the members who are online

## Emoji

Type `:` followed by a name for inline emoji suggestions, or use the emoji
picker.

## Attach a file

Drag a file onto the conversation, or use the attach control. Uploads show a
progress bar and can be cancelled mid-flight. Images render inline and open in
a viewer when clicked.

If the file is a document, it may also be indexed so agents in the room can
answer questions about it — see [Knowledge and documents](help:knowledge).

## Act on a message

Hover a message (or focus it) for its actions:

- **Replies** — see [Threads](help:threads)
- **Quote reply** — pulls the text into your composer as a quote
- **Add reaction**
- **Save** — files it in your personal saved list
- **Pin / unpin** — pins it for the whole room
- **Promote to Project Ops task** — see [Turn a message into a task](help:project-ops)
- **Edit** / **Delete** — your own messages only

`Cmd/Ctrl ↑` in an empty composer jumps straight to editing your last message.
