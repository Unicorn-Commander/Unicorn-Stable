import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import clsx from "clsx";
import type { FloatGeometry } from "@/stores/panelChromeStore";

interface FloatingWindowProps {
  titleId?: string;
  geometry: FloatGeometry;
  onGeometryChange: (geom: FloatGeometry) => void;
  minW?: number;
  minH?: number;
  className?: string;
  children: ReactNode;
  /** Header drag region (title bar). */
  header: ReactNode;
}

/**
 * In-app floating window: drag via header, resize from SE corner, size/pos
 * persisted by the parent. Does not use a modal backdrop so the rest of the
 * app stays interactive (multi-monitor desk workflow).
 */
export function FloatingWindow({
  titleId,
  geometry,
  onGeometryChange,
  minW = 280,
  minH = 280,
  className,
  children,
  header,
}: FloatingWindowProps) {
  const geomRef = useRef(geometry);
  geomRef.current = geometry;
  const [live, setLive] = useState(geometry);
  useEffect(() => setLive(geometry), [geometry]);

  const dragRef = useRef<{
    kind: "move" | "resize";
    pointerId: number;
    startX: number;
    startY: number;
    origin: FloatGeometry;
  } | null>(null);

  const clampGeom = useCallback(
    (g: FloatGeometry): FloatGeometry => {
      const maxW = Math.max(minW, window.innerWidth - 16);
      const maxH = Math.max(minH, window.innerHeight - 16);
      const w = Math.min(maxW, Math.max(minW, g.w));
      const h = Math.min(maxH, Math.max(minH, g.h));
      const x = Math.min(window.innerWidth - 48, Math.max(0, g.x));
      const y = Math.min(window.innerHeight - 48, Math.max(0, g.y));
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    },
    [minW, minH],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      onGeometryChange(clampGeom(geomRef.current));
    },
    [clampGeom, onGeometryChange],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      let next: FloatGeometry;
      if (d.kind === "move") {
        next = {
          ...d.origin,
          x: d.origin.x + dx,
          y: d.origin.y + dy,
        };
      } else {
        next = {
          ...d.origin,
          w: d.origin.w + dx,
          h: d.origin.h + dy,
        };
      }
      next = clampGeom(next);
      geomRef.current = next;
      setLive(next);
    },
    [clampGeom],
  );

  const startMove = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't start drag from interactive controls inside the header.
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, select, textarea, [data-no-drag]")) return;
    e.preventDefault();
    dragRef.current = {
      kind: "move",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: { ...geomRef.current },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
  };

  const startResize = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind: "resize",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: { ...geomRef.current },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
  };

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className={clsx(
        "glass-heavy fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-line shadow-pop",
        className,
      )}
      style={{
        left: live.x,
        top: live.y,
        width: live.w,
        height: live.h,
      }}
    >
      <div
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={startMove}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {header}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <div
        className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
        onPointerDown={startResize}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label="Resize window"
        title="Drag to resize"
      >
        <span
          className="absolute bottom-1 right-1 h-2.5 w-2.5 border-b-2 border-r-2 border-slate-500/80"
          aria-hidden
        />
      </div>
    </div>
  );
}
