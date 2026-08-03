import { describe, expect, it } from "vitest";

import {
  DEFAULT_RIG,
  PUPPETS,
  hasPuppet,
  normalizeAgentKey,
  puppetForAgent,
  toUv,
} from "@/lib/puppetRig";

/**
 * Resolution has to work from any of the three ways Stable addresses an agent:
 * the LiveKit identity (`agent-<id>`), the Brigade id, or a display name off a
 * room title. Brigade ids are not clean slugs — `cpl.-colophon` carries a
 * literal dot — and the Ops leads' display names share nothing at all with
 * their ids, which is what the alias table exists for.
 */
describe("agent → puppet resolution", () => {
  it.each([
    ["majik", "Majik"],
    ["agent-majik", "Majik"],
    ["Chat with Majik", "Majik"],
    ["cpl.-colophon", "Cpl. Colophon"],
    ["Cpl. Colophon", "Cpl. Colophon"],
    ["prudence", "Prudence Finch"],
    ["prudence-finch", "Prudence Finch"],
    ["perry", "Perrywinkle Spector"],
    ["perrywinkle-spector", "Perrywinkle Spector"],
    ["accounting-ops-cfo", "Col. Ledger"],
    ["Col. Ledger", "Col. Ledger"],
    ["Capt. Cadence", "Capt. Cadence"],
    ["the-general", "The General"],
  ])("resolves %s", (key, label) => {
    expect(puppetForAgent(key, null)?.label).toBe(label);
  });

  it("resolves from the display name when the id does not match", () => {
    expect(puppetForAgent("some-unmapped-id", "Prof. Fathom")?.label).toBe(
      "Prof. Fathom",
    );
  });

  /**
   * Iris is still bound to a neon LOGO emblem — a line-art robot with no mouth
   * — and Sgt. Quill's art is a quill and a book with no face at all. Puppeting
   * either would composite a black mouth into the middle of a logo, silently,
   * on a live call. They must resolve to null and fall to the procedural head.
   */
  it.each(["iris", "sgt-quill", "Sgt. Quill", "gflow", "claude", ""])(
    "refuses %s, which has no character portrait",
    (key) => {
      expect(puppetForAgent(key, null)).toBeNull();
    },
  );

  it("treats missing identity as no puppet rather than throwing", () => {
    expect(hasPuppet(null, null)).toBe(false);
    expect(hasPuppet(undefined, undefined)).toBe(false);
  });

  it("folds punctuation rather than assuming kebab-case", () => {
    expect(normalizeAgentKey("agent-Cpl. Colophon")).toBe("cpl-colophon");
    expect(normalizeAgentKey("Chat with The General")).toBe("the-general");
    expect(normalizeAgentKey("  ")).toBe("");
  });

  /* A near-miss must not resolve: partial matching here would bind an agent to
   * somebody else's face, which is worse than no face. */
  it("does not match on a prefix or a superstring", () => {
    expect(puppetForAgent("majikal", null)).toBeNull();
    expect(puppetForAgent("not-majik", null)).toBeNull();
  });
});

describe("puppet artwork", () => {
  it("serves every texture from our own origin", () => {
    for (const [id, spec] of Object.entries(PUPPETS)) {
      // A cross-origin image cannot be uploaded into a WebGL texture without
      // CORS, and Brigade's avatars live on a different origin — so a relative
      // path under /agent-puppets/ is not a style preference, it is the
      // difference between a face and a failed load.
      expect(spec.texture, `${id} texture must be same-origin`).toMatch(
        /^\/agent-puppets\/[a-z0-9-]+\.webp$/,
      );
    }
  });

  it("gives every puppet a distinct texture", () => {
    const seen = new Set(Object.values(PUPPETS).map((s) => s.texture));
    expect(seen.size).toBe(Object.keys(PUPPETS).length);
  });
});

describe("rig geometry", () => {
  const ALL: Array<[string, typeof DEFAULT_RIG]> = [
    ["DEFAULT_RIG", DEFAULT_RIG],
    ...Object.entries(PUPPETS).map(
      ([id, spec]) => [id, spec] as [string, typeof DEFAULT_RIG],
    ),
  ];

  /* The opening grows DOWNWARD from the mouth line. If it reaches past the
   * bottom of the face the cavity is being drawn on the collar — the exact bug
   * `openDepth` was introduced to make visible. */
  it.each(ALL)("%s keeps the full opening on the face", (_id, rig) => {
    expect(rig.mouth.cy + rig.openDepth).toBeLessThan(0.85);
    expect(rig.mouth.cy - rig.mouth.ry).toBeGreaterThan(0.3);
    expect(rig.openDepth).toBeGreaterThan(0);
  });

  it.each(ALL)("%s has the eyes above the mouth", (_id, rig) => {
    expect(rig.eyeL.cy).toBeLessThan(rig.mouth.cy);
    expect(rig.eyeR.cy).toBeLessThan(rig.mouth.cy);
    // eyeL is the viewer's left, so it must be the smaller x. The shader
    // derives nothing from the names, but a swap would put a lid on the wrong
    // socket the moment a character stops being symmetric.
    expect(rig.eyeL.cx).toBeLessThan(rig.eyeR.cx);
  });

  it("flips y exactly once, top-down → y-up", () => {
    expect(toUv({ cx: 0.4, cy: 0.25, rx: 0.03, ry: 0.04 })).toEqual([
      0.4, 0.75, 0.03, 0.04,
    ]);
  });
});
