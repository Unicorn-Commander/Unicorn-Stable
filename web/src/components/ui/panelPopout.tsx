import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  getPopoutRoot,
  isPopoutSupported,
  openCallPopoutWithResult,
} from "@/components/Room/popout/callPopout";
import type { CallPopoutHandle } from "@/components/Room/popout/types";

/**
 * Lightweight panel pop-out: reuses the call pop-out window primitive so
 * People / Saved / etc. can detach to a real browser window with themed CSS.
 */
export function usePanelPopout(opts: {
  title: string;
  geometryKey: string;
  width?: number;
  height?: number;
  onBlocked?: () => void;
}) {
  const [handle, setHandle] = useState<CallPopoutHandle | null>(null);
  const handleRef = useRef<CallPopoutHandle | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setH = useCallback((h: CallPopoutHandle | null) => {
    handleRef.current = h;
    setHandle(h);
  }, []);

  const close = useCallback(() => {
    const cur = handleRef.current;
    const win = cur?.window ?? null;
    if (win && !win.closed) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
    }
    setH(null);
  }, [setH]);

  const open = useCallback((): boolean => {
    if (!isPopoutSupported()) {
      optsRef.current.onBlocked?.();
      return false;
    }
    const cur = handleRef.current;
    if (cur && cur.isOpen) {
      cur.focus();
      return true;
    }
    let created: CallPopoutHandle | null = null;
    const result = openCallPopoutWithResult({
      title: optsRef.current.title,
      width: optsRef.current.width ?? 400,
      height: optsRef.current.height ?? 640,
      geometryKey: optsRef.current.geometryKey,
      onClose: () => {
        if (handleRef.current === created) setH(null);
      },
    });
    if (!result.handle) {
      optsRef.current.onBlocked?.();
      return false;
    }
    created = result.handle;
    setH(created);
    return true;
  }, [setH]);

  useEffect(() => () => close(), [close]);

  return {
    isOpen: !!(handle && handle.isOpen),
    open,
    close,
    handle,
    supported: isPopoutSupported(),
  };
}

export function PanelPopoutPortal({
  handle,
  children,
}: {
  handle: CallPopoutHandle | null;
  children: ReactNode;
}) {
  if (!handle?.isOpen || !handle.window) return null;
  const root = getPopoutRoot(handle.window.document);
  return createPortal(
    <div className="flex h-full min-h-0 flex-col bg-surface-0 text-slate-100">
      {children}
    </div>,
    root,
  );
}
