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
 *     • openCallPopoutWithResult → { handle, failure } — distinguishes a
 *                                    BLOCKED popup from unsupported so the UI
 *                                    can say so instead of doing nothing
 *     • CallPopoutHost           → portals children into the pop-out
 *     • useCallPopout(opts?)     → { isOpen, open, close, error, clearError,
 *                                    Host }
 *     • isPopoutSupported()      → feature-detect
 *     • readPopoutGeometry() / clearPopoutGeometry() → the validated,
 *                                    persisted window POSITION (never size —
 *                                    see callPopout.ts for why round-tripping
 *                                    size grows the window every cycle)
 *
 * Both entries are HUMAN-only (they need a user-activation gesture); they are
 * intentionally NOT wired to the agent `ui_command` seam.
 */

// --- Native Picture-in-Picture ---
export { usePipTile, usePipManager, useMergedVideoRef } from "./usePipTile";
export { pipManager, PipUnsupportedError } from "./pipManager";
export { mergeVideoRefs } from "./mergeVideoRefs";

// --- Detached window ---
export {
  openCallPopout,
  openCallPopoutWithResult,
  isPopoutSupported,
  readPopoutGeometry,
  clearPopoutGeometry,
} from "./callPopout";
export { CallPopoutHost, useCallPopout } from "./CallPopoutHost";

// --- Types ---
export type {
  PipTileController,
  PipManagerController,
  CallPopoutHandle,
  CallPopoutController,
  OpenCallPopoutOptions,
  OpenCallPopoutResult,
  PopoutOpenFailure,
  PopoutGeometry,
  VideoCallbackRef,
} from "./types";
