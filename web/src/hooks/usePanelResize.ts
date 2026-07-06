import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Drag-to-resize for the docked side panels (sidebar, participants, canvas,
 * knowledge). Pointer-events based: the 6px handle strip takes pointer capture
 * on pointerdown, so iframes/canvases inside the panel never swallow the
 * pointermove stream and the drag survives leaving the strip.
 *
 * Width persists per-panel to localStorage (`stable.panel.width.<key>.v1`,
 * write-through on drag end / keyboard nudge, read once lazily on mount).
 * Double-click resets to the default. Desktop-only by convention: the mobile
 * variants of these panels are fixed overlay drawers, so call sites gate both
 * the handle (`hidden md:block`) and the inline width (useIsDesktop) at `md`.
 */

export type PanelResizeEdge = "left" | "right";

export interface PanelResizeOptions {
  defaultWidth: number;
  min: number;
  max: number;
  /**
   * Which edge of the panel the handle sits on. "left" = right-docked panel
   * (dragging the handle left widens it); "right" = the left sidebar
   * (dragging right widens it).
   */
  edge: PanelResizeEdge;
}

/** How far one arrow-key press moves the handle, in px. */
const KEYBOARD_STEP = 16;

/**
 * Shared look for the drag strip. Call sites add positioning (`left-0` /
 * `right-0`), the desktop gate (`hidden md:block`), and a dragging highlight
 * (`isDragging && PANEL_RESIZE_ACTIVE_CLASS`). The 8px strip sits just INSIDE
 * the panel edge (several of these panels are overflow-hidden, so a
 * border-straddling negative offset would be clipped) and hugs the panel
 * border.
 *
 * Discoverability: a persistent grip pill (`::before`) sits centred on the
 * strip so the edge visibly reads as draggable at rest — without it the
 * feature is a transparent 6px strip nobody finds. On hover / keyboard focus
 * the pill grows and turns accent-purple and a hairline (`::after`) glows down
 * the seam. `PANEL_RESIZE_ACTIVE_CLASS` drives that same lit state while a drag
 * is in progress even if the pointer outruns the strip.
 */
export const PANEL_RESIZE_HANDLE_CLASS =
  "group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none select-none " +
  // persistent grip pill — the at-rest affordance
  "before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:h-8 before:w-[3px] " +
  "before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-white/20 " +
  "before:transition-all before:duration-150 before:content-[''] " +
  // seam glow — hairline down the panel edge, transparent until active
  "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 " +
  "after:bg-transparent after:transition-colors after:duration-150 after:content-[''] " +
  // hover + keyboard focus: grip grows and turns purple, seam lights up
  "hover:before:h-14 hover:before:bg-stable-purple/80 hover:after:bg-stable-purple/40 " +
  "focus:outline-none focus-visible:before:h-14 focus-visible:before:bg-stable-purple focus-visible:after:bg-stable-purple/50";

/**
 * Appended by call sites while `isDragging` so the grip stays lit even when the
 * captured pointer leaves the strip. Arbitrary variants reach the same
 * pseudo-elements the hover state styles.
 */
export const PANEL_RESIZE_ACTIVE_CLASS =
  "bg-stable-purple/5 [&::before]:h-14 [&::before]:bg-stable-purple [&::after]:bg-stable-purple/50";

/** Tailwind `md` — matches the drawers' fixed/overlay↔docked breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * True at Tailwind `md` and up. Used to apply hook-driven inline widths only
 * where the panels are docked columns — on phones they are full-screen /
 * fixed-width overlays and an inline `width` would override those classes.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

const storageKey = (key: string) => `stable.panel.width.${key}.v1`;

const clampWidth = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const readStoredWidth = (
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    // Clamp on read so a later min/max change can never resurrect a stored
    // width outside the current bounds.
    return clampWidth(parsed, min, max);
  } catch {
    // localStorage can throw (private mode / storage disabled) — fall back.
    return fallback;
  }
};

export interface PanelResizeHandleProps {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  tabIndex: 0;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface PanelResizeResult {
  width: number;
  isDragging: boolean;
  /** Spread onto the handle element; add `aria-label` + classes at the call site. */
  dragHandleProps: PanelResizeHandleProps;
}

export function usePanelResize(
  key: string,
  { defaultWidth, min, max, edge }: PanelResizeOptions,
): PanelResizeResult {
  const [width, setWidth] = useState(() =>
    readStoredWidth(key, defaultWidth, min, max),
  );
  const [isDragging, setIsDragging] = useState(false);
  // Live drag session (null when idle). Refs, not state: pointermove must not
  // depend on a re-render to see the latest values.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(storageKey(key), String(w));
      } catch {
        // Best-effort: width still applies for the session.
      }
    },
    [key],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Primary button only for mice; touch/pen report button 0 or -1 states
      // inconsistently, so gate on pointerType.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: widthRef.current,
      };
      setIsDragging(true);
      // Capture keeps every pointermove on the handle even when the cursor
      // outruns the 6px strip or crosses an iframe/canvas inside the panel.
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const delta = e.clientX - drag.startX;
      // Handle on the LEFT edge of a right-docked panel: moving left widens.
      const next =
        edge === "left" ? drag.startWidth - delta : drag.startWidth + delta;
      setWidth(clampWidth(next, min, max));
    },
    [edge, min, max],
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
      persist(widthRef.current);
    },
    [persist],
  );

  const onDoubleClick = useCallback(() => {
    const w = clampWidth(defaultWidth, min, max);
    setWidth(w);
    persist(w);
  }, [defaultWidth, min, max, persist]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      // Arrows move the HANDLE, so which key widens depends on the edge:
      // left-edge handle (right-docked panel) widens on ArrowLeft.
      let dir: number;
      if (e.key === "ArrowLeft") dir = edge === "left" ? 1 : -1;
      else if (e.key === "ArrowRight") dir = edge === "left" ? -1 : 1;
      else return;
      e.preventDefault();
      const next = clampWidth(widthRef.current + dir * KEYBOARD_STEP, min, max);
      setWidth(next);
      persist(next);
    },
    [edge, min, max, persist],
  );

  // If the panel unmounts mid-drag (Esc closes it, room switch), the body
  // styles must not leak.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };
  }, []);

  return {
    width,
    isDragging,
    dragHandleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
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
