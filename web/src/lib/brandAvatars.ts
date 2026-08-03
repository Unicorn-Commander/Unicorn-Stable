/**
 * Portrait artwork for agents, shipped same-origin with the web bundle.
 *
 * Brand-Ops is the identity factory and Brigade is the runtime registry, but
 * both serve their images from behind SSO / a different origin, so neither can
 * be hotlinked from an `<img>` and neither can be uploaded into a WebGL
 * texture. These are our own copies.
 *
 * ── Two tiers, and the difference matters ──────────────────────────────────
 * CHARACTER PORTRAITS come from `puppetRig.ts` and are the same files the 2D
 * puppet animates. Deriving them from that table rather than listing them
 * again is deliberate: two hand-maintained lists of the same artwork is how a
 * face ends up animated in a call and stale in the roster.
 *
 * EMBLEMS are neon logo marks — a crest, a line-art robot, a quill and a book
 * with no face on it. They are kept because they are the only art these agents
 * have and a crest beats an initial, but they can never be puppeted. Each one
 * passed Brand-Ops' compliance gate at 100/100, because that gate scores
 * COLOUR, not subject: it cannot tell a portrait from a logo. Replacing these
 * with real portraits is the remaining art task.
 */
import { PUPPETS, normalizeAgentKey, puppetForAgent } from "@/lib/puppetRig";

/** Logo marks. Not characters — see the header. */
const EMBLEMS: Record<string, string> = {
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
  return EMBLEMS[normalizeAgentKey(name)] ?? null;
}

/** How many agents have real character art, for the debug HUD's honesty line. */
export function characterPortraitCount(): number {
  return Object.keys(PUPPETS).length;
}
