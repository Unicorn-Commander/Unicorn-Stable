/**
 * The head is judged by eye, not by assertion — these cover the two things a
 * screenshot cannot tell you.
 *
 *  1. Which agent gets the rainbow. That is a product decision (Aaron approved
 *     Majik, nobody else) and it must not drift into a substring heuristic that
 *     quietly repaints a new agent.
 *  2. That every geometry, material and texture the builder allocates is
 *     released by dispose(). Popout/re-dock tears the whole rig down and
 *     rebuilds it, and a leak there is a leak per cycle, forever.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildProceduralUnicornHead,
  resolveManeStyle,
} from "@/components/Agents/proceduralUnicornHead";

describe("resolveManeStyle", () => {
  it("gives Majik the rainbow from either the slug or the display name", () => {
    expect(resolveManeStyle("majik", "Majik")).toBe("rainbow");
    expect(resolveManeStyle("agent-majik", null)).toBe("rainbow");
    expect(resolveManeStyle(null, "Chat with Majik")).toBe("rainbow");
    expect(resolveManeStyle("MAJIK", null)).toBe("rainbow");
  });

  it("leaves every other agent on its identity hue", () => {
    for (const id of ["triage", "sidekick", "gunny", "general", "corporal"]) {
      expect(resolveManeStyle(id, id)).toBe("identity");
    }
    expect(resolveManeStyle(null, null)).toBe("identity");
    // Not a substring match: a different agent whose name merely contains the
    // approved one must not inherit an approved character trait.
    expect(resolveManeStyle("majikal", "Majikal")).toBe("identity");
  });
});

describe("buildProceduralUnicornHead", () => {
  it("still accepts the bare-hue call signature", () => {
    const rig = buildProceduralUnicornHead("#8b5cf6");
    expect(rig.root.children.length).toBeGreaterThan(0);
    rig.dispose();
  });

  it("hinges the jaw and swaps the mouth shapes across the range", () => {
    const rig = buildProceduralUnicornHead({ hue: "#8b5cf6", mane: "rainbow" });
    const jaw = rig.root.getObjectByName("jaw");
    expect(jaw).toBeDefined();
    rig.setMouthOpen(0);
    const shut = jaw?.rotation.x ?? 0;
    rig.setMouthOpen(1);
    expect(jaw?.rotation.x ?? 0).toBeGreaterThan(shut);
    // Clamped, not thrown, on out-of-range input from a noisy audio level.
    expect(() => {
      rig.setMouthOpen(4);
      rig.setMouthOpen(-1);
      rig.setBlink(2);
      rig.setHeadTurn(0.2, -0.1);
    }).not.toThrow();
    rig.dispose();
  });

  it("disposes every geometry, material and texture it allocated", () => {
    const rig = buildProceduralUnicornHead({ hue: "#22d3ee", mane: "identity" });

    const owned = new Set<{ dispose: () => void }>();
    rig.root.traverse((o) => {
      const m = o as unknown as {
        geometry?: { dispose: () => void };
        material?: { dispose: () => void; gradientMap?: { dispose: () => void } };
      };
      if (m.geometry) owned.add(m.geometry);
      if (m.material) {
        owned.add(m.material);
        if (m.material.gradientMap) owned.add(m.material.gradientMap);
      }
    });
    expect(owned.size).toBeGreaterThan(10);

    const spies = [...owned].map((o) => vi.spyOn(o, "dispose"));
    rig.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(rig.root.children).toHaveLength(0);
  });
});
