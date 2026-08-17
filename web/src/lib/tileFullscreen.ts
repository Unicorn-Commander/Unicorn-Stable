/**
 * tileFullscreen — the framework-free engine under the per-tile "Full screen"
 * button. `hooks/useTileFullscreen.ts` wires it into React; this module owns
 * every decision so the logic is testable without a DOM.
 *
 * Meeting action item (Shafen / Adam calls): in a call you can only really
 * feature the active speaker — ANY tile (gallery/grid, filmstrip, screen
 * share, agent face) must be full-screenable.
 *
 * Two fullscreen pipelines, one ladder:
 *
 *  1. ELEMENT fullscreen — the standard Fullscreen API on the tile's
 *     CONTAINER div (`requestFullscreen`, plus the `webkit*` vendor aliases
 *     for older Safari). The whole tile goes fullscreen: name plate, status
 *     badges and the control cluster stay usable, and the same button (or
 *     Escape — the browser handles it natively) exits.
 *
 *  2. VIDEO fullscreen — iPhone Safari has NO element fullscreen at all; the
 *     only thing that can go fullscreen there is a <video>, via the
 *     video-tag-only `webkitEnterFullscreen()`, which presents the NATIVE
 *     player. Exit is the native player's own control (or
 *     `webkitExitFullscreen()` on the video); `webkitbeginfullscreen` /
 *     `webkitendfullscreen` events on the video report the state. A tile with
 *     no <video> (an avatar-only participant) has nothing this pipeline can
 *     present, so on iPhone such a tile honestly renders NO button rather
 *     than a dead one.
 *
 * Everything here takes the document/elements as ARGUMENTS and never reads
 * globals — that is what makes it honest under test AND correct for a
 * popped-out tile, which lives in a CHILD window's document where the
 * opener's `document.fullscreenElement` is simply the wrong object (same
 * wrong-document bug class as pipManager / CallPopoutHost).
 */

/** The document surface the engine touches (vendor-prefixed members optional). */
export interface TileFullscreenDoc {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/** The tile container surface (a div in practice). */
export interface TileFullscreenContainer {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** The video-tag surface — the iPhone-only pipeline. */
export interface TileFullscreenVideo {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
}

/** Everything a fullscreen operation needs, resolved by the caller. */
export interface TileFullscreenTarget {
  doc: TileFullscreenDoc | null | undefined;
  container: TileFullscreenContainer | null | undefined;
  video?: TileFullscreenVideo | null;
}

/** Which pipeline a tile can use right now. */
export type TileFullscreenMode = "element" | "video" | "none";

/** The current element-fullscreen element of `doc`, vendor-neutral. */
export function fullscreenElementOf(
  doc: TileFullscreenDoc | null | undefined,
): Element | null {
  if (!doc) return null;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** The video-tag pipeline is genuinely available on this <video>. */
function videoPipelineAvailable(
  video: TileFullscreenVideo | null | undefined,
): video is TileFullscreenVideo {
  return (
    !!video &&
    typeof video.webkitEnterFullscreen === "function" &&
    // Safari reports per-video support; `undefined` (any other browser that
    // happens to carry the method) is treated as capable, `false` is a no.
    video.webkitSupportsFullscreen !== false
  );
}

/**
 * Which fullscreen pipeline this tile has RIGHT NOW — this is the button's
 * render decision. "none" hides the affordance entirely (e.g. an iPhone tile
 * that is only an avatar); "video" means the native player will present just
 * the video; "element" is the full-tile experience everywhere else.
 */
export function tileFullscreenMode(
  doc: TileFullscreenDoc | null | undefined,
  video?: TileFullscreenVideo | null,
): TileFullscreenMode {
  if (doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
    return "element";
  }
  if (videoPipelineAvailable(video)) return "video";
  return "none";
}

/** True when THIS tile is fullscreen by either pipeline. */
export function isTileFullscreen(target: TileFullscreenTarget): boolean {
  const { doc, container, video } = target;
  const fsEl: unknown = fullscreenElementOf(doc);
  if (container && fsEl && fsEl === container) return true;
  return !!video?.webkitDisplayingFullscreen;
}

/**
 * Enter fullscreen for the tile. Ladder: standard element API → webkit
 * element API → iPhone video-tag API. Returns the pipeline that engaged, or
 * "none" when every rung was missing or refused (the caller decides whether
 * to log). Must run synchronously out of a user gesture.
 */
export async function enterTileFullscreen(
  target: TileFullscreenTarget,
): Promise<TileFullscreenMode> {
  const { container, video } = target;
  const request =
    container?.requestFullscreen ?? container?.webkitRequestFullscreen;
  if (container && request) {
    try {
      await request.call(container);
      return "element";
    } catch {
      // The element API exists but refused (iframe policy, transient state).
      // Fall through to the video-tag rung rather than dead-ending.
    }
  }
  if (videoPipelineAvailable(video)) {
    try {
      video.webkitEnterFullscreen?.();
      return "video";
    } catch {
      // InvalidStateError before the video has metadata; nothing else to try.
    }
  }
  return "none";
}

/**
 * Exit whatever fullscreen the tile holds. The video pipeline is checked
 * first: on iPhone the document-level exit does not exist, and when the
 * native player is up it is the only thing to dismiss.
 */
export async function exitTileFullscreen(
  target: TileFullscreenTarget,
): Promise<void> {
  const { doc, video } = target;
  if (
    video?.webkitDisplayingFullscreen &&
    typeof video.webkitExitFullscreen === "function"
  ) {
    video.webkitExitFullscreen();
    return;
  }
  if (!doc) return;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (exit) await exit.call(doc);
}

/**
 * The button's click behavior: exit when THIS tile is fullscreen, else enter.
 * Returns "exit" or the pipeline entered ("none" = nothing worked).
 */
export async function toggleTileFullscreen(
  target: TileFullscreenTarget,
): Promise<TileFullscreenMode | "exit"> {
  if (isTileFullscreen(target)) {
    await exitTileFullscreen(target);
    return "exit";
  }
  return enterTileFullscreen(target);
}
