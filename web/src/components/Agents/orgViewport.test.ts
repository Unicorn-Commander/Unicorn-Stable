import { describe, it, expect } from "vitest";
import {
  clampZoom,
  zoomStep,
  nodesRect,
  fitZoom,
  fitTarget,
  collectSubtreeIds,
  FIT_MIN_ZOOM,
  FIT_PADDING,
  LEGIBLE_ZOOM,
  CHART_MAX_ZOOM,
  ZOOM_STEP_FACTOR,
} from "./orgViewport";

describe("clampZoom", () => {
  it("passes a zoom already inside the range through unchanged", () => {
    expect(clampZoom(0.7, 0.12, 1.6)).toBe(0.7);
  });

  it("clamps below to min and above to max", () => {
    expect(clampZoom(0.01, 0.12, 1.6)).toBe(0.12);
    expect(clampZoom(9, 0.12, 1.6)).toBe(1.6);
  });

  it("lands exactly on the bounds at the bounds", () => {
    expect(clampZoom(0.12, 0.12, 1.6)).toBe(0.12);
    expect(clampZoom(1.6, 0.12, 1.6)).toBe(1.6);
  });
});

describe("zoomStep", () => {
  it("multiplies in and divides out by the step factor", () => {
    expect(zoomStep(1, 1, FIT_MIN_ZOOM, CHART_MAX_ZOOM)).toBeCloseTo(
      ZOOM_STEP_FACTOR,
    );
    expect(zoomStep(1, -1, FIT_MIN_ZOOM, CHART_MAX_ZOOM)).toBeCloseTo(
      1 / ZOOM_STEP_FACTOR,
    );
  });

  it("one step in then one step out returns to the start", () => {
    const there = zoomStep(0.5, 1, FIT_MIN_ZOOM, CHART_MAX_ZOOM);
    expect(zoomStep(there, -1, FIT_MIN_ZOOM, CHART_MAX_ZOOM)).toBeCloseTo(0.5);
  });

  it("pins at the limits instead of walking past them", () => {
    expect(zoomStep(CHART_MAX_ZOOM, 1, FIT_MIN_ZOOM, CHART_MAX_ZOOM)).toBe(
      CHART_MAX_ZOOM,
    );
    expect(zoomStep(FIT_MIN_ZOOM, -1, FIT_MIN_ZOOM, CHART_MAX_ZOOM)).toBe(
      FIT_MIN_ZOOM,
    );
  });
});

describe("nodesRect", () => {
  const W = 212;
  const H = 78;

  it("returns null for no nodes — there is nothing to frame", () => {
    expect(nodesRect([], W, H)).toBeNull();
  });

  it("a single node's rect is its own footprint", () => {
    expect(nodesRect([{ x: 40, y: -10 }], W, H)).toEqual({
      x: 40,
      y: -10,
      width: W,
      height: H,
    });
  });

  it("spans the union of all node footprints", () => {
    // Apex at origin, two reports one tier down — the rect must reach the
    // right edge of the rightmost node and the bottom of the lower tier.
    const rect = nodesRect(
      [
        { x: 200, y: 0 },
        { x: 0, y: 148 },
        { x: 400, y: 148 },
      ],
      W,
      H,
    );
    expect(rect).toEqual({ x: 0, y: 0, width: 400 + W, height: 148 + H });
  });

  it("handles negative coordinates (dagre margins can go left of 0)", () => {
    const rect = nodesRect(
      [
        { x: -300, y: -50 },
        { x: 100, y: 20 },
      ],
      W,
      H,
    );
    expect(rect).toEqual({ x: -300, y: -50, width: 400 + W, height: 70 + H });
  });
});

describe("fitZoom", () => {
  const pane = { width: 1000, height: 500 };

  it("with zero padding is the plain contain-scale", () => {
    // 1000/400 = 2.5 wide, 500/200 = 2.5 tall — exact fit both ways.
    expect(fitZoom(pane, { x: 0, y: 0, width: 400, height: 200 }, 0)).toBe(2.5);
  });

  it("the tighter axis wins", () => {
    // Wide ribbon: width is the constraint.
    expect(
      fitZoom(pane, { x: 0, y: 0, width: 4000, height: 100 }, 0),
    ).toBeCloseTo(0.25);
    // Tall column: height is the constraint.
    expect(
      fitZoom(pane, { x: 0, y: 0, width: 100, height: 2000 }, 0),
    ).toBeCloseTo(0.25);
  });

  it("padding reserves a fraction of the rect on each side (fitView semantics)", () => {
    // padding 0.12 treats the rect as 1.24× its size in both axes.
    expect(
      fitZoom(pane, { x: 0, y: 0, width: 1000, height: 100 }, 0.12),
    ).toBeCloseTo(1 / 1.24);
  });

  it("position of the rect is irrelevant — only its size decides the zoom", () => {
    const a = fitZoom(pane, { x: 0, y: 0, width: 600, height: 300 }, 0.1);
    const b = fitZoom(pane, { x: -900, y: 4000, width: 600, height: 300 }, 0.1);
    expect(a).toBe(b);
  });

  it("the leadership ribbon from the live org really is below legible zoom", () => {
    // The scenario the overview's anchor branch exists for: 15+ domain leads
    // in one dagre rank ≈ 3500px wide inside a ~1000px pane. Fitting that
    // lands far under LEGIBLE_ZOOM, so the overview must anchor, not fit.
    const would = fitZoom(
      { width: 1000, height: 700 },
      { x: 0, y: 0, width: 3500, height: 180 },
      FIT_PADDING,
    );
    expect(would).toBeLessThan(LEGIBLE_ZOOM);
  });
});

describe("fitTarget", () => {
  const pane = { width: 1000, height: 500 };
  const opts = { padding: 0, minZoom: 0.12, maxZoom: 1.1 };

  it("centres on the rect", () => {
    const t = fitTarget(pane, { x: 100, y: 60, width: 400, height: 200 }, opts);
    expect(t.cx).toBe(300);
    expect(t.cy).toBe(160);
  });

  it("uses the fit zoom when it is inside the clamp range", () => {
    const t = fitTarget(pane, { x: 0, y: 0, width: 1200, height: 500 }, opts);
    expect(t.zoom).toBeCloseTo(1000 / 1200);
  });

  it("clamps a tiny subject (one leaf node) to maxZoom, centre intact", () => {
    // A single 212×78 node in a 1000×500 pane would fit at ~4.7× — the clamp
    // keeps it at maxZoom so one card never fills the screen.
    const t = fitTarget(pane, { x: 500, y: 300, width: 212, height: 78 }, opts);
    expect(t.zoom).toBe(1.1);
    expect(t.cx).toBe(500 + 106);
    expect(t.cy).toBe(300 + 39);
  });

  it("clamps a huge subject to minZoom, cropping evenly around the centre", () => {
    const t = fitTarget(
      pane,
      { x: -5000, y: 0, width: 20000, height: 400 },
      opts,
    );
    expect(t.zoom).toBe(0.12);
    expect(t.cx).toBe(5000);
    expect(t.cy).toBe(200);
  });
});

describe("collectSubtreeIds", () => {
  // The live tree's shape: apex → leads → members.
  const children = new Map<string, string[]>([
    ["the-general", ["perry", "center-deep-lead", "majik"]],
    ["perry", ["motion-drafter", "gap-analyzer"]],
    ["center-deep-lead", ["maj-recon"]],
    ["majik", []],
    ["motion-drafter", []],
    ["gap-analyzer", []],
    ["maj-recon", []],
  ]);

  it("includes the root itself", () => {
    expect(collectSubtreeIds(children, "majik")).toEqual(["majik"]);
  });

  it("collects every level of a mid-tree subtree, and only that subtree", () => {
    const ids = collectSubtreeIds(children, "perry").sort();
    expect(ids).toEqual(["gap-analyzer", "motion-drafter", "perry"]);
  });

  it("from the apex reaches the whole org", () => {
    expect(collectSubtreeIds(children, "the-general")).toHaveLength(7);
  });

  it("an id with no children entry is just itself (roster drift tolerance)", () => {
    expect(collectSubtreeIds(children, "ghost")).toEqual(["ghost"]);
  });

  it("terminates on a cyclic child map instead of walking forever", () => {
    const cyclic = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(collectSubtreeIds(cyclic, "a").sort()).toEqual(["a", "b"]);
  });
});
