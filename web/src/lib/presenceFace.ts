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

export interface PresenceRungInput {
  /** `isTalkingFaceEnabled()` — the master switch. */
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
}

/**
 * Pick the rung. Order is fixed; each guard is a separate line so a failure is
 * attributable to one condition rather than to a boolean soup.
 */
export function selectPresenceRung(input: PresenceRungInput): PresenceRung {
  const faceAllowed =
    input.flagEnabled &&
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
