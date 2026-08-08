// Viewport math for the org chart — every number the pan/zoom layer computes,
// kept pure so it can be unit-tested without a DOM or an xyflow instance
// (same split as orgTree.ts: the component renders, this file decides).
//
// Coordinate model: "flow" space is the dagre-laid-out plane the nodes live
// on; the viewport shows it at some `zoom` centred on a flow-space point.
// Everything here returns flow-space centres + a zoom for xyflow's
// `setCenter(cx, cy, { zoom })` — we never hand back a raw translate, so the
// math stays independent of pane pixel origins.

/** Pane (or any box) size in px. */
export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned rectangle in flow coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A `setCenter` instruction: centre the viewport here at this zoom. */
export interface CenterTarget {
  cx: number;
  cy: number;
  zoom: number;
}

// Fit has to be allowed to zoom out far enough to actually show the widest
// tier. A floor of 0.5 was clamping it: the org has 15+ domain leads in one
// row (~3500px) inside a ~1000px canvas, which needs ~0.28 — so the fit
// silently gave up, the row ran off both edges and the apex sat off-centre,
// making the hierarchy unreadable. Keep this at or below the flow's minZoom.
export const FIT_MIN_ZOOM = 0.12;
export const FIT_PADDING = 0.12;
export const FIT_MAX_ZOOM = 0.85;

// Below this the node labels stop being readable — names turn to grey mush.
// A wide org (20 domain leads is ~4200px in a ~1200px pane) only "fits" at
// about 0.2, so fitting everything is worse than not fitting: you get a
// legible-at-no-zoom-level ribbon floating in an empty pane. Past this point
// the overview anchors on the apex at a readable size instead.
export const LEGIBLE_ZOOM = 0.55;

// Hard ceiling for manual zoom (wheel / pinch / buttons). Past this a node is
// just a blurry business card.
export const CHART_MAX_ZOOM = 1.6;

// One +/− button press multiplies the zoom by this. Two presses ≈ 1.8×, which
// walks the whole 0.12→1.6 range in ~7 presses — granular enough to aim,
// coarse enough not to feel like a scroll wheel.
export const ZOOM_STEP_FACTOR = 1.35;

// Focusing an agent's subtree: a little more breathing room than the overview
// fit (the subtree is the subject, not wallpaper), and a lower ceiling than
// manual zoom so a single leaf doesn't slam to 1.6× and fill the pane with
// one giant card.
export const FOCUS_PADDING = 0.18;
export const FOCUS_MAX_ZOOM = 1.1;

/** Clamp a zoom into [min, max]. If the range is inverted, min wins. */
export function clampZoom(zoom: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, zoom));
}

/**
 * The next zoom after one +/− press: multiplicative (so steps feel even
 * across the range — 0.12→0.16 and 1.0→1.35 are the same "one notch"),
 * clamped to the chart's limits.
 */
export function zoomStep(
  zoom: number,
  direction: 1 | -1,
  min: number,
  max: number,
  factor: number = ZOOM_STEP_FACTOR,
): number {
  return clampZoom(direction === 1 ? zoom * factor : zoom / factor, min, max);
}

/**
 * Bounding rect of a set of fixed-size nodes given their top-left positions.
 * Used instead of xyflow's `getNodesBounds` for subtree focus because it
 * needs no DOM measurement: right after a drill-down expand, freshly mounted
 * nodes may not be measured yet, but dagre has already given every node a
 * position and all org nodes share one known size.
 */
export function nodesRect(
  positions: readonly { x: number; y: number }[],
  nodeWidth: number,
  nodeHeight: number,
): Rect | null {
  if (!positions.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + nodeWidth,
    height: maxY - minY + nodeHeight,
  };
}

/**
 * The zoom at which `rect` exactly fits in `pane` with xyflow's fitView
 * padding semantics (`padding: 0.12` reserves 12% of the rect's size on each
 * side, i.e. the rect is treated as (1 + 2·padding)× its size). Mirroring
 * fitView's own arithmetic matters: the overview uses this to decide
 * *whether* to fit BEFORE moving the viewport, and a decision made with
 * different math than the move would fit-then-correct in front of the user.
 */
export function fitZoom(pane: Size, rect: Rect, padding: number): number {
  const pad = 1 + padding * 2;
  return Math.min(
    pane.width / (rect.width * pad),
    pane.height / (rect.height * pad),
  );
}

/**
 * Centre-and-zoom instruction that shows `rect` in `pane`: centred on the
 * rect, at its fit zoom clamped into [minZoom, maxZoom]. When the clamp
 * engages, the centre holds — a subtree too big for maxLegible crops evenly
 * on all sides rather than sliding off one edge, and a single node hits
 * maxZoom instead of filling the screen.
 */
export function fitTarget(
  pane: Size,
  rect: Rect,
  opts: { padding: number; minZoom: number; maxZoom: number },
): CenterTarget {
  return {
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
    zoom: clampZoom(fitZoom(pane, rect, opts.padding), opts.minZoom, opts.maxZoom),
  };
}

/**
 * Every id in the subtree rooted at `rootId` (inclusive), walking
 * `childrenById` depth-first. Defensive against cycles even though
 * buildOrgTree guarantees an acyclic child map — this feeds an expansion set
 * and a viewport poll, and an infinite walk in either is a frozen tab.
 */
export function collectSubtreeIds(
  childrenById: ReadonlyMap<string, readonly string[]>,
  rootId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = childrenById.get(id);
    if (kids) for (const c of kids) stack.push(c);
  }
  return out;
}
