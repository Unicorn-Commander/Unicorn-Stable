import { describe, expect, it } from "vitest";
import { PORTRAITS, EMBLEMS, brandAvatarFor } from "@/lib/brandAvatars";
import { PUPPETS, normalizeAgentKey, puppetForTexture } from "@/lib/puppetRig";

/**
 * The invariant these tests exist for: A PATH IN A TABLE IS NOT A PICTURE.
 *
 * Brigade's roster spent months claiming 41 avatar files that were never
 * generated — every one of them a plausible-looking `/avatars/<slug>-v2.png`
 * that 404'd, which is invisible in a diff and only shows up as a missing face
 * on the page. The bundled tiers can fail exactly the same way: rename a WebP,
 * or add a row with a typo in the filename, and the roster silently drops that
 * agent back to a generic head. Unlike the remote URLs, this one is cheap to
 * prove — the files are in the repo, so assert against the filesystem.
 */
/**
 * The art that actually ships, enumerated by Vite rather than by `node:fs` —
 * the web tsconfig carries no node types, and one regression test is not worth
 * putting @types/node into the app's type graph. The glob is resolved at
 * transform time against `web/public`, so a renamed or deleted file changes
 * this set exactly the way a missing file should.
 */
const SHIPPED = new Set(
  Object.keys({
    ...import.meta.glob("../../public/agent-puppets/*.webp"),
    // PNG too: the puppet set was all-WebP until Rook, whose art was delivered
    // as PNG. A glob that only saw WebP would have reported his real, shipped
    // file as missing — the opposite of what this test is for.
    ...import.meta.glob("../../public/agent-puppets/*.png"),
    ...import.meta.glob("../../public/agent-avatars/*.png"),
  }),
);

/** Does `/agent-puppets/x.webp` name a file that ships? */
function ships(src: string): boolean {
  return [...SHIPPED].some((k) => k.endsWith(src));
}

describe("bundled agent art", () => {
  it("enumerated some art at all (guards the glob itself)", () => {
    // Without this, a glob that silently matched nothing would make every
    // "missing" assertion below pass vacuously.
    expect(SHIPPED.size).toBeGreaterThan(20);
  });

  it("ships a real file for every flat portrait", () => {
    const missing = Object.entries(PORTRAITS)
      .filter(([, src]) => !ships(src))
      .map(([key, src]) => `${key} -> ${src}`);
    expect(missing).toEqual([]);
  });

  it("ships a real file for every emblem", () => {
    const missing = Object.entries(EMBLEMS)
      .filter(([, src]) => !ships(src))
      .map(([key, src]) => `${key} -> ${src}`);
    expect(missing).toEqual([]);
  });

  it("ships a real file for every rigged puppet texture", () => {
    const missing = Object.entries(PUPPETS)
      .filter(([, spec]) => !ships(spec.texture))
      .map(([key, spec]) => `${key} -> ${spec.texture}`);
    expect(missing).toEqual([]);
  });

  it("ships a real file for every superseded texture path too", () => {
    // Same invariant one step further out: a participant row can name the PNG
    // master rather than the shipped WebP, and `puppetForTexture` maps it
    // across. If the master is ever deleted the mapping still resolves — so
    // the file has to be asserted, not assumed.
    const supersededRookMaster = "/agent-puppets/rook-v2.png";
    expect(ships(supersededRookMaster)).toBe(true);
    expect(puppetForTexture(supersededRookMaster)?.label).toBe("Rook");
  });

  /**
   * The two tables answer different questions ("what can we animate" vs "what
   * picture exists"), so an id in both would be ambiguous — and worse, the
   * PUPPETS entry would win and animate art whose rig was never calibrated.
   */
  it("keeps the rigged and flat tiers disjoint", () => {
    const overlap = Object.keys(PORTRAITS).filter((k) => k in PUPPETS);
    expect(overlap).toEqual([]);
  });

  it("keys every portrait on an already-normalized agent id", () => {
    const unnormalized = Object.keys(PORTRAITS).filter(
      (k) => normalizeAgentKey(k) !== k,
    );
    expect(unnormalized).toEqual([]);
  });

  it("resolves art for the legal drafters that used to fall through", () => {
    // The family behind Aaron's "legal drafter with that basic unicorn":
    // every one of these resolved to null before, so they rendered the
    // procedural head while their Brigade URL 404'd.
    for (const id of [
      "brief-drafter",
      "complaint-drafter",
      "motion-drafter",
      "discovery-drafter",
      "demand-letter-drafter",
      "foia-drafter",
      "deposition-prep",
      "cross-exam-builder",
      "devils-advocate",
    ]) {
      expect(brandAvatarFor(id), id).toBe(`/agent-puppets/${id}.webp`);
    }
  });

  it("still prefers the rigged puppet when an agent has one", () => {
    expect(brandAvatarFor("majik")).toBe("/agent-puppets/majik.webp");
    // …and keeps matching a display name, not just an id.
    expect(brandAvatarFor("Chat with Majik")).toBe("/agent-puppets/majik.webp");
  });

  it("returns null for an agent with no art, so the fallback still runs", () => {
    expect(brandAvatarFor("no-such-agent-anywhere")).toBeNull();
    expect(brandAvatarFor(null)).toBeNull();
  });
});
