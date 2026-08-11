import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_STYLE,
  FACE_PREF_KEY,
  FACE_STYLE_META,
  FACE_STYLE_ORDER,
  isFaceStyle,
  nextFaceStyle,
  type FaceStyle,
} from "./facePreference";

describe("face style vocabulary", () => {
  it("is exactly the four agreed styles, auto first (the default)", () => {
    expect([...FACE_STYLE_ORDER]).toEqual(["auto", "puppet", "vrm", "portrait"]);
    expect(DEFAULT_FACE_STYLE).toBe("auto");
  });

  it("every style carries settings copy (label + one-line blurb)", () => {
    for (const style of FACE_STYLE_ORDER) {
      const meta = FACE_STYLE_META[style];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
    }
  });

  it("the storage key is versioned — the seam for the per-agent v2", () => {
    expect(FACE_PREF_KEY).toBe("stable.facePref.v1");
  });
});

describe("isFaceStyle", () => {
  it("accepts the four styles and nothing else", () => {
    for (const style of FACE_STYLE_ORDER) expect(isFaceStyle(style)).toBe(true);
    expect(isFaceStyle("3d")).toBe(false);
    expect(isFaceStyle("")).toBe(false);
    expect(isFaceStyle(null)).toBe(false);
    expect(isFaceStyle(undefined)).toBe(false);
    expect(isFaceStyle(1)).toBe(false);
  });
});

describe("nextFaceStyle — the per-tile cycle", () => {
  it("cycles auto → puppet → vrm → portrait → auto", () => {
    expect(nextFaceStyle("auto")).toBe("puppet");
    expect(nextFaceStyle("puppet")).toBe("vrm");
    expect(nextFaceStyle("vrm")).toBe("portrait");
    expect(nextFaceStyle("portrait")).toBe("auto");
  });

  it("visits every style exactly once per lap, from any start", () => {
    for (const start of FACE_STYLE_ORDER) {
      const seen = new Set<FaceStyle>();
      let cur = start;
      for (let i = 0; i < FACE_STYLE_ORDER.length; i++) {
        seen.add(cur);
        cur = nextFaceStyle(cur);
      }
      expect(cur).toBe(start); // a full lap returns home
      expect(seen.size).toBe(FACE_STYLE_ORDER.length);
    }
  });

  it("an unknown value restarts at the default rather than sticking", () => {
    expect(nextFaceStyle("bogus" as FaceStyle)).toBe("auto");
  });
});
