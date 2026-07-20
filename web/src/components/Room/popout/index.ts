/**
 * Room/popout — pop-out & Picture-in-Picture module for the Stable call surface.
 *
 * Public API (see CONTRACT.md for exact signatures + integration notes):
 *
 *   Native Picture-in-Picture (single <video>, element stays in the main doc)
 *     • usePipTile(opts?)        → per-tile controller { videoRef, isActive,
 *                                    supported, enter, exit, toggle }
 *     • usePipManager()          → { isSupported, activePipId, requestPip, exitPip }
 *     • pipManager               → the same surface, imperative / non-React
 *     • mergeVideoRefs(...refs)  → compose the LiveKit attach ref + pip.videoRef
 *     • useMergedVideoRef(...)   → mergeVideoRefs with the required memoization
 *
 *   Detached window (real second window; tiles rendered via a React portal)
 *     • openCallPopout(opts?)    → imperative CallPopoutHandle | null
 *     • CallPopoutHost           → portals children into the pop-out
 *     • useCallPopout(opts?)     → { isOpen, open, close, Host }
 *     • isPopoutSupported()      → feature-detect
 *
 * Both entries are HUMAN-only (they need a user-activation gesture); they are
 * intentionally NOT wired to the agent `ui_command` seam.
 */

// --- Native Picture-in-Picture ---
export { usePipTile, usePipManager, useMergedVideoRef } from "./usePipTile";
export { pipManager, PipUnsupportedError } from "./pipManager";
export { mergeVideoRefs } from "./mergeVideoRefs";

// --- Detached window ---
export { openCallPopout, isPopoutSupported } from "./callPopout";
export { CallPopoutHost, useCallPopout } from "./CallPopoutHost";

// --- Types ---
export type {
  PipTileController,
  PipManagerController,
  CallPopoutHandle,
  CallPopoutController,
  OpenCallPopoutOptions,
  VideoCallbackRef,
} from "./types";
