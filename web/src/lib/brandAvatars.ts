/**
 * Portrait artwork for agents, shipped same-origin with the web bundle.
 *
 * Brand-Ops is the identity factory and Brigade is the runtime registry, but
 * both serve their images from behind SSO / a different origin, so neither can
 * be hotlinked from an `<img>` and neither can be uploaded into a WebGL
 * texture. These are our own copies.
 *
 * ── Three tiers, and the differences matter ────────────────────────────────
 * RIGGED PORTRAITS come from `puppetRig.ts` and are the same files the 2D
 * puppet animates. Deriving them from that table rather than listing them
 * again is deliberate: two hand-maintained lists of the same artwork is how a
 * face ends up animated in a call and stale in the roster.
 *
 * FLAT PORTRAITS (`PORTRAITS` below) are the same locked recipe and the same
 * quality — chibi unicorn bust, thick black outlines, white sticker border,
 * dark navy ground — but no rig has been calibrated for them yet, so they are
 * deliberately NOT in `PUPPETS`. That split is the whole point of the two
 * tables: `puppetRig.ts` answers "what can we animate", this file answers
 * "what picture of this agent exists". Registering un-calibrated art as a
 * puppet is how you punch a mouth cavity through a character's chin (see the
 * openDepth note in puppetRig.ts) — a wrong rig looks worse than none, while a
 * flat portrait is correct everywhere it renders. Calibrating one (`npm run
 * puppet:calibrate`) and moving its row into PUPPETS is a promotion, which is
 * why the files already live under `public/agent-puppets/`.
 *
 * EMBLEMS are neon logo marks — a crest, a line-art robot, a quill and a book
 * with no face on it. They are kept because they are the only art these agents
 * have and a crest beats an initial, but they can never be puppeted. Each one
 * passed Brand-Ops' compliance gate at 100/100, because that gate scores
 * COLOUR, not subject: it cannot tell a portrait from a logo. Replacing these
 * with real portraits is the remaining art task.
 */
import { PUPPETS, normalizeAgentKey, puppetForAgent } from "@/lib/puppetRig";

/**
 * Character art with no calibrated rig yet — flat portrait only. Keyed by
 * normalized Brigade agent id.
 *
 * Generated 2026-08-12 through Brand-Ops' compliance-checked agent-identity
 * pipeline (brand `magic-unicorn`, one master per slug, colour-palette
 * compliance pass — 35 at 100/100, `settlement-modeler` at 97/100), then
 * re-encoded to 512² WebP without semantic edits. Before this, 36 of Brigade's
 * 55 roster agents had no portrait that resolved anywhere: their `avatar_url`
 * rows point at `/avatars/<slug>-v2.png` files that were never generated and
 * return 404, so every one of them fell through to a generic head.
 */
export const PORTRAITS: Record<string, string> = {
  // Legal — the drafter family (Perry's team).
  "brief-drafter": "/agent-puppets/brief-drafter.webp",
  "complaint-drafter": "/agent-puppets/complaint-drafter.webp",
  "motion-drafter": "/agent-puppets/motion-drafter.webp",
  "discovery-drafter": "/agent-puppets/discovery-drafter.webp",
  "demand-letter-drafter": "/agent-puppets/demand-letter-drafter.webp",
  "foia-drafter": "/agent-puppets/foia-drafter.webp",
  "deposition-prep": "/agent-puppets/deposition-prep.webp",
  "cross-exam-builder": "/agent-puppets/cross-exam-builder.webp",
  "devils-advocate": "/agent-puppets/devils-advocate.webp",
  "legal-theory-evaluator": "/agent-puppets/legal-theory-evaluator.webp",
  "gap-analyzer": "/agent-puppets/gap-analyzer.webp",
  "damages-modeler": "/agent-puppets/damages-modeler.webp",
  "settlement-modeler": "/agent-puppets/settlement-modeler.webp",
  "evidence-correlator": "/agent-puppets/evidence-correlator.webp",
  "timeline-builder": "/agent-puppets/timeline-builder.webp",
  "media-strategist": "/agent-puppets/media-strategist.webp",
  "intake-bootstrapper": "/agent-puppets/intake-bootstrapper.webp",
  "intake-appender": "/agent-puppets/intake-appender.webp",
  // Ops, infra and watchers.
  "deadline-sentinel": "/agent-puppets/deadline-sentinel.webp",
  "gateway-health": "/agent-puppets/gateway-health.webp",
  "zpool-health": "/agent-puppets/zpool-health.webp",
  "cwo-lightsout": "/agent-puppets/cwo-lightsout.webp",
  "the-fixer": "/agent-puppets/the-fixer.webp",
  "the-colonel": "/agent-puppets/the-colonel.webp",
  companion: "/agent-puppets/companion.webp",
  "project-ops-assistant": "/agent-puppets/project-ops-assistant.webp",
  "project-ops-report-writer": "/agent-puppets/project-ops-report-writer.webp",
  librarian: "/agent-puppets/librarian.webp",
  gflow: "/agent-puppets/gflow.webp",
  "majiks-mobile-dev": "/agent-puppets/majiks-mobile-dev.webp",
  "deploy2-smoke": "/agent-puppets/deploy2-smoke.webp",
  "dr-glitter-mane": "/agent-puppets/dr-glitter-mane.webp",
  "dj-majik-mane": "/agent-puppets/dj-majik-mane.webp",
  // Build In Public crew — EXTERNAL vendor models. The 2026-09-02 puppet set
  // draws these as the vendor's official mark on a neutral field with a grey
  // frame (rook-bin/puppet/build-tiles.py), deliberately not as a face: a
  // logo has no mouth, so they live here and not in PUPPETS.
  codex: "/agent-puppets/codex.webp",
  grok: "/agent-puppets/grok.webp",
  chatgpt: "/agent-puppets/chatgpt.webp",
  gemini: "/agent-puppets/gemini.webp",
  deepseek: "/agent-puppets/deepseek.webp",
  qwen: "/agent-puppets/qwen.webp",
  // Harmony's routing variants. Separate identities in Brigade and Brand-Ops,
  // so each carries its own master rather than an alias onto `harmony` — the
  // avatars PROVENANCE manifest forbids binding an id to art it does not own.
  "harmony-local": "/agent-puppets/harmony-local.webp",
  "harmony-local-tuned": "/agent-puppets/harmony-local-tuned.webp",
  "harmony-r2-control": "/agent-puppets/harmony-r2-control.webp",
};

/** Logo marks. Not characters — see the header. */
export const EMBLEMS: Record<string, string> = {
  iris: "/agent-avatars/iris.png",
  "sgt-quill": "/agent-avatars/sgt-quill.png",
};

/**
 * The on-brand avatar URL for an agent display name or id, or null → fall back
 * to the animated UnicornAvatar. Accepts room titles like "Chat with Majik".
 */
export function brandAvatarFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const portrait = puppetForAgent(name, name);
  if (portrait) return portrait.texture;
  const key = normalizeAgentKey(name);
  return PORTRAITS[key] ?? EMBLEMS[key] ?? null;
}

/** How many agents have real character art, for the debug HUD's honesty line.
 *  Both portrait tiers count — the rig is what PUPPETS adds, not the face. */
export function characterPortraitCount(): number {
  return Object.keys(PUPPETS).length + Object.keys(PORTRAITS).length;
}
