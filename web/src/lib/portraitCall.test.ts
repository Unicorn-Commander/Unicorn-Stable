import { describe, it, expect } from "vitest";
import { shouldUsePortraitStage, clampSelfView } from "./portraitCall";
const phone = {
  desktop: false,
  landscape: false,
  mode: "video",
  remoteCount: 1,
  screenCount: 0,
  view: "grid",
  chips: false,
};
describe("portrait one-to-one stage", () => {
  it("fills a phone video call with one remote", () =>
    expect(shouldUsePortraitStage(phone)).toBe(true));
  it.each([
    { desktop: true },
    { landscape: true },
    { mode: "split" },
    { mode: "chat" },
    { remoteCount: 2 },
    { remoteCount: 0 },
    { screenCount: 1 },
    { view: "screen" },
    { chips: true },
  ])("preserves other layouts %j", (override) =>
    expect(shouldUsePortraitStage({ ...phone, ...override })).toBe(false),
  );
  it("keeps self-view clear of edges, top switcher and bottom controls", () => {
    expect(clampSelfView(-100, -100, 390, 700)).toEqual({ x: 8, y: 64 });
    expect(clampSelfView(2000, 2000, 390, 700)).toEqual({ x: 270, y: 408 });
  });
  it("clamps a dragged view after the viewport shrinks", () =>
    expect(clampSelfView(270, 408, 320, 568)).toEqual({ x: 200, y: 276 }));
});
