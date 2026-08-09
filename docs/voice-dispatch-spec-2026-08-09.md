# Voice dispatch — multi-agent call addressing (spec handoff, 2026-08-08/09)

Deferred work, captured from Aaron's side-conversation handoff. Four PO tasks
on P-00115 reference this doc; each is a fresh lane session. Do not implement
piecemeal — task 2 is the architectural core.

## 1. Always-on wake word for Stable
Nothing always-on exists today; voice is in-call via LiveKit. Four tiers
assessed: (a) browser-tab WASM wake word (openWakeWord/Porcupine web SDK —
days of effort, tab must stay open, dies on phone lock); (b) desktop tray app
via Tauri/Electron (the realistic true always-on, 1–2 weeks); (c) native
mobile (Android possible with foreground service; iOS effectively impossible —
no persistent background mic for third parties; mostly not worth it since
mobile push now covers reachability); (d) satellite hardware — the uc-1 voice
hub / one-hot-mic doctrine pattern, best always-on per dollar, ears local +
server brain. Decision: no action now; tier (a) as a quick feature someday;
tier (d) is the right ambient architecture.

## 2. The core problem: multi-agent call addressing
Distinct Kokoro voices solve who is *speaking*; nothing solves who is being
*spoken to*. Independent per-agent "should I respond?" decisions
mathematically produce pile-ons. Fix is architectural: ONE server-side
dispatcher decides who (if anyone) responds; agents speak only when
dispatched. Four layers:
- **Name addressing** ("Corporal Qwen, …" routes to Qwen).
- **Sticky turn-taking** (unnamed follow-ups stay with last-addressed until
  re-address / timeout / topic shift).
- **Floor mutex** (exactly one agent may hold the speaking floor — one-hot
  voice, mirrors the one-hot-mic doctrine).
- **The "addressed to NOBODY" class** (Aaron and Shafen talking to each
  other → all agents silent). Critical.
Agents never respond to agent speech unless explicitly invited. Validated
scenario: Aaron + Shafen + Corporal Qwen + Majik/DJ Majik Mane in a call —
humans converse freely, the right agent answers when addressed, stickiness
releases when humans resume.

## 3. Model sizing
The LLM only handles the ambiguous residue (unnamed domain-routed utterances,
human-vs-agent-directed calls) — names and stickiness are rules/state-machine.
Qwen 0.6B-class is sufficient WITH constrained decoding (output = one agent-id
or "nobody", single token / strict JSON, roster + last turns + last-addressed
in prompt, cacheable prefix). Low confidence → "nobody" → silence (safe
failure; the mutex caps the bad case regardless). A fine-tuned 100–300M
encoder classifier (BERT/DeBERTa) would beat prompted-0.6B but needs labeled
data. Escalate rare pragmatics cases to 4–8B; don't upgrade the whole path.

## 4. Placement: server, definitively
Single authority (browser-side would recreate the pile-on one layer up);
transcripts are already server-side post-STT; ~200–300 ms feel budget;
tens-of-ms on a 3090 sliver, <100 ms on 780M-class iGPU with prefix caching.
Wake word is the only endpoint-side piece (few-MB keyword spotting, NOT an
LLM; XDNA1 NPU is a natural fit — Home-Ops may have done openWakeWord on NPU,
unverified, check before assuming). Real capacity cost is streaming STT per
call, not dispatch. Dispatch runs in its own tiny isolated instance (~1 GB) so
big-lane OOMs can't wedge it.

## 5. HA / fallback design
Make the *service* highly available, not the model: local model → peer model
(Shafen's uc-1, tailnet RTT acceptable) → optional cloud → **rules-only mode**
(name-matching floor, 100% uptime, free — worst case is "address agents by
name"). Stateless classify() service — sticky/floor state lives with the call
session in Stable's backend; roster passed per call (clean multi-tenancy on
unicorncommander.ai via the existing gateway alias-pool pattern). Hard
per-tier timeouts (~150 ms local / ~300 ms peer → rules). Cloud tier
default-OFF for customer orgs (governance: customer utterances leaving the
boundary), per-org opt-in; may not be worth its disclosure surface at all.
Tag every logged decision with the deciding tier.

## 6. Synthetic training pipeline
Scenario-FIRST generation (label baked into the construction, not judged
after): Qwen generates call snippets per scenario class (implicit domain
routing, human-to-human, sticky follow-ups, "nobody"), 3× generation +
unanimity for genuinely ambiguous ones. Must look like STT output (lowercase,
fillers, misrecognitions) and vary rosters (names/counts/domains) to force
description-matching over memorization. 10–20k examples ≈ 4–8 M tokens ≈ one
overnight batched vLLM run on the 3090 (respect borrow-and-restore + no
overlap with serving lanes/catalogue sprints). Training: 10–30 min for a base
encoder, ~1 h for large or LoRA on 0.6B. **Eval set must be real logged
decisions only** (including re-address corrections) — never synthetic holdout.
Flywheel: ship prompted-0.6B first → log → distill.

## 7. Prior art (why this is buildable)
Open Interpreter's 01 sidestepped it (single assistant, push-to-talk; its
contribution = cheap-satellite-ears + server-brain, hardware discontinued).
Solved components: Amazon device-directed-speech detection / Follow-Up Mode
(= the "nobody" class, small classifier, production scale); Google Continued
Conversation (stickiness); Alexa device arbitration (= floor mutex); OpenAI
Swarm/Agents-SDK handoff (= dispatcher in text); LiveKit Agents has semantic
end-of-turn (when to speak, NOT who — frameworks assume one agent/session).
The multi-persona composition is the greenfield part; we can do it because we
own every layer (STT, lanes, LiveKit, client), our accuracy bar is "feels
right + 1-second recovery gesture," and v1 needs no research breakthrough.
It's a differentiating Stable feature.

## 8. Proactive interjection + raise-hand
Stable's call UI has NO raise-hand function today (confirmed gap). Polite v1:
the dispatcher runs a second high-threshold question ("high-value input?"),
budgeted (~1 per N minutes), surfacing as a visual raise-hand the human
acknowledges to grant the floor — NOT audio barge-in (explicitly out of
scope; a later tuning knob).

## Task map (P-00115)
1. Audit `feat/agents-voice-dispatch` branch (LOW, do first — unknown state,
   precursor to the lane).
2. Voice dispatch v1 — rules only (HIGH): server-side post-STT dispatcher —
   name routing, sticky turn-taking, "nobody" class, floor mutex,
   agents-ignore-agents default, and log every dispatch decision (feeds
   task 3's eval + training).
3. Dispatch classifier + tiered fallback (MEDIUM, depends on 2): synthetic
   pipeline per §6, small model per §3, tier chain per §5.
4. Raise-hand UI + gated proactive interjection (MEDIUM, depends on 2):
   per §8; barge-in out of scope.
