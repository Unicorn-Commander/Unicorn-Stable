import { describe, expect, it } from "vitest";
import {
  ANALYSER_FULL_SPEECH,
  ANALYSER_NOISE_FLOOR,
  MOUTH_NOISE_FLOOR,
  MOUTH_NORMAL_SPEECH,
  blinkAmount,
  idleMouthOpen,
  mouthOpenFromAnalyserVolume,
  mouthOpenFromLevel,
  resolveMouthMorph,
  smoothLevel,
} from "./mouthShape";

describe("resolveMouthMorph", () => {
  it("prefers the ARKit name", () => {
    expect(resolveMouthMorph(["blink", "mouthOpen", "jawOpen", "aa"])).toBe(
      "jawOpen",
    );
  });

  it("falls back through the VRM viseme presets in order", () => {
    expect(resolveMouthMorph(["blink", "aa", "ih", "ou"])).toBe("aa");
    expect(resolveMouthMorph(["blink", "A", "I", "U"])).toBe("A");
    expect(resolveMouthMorph(["mouthOpen", "eyeBlink"])).toBe("mouthOpen");
  });

  it("is case-insensitive — exporters disagree about A vs a", () => {
    expect(resolveMouthMorph(["JawOpen"])).toBe("JawOpen");
    expect(resolveMouthMorph(["MOUTHOPEN"])).toBe("MOUTHOPEN");
  });

  it("sweeps for anything jaw/mouth-ish when no alias matches", () => {
    // This is what rescues a hand-authored rig from a non-standard exporter.
    expect(resolveMouthMorph(["Fcl_MTH_A", "head_jaw_open"])).toBe(
      "head_jaw_open",
    );
    expect(resolveMouthMorph(["eyeLookUp", "mouth_wide"])).toBe("mouth_wide");
  });

  it("returns null rather than driving an arbitrary morph", () => {
    // Driving whatever happens to be first would inflate an eyebrow with the
    // agent's voice, which reads as a bug rather than as a missing feature.
    expect(resolveMouthMorph(["eyeBlinkLeft", "browUp"])).toBeNull();
    expect(resolveMouthMorph([])).toBeNull();
    expect(resolveMouthMorph(null)).toBeNull();
    expect(resolveMouthMorph(undefined)).toBeNull();
  });
});

describe("smoothLevel", () => {
  it("moves a fraction of the way toward the target", () => {
    expect(smoothLevel(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(smoothLevel(0.5, 0.5, 0.25)).toBeCloseTo(0.5);
  });

  it("converges rather than overshooting", () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = smoothLevel(v, 0.2, 0.25);
    expect(v).toBeGreaterThan(0.199);
    expect(v).toBeLessThanOrEqual(0.2);
  });

  it("clamps a nonsense alpha instead of exploding", () => {
    expect(smoothLevel(0, 1, 5)).toBe(1);
    expect(smoothLevel(0.4, 1, -2)).toBe(0.4);
  });

  it("treats NaN as silence — a dead participant must not freeze the mouth", () => {
    expect(smoothLevel(NaN, 0.5, 0.5)).toBeCloseTo(0.25);
    expect(smoothLevel(0.5, NaN, 1)).toBe(0);
  });
});

describe("mouthOpenFromLevel", () => {
  it("is fully shut at and below the noise floor", () => {
    expect(mouthOpenFromLevel(0)).toBe(0);
    expect(mouthOpenFromLevel(MOUTH_NOISE_FLOOR)).toBe(0);
    expect(mouthOpenFromLevel(MOUTH_NOISE_FLOOR - 0.001)).toBe(0);
    expect(mouthOpenFromLevel(-1)).toBe(0);
  });

  it("is fully open by the time speech reaches normal loudness", () => {
    expect(mouthOpenFromLevel(MOUTH_NORMAL_SPEECH)).toBeCloseTo(1);
    expect(mouthOpenFromLevel(0.9)).toBe(1);
  });

  it("APPLIES GAIN — the whole reason this is not a pass-through", () => {
    // LiveKit reports ~0.05 for ordinary speech. Feeding that straight to a
    // morph gives a jaw that moves by a pixel: technically animated, visibly
    // dead. A quiet-but-real voice must already read as an open mouth.
    const quietSpeech = 0.05;
    expect(quietSpeech).toBeLessThan(0.1);
    expect(mouthOpenFromLevel(quietSpeech)).toBeGreaterThan(0.45);
  });

  it("is monotonic across the speech range", () => {
    let previous = -1;
    for (let level = 0; level <= 0.3; level += 0.005) {
      const open = mouthOpenFromLevel(level);
      expect(open).toBeGreaterThanOrEqual(previous);
      previous = open;
    }
  });

  it("never leaves 0..1, whatever it is handed", () => {
    for (const level of [NaN, Infinity, -Infinity, 1e9, -1e9, 0.0001, 1]) {
      const open = mouthOpenFromLevel(level);
      expect(open).toBeGreaterThanOrEqual(0);
      expect(open).toBeLessThanOrEqual(1);
    }
  });
});

describe("mouthOpenFromAnalyserVolume", () => {
  it("gates silence to fully closed", () => {
    expect(mouthOpenFromAnalyserVolume(0)).toBe(0);
    expect(mouthOpenFromAnalyserVolume(ANALYSER_NOISE_FLOOR)).toBe(0);
    expect(mouthOpenFromAnalyserVolume(ANALYSER_NOISE_FLOOR * 0.5)).toBe(0);
  });

  it("reaches fully open at conversational analyser RMS", () => {
    expect(mouthOpenFromAnalyserVolume(ANALYSER_FULL_SPEECH)).toBe(1);
    expect(mouthOpenFromAnalyserVolume(0.9)).toBe(1);
  });

  it("is monotonic through the speech band", () => {
    let previous = -1;
    for (let v = ANALYSER_NOISE_FLOOR; v <= ANALYSER_FULL_SPEECH; v += 0.02) {
      const open = mouthOpenFromAnalyserVolume(v);
      expect(open).toBeGreaterThanOrEqual(previous);
      previous = open;
    }
  });

  it("never leaves 0..1, whatever it is handed", () => {
    for (const volume of [NaN, Infinity, -Infinity, 1e9, -1, 0.5, 1]) {
      const open = mouthOpenFromAnalyserVolume(volume);
      expect(open).toBeGreaterThanOrEqual(0);
      expect(open).toBeLessThanOrEqual(1);
    }
  });
});

describe("idle life", () => {
  it("breathes, but stays well below a visible gape", () => {
    const samples = [0, 400, 900, 1400, 2000, 2600].map(idleMouthOpen);
    for (const s of samples) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(0.06);
    }
    // It must actually MOVE — a constant would read as a frozen frame.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.01);
  });

  it("blinks: shut briefly, open for most of the cycle", () => {
    expect(blinkAmount(0, 4200)).toBeCloseTo(0, 5);
    expect(blinkAmount(65, 4200)).toBeGreaterThan(0.9); // mid-blink
    expect(blinkAmount(600, 4200)).toBe(0);
    expect(blinkAmount(4200 + 65, 4200)).toBeGreaterThan(0.9); // next cycle
  });
});
