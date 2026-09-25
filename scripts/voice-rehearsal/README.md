# Voice rehearsal without a human

Proves a room's multi-agent voice path end to end with a synthetic human: a
LiveKit participant that joins the room from inside `stable-agents` and plays
recorded lines into it. Nothing here needs a microphone, so it can run before
a show, after a deploy, or at 3 a.m.

What one run exercises:

| Line | What it checks |
| --- | --- |
| `01-name-grok` "Grok, in one sentence, what is the point of a rehearsal?" | addressing by name; one utterance becomes one chat line |
| `02-followup` "And why does that matter for a live show?" | an unnamed follow-up inside 30 s sticks to Grok |
| `03-name-zen` "Zen, tell me one thing you would change about tonight's plan." | a new name takes the floor from the last speaker |
| `04-unaddressed` "Does anyone know what time it is right now?" | unaddressed speech goes to the room's co-host only |
| `06-name-shox` "Shox, what is two plus two?" | Whisper hears "shocks"; the cast alias routes it to Shox |
| `05-bargein` "Stop. Hold on, I need to interrupt you for a second." | speaking over an agent cuts it off mid-sentence |

## Run it

1. On a Mac, make the lines once: `scripts/voice-rehearsal/make_lines.sh ~/stable-rehearsal`
   and copy the folder to the Stable host.
2. The probe must look like a human to the relay: its identity is
   `<username>_<participant uuid>` of a real `participants` row. Dogfood keeps one
   for this, `voice-probe` (`67883fc7-2e0b-4b01-8aeb-d3b730ea8f65`), a member of
   `#voice-rehearsal-0924`.
3. On the Stable host:

   ```bash
   PROBE_IDENTITY=voice-probe_67883fc7-2e0b-4b01-8aeb-d3b730ea8f65 \
     scripts/voice-rehearsal/run_rehearsal.sh ~/stable-rehearsal
   ```

   Pass wav names after the folder to play only some lines. `ROOM`, `GAP` and
   `OUT` are environment overrides.

The probe counts as a human joining, so the relay and the cast join the room,
and a room that records `always` starts a recording. That makes the same run
the proof for composite video: read the newest `call_egresses` row in
`evidence.txt` and pull a frame from its MP4.

## Read the evidence

`evidence.txt` holds the room's recordings, every `voice_dispatch` decision
(rule, winner, speaker) and the chat lines the relay persisted. A clean run has
one chat line and one dispatch decision per spoken line, each routed by the rule
in the table above. `relay.log` has the relay's own events, and `stats.log`
samples egress CPU every 5 s.
