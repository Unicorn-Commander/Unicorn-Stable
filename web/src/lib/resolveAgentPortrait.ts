/**
 * The portrait rung of the presence-face ladder.
 *
 * Call tiles today pass `agent?.avatar_url` straight into `Avatar` and never
 * consult the brand pack, so an agent whose portrait only exists in
 * `brandAvatars.ts` renders as initials in a call while rendering as art
 * everywhere else. This is the one place that unifies the two:
 *
 *   roster/Brigade avatar_url (host-allowlisted)  →  brand pack  →  null
 *
 * Returning null is a real answer, not a failure: it means "no photograph of
 * this agent exists", and the caller drops to the procedural UnicornAvatar,
 * which always renders something.
 */
import { toAvatarSrc } from "@/lib/avatar";
import { brandAvatarFor } from "@/lib/brandAvatars";

export function resolveAgentPortrait(
  agentId: string | null | undefined,
  name: string | null | undefined,
  avatarUrl: string | null | undefined,
): string | null {
  // BUNDLED ART FIRST. Brigade's roster bindings dangle en masse (~38 of 54
  // claimed files 404 as of 2026-08-07), and a dangling-but-allowlisted URL
  // used to win this rung and then die in <img onError> as initials — the
  // guaranteed puppet never got a look. Bundle art is same-origin, versioned
  // with the app, and can't 404 (short of a broken build), so when we HAVE a
  // character, use it; the roster URL is the tier for agents we don't ship.
  const fromBrand = brandAvatarFor(name) ?? brandAvatarFor(agentId);
  if (fromBrand) return fromBrand;
  // toAvatarSrc applies the host allowlist and resolves a relative path against
  // the ACTIVE federated instance's API origin, which is where Brigade portraits
  // are served from. Returns null for anything unsafe.
  return toAvatarSrc(avatarUrl);
}
