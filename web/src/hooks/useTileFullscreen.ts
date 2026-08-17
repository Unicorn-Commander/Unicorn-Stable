/**
 * useTileFullscreen — per-tile browser fullscreen for every call surface
 * (ParticipantTile, ScreenShareTile, StageView, the guest stage).
 *
 * The decisions live in `lib/tileFullscreen.ts` (tested there); this hook
 * only binds them to React. Two things it must get right:
 *
 *  1. DOCUMENT-AWARE (multi-window): a tile that has been popped out lives in
 *     the CHILD window's document, so `document.fullscreenElement` /
 *     `document.exitFullscreen()` on the global (opener) document address the
 *     wrong window entirely — the button would report the wrong state and
 *     could never exit. Everything here resolves the document from the NODE
 *     (`el.ownerDocument`) and re-binds its listeners when the node moves
 *     between documents. Same wrong-document bug class that makes SplitPane
 *     unsafe to portal.
 *
 *  2. THE iPHONE RUNG: iPhone Safari has no element fullscreen, only the
 *     video-tag `webkitEnterFullscreen()`. Tiles therefore register their
 *     <video> via `videoRef` (merge it into the composed video ref); when
 *     that is the only pipeline, `supported` stays false until a video
 *     actually mounts — an avatar-only tile on iPhone shows no button rather
 *     than a dead one. Native-player state arrives via the video's
 *     `webkitbeginfullscreen` / `webkitendfullscreen` events.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTileFullscreen,
  tileFullscreenMode,
  toggleTileFullscreen,
  type TileFullscreenDoc,
  type TileFullscreenVideo,
} from "@/lib/tileFullscreen";

/** A real <video> plus the (undeclared-in-lib.dom) webkit video pipeline. */
export type TileFullscreenVideoEl = HTMLVideoElement & TileFullscreenVideo;

export interface TileFullscreenController {
  /** Attach to the tile's outermost container div. */
  ref: (el: HTMLDivElement | null) => void;
  /**
   * Register the tile's <video> (merge into the composed video ref). Enables
   * the iPhone video-tag fallback; harmless everywhere else. Stable identity,
   * so it never breaks `useMergedVideoRef` memoization.
   */
  videoRef: (el: HTMLVideoElement | null) => void;
  isFullscreen: boolean;
  /** False only when NO fullscreen pipeline exists for this tile right now. */
  supported: boolean;
  toggle: () => void;
}

export function useTileFullscreen(): TileFullscreenController {
  const elRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<TileFullscreenVideoEl | null>(null);
  // The document our node currently lives in; flips when the tile is portalled
  // into (or back out of) a pop-out window, which re-runs the listener effect.
  const [ownerDoc, setOwnerDoc] = useState<Document | null>(null);
  // State-mirrored so `supported` re-evaluates when a video mounts/unmounts.
  const [videoEl, setVideoEl] = useState<TileFullscreenVideoEl | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  /** One truth function for both pipelines' change events. */
  const recompute = useCallback(() => {
    const el = elRef.current;
    const video = videoElRef.current;
    const doc = (el?.ownerDocument ??
      video?.ownerDocument ??
      (typeof document !== "undefined" ? document : null)) as
      | TileFullscreenDoc
      | null;
    setIsFullscreen(isTileFullscreen({ doc, container: el, video }));
  }, []);

  // Element-pipeline listeners, bound to the OWNER document.
  useEffect(() => {
    const doc = ownerDoc ?? (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    // Reconcile immediately: moving documents can only ever drop fullscreen,
    // and a stale `true` would leave the tile stuck on its exit affordance.
    recompute();
    doc.addEventListener("fullscreenchange", recompute);
    doc.addEventListener("webkitfullscreenchange", recompute);
    return () => {
      doc.removeEventListener("fullscreenchange", recompute);
      doc.removeEventListener("webkitfullscreenchange", recompute);
    };
  }, [ownerDoc, recompute]);

  // Video-pipeline (iPhone native player) listeners, bound to the <video>.
  useEffect(() => {
    const video = videoEl;
    if (!video) return;
    video.addEventListener("webkitbeginfullscreen", recompute);
    video.addEventListener("webkitendfullscreen", recompute);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", recompute);
      video.removeEventListener("webkitendfullscreen", recompute);
    };
  }, [videoEl, recompute]);

  const supported =
    tileFullscreenMode(
      (ownerDoc ??
        (typeof document !== "undefined" ? document : null)) as
        | TileFullscreenDoc
        | null,
      videoEl,
    ) !== "none";

  const toggle = useCallback(() => {
    const el = elRef.current;
    const video = videoElRef.current;
    // Resolve from the node, NOT the global — this is the whole point.
    const doc = (el?.ownerDocument ??
      video?.ownerDocument ??
      (typeof document !== "undefined" ? document : null)) as
      | TileFullscreenDoc
      | null;
    void toggleTileFullscreen({ doc, container: el, video })
      .then((outcome) => {
        if (outcome === "none") {
          console.warn("tile fullscreen: no pipeline available");
        }
      })
      .catch((e) => {
        console.error("fullscreen toggle failed", e);
      });
  }, []);

  const ref = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setOwnerDoc(el?.ownerDocument ?? null);
  }, []);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    const video = el as TileFullscreenVideoEl | null;
    videoElRef.current = video;
    setVideoEl(video);
  }, []);

  return { ref, videoRef, isFullscreen, supported, toggle };
}
