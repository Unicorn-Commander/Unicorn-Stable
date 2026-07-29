import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { pipManager } from "./pipManager";
import { mergeVideoRefs } from "./mergeVideoRefs";
import type {
  PipManagerController,
  PipTileController,
  VideoCallbackRef,
} from "./types";

/**
 * usePipTile — per-tile native Picture-in-Picture.
 *
 * Bind {@link PipTileController.videoRef} to the tile's <video> ALONGSIDE the
 * LiveKit attach ref (compose with {@link mergeVideoRefs}). The element is NOT
 * moved — only decoded frames go to the OS PiP surface — so no LiveKit track
 * handling changes here. Because the tile <video> is `muted`, PiP is silent by
 * design; audio keeps coming from the VoiceProvider's global sink.
 *
 * `isActive` is derived from the shared {@link pipManager} (single source of
 * truth for "who owns PiP"), so opening another tile automatically flips this
 * one inactive. `onAutoClose` fires when the OS chrome's close button ends PiP
 * (as opposed to our own `exit()`), letting the caller reconcile UI state.
 */
export function usePipTile(opts?: {
  /** Fired when the OS PiP chrome closes the window (not our own `exit()`). */
  onAutoClose?: () => void;
}): PipTileController {
  // Stable per-instance id → lets the manager report which tile owns PiP.
  const id = useId();
  const elRef = useRef<HTMLVideoElement | null>(null);
  const onAutoCloseRef = useRef(opts?.onAutoClose);
  onAutoCloseRef.current = opts?.onAutoClose;
  // Set right before WE trigger an exit, so the element's `leavepictureinpicture`
  // handler can distinguish an OS-chrome close (fire onAutoClose) from our exit.
  const selfExitingRef = useRef(false);
  // Per-element opt-out (`<video disablePictureInPicture>`), learned on attach.
  const [elDisabled, setElDisabled] = useState(false);

  const activeId = useSyncExternalStore(
    pipManager.subscribe,
    pipManager.getActivePipId,
    () => null,
  );
  const isActive = activeId === id;

  const supported = pipManager.isSupported() && !elDisabled;

  // Stable callback ref: caches the element + wires the OS-close listener. Kept
  // stable (empty deps) so composing it via mergeVideoRefs never churns.
  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    if (!el) {
      elRef.current = null;
      return;
    }
    elRef.current = el;
    setElDisabled(!!el.disablePictureInPicture);

    const onLeave = () => {
      if (selfExitingRef.current) {
        selfExitingRef.current = false;
      } else {
        onAutoCloseRef.current?.();
      }
    };
    el.addEventListener("leavepictureinpicture", onLeave);

    return () => {
      el.removeEventListener("leavepictureinpicture", onLeave);
      // Tile unmounting while it owns PiP → close the OS window so it doesn't
      // linger over a torn-down element.
      // MULTI-WINDOW: the <video> may live in a pop-out child document; the
      // global `document.pictureInPictureElement` is the WRONG document then.
      // Exit via pipManager, which remembers the owning document.
      const owner = el.ownerDocument;
      const ownsPip =
        owner?.pictureInPictureElement === el ||
        (typeof document !== "undefined" &&
          document.pictureInPictureElement === el);
      if (ownsPip) {
        selfExitingRef.current = true;
        void pipManager.exitPip().catch(() => {});
      }
      if (elRef.current === el) elRef.current = null;
    };
  }, []);

  const enter = useCallback(async () => {
    const el = elRef.current;
    // Expected no-ops (no element / unsupported / opted out) resolve silently so
    // a gated button never rejects; genuine PiP API errors propagate to callers.
    if (!el || !pipManager.isSupported() || el.disablePictureInPicture) return;
    // Ensure the video is actually playing before requestPictureInPicture —
    // some Chromium builds reject PiP on a paused/zero-frame element after a
    // LiveKit re-attach (common when a tile just moved into a pop-out).
    try {
      if (el.paused) void el.play().catch(() => {});
    } catch {
      /* ignore */
    }
    await pipManager.requestPip(el, id);
  }, [id]);

  const exit = useCallback(async () => {
    // Use manager ownership (id), not only the main-document PiP element.
    // Popped-out tiles put their <video> in a child document; checking only
    // `document.pictureInPictureElement` left the button stuck "active" with
    // no way to exit.
    const el = elRef.current;
    const owner = el?.ownerDocument ?? null;
    const ownsPip =
      pipManager.getActivePipId() === id ||
      (!!el && owner?.pictureInPictureElement === el) ||
      (!!el &&
        typeof document !== "undefined" &&
        document.pictureInPictureElement === el);
    if (!ownsPip) return;
    selfExitingRef.current = true;
    await pipManager.exitPip();
  }, [id]);

  const toggle = useCallback(async () => {
    if (isActive) await exit();
    else await enter();
  }, [isActive, enter, exit]);

  return { videoRef, isActive, supported, enter, exit, toggle };
}

/**
 * usePipManager — reactive view of the imperative PiP surface (the literal
 * `requestPip / isSupported / activePipId / exitPip` capability set). Use this
 * when you need PiP control decoupled from a specific tile hook; otherwise
 * prefer {@link usePipTile}. `activePipId` re-renders on owner changes.
 */
export function usePipManager(): PipManagerController {
  const activePipId = useSyncExternalStore(
    pipManager.subscribe,
    pipManager.getActivePipId,
    () => null,
  );
  return {
    isSupported: pipManager.isSupported(),
    activePipId,
    requestPip: pipManager.requestPip,
    exitPip: pipManager.exitPip,
  };
}

/**
 * useMergedVideoRef — {@link mergeVideoRefs} with the required memoization built
 * in. Returns a STABLE merged callback ref while its inputs are stable, so the
 * composed LiveKit + PiP refs don't detach/reattach the track every render.
 *
 *   const videoRef = useMergedVideoRef(attachTrack(track), pip.videoRef);
 */
export function useMergedVideoRef(
  ...refs: Array<VideoCallbackRef | null | undefined>
): (el: HTMLVideoElement | null) => void {
  // The merged ref must stay stable while the child refs are stable; the child
  // refs ARE the dep list. (attachTrack(track) is per-track cached; pip.videoRef
  // is a useCallback — so this only changes when a track actually changes.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => mergeVideoRefs(...refs), refs);
}
