import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Drag-to-resize SPLIT primitive — a divider BETWEEN two sibling panes.
 *
 * This is the counterpart to {@link usePanelResize} (which sizes a single panel
 * docked against a viewport edge). A split owns the size of the SECONDARY (end)
 * pane; the primary pane is `flex-1` and simply takes the rest. Both axes are
 * supported: "horizontal" lays the panes out side-by-side with a vertical
 * divider (size = width), "vertical" stacks them with a horizontal divider
 * (size = height) — so ONE instance can flip orientation across a breakpoint
 * (side-by-side on desktop, stacked on mobile) WITHOUT remounting either pane,
 * which is essential: a remount would detach/reattach the LiveKit video tracks
 * living inside the primary pane.
 *
 * Pointer-events + pointer capture (identical ergonomics to usePanelResize): the
 * handle captures the pointer on pointerdown so the drag survives the cursor
 * outrunning the strip or crossing an iframe/<video>/canvas inside a pane.
 *
 * Persistence: the secondary size is written through to localStorage per axis
 * (`stable.split.<key>.<w|h>.v1`), and the collapsed flag to
 * `stable.split.<key>.collapsed.v1`. Sizes are clamped on read so a later
 * min/max change can never resurrect an out-of-bounds stored value. Keyboard
 * arrows nudge the divider; double-click resets to the default size.
 */

export type SplitOrientation = "horizontal" | "vertical";

export interface SplitPaneOptions {
  /** Natural size (px) of the SECONDARY (end) pane. */
  defaultSize: number;
  min: number;
  max: number;
  orientation: SplitOrientation;
  /** Allow the secondary pane to collapse to zero (persisted). Default false. */
  collapsible?: boolean;
  /** Called when a drag, key nudge, or double-click commits a size. */
  onSizeCommit?: (size: number) => void;
  /**
   * Previous storage key. If this split has no saved size yet, copy the
   * legacy size once. A later drag writes the new key and is not overwritten.
   */
  legacyKey?: string;
}

export interface SplitSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Copy a pre-per-room split size onto `key` when `key` has none yet. */
export function adoptLegacySplitSize(
  storage: SplitSizeStorage,
  key: string,
  legacyKey: string | undefined,
  orientation: SplitOrientation,
): void {
  if (!legacyKey || legacyKey === key) return;
  const nextKey = sizeKey(key, orientation);
  if (storage.getItem(nextKey) != null) return;
  const legacy = storage.getItem(sizeKey(legacyKey, orientation));
  if (legacy == null) return;
  storage.setItem(nextKey, legacy);
}

/** How far one arrow-key press moves the divider, in px. */
const KEYBOARD_STEP = 24;

const sizeKey = (key: string, o: SplitOrientation): string =>
  `stable.split.${key}.${o === "horizontal" ? "w" : "h"}.v1`;
const collapsedStorageKey = (key: string): string =>
  `stable.split.${key}.collapsed.v1`;

const clampSize = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

function readStoredSize(
  key: string,
  orientation: SplitOrientation,
  fallback: number,
  min: number,
  max: number,
  legacyKey?: string,
): number {
  try {
    adoptLegacySplitSize(localStorage, key, legacyKey, orientation);
    const raw = localStorage.getItem(sizeKey(key, orientation));
    if (!raw) return clampSize(fallback, min, max);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return clampSize(fallback, min, max);
    return clampSize(parsed, min, max);
  } catch {
    return clampSize(fallback, min, max);
  }
}

function readStoredCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(collapsedStorageKey(key)) === "1";
  } catch {
    return false;
  }
}

export interface SplitHandleAria {
  role: "separator";
  "aria-orientation": SplitOrientation;
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  /** Drives the lit dragging state on the handle. */
  "data-dragging": "true" | "false";
  tabIndex: 0;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface SplitPaneResult {
  /** Current secondary-pane size in px (width for horizontal, height for vertical). */
  size: number;
  isDragging: boolean;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggleCollapsed: () => void;
  /** Set the secondary size and persist it (preset apply). */
  commitSize: (size: number) => void;
  orientation: SplitOrientation;
  /** Spread onto the drag handle element; add positioning classes at the call site. */
  dragHandleProps: SplitHandleAria;
}

export function useSplitPane(
  key: string,
  {
    defaultSize,
    min,
    max,
    orientation,
    collapsible = false,
    onSizeCommit,
    legacyKey,
  }: SplitPaneOptions,
): SplitPaneResult {
  const [size, setSize] = useState(() =>
    readStoredSize(key, orientation, defaultSize, min, max, legacyKey),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsedState] = useState(() =>
    collapsible ? readStoredCollapsed(key) : false,
  );

  // Live drag session (null when idle). Refs, not state: pointermove must not
  // depend on a re-render to see the latest values.
  const dragRef = useRef<{
    pointerId: number;
    start: number;
    startSize: number;
  } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const onSizeCommitRef = useRef(onSizeCommit);
  onSizeCommitRef.current = onSizeCommit;

  // Re-read the stored size when the axis flips (breakpoint cross) or the key
  // changes, so the horizontal (width) and vertical (height) layouts each
  // restore their own persisted size. Skipped mid-drag so it can't fight a drag.
  useEffect(() => {
    if (dragRef.current) return;
    setSize(readStoredSize(key, orientation, defaultSize, min, max, legacyKey));
    // defaultSize/min/max are call-site constants; re-reading on key/orientation
    // is the whole point. eslint-disable to keep the dep list to the triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, orientation, legacyKey]);

  const persistSize = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(sizeKey(key, orientation), String(w));
      } catch {
        // Best-effort: size still applies for the session.
      }
      onSizeCommitRef.current?.(w);
    },
    [key, orientation],
  );

  const commitSize = useCallback(
    (next: number) => {
      const w = clampSize(next, min, max);
      setSize(w);
      persistSize(w);
    },
    [min, max, persistSize],
  );

  const setCollapsed = useCallback(
    (v: boolean) => {
      setCollapsedState(v);
      try {
        localStorage.setItem(collapsedStorageKey(key), v ? "1" : "0");
      } catch {
        // Best-effort.
      }
    },
    [key],
  );

  const toggleCollapsed = useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      dragRef.current = {
        pointerId: e.pointerId,
        start: orientation === "horizontal" ? e.clientX : e.clientY,
        startSize: sizeRef.current,
      };
      setIsDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor =
        orientation === "horizontal" ? "col-resize" : "row-resize";
    },
    [orientation],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const pos = orientation === "horizontal" ? e.clientX : e.clientY;
      // Secondary pane is the END pane: moving the divider toward the start
      // (negative delta) GROWS it.
      const delta = pos - drag.start;
      setSize(clampSize(drag.startSize - delta, min, max));
    },
    [orientation, min, max],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setIsDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      persistSize(sizeRef.current);
    },
    [persistSize],
  );

  const onDoubleClick = useCallback(() => {
    const w = clampSize(defaultSize, min, max);
    setSize(w);
    persistSize(w);
  }, [defaultSize, min, max, persistSize]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      // Arrows move the DIVIDER; the secondary (end) pane grows when the divider
      // moves toward the start of the axis.
      let dir: number;
      if (orientation === "horizontal") {
        if (e.key === "ArrowLeft") dir = 1;
        else if (e.key === "ArrowRight") dir = -1;
        else return;
      } else {
        if (e.key === "ArrowUp") dir = 1;
        else if (e.key === "ArrowDown") dir = -1;
        else return;
      }
      e.preventDefault();
      const next = clampSize(sizeRef.current + dir * KEYBOARD_STEP, min, max);
      setSize(next);
      persistSize(next);
    },
    [orientation, min, max, persistSize],
  );

  // If a pane unmounts mid-drag (mode switch, room switch), don't leak the body
  // styles the pointerdown set.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };
  }, []);

  return {
    size,
    isDragging,
    collapsed,
    setCollapsed,
    toggleCollapsed,
    commitSize,
    orientation,
    dragHandleProps: {
      role: "separator",
      "aria-orientation": orientation,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": size,
      "data-dragging": isDragging ? "true" : "false",
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick,
      onKeyDown,
    },
  };
}
