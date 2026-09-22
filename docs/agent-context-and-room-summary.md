# Agent context and the rolling room summary

Design: `docs/design/stable-ux-north-star-2026-09-21.md` §4. Lane L4 (2026-09-22).
Code: `server/app/services/context_builder.py`, `server/app/services/context_summary.py`,
`server/app/api/context.py`, the context endpoints in `api/conversation.py` (member) and
`api/gateway.py` (seat mirror), `agent_chat_responder._build_history` (Brigade), and the
seat runner (`~/Projects/stable-agent-runner`, `runner/context.py` + `runner/watcher.py`).

## What an agent walks into

One server-side builder hands any consumer the room stream, oldest first, within a
token budget (chars/4; default 6000, max 32000, `room_members.context_depth` caps the
entry count for that member). Entries: `{id, ts, sender{id,name,kind}, kind, text}` with
`kind` = `message | reply | voice | system`. Replies are inline with their text prefixed
`↳ reply to <author>: `; voice lines are the call transcript rows (`metadata.via=voice`);
placeholders (`…`) and user-stopped partial replies are dropped. Never filtered by join
or mention time.

- `GET /rooms/{id}/context?budget_tokens=&since=&for=` — members only (no guests).
- `GET /gateway/rooms/{room}/context?budget_tokens=&since=` — the seat mirror. Adds
  `seat_participant_id`, `agent_mode`, `context_depth` for the calling seat.
- Brigade agents: the responder's history IS the builder's window (assistant iff the
  sender is the agent; `Name:` attribution only in multi-party windows; voice marked;
  the trigger line verbatim — Brigade's `message` + `history` wire shape is unchanged).
- Runner seats — the cold/warm rule: a turn is **cold** when the (profile, room) has no
  harness session, its last turn is older than 6 h, or more than 40 messages arrived
  since the seat's last posted reply → the mirror's payload goes into the prompt under
  "Room so far"; otherwise **warm** → only the delta since the last reply (what the
  watcher already polled). `agent_mode` is honoured when the gateway payload carries it
  (`listening` = watermark only, `muted` = skip, `when_named` / `answers_all`).

## The rolling summary

`rooms.metadata.context_summary = {text, watermark, watermark_ts, updated_at,
message_count, model}` (JSONB, no migration). The builder prepends `text` when the
watermark precedes the window it returns, or the window was truncated for budget — never
through a history floor. The text is capped (2400 chars) and charged to the budget.

When: every `CONTEXT_SUMMARY_EVERY_MESSAGES` (50) live messages since the watermark,
found by a lifespan worker that polls every `CONTEXT_SUMMARY_POLL_SECONDS` (60) over
rooms active in the last `CONTEXT_SUMMARY_LOOKBACK_DAYS` (30); or on demand,
`POST /rooms/{id}/context/summarize` by the room's owner/admin (200 with the stored
summary; 403 otherwise; 503 naming the missing setting when off/unconfigured; 409 while
another worker holds the room's lease; 502 when the model gateway failed). Never on a
message-send path. A per-room Redis lease (`stable:context_summary:lease:<room>`) keeps
the four uvicorn workers from summarizing one room twice; it fails open.

Where: the LiteLLM gateway, OpenAI-compatible `/chat/completions`. Default lane
`qwen3.6-35b-long-batch` on bigboy's 3090 — room content (customer names included)
stays on our hardware. `<think>` blocks are stripped; the delta is bounded (newest 400
messages, 60k chars); the prompt carries the previous summary plus the delta lines
`[MM-DD HH:MM] Name: text`.

Environment (stable-backend), all read by `app/config.py`; values are never logged
or returned by any route:

| name | default | meaning |
|---|---|---|
| `CONTEXT_SUMMARY_ENABLED` | `false` | master switch; off = worker exits at startup, endpoint 503 |
| `CONTEXT_SUMMARY_BASE_URL` | — | LiteLLM gateway base, e.g. `https://ai.magicunicorn.dev/v1` |
| `CONTEXT_SUMMARY_API_KEY` | — | a scoped LiteLLM virtual key (Vaultwarden; never in compose files in git) |
| `CONTEXT_SUMMARY_MODEL` | `qwen3.6-35b-long-batch` | gateway model name |
| `CONTEXT_SUMMARY_EVERY_MESSAGES` | `50` | threshold since the watermark |
| `CONTEXT_SUMMARY_POLL_SECONDS` | `60` | worker sweep interval |
| `CONTEXT_SUMMARY_LOOKBACK_DAYS` | `30` | only rooms active this recently are swept |
| `CONTEXT_SUMMARY_TIMEOUT_SECONDS` | `180` | one model call |
| `CONTEXT_SUMMARY_MAX_CHARS` | `2400` | stored summary cap |
| `CONTEXT_BUDGET_TOKENS` | `6000` | the Brigade responder's builder budget |

## Live proof on dogfood (after integration; Persephone runs it)

1. Set the summary env on the dogfood `stable-backend` (compose env, key from
   Vaultwarden by name) and restart the backend; the log shows
   `context_summary_worker_started model=qwen3.6-35b-long-batch`. Without the env the
   worker logs `context_summary_worker_idle` and everything else still works.
2. In a channel where Persephone's seat is a member, post 15 messages; message 3 carries
   a distinct fact (e.g. "the venue for E06 is the sunroom"). Then `@persephone what was
   the venue?` — her reply must cite the sunroom. Runner log: `context=no-session` (or
   `stale`) and a `GET /api/v1/gateway/rooms/<room>/context` in the backend access log.
3. Ask again within 6 h → runner log `context=warm`, no context GET.
4. Summary: post past 50 messages (or `POST /rooms/{id}/context/summarize` as owner) →
   backend log `context_summary_written room_id=… messages=… chars=…`;
   `select metadata->'context_summary' from rooms where id=…` is set; the next cold
   context carries `summary`.
5. Listening: `PATCH /rooms/{id}/members/{seat_participant}` `{agent_mode: "listening"}`
   → the seat's next context fetch caches the mode and it stops answering until the mode
   changes. Note: the gateway messages poll does not carry `agent_mode` yet (L2's
   payload), so a seat learns a mode change on its next cold turn or context fetch.
   Post the transcript on task d86845ff.
