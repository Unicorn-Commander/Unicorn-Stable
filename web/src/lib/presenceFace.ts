/**
 * Presence-face selection — the pure half of the talking-face feature.
 *
 * Everything here is a total function over plain data so the interesting
 * decisions (which rung renders, which surfaces may spin up a WebGL context,
 * what counts as an agent) can be tested without a DOM, a GPU or a call.
 *
 * The ladder, top rung first:
 *
 *   1. face    — WebGL: a rigged VRM, or the procedural placeholder head
 *   2. portrait— a real picture of the agent (Brigade roster or brand pack)
 *   3. unicorn — the procedural animated SVG bust (UnicornAvatar)
 *   4. avatar  — Avatar's own emoji/initials last resort
 *
 * Rung 4 always renders, which is the point: no branch of this ladder can
 * produce a blank tile.
 */

import { brandAvatarFor } from "@/lib/brandAvatars";
import { hasPuppet } from "@/lib/puppetRig";

export type PresenceRung = "face" | "portrait" | "unicorn" | "avatar";

export type PresenceExpression =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "pleased"
  | "alert"
  | "success"
  | "working"
  | "offline";

export type PresenceSurface = "stage" | "filmstrip" | "chip";

/**
 * Is this LiveKit identity an agent?
 *
 * Deliberately NOT "did the Brigade roster query return a row for it". That
 * query is a react-query fetch that can be empty, slow or failed, and when it
 * is, `CallParticipant.isAgent` is false and Majik would silently stay on the
 * bare 2D path. The `agent-<slug>` identity convention is minted by the agent
 * dispatcher itself and is true the instant the participant appears.
 *
 * "local" is the local human's synthetic id and is never an agent.
 */
export function isAgentIdentity(identity: string | null | undefined): boolean {
  if (!identity) return false;
  if (identity === "local") return false;
  return identity.startsWith("agent-");
}

/** "agent-majik" → "majik". Idempotent for ids that never had the prefix. */
export function agentSlugFromIdentity(
  identity: string | null | undefined,
): string {
  return (identity ?? "").replace(/^agent-/, "");
}

/** The identity a call tile should draw art for. */
export interface CallTilePersona {
  /** Art/catalog slug ("majik") — feeds the puppet/portrait/VRM lookups. */
  slug: string;
  /** Display name for the face's alt text and initials fallback. */
  name: string;
}

/**
 * Resolve WHICH CHARACTER an agent tile shows.
 *
 * The bug this fixes (Aaron's "2D unicorn avatar that wasn't based on ours"):
 * the LiveKit worker joins with a TYPE-shaped identity — verified on dogfood
 * as `stable-brigade`, and `agent-<agent_type>` per the registry's job accept
 * — NOT a persona-shaped one like `agent-majik`. Keying the art off that
 * identity resolves no puppet, no portrait, no roster row, so Majik rendered
 * as the generic procedural UnicornAvatar in every call while his branded
 * puppet sat unused in `/agent-puppets/majik.webp`.
 *
 * Order:
 *   1. The tile's own identity/name, when it actually resolves art — a
 *      persona-shaped identity ("agent-majik") keeps working, and a future
 *      multi-agent call where each worker has its own persona identity is
 *      attributed correctly.
 *   2. The ROOM's resident `brigade_agent_id` (server room metadata, already
 *      on the web Room model) — the same source the server uses to dispatch
 *      the worker, so it names the persona the worker is speaking as.
 *   3. The tile's own identity/name unchanged (no art anywhere → the
 *      procedural rungs, exactly as before).
 */
export function resolveCallTilePersona(
  identity: string | null | undefined,
  displayName: string | null | undefined,
  roomBrigadeAgentId?: string | null,
): CallTilePersona {
  const ownSlug = agentSlugFromIdentity(identity);
  const ownName = displayName || ownSlug;
  if (brandAvatarFor(ownSlug) || brandAvatarFor(displayName ?? null)) {
    return { slug: ownSlug, name: ownName };
  }
  if (roomBrigadeAgentId && brandAvatarFor(roomBrigadeAgentId)) {
    return {
      slug: roomBrigadeAgentId,
      // Canonical display derivation, mirroring the server
      // (agent_chat_responder: id.replace("-", " ").title()).
      name: roomBrigadeAgentId
        .split("-")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    };
  }
  return { slug: ownSlug, name: ownName };
}

/**
 * Does this (slug, name) have an AUTHORED talking puppet? Re-exported through
 * the presence module so callers deciding a RUNG don't import the rig table
 * directly. This is what lets the branded 2D puppet reach the face rung
 * without the experimental talking-face flag.
 */
export function puppetAvailableFor(
  slug: string | null | undefined,
  name: string | null | undefined,
): boolean {
  return hasPuppet(slug, name);
}

/**
 * May this tile mount WebGL?
 *
 * Gate on the tile's ROLE, never on its pixel size. Large tiles pass Avatar 96
 * and normal/filmstrip/grid tiles pass 64, so a `size >= 64` test would mount a
 * WebGL context on every tile in the filmstrip — a dozen contexts on a phone,
 * which is how you get a black grid and a dead battery. Stage-class surfaces
 * only: the spotlight/focus tile, a stage fill layout, or a pop-out window
 * (which builds its tile with `size: "large"`).
 */
export function isVrmSurfaceEligible(opts: {
  size?: "normal" | "large";
  fill?: boolean;
  inPopout?: boolean;
}): boolean {
  return opts.size === "large" || !!opts.fill || !!opts.inPopout;
}

/**
 * Smallest CSS box we will put a 3D face in. A stage tile that has collapsed to
 * nothing (mid-layout, a 0-height flex parent) must not get a renderer — the
 * safety net for "eligible by role, broken by layout".
 */
export const MIN_FACE_BOX_PX = 80;

/**
 * How many AGENT face contexts one call surface may mount at once.
 *
 * Why this exists (Aaron, 2026-08-09: "in video it was just the static avatar
 * image"): `isVrmSurfaceEligible` gates by ROLE, and only the Speaker/
 * Spotlight big tile (size "large" / fill) has the role — so in GALLERY, the
 * view every "show video" path actually lands on (mobile Video forces grid;
 * the camera nudge and the ViewModeSwitcher lift to grid), no agent tile was
 * ever face-eligible and the branded puppet never mounted. The role gate
 * exists to stop UNBOUNDED WebGL contexts (a dozen filmstrip tiles on a
 * phone); a BUDGET achieves the same protection while letting the one agent
 * in a 1:1 Majik call talk in Gallery. Humans never mount WebGL regardless,
 * so the budget counts AGENT tiles only. Tiles that are eligible but
 * physically small are still refused by MIN_FACE_BOX_PX before any context
 * is created.
 */
export const MAX_AGENT_FACE_CONTEXTS = 3;

/** May EVERY agent tile on this surface take the face rung? */
export function withinAgentFaceBudget(agentTileCount: number): boolean {
  return agentTileCount > 0 && agentTileCount <= MAX_AGENT_FACE_CONTEXTS;
}

export interface PresenceRungInput {
  /** `isTalkingFaceEnabled()` — the switch for the EXPERIMENTAL faces. */
  flagEnabled: boolean;
  /** Which call surface this is. Only "stage" may reach the face rung. */
  surface: PresenceSurface;
  /** Does this client have a usable WebGL context? */
  webglOk: boolean;
  /** The tile has not (yet) failed to build a face. */
  faceHealthy: boolean;
  /** Resolved portrait URL, or null. */
  portraitSrc: string | null;
  /**
   * A VRM asset for this agent, if one is configured. **null is expected** in
   * phase 1: no brand VRM exists yet, and the face rung then renders the
   * procedural placeholder head rather than nothing.
   */
  vrmSrc: string | null;
  /**
   * An AUTHORED branded 2D puppet exists for this agent (puppetRig.ts).
   * A puppet is SHIPPED PRODUCT, not an experiment: it reaches the face rung
   * with the flag OFF, and it is the preferred face when it exists — the
   * generic VRM/procedural heads are for agents we have not drawn yet. The
   * flag keeps gating exactly those generic/experimental faces.
   */
  puppetAvailable?: boolean;
}

/**
 * Pick the rung. Order is fixed; each guard is a separate line so a failure is
 * attributable to one condition rather than to a boolean soup.
 */
export function selectPresenceRung(input: PresenceRungInput): PresenceRung {
  const faceAllowed =
    (input.flagEnabled || !!input.puppetAvailable) &&
    input.surface === "stage" &&
    input.webglOk &&
    input.faceHealthy;
  if (faceAllowed) return "face";
  if (input.portraitSrc) return "portrait";
  return "unicorn";
}

/**
 * The 2D-only ladder, for when the face rung is unavailable or has failed.
 * Split out so a caller that already knows it is not rendering WebGL (chip,
 * filmstrip) does not have to construct the full input.
 */
export function selectFallbackRung(
  portraitSrc: string | null,
): Exclude<PresenceRung, "face"> {
  return portraitSrc ? "portrait" : "unicorn";
}

/** LiveKit's `lk.agent.state` (plus local hints) → our expression vocabulary. */
export function mapAgentState(
  agentState: string | null | undefined,
  opts?: { isSpeaking?: boolean; isOffline?: boolean },
): PresenceExpression {
  if (opts?.isOffline) return "offline";
  switch (agentState) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "initializing":
      return "working";
    default:
      return opts?.isSpeaking ? "speaking" : "idle";
  }
}

/** The UnicornAvatar state that matches an expression (rung 3 animation). */
export function unicornStateFor(
  expression: PresenceExpression,
): "idle" | "talking" | "working" | "offline" {
  switch (expression) {
    case "speaking":
      return "talking";
    case "thinking":
    case "working":
      return "working";
    case "offline":
      return "offline";
    default:
      return "idle";
  }
}
