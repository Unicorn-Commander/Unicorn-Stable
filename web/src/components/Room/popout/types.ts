import type { FC, ReactNode } from "react";

/**
 * Shared type surface for the pop-out / Picture-in-Picture module.
 *
 * Kept framework-light and dependency-free so the wire/attach contracts stay
 * portable. The two capabilities are independent:
 *
 *   1. Native Picture-in-Picture — floats a SINGLE <video> into the OS PiP
 *      window. The element STAYS in the main document; only decoded frames go
 *      to the OS surface, so the LiveKit track is never moved.
 *   2. Detached window — opens a real second browser window and renders selected
 *      tiles into it via a React portal. The tiles' attach refs run in the child
 *      document, so `track.attach(childVideoEl)` genuinely re-homes the surface.
 *
 * Neither entry can be agent-driven: both require a user-activation gesture
 * (a real click), which an agent data packet is not. This is why pop-out/PiP is
 * intentionally NOT part of the `ui_command` wire seam.
 */

/**
 * A React callback ref for a <video>, in the same shape the call stage already
 * uses (`useAttachTrack` in VoiceVideoBar): it may return a cleanup function
 * (React-19 ref-cleanup style) or nothing. This is the shape {@link mergeVideoRefs}
 * composes so one <video> can carry BOTH the LiveKit attach ref and the PiP ref.
 */
export type VideoCallbackRef = (
  el: HTMLVideoElement | null,
) => (() => void) | void;

/* ------------------------------------------------------------------ *
 * Native Picture-in-Picture
 * ------------------------------------------------------------------ */

/**
 * Per-tile PiP controller returned by {@link usePipTile}. Bind {@link videoRef}
 * to the tile's <video> ALONGSIDE the LiveKit attach ref (compose via
 * {@link mergeVideoRefs}); the element is not moved, so no track handling changes.
 */
export interface PipTileController {
  /**
   * Compose onto the tile's <video> alongside the LiveKit attach ref. Stable
   * across renders (safe to pass to `mergeVideoRefs` without churn).
   */
  videoRef: (el: HTMLVideoElement | null) => void;
  /** This tile currently owns the (single) OS PiP window. */
  isActive: boolean;
  /** `document.pictureInPictureEnabled` AND this element isn't opted out. */
  supported: boolean;
  /** Enter PiP for this tile. MUST be called from a user gesture. */
  enter: () => Promise<void>;
  /** Exit PiP if this tile owns it (no-op otherwise). */
  exit: () => Promise<void>;
  /** Enter if inactive, exit if active. MUST be called from a user gesture. */
  toggle: () => Promise<void>;
}

/**
 * Imperative, non-React PiP surface — the literal `requestPip / isSupported /
 * activePipId / exitPip` capability set. Exposed both as the {@link usePipManager}
 * hook (reactive `activePipId`) and as the module singleton `pipManager`.
 */
export interface PipManagerController {
  /** Feature-detected: the browser exposes standard Picture-in-Picture. */
  isSupported: boolean;
  /** Opaque id of the element currently in PiP, or null. */
  activePipId: string | null;
  /**
   * Float a specific <video> into PiP. MUST be called synchronously from a user
   * gesture. Rejects with {@link PipUnsupportedError} when unavailable.
   */
  requestPip: (el: HTMLVideoElement, id?: string) => Promise<void>;
  /** Close the OS PiP window (no-op when nothing is in PiP). */
  exitPip: () => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Detached window
 * ------------------------------------------------------------------ */

/** Imperative handle over a live pop-out window. */
export interface CallPopoutHandle {
  /** The child window while open, else null. */
  readonly window: Window | null;
  /** True until the window is closed (by us, the user, or the opener unloading). */
  readonly isOpen: boolean;
  /** Bring the pop-out window to the front. */
  focus(): void;
  /** Close the window + run teardown (fires the `onClose` callback once). */
  close(): void;
}

/**
 * A pop-out window's on-screen POSITION, as persisted across reloads.
 *
 * Position only — deliberately NOT size. `window.open`'s `width`/`height`
 * features are CONTENT dimensions, while `outerWidth`/`outerHeight` (the only
 * size a parent can read back) INCLUDE the window chrome. Round-tripping one
 * through the other adds the chrome size on every open/close cycle, so the
 * window grows without bound. Position has no such mismatch: both the `left`/
 * `top` features and `screenX`/`screenY` address the window frame's top-left
 * corner, and any residual per-browser offset is measured and cancelled (see
 * `callPopout.ts`), so it cannot accumulate.
 */
export interface PopoutGeometry {
  /** Screen X of the window's left edge (may be negative on a left monitor). */
  left: number;
  /** Screen Y of the window's top edge. */
  top: number;
}

/**
 * Why a pop-out failed to open.
 *   • `"unsupported"` — no `window.open` (SSR / exotic embed).
 *   • `"blocked"` — the browser's popup blocker ate it. USER-VISIBLE: this is
 *     recoverable (allow popups for the site) and must never degrade silently.
 */
export type PopoutOpenFailure = "unsupported" | "blocked";

/** Result of `openCallPopoutWithResult` — exactly one side is non-null. */
export interface OpenCallPopoutResult {
  handle: CallPopoutHandle | null;
  failure: PopoutOpenFailure | null;
}

/** Options for {@link openCallPopout}. */
export interface OpenCallPopoutOptions {
  /** Window + document title. Default "Stable — call". */
  title?: string;
  /** Content width in px. Default 960. */
  width?: number;
  /** Content height in px. Default 600. */
  height?: number;
  /**
   * Namespace for this window's persisted POSITION. Omit for the original
   * single whole-stage pop-out (keeps its existing storage slot); pass the feed
   * id for a per-feed window so each one remembers its own monitor.
   */
  geometryKey?: string;
  /**
   * Nth simultaneously-open window, used ONLY to cascade the default centred
   * position so several first-time windows don't stack on the same pixel. A
   * saved position always wins over the cascade.
   */
  cascadeIndex?: number;
  /** Fired once when the window closes (child unload, `.close()`, or opener unload). */
  onClose?: () => void;
}

/* ------------------------------------------------------------------ *
 * Multi-window feed registry
 * ------------------------------------------------------------------ */

/**
 * Identifies ONE poppable feed. A participant can publish BOTH a camera and a
 * screen share, and those are separately poppable, so the source is part of the
 * key — `cam:<participantId>` / `screen:<screenSid>`. This string is also the
 * geometry namespace, so it must be stable across reloads for a given feed.
 */
export type FeedKey = string;

/** A feed pop-out that failed to open, with enough context to name it. */
export interface FeedPopoutError {
  feedKey: FeedKey;
  /** Human label for the feed ("Shafen — screen"), for the error banner. */
  label: string;
  failure: PopoutOpenFailure;
}

/** Per-feed overrides when opening a feed window. */
export interface OpenFeedPopoutOptions {
  /** Window + document title, e.g. "Shafen — screen · Stable". */
  title?: string;
  /** Human label used in the blocked-popup banner. Defaults to the key. */
  label?: string;
  width?: number;
  height?: number;
}

/**
 * Registry of N simultaneously-open feed windows, returned by
 * {@link useFeedPopouts}.
 *
 * THE LOAD-BEARING INVARIANT (same as CallPopoutHost): a feed's tile must be
 * rendered in EXACTLY ONE place at a time. When {@link isOpen} is true for a
 * key, the main grid must render a PLACEHOLDER and the real tile must be
 * rendered inside that key's {@link Host} — never both, or the LiveKit track
 * gets double-attached and you get black frames.
 */
export interface FeedPopoutRegistry {
  /** Feed keys with a live window, in open order. Reactive. */
  openKeys: FeedKey[];
  /** Is this feed currently in its own window? Reactive. */
  isOpen: (feedKey: FeedKey) => boolean;
  /**
   * Open (or focus) this feed's window. MUST be called synchronously from a
   * user gesture — one gesture per window, which is also what keeps popup
   * blockers from eating the 2nd..Nth. Returns false on failure and sets
   * {@link error}.
   */
  open: (feedKey: FeedKey, opts?: OpenFeedPopoutOptions) => boolean;
  /** Close one feed's window (returns that feed to the grid). */
  close: (feedKey: FeedKey) => void;
  /** Close every feed window. */
  closeAll: () => void;
  /** Last open failure. Non-null ⇒ the UI MUST render it. */
  error: FeedPopoutError | null;
  clearError: () => void;
  /** Portals its children into `feedKey`'s window; null when that feed is closed. */
  Host: FC<{ feedKey: FeedKey; children: ReactNode }>;
}

/**
 * Stateful convenience returned by {@link useCallPopout}: a pre-bound `Host`
 * plus reactive `isOpen` and gesture-safe `open`/`close`.
 */
export interface CallPopoutController {
  isOpen: boolean;
  /**
   * Open (or focus) the pop-out. Call directly from an `onClick` (user gesture).
   * Returns true when a window is now open; false means it failed and
   * {@link error} has been set for the UI to render.
   */
  open: () => boolean;
  /** Close the pop-out. */
  close: () => void;
  /**
   * The last open failure, or null. Non-null ⇒ RENDER SOMETHING: a blocked
   * popup is invisible at the browser level, so the app owns telling the user.
   */
  error: PopoutOpenFailure | null;
  /** Clear {@link error} (dismiss the banner). */
  clearError: () => void;
  /** Portals its children into the pop-out while open; renders null otherwise. */
  Host: FC<{ children: ReactNode }>;
}
