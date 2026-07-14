import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * VideoGrid — a responsive, best-fit tile grid for the call stage.
 *
 * Pure layout: it receives already-built tile nodes (each carrying its own
 * LiveKit attach ref) and arranges them to MAXIMISE tile size while preserving
 * a 16:9 aspect and never clipping. It measures its own box with a
 * ResizeObserver and, for the visible tile count, picks the column count that
 * yields the largest tile — biased toward the product spec for small calls:
 *
 *   1 → full-bleed · 2 → 2-up (side-by-side) · 3-4 → 2×2 · more → auto grid.
 *
 * On a portrait/short container the same search naturally stacks the tiles
 * (e.g. a short-wide mobile video pane keeps 2 people readable). Beyond
 * `maxTiles` it paginates — off-page tiles simply aren't mounted, so LiveKit's
 * adaptive stream pauses their layers until you page to them.
 */

export interface VideoTileItem {
  key: string;
  node: ReactNode;
}

interface VideoGridProps {
  items: VideoTileItem[];
  /** Gap between tiles, px. */
  gap?: number;
  /** Tile aspect ratio (w/h). */
  aspect?: number;
  /** Max tiles per page before paginating. */
  maxTiles?: number;
  className?: string;
}

/**
 * Preferred maximum columns for a given tile count — encodes the spec's intent
 * (2 → 2-up, 3-4 → 2×2) as a ceiling; the best-fit search below still drops to
 * fewer columns when the container is too short to benefit.
 */
function preferredMaxCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  if (count <= 12) return 4;
  return 5;
}

interface FitResult {
  cols: number;
  tileW: number;
}

function bestFit(
  count: number,
  width: number,
  height: number,
  gap: number,
  aspect: number,
): FitResult {
  const maxCols = Math.min(preferredMaxCols(count), count);
  let best: FitResult = { cols: 1, tileW: 0 };
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(count / cols);
    const availW = width - gap * (cols - 1);
    const availH = height - gap * (rows - 1);
    if (availW <= 0 || availH <= 0) continue;
    const cellW = availW / cols;
    const cellH = availH / rows;
    // Largest 16:9 tile that fits this cell.
    const tileW = Math.min(cellW, cellH * aspect);
    if (tileW > best.tileW) best = { cols, tileW };
  }
  return best;
}

export function VideoGrid({
  items,
  gap = 8,
  aspect = 16 / 9,
  maxTiles = 12,
  className,
}: VideoGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [page, setPage] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageCount = Math.max(1, Math.ceil(items.length / maxTiles));
  // Clamp the page when the roster shrinks (someone left / stopped video).
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  const start = page * maxTiles;
  const visible = items.slice(start, start + maxTiles);
  const measured = size.w > 0 && size.h > 0 && visible.length > 0;
  const fit = measured
    ? bestFit(visible.length, size.w, size.h, gap, aspect)
    : null;

  return (
    <div
      ref={containerRef}
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
        className,
      )}
    >
      {fit && fit.tileW > 0 ? (
        <div
          className="grid h-full w-full place-content-center"
          style={{
            gridTemplateColumns: `repeat(${fit.cols}, ${fit.tileW}px)`,
            gap: `${gap}px`,
          }}
        >
          {visible.map((it) => (
            <div key={it.key} className="min-w-0" style={{ width: fit.tileW }}>
              {it.node}
            </div>
          ))}
        </div>
      ) : (
        // Pre-measure fallback: never render an empty stage for a frame.
        <div className="grid h-full w-full auto-rows-min content-center gap-2 sm:grid-cols-2">
          {visible.map((it) => (
            <div key={it.key} className="min-w-0">
              {it.node}
            </div>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="glass pointer-events-auto absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-1.5 py-1 text-xs text-slate-200">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="focus-ring flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="tabular-nums px-1">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            className="focus-ring flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
