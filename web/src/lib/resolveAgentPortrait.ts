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
  // toAvatarSrc applies the host allowlist and resolves a relative path against
  // the ACTIVE federated instance's API origin, which is where Brigade portraits
  // are served from. Returns null for anything unsafe.
  const fromRoster = toAvatarSrc(avatarUrl);
  if (fromRoster) return fromRoster;
  // brandAvatarFor hands back same-origin bundle paths ("/agent-avatars/x.png"),
  // which must NOT go through toAvatarSrc — that would retarget them at the API
  // origin, where they do not exist.
  return brandAvatarFor(name) ?? brandAvatarFor(agentId) ?? null;
}
