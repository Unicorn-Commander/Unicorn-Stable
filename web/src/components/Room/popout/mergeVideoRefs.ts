import type { VideoCallbackRef } from "./types";

/**
 * Compose several <video> callback refs into ONE, so a single tile <video> can
 * carry both the LiveKit attach ref (`useAttachTrack`) and the PiP ref
 * (`usePipTile().videoRef`) at the same time.
 *
 * Each child ref keeps its own discipline — this merger supports BOTH the
 * React-19 ref-cleanup style (the ref returns a `() => void` run on detach, as
 * `useAttachTrack` does) AND the classic style (the ref is invoked with `null`
 * on detach). Cleanups are tracked per child so a child is never both
 * cleaned-up AND re-invoked with null (which would double-detach a track).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STABILITY IS THE CALLER'S JOB. The merged callback attaches on the `el` call
 * and detaches on the `null` call, exactly like React's ref lifecycle. If a
 * FRESH merged function is produced every render, React will detach + reattach
 * the underlying LiveKit track on EVERY render (flicker + a black frame +
 * adaptive-stream churn) — the precise bug `useAttachTrack`'s per-track cache
 * exists to avoid. Memoize the result:
 *
 *   const videoRef = useMemo(
 *     () => mergeVideoRefs(attachTrack(track), pip.videoRef),
 *     [track, pip.videoRef],
 *   );
 *
 * or use the {@link useMergedVideoRef} hook which does this for you. Both inputs
 * are already stable (attachTrack is per-track cached; pip.videoRef is a
 * useCallback), so the memo only changes when the track changes — which is when
 * you WANT a re-attach.
 */
export function mergeVideoRefs(
  ...refs: Array<VideoCallbackRef | null | undefined>
): (el: HTMLVideoElement | null) => void {
  // Per-child cleanups from the most recent `el` attach. Closed over by the ONE
  // returned function instance, so it must stay stable across renders (see note).
  const cleanups = new Map<number, () => void>();

  const runCleanup = (i: number): boolean => {
    const c = cleanups.get(i);
    if (!c) return false;
    cleanups.delete(i);
    try {
      c();
    } catch (e) {
      console.error("mergeVideoRefs: child cleanup threw", e);
    }
    return true;
  };

  return (el: HTMLVideoElement | null) => {
    if (el === null) {
      // Detach: prefer each child's cleanup; fall back to invoking with null for
      // children that don't use the cleanup style.
      refs.forEach((ref, i) => {
        if (runCleanup(i)) return;
        if (ref) {
          try {
            ref(null);
          } catch (e) {
            console.error("mergeVideoRefs: child ref(null) threw", e);
          }
        }
      });
      return;
    }

    refs.forEach((ref, i) => {
      if (!ref) return;
      // Defensive: a re-attach without an intervening null must not stack a
      // second attach on the same element.
      runCleanup(i);
      try {
        const cleanup = ref(el);
        if (typeof cleanup === "function") cleanups.set(i, cleanup);
      } catch (e) {
        console.error("mergeVideoRefs: child ref attach threw", e);
      }
    });
  };
}
