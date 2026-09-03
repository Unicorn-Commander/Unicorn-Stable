import { describe, expect, it } from "vitest";

import {
  DEFAULT_RIG,
  PUPPETS,
  hasPuppet,
  normalizeAgentKey,
  puppetForAgent,
  puppetForTexture,
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
  it.each(["iris", "sgt-quill", "Sgt. Quill", "gflow", ""])(
    "refuses %s, which has no character portrait",
    (key) => {
      expect(puppetForAgent(key, null)).toBeNull();
    },
  );

  // 2026-08-07: claude moved OUT of the refusal list — it has a real
  // character portrait now (Brand-Ops batch), so it must resolve.
  it("resolves claude, who gained a portrait in the 2026-08-07 batch", () => {
    expect(puppetForAgent("claude", null)?.texture).toBe(
      "/agent-puppets/claude.webp",
    );
  });

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

/**
 * The reverse lookup, which exists because a SLUG is not always a character.
 *
 * `claude-code` is the shared id of every Claude Code resident in the roster —
 * Aaron's box (Rook), Shafen's box, six webhook seats and `claude-orch1` all
 * normalize onto it — so slug lookup can only ever return the one generic
 * Claude drawing. A participant's own roster row is finer-grained, and this is
 * how that row's art becomes a rigged spec.
 */
describe("texture → puppet resolution", () => {
  it("resolves Rook from the art his participant row names", () => {
    // His row was written against the PNG master; the app ships the WebP.
    // Same drawing, and the roster must not be wrong about it.
    for (const url of [
      "/agent-puppets/rook-v2.png",
      "/agent-puppets/rook.webp",
    ]) {
      const spec = puppetForTexture(url);
      expect(spec?.label, url).toBe("Rook");
      expect(spec?.texture, url).toBe("/agent-puppets/rook.webp");
      // The RIG comes with it — a texture swap alone would animate his mouth
      // with somebody else's coordinates.
      expect(spec?.mouth.cy, url).toBeCloseTo(0.66, 2);
    }
  });

  it("is finer-grained than the slug, which decides for a whole class", () => {
    // `claude-code` is aliased to Rook today, so the slug DOES reach his face —
    // at the documented cost that anything presenting as plain "Claude Code"
    // wears it too. The seam below is what can tell those participants apart:
    // one member row, one picture.
    expect(puppetForAgent("claude-code", null)?.label).toBe("Rook");
    expect(puppetForAgent("Claude Code", null)?.label).toBe("Rook");
    // The generic drawing is still registered and still reachable by the seats
    // that alias onto the id rather than presenting as the bare name.
    expect(puppetForTexture("/agent-puppets/claude-code.webp")?.label).toBe(
      "Claude Code",
    );
    // Shafen's seat is its own character (Flow) since the crew set; the
    // generic drawing is still what the webhook dev residents wear.
    expect(puppetForAgent("shafen-claude-code", null)?.label).toBe("Flow");
    expect(puppetForAgent("webhook-dev-stable", null)?.texture).toBe(
      "/agent-puppets/claude-code.webp",
    );
  });

  it("returns nothing for art we do not ship", () => {
    // The url comes out of a database column an agent can write, and the two
    // places the caller would put it are a WebGL texture upload and an <img
    // src>. Refusing anything but our own registered paths means neither can
    // ever receive the caller's string.
    expect(puppetForTexture("https://evil.example/rook-v2.png")).toBeNull();
    expect(puppetForTexture("/agent-puppets/not-a-puppet.webp")).toBeNull();
    expect(puppetForTexture("/avatars/rook-v2.png")).toBeNull();
    expect(puppetForTexture("rook-v2.png")).toBeNull();
    expect(puppetForTexture(null)).toBeNull();
    expect(puppetForTexture("")).toBeNull();
    expect(puppetForTexture("   ")).toBeNull();
  });

  it("tolerates a cache-buster or fragment on our own path", () => {
    expect(puppetForTexture("/agent-puppets/majik.webp?v=3")?.label).toBe(
      "Majik",
    );
    expect(puppetForTexture("/agent-puppets/majik.webp#x")?.label).toBe("Majik");
  });

  it("round-trips every registered texture", () => {
    for (const [id, spec] of Object.entries(PUPPETS)) {
      expect(puppetForTexture(spec.texture), id).toBe(spec);
    }
  });
});

describe("puppet artwork", () => {
  it("serves every texture from our own origin", () => {
    for (const [id, spec] of Object.entries(PUPPETS)) {
      // A cross-origin image cannot be uploaded into a WebGL texture without
      // CORS, and Brigade's avatars live on a different origin — so a relative
      // path under /agent-puppets/ is not a style preference, it is the
      // difference between a face and a failed load.
      // The CONTAINER format is not the invariant — same-origin under
      // /agent-puppets/ is. Rook's art shipped as PNG; that is a fact about
      // the encoder, and a WebP-only regex would have refused a perfectly
      // loadable texture. "The file actually exists" is asserted against the
      // filesystem in brandAvatars.test.ts, which is the real typo guard.
      expect(spec.texture, `${id} texture must be same-origin`).toMatch(
        /^\/agent-puppets\/[a-z0-9-]+\.(webp|png)$/,
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
