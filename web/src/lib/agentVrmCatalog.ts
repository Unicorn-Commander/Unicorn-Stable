/**
 * Which agents have a rigged 3D head, and where it lives.
 *
 * ⚠️ THE PACK IS EMPTY, AND THAT IS THE HONEST STATE OF THE ART PIPELINE.
 * No brand VRM has been authored yet — not for Majik, not for anyone. Until one
 * lands, `resolveAgentVrmUrl` returns null for every agent and the face rung
 * renders the PROCEDURAL PLACEHOLDER head (see proceduralUnicornHead.ts), which
 * is a generic unicorn in the agent's identity hue and is not, and does not
 * claim to be, any of our characters.
 *
 * Adding the first real skin is a one-line change here plus the asset in
 * `web/public/agent-vrm/`:
 *
 *   const PACK = { majik: "/agent-vrm/majik-v1.vrm" };
 *
 * Brigade's `avatar_vrm_url` wins over this pack when the field exists (PR7),
 * but the pack is LONG-LIVED, not a dogfood crutch: it is what keeps skins
 * shippable while a server-side schema change is in flight.
 */
import { isTalkingFaceEnabled } from "@/lib/talkingFaceFlag";
import { resolveVrmSrc } from "@/lib/resolveVrmSrc";

const PACK: Record<string, string> = {
  // Intentionally empty. See the header — do not add a placeholder here to make
  // a demo look further along than it is.
};

/** Normalize an id or display name to a pack key ("Chat with Majik" → majik). */
export function catalogKey(
  agentId?: string | null,
  name?: string | null,
): string {
  const fromId = (agentId ?? "")
    .toLowerCase()
    .replace(/^agent[-_\s]+/, "")
    .trim();
  if (fromId && PACK[fromId]) return fromId;
  const fromName = (name ?? "")
    .toLowerCase()
    .replace(/^chat with\s+/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (fromName && PACK[fromName]) return fromName;
  return fromId || (fromName.split(/\s+/)[0] ?? "");
}

/**
 * A model URL for this agent, or null. Null is the normal answer today; the
 * caller must treat it as "render the placeholder head", not as an error.
 */
export function resolveAgentVrmUrl(
  agentId?: string | null,
  name?: string | null,
  serverVrmUrl?: string | null,
): string | null {
  if (!isTalkingFaceEnabled()) return null;
  if (serverVrmUrl) return resolveVrmSrc(serverVrmUrl);
  const path = PACK[catalogKey(agentId, name)];
  return path ? resolveVrmSrc(path) : null;
}

/** Does ANY agent have a real model yet? Used by the debug HUD's honesty line. */
export function hasAnyVrmSkin(): boolean {
  return Object.keys(PACK).length > 0;
}
