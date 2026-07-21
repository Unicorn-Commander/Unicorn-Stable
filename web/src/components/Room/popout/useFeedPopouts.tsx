import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { CallPopoutHost } from "./CallPopoutHost";
import { openCallPopoutWithResult } from "./callPopout";
import type {
  CallPopoutHandle,
  FeedKey,
  FeedPopoutError,
  FeedPopoutRegistry,
  OpenFeedPopoutOptions,
} from "./types";

/**
 * useFeedPopouts — a REGISTRY of pop-out windows, one per video feed.
 *
 * This is the multi-window generalisation of {@link useCallPopout}. That hook
 * holds a SINGLE handle in `useState`, which caps you at one window per hook
 * instance; this one holds a `Map<FeedKey, CallPopoutHandle>` so Aaron can put
 * his camera on one monitor, Shafen's on another, and each of their screen
 * shares on two more — four windows, four feeds, simultaneously.
 *
 * WHY THE TRACKS SURVIVE (unchanged from the single-window design, and the
 * reason no BroadcastChannel/SharedWorker is involved): each window is a React
 * PORTAL target, not a second app instance. There is one JS context, one
 * LiveKit `Room`, one peer connection; only the DOM node relocates.
 * `track.attach(el)` accepts a media element from ANY document, so a tile whose
 * subtree is portalled into a child window simply re-attaches there.
 *
 * THE LOAD-BEARING INVARIANT: render each track in EXACTLY ONE place at a time.
 * For every key in {@link FeedPopoutRegistry.openKeys} the caller must render a
 * placeholder in the main grid and the real tile inside that key's `Host`. Both
 * at once means double attach/detach churn and black frames.
 *
 * POPUP BLOCKERS: `open()` must be called synchronously from a real click, and
 * each window needs its OWN gesture. Opening several in one gesture (a "pop out
 * everything" button) is the classic blocker trigger, so this hook deliberately
 * exposes no such bulk-open — `closeAll` exists, `openAll` does not. A failure
 * is recorded in {@link FeedPopoutRegistry.error} for the UI to render, because
 * `window.open` returning null is otherwise completely invisible.
 *
 * TEARDOWN: closing the main tab closes every child. Each window registers its
 * own `pagehide` listener on the opener inside `openCallPopoutWithResult`, so N
 * windows means N listeners and all of them tear down — no extra bookkeeping is
 * needed here. This hook additionally closes everything on unmount so a call
 * that ends (or a component that remounts) never orphans a window.
 */
export function useFeedPopouts(): FeedPopoutRegistry {
  const [handles, setHandles] = useState<ReadonlyMap<FeedKey, CallPopoutHandle>>(
    () => new Map(),
  );
  const [error, setError] = useState<FeedPopoutError | null>(null);
  // Ref mirror so `open`/`close`/`closeAll` read the live map synchronously
  // without being re-created — they stay gesture-stable identity-wise, which
  // matters because they are called straight out of onClick.
  const handlesRef = useRef<ReadonlyMap<FeedKey, CallPopoutHandle>>(handles);

  const commit = useCallback((next: Map<FeedKey, CallPopoutHandle>) => {
    handlesRef.current = next;
    setHandles(next);
  }, []);

  const open = useCallback(
    (feedKey: FeedKey, opts?: OpenFeedPopoutOptions): boolean => {
      const existing = handlesRef.current.get(feedKey);
      if (existing && existing.isOpen) {
        // Already detached — surface it instead of opening a duplicate window
        // for the same track (which WOULD double-attach it).
        existing.focus();
        return true;
      }

      // Synchronous open — nothing may be awaited before this or the popup is
      // blocked. `cascadeIndex` only nudges the DEFAULT centred position so a
      // first-time 4-window layout doesn't stack on one pixel; a saved position
      // always wins.
      let created: CallPopoutHandle | null = null;
      const result = openCallPopoutWithResult({
        title: opts?.title ?? "Stable — video",
        width: opts?.width ?? 800,
        height: opts?.height ?? 480,
        geometryKey: feedKey,
        cascadeIndex: handlesRef.current.size,
        onClose: () => {
          // Only react if the handle that closed is STILL the registered one for
          // this key. Guards the fast close→reopen race: a stale window's 500ms
          // watchdog can fire teardown late and must not evict a newer window.
          if (handlesRef.current.get(feedKey) !== created) return;
          const next = new Map(handlesRef.current);
          next.delete(feedKey);
          commit(next);
        },
      });
      created = result.handle;

      if (created) {
        const next = new Map(handlesRef.current);
        next.set(feedKey, created);
        commit(next);
      }
      if (result.failure) {
        setError({
          feedKey,
          label: opts?.label ?? feedKey,
          failure: result.failure,
        });
      }
      return !!created;
    },
    [commit],
  );

  const close = useCallback((feedKey: FeedKey) => {
    const h = handlesRef.current.get(feedKey);
    if (!h) return;
    // `close()` runs teardown synchronously, which fires the `onClose` above and
    // evicts the key. Belt-and-braces: if the handle was already dead, evict
    // here so a stale key can't pin a placeholder in the grid forever.
    h.close();
    if (handlesRef.current.has(feedKey) && handlesRef.current.get(feedKey) === h) {
      const next = new Map(handlesRef.current);
      next.delete(feedKey);
      commit(next);
    }
  }, [commit]);

  const closeAll = useCallback(() => {
    // Snapshot first: each close() synchronously mutates the map via onClose.
    for (const h of Array.from(handlesRef.current.values())) h.close();
    if (handlesRef.current.size) commit(new Map());
  }, [commit]);

  const clearError = useCallback(() => setError(null), []);

  // Never orphan a window when the call stage unmounts.
  useEffect(() => {
    return () => {
      for (const h of Array.from(handlesRef.current.values())) h.close();
    };
  }, []);

  const openKeys = useMemo(() => Array.from(handles.keys()), [handles]);

  const isOpen = useCallback(
    (feedKey: FeedKey) => {
      const h = handles.get(feedKey);
      return !!h && h.isOpen;
    },
    [handles],
  );

  // Bound Host — re-created only when the handle map changes (i.e. a window
  // opened or closed), so a live window's portal subtree is never remounted by
  // an unrelated parent re-render. Remounting it would detach and re-attach the
  // LiveKit track: a visible black frame.
  const Host = useCallback<FC<{ feedKey: FeedKey; children: ReactNode }>>(
    ({ feedKey, children }) => (
      <CallPopoutHost handle={handles.get(feedKey) ?? null}>
        {children}
      </CallPopoutHost>
    ),
    [handles],
  );

  return { openKeys, isOpen, open, close, closeAll, error, clearError, Host };
}
