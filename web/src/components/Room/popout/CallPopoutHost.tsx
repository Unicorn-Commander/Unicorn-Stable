import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type ReactPortal,
} from "react";
import { createPortal } from "react-dom";
import { getPopoutRoot, openCallPopout } from "./callPopout";
import type {
  CallPopoutController,
  CallPopoutHandle,
  OpenCallPopoutOptions,
} from "./types";

/**
 * CallPopoutHost — portals its children into a pop-out window.
 *
 * Mount ONE of these high in the call tree and feed it the tiles you want
 * detached. While the window is open it renders a React portal into the child
 * document's mount node (so the tiles' LiveKit attach refs attach to <video>
 * elements in THAT window); while closed it renders null in the main tree.
 *
 * IMPORTANT: render each track's tile in EXACTLY ONE place at a time — either
 * the main tree OR here, never both — so attach/detach stays balanced and no
 * track is double-owned. Show a "playing in pop-out" placeholder in the main
 * tree for the moved surface.
 *
 * NOTE: `handle` is an imperative object with getters — this component only
 * re-evaluates the portal when the PARENT re-renders. Pass a fresh `handle`
 * value (or a `key`) when the window opens/closes, or use {@link useCallPopout},
 * which drives the re-render for you.
 *
 * Audio stays in the MAIN document: the VoiceProvider sink and the tile <video>
 * `muted` attribute are unchanged, so audio keeps playing from the opener tab —
 * no second autoplay prompt, no double-attach.
 */
export function CallPopoutHost({
  handle,
  children,
}: {
  handle: CallPopoutHandle | null;
  children: ReactNode;
}): ReactPortal | null {
  const win = handle?.window ?? null;
  if (!win || !handle?.isOpen) return null;
  const root = getPopoutRoot(win.document);
  return createPortal(children, root);
}

/**
 * useCallPopout — stateful convenience: reactive `isOpen`, gesture-safe
 * `open`/`close`, and a pre-bound `Host` that re-renders as the window
 * opens/closes. `open()` opens (or focuses) the pop-out and MUST be called
 * directly from an `onClick` (user gesture) — it opens the window synchronously.
 */
export function useCallPopout(
  opts?: OpenCallPopoutOptions,
): CallPopoutController {
  const [handle, setHandleState] = useState<CallPopoutHandle | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Ref mirror so `open`/`close` can read the live handle synchronously without
  // being re-created (keeping them gesture-stable).
  const handleRef = useRef<CallPopoutHandle | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setHandle = useCallback((h: CallPopoutHandle | null) => {
    handleRef.current = h;
    setHandleState(h);
    setIsOpen(!!h && h.isOpen);
  }, []);

  const open = useCallback(() => {
    const cur = handleRef.current;
    if (cur && cur.isOpen) {
      cur.focus();
      return;
    }
    // Synchronous open — no `await` before this, or the popup is blocked.
    let created: CallPopoutHandle | null = null;
    created = openCallPopout({
      title: optsRef.current?.title,
      width: optsRef.current?.width,
      height: optsRef.current?.height,
      onClose: () => {
        // Only react if the handle that closed is STILL the active one. Guards
        // the fast close→reopen race: a stale window's watchdog teardown fires
        // late and must not clobber a newer window's handle (or double-fire the
        // consumer's onClose for a pop-out they've already replaced).
        if (handleRef.current === created) {
          setHandle(null);
          optsRef.current?.onClose?.();
        }
      },
    });
    setHandle(created);
  }, [setHandle]);

  const close = useCallback(() => {
    handleRef.current?.close();
    // `close()` fires onClose synchronously (which resets state); reset here too
    // in case the handle was already gone.
    if (!handleRef.current) setHandle(null);
  }, [setHandle]);

  // Close the pop-out if the owning component unmounts (never orphan a window).
  useEffect(() => {
    return () => {
      handleRef.current?.close();
    };
  }, []);

  // Bound Host — stable while the window session is stable (handle only changes
  // on open/close), so a live session's portal subtree is never remounted by an
  // unrelated parent re-render.
  const Host = useCallback<FC<{ children: ReactNode }>>(
    ({ children }) => <CallPopoutHost handle={handle}>{children}</CallPopoutHost>,
    [handle],
  );

  return { isOpen, open, close, Host };
}
