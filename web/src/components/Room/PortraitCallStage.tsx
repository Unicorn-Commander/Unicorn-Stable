import { useEffect, useRef, useState, type ReactNode } from "react";
import { clampSelfView } from "@/lib/portraitCall";

/** One owner per track: remote stage and local bubble never duplicate a feed. */
export function PortraitCallStage({
  remote,
  self,
}: {
  remote: ReactNode;
  self?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setPosition((old) => {
        const rect = el.getBoundingClientRect();
        return clampSelfView(
          old?.x ?? rect.width - 120,
          old?.y ?? 64,
          rect.width,
          rect.height,
        );
      }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const move = (x: number, y: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (rect) setPosition(clampSelfView(x, y, rect.width, rect.height));
  };
  return (
    <div
      ref={frame}
      data-testid="portrait-call-stage"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-black"
    >
      <div className="absolute inset-0">{remote}</div>
      {self && (
        <div
          data-testid="self-view"
          className="absolute z-10 h-40 w-28 overflow-hidden rounded-3xl border border-white/20 bg-black shadow-xl"
          style={
            position
              ? { left: position.x, top: position.y }
              : { right: 8, top: 64 }
          }
        >
          {self}
          <button
            type="button"
            aria-label="Move self-view"
            title="Drag self-view; arrow keys move it"
            className="absolute inset-x-0 top-0 flex h-11 touch-none items-start justify-center pt-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            onPointerDown={(e) => {
              e.stopPropagation();
              const rect =
                e.currentTarget.parentElement!.getBoundingClientRect();
              const parent = frame.current!.getBoundingClientRect();
              drag.current = {
                id: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                left: rect.left - parent.left,
                top: rect.top - parent.top,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d?.id === e.pointerId)
                move(d.left + e.clientX - d.x, d.top + e.clientY - d.y);
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              const steps: Record<string, [number, number]> = {
                ArrowLeft: [-16, 0],
                ArrowRight: [16, 0],
                ArrowUp: [0, -16],
                ArrowDown: [0, 16],
              };
              const d = steps[e.key];
              if (d && position) {
                e.preventDefault();
                move(position.x + d[0], position.y + d[1]);
              }
            }}
          >
            <span
              aria-hidden="true"
              className="h-1 w-8 rounded-full bg-white/80 shadow"
            />
          </button>
        </div>
      )}
    </div>
  );
}
