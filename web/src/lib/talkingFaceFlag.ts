/**
 * Talking-face feature flag (design: docs/designs/talking-face-vrm-avatars.md).
 *
 * DEFAULT OFF, deliberately. `isNavV1Enabled` uses the same priority order but
 * defaults ON; do not copy that default here. Nothing about a call tile may
 * change for a user who has not opted in — the flag gates the WHOLE
 * AgentPresenceFace swap, not just the WebGL rung, so "off" is byte-identical
 * to the render path that shipped before this feature existed.
 *
 * Priority (first hit wins):
 *   1. localStorage `stable.talkingFace.v1`   — "1"/"true" on, "0"/"false" off
 *   2. `?talkingFace=1` in the URL            — also persisted to (1) so a
 *                                               shared link sticks across the
 *                                               reloads a call flow does
 *   3. `import.meta.env.VITE_TALKING_FACE_V1` — build-time default per deploy
 *   4. false
 *
 * The value is read ONCE per document and cached. Two reasons: every agent tile
 * would otherwise hit localStorage on every render, and a flag that flips
 * mid-session would tear down a live WebGL context under a call. Flipping it
 * takes a reload, which is how the nav-v1 flag already behaves.
 */

export const TALKING_FACE_FLAG_KEY = "stable.talkingFace.v1";
/** Rolling-fps + rung HUD on the tile. Separate switch; also default off. */
export const TALKING_FACE_DEBUG_KEY = "stable.talkingFace.debug";

function readSwitch(key: string, urlParam: string, envValue: unknown): boolean {
  if (typeof window !== "undefined") {
    // URL first so a link can TURN IT ON, but a stored "0" still wins for the
    // rest of the session — an explicit opt-out is not overridden by a stale
    // link someone pasted in chat.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      /* private mode / blocked storage — fall through to URL, then env */
    }
    if (stored === "0" || stored === "false") return false;
    if (stored === "1" || stored === "true") return true;

    try {
      const q = new URLSearchParams(window.location.search).get(urlParam);
      if (q === "1" || q === "true") {
        try {
          localStorage.setItem(key, "1");
        } catch {
          /* fine — it just won't survive the next navigation */
        }
        return true;
      }
      if (q === "0" || q === "false") {
        try {
          localStorage.setItem(key, "0");
        } catch {
          /* as above */
        }
        return false;
      }
    } catch {
      /* malformed query string — fall through to env */
    }
  }
  return envValue === "1" || envValue === "true";
}

let enabledCache: boolean | null = null;
let debugCache: boolean | null = null;

/** Is the talking-face path on for this document? Default **false**. */
export function isTalkingFaceEnabled(): boolean {
  if (enabledCache === null) {
    enabledCache = readSwitch(
      TALKING_FACE_FLAG_KEY,
      "talkingFace",
      import.meta.env.VITE_TALKING_FACE_V1,
    );
    if (enabledCache) {
      // Observability: one line per session, so a "why is my tile 3D" report
      // has an answer in the console rather than in someone's memory.
      console.info(
        "[talking-face] enabled (stable.talkingFace.v1). Set it to \"0\" and reload to turn it off.",
      );
    }
  }
  return enabledCache;
}

/** Debug HUD (fps + which rung is rendering). Default **false**. */
export function isTalkingFaceDebugEnabled(): boolean {
  if (debugCache === null) {
    debugCache = readSwitch(
      TALKING_FACE_DEBUG_KEY,
      "talkingFaceDebug",
      import.meta.env.VITE_TALKING_FACE_DEBUG,
    );
  }
  return debugCache;
}

/** Tests only — the caches above are per-document and never cleared at runtime. */
export function __resetTalkingFaceFlagCache(): void {
  enabledCache = null;
  debugCache = null;
}
