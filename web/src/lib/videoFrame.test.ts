import { describe, expect, it } from "vitest";
import {
  MIN_PICTURE_MEAN,
  MIN_PICTURE_SPREAD,
  frameHasPicture,
  frameLumaStats,
} from "./videoFrame";

/** RGBA bytes for a run of identical pixels. */
function flat(r: number, g: number, b: number, pixels = 576): number[] {
  return Array.from({ length: pixels * 4 }, (_, i) =>
    i % 4 === 0 ? r : i % 4 === 1 ? g : i % 4 === 2 ? b : 255,
  );
}

describe("frameLumaStats", () => {
  it("reports zero spread for a flat frame", () => {
    const s = frameLumaStats(flat(17, 17, 17));
    expect(s.spread).toBe(0);
    expect(s.min).toBeCloseTo(17, 5);
    expect(s.max).toBeCloseTo(17, 5);
    expect(s.mean).toBeCloseTo(17, 5);
  });

  it("is safe on an empty buffer", () => {
    expect(frameLumaStats([])).toEqual({ min: 0, max: 0, mean: 0, spread: 0 });
  });

  it("weights green most, like Rec.601", () => {
    const green = frameLumaStats(flat(0, 255, 0)).mean;
    const red = frameLumaStats(flat(255, 0, 0)).mean;
    const blue = frameLumaStats(flat(0, 0, 255)).mean;
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe("frameHasPicture", () => {
  it("REJECTS the agent face track measured on dogfood", () => {
    // The real numbers, 2026-08-02, sampled off the live stage tile at 32x18:
    // a 640x360 readyState-4 stream in which every pixel is luma 17.3. If this
    // ever returns true, the stage goes back to being a black rectangle and the
    // talking face is invisible again.
    const stats = { min: 17.3, max: 17.3, mean: 17.3, spread: 0 };
    expect(frameHasPicture(stats)).toBe(false);
  });

  it("rejects pure black and pure flat grey", () => {
    expect(frameHasPicture(frameLumaStats(flat(0, 0, 0)))).toBe(false);
    expect(frameHasPicture(frameLumaStats(flat(20, 20, 20)))).toBe(false);
  });

  it("accepts a dim frame that has any structure in it", () => {
    // A webcam in a dark room: low mean, but not uniform. This must show.
    const dim = [...flat(8, 8, 8, 500), ...flat(20, 20, 20, 76)];
    const stats = frameLumaStats(dim);
    expect(stats.mean).toBeLessThan(MIN_PICTURE_MEAN);
    expect(frameHasPicture(stats)).toBe(true);
  });

  it("accepts a bright but genuinely flat frame", () => {
    // A camera pointed at a lit wall: no structure, but obviously a picture.
    const stats = frameLumaStats(flat(210, 210, 210));
    expect(stats.spread).toBeLessThan(MIN_PICTURE_SPREAD);
    expect(frameHasPicture(stats)).toBe(true);
  });

  it("is exactly at the boundary it documents", () => {
    expect(frameHasPicture({ min: 0, max: MIN_PICTURE_SPREAD, mean: 1, spread: MIN_PICTURE_SPREAD })).toBe(true);
    expect(
      frameHasPicture({
        min: 0,
        max: MIN_PICTURE_SPREAD - 0.01,
        mean: 1,
        spread: MIN_PICTURE_SPREAD - 0.01,
      }),
    ).toBe(false);
    expect(frameHasPicture({ min: 0, max: 0, mean: MIN_PICTURE_MEAN, spread: 0 })).toBe(true);
  });
});
