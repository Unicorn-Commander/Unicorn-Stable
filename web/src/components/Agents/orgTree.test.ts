import { describe, it, expect } from "vitest";
import { buildOrgTree } from "./orgTree";
import type { Agent } from "@/services/api";

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    name: partial.id,
    display_name: partial.id,
    description: "",
    avatar_url: null,
    status: "active",
    capabilities: [],
    model: "",
    ...partial,
  } as Agent;
}

// The live roster's shape, trimmed to the parts that decide the tree.
const ROSTER: Agent[] = [
  agent({ id: "the-general", display_name: "The General", rank: "Field Marshal", domain: "orchestration" }),
  agent({ id: "majik", display_name: "Majik", rank: "Field Marshal", domain: "orchestration" }),
  agent({ id: "gflow", display_name: "GFlow", rank: "Field Marshal", domain: "orchestration" }),
  agent({ id: "perry", display_name: "Perrywinkle Spector — General Counsel", rank: "General Counsel", domain: "legal" }),
  agent({ id: "motion-drafter", display_name: "Motion Drafter", rank: "Senior Counsel", domain: "legal" }),
  agent({ id: "gap-analyzer", display_name: "Gap Analyzer", rank: "Senior Analyst", domain: "legal" }),
  agent({ id: "center-deep-lead", display_name: "Center Deep Lead", rank: "Domain Lead", domain: "research" }),
  agent({ id: "maj-recon", display_name: "Maj. Recon", rank: "Major", domain: "research" }),
];

const withLines = (lines: Record<string, string | null>): Agent[] =>
  ROSTER.map((a) => ({ ...a, reports_to: lines[a.id] ?? null }));

// Brigade's backfill, i.e. the hierarchy live today.
const STATED: Record<string, string | null> = {
  "the-general": null,
  majik: "the-general",
  gflow: "the-general",
  perry: "the-general",
  "motion-drafter": "perry",
  "gap-analyzer": "perry",
  "center-deep-lead": "the-general",
  "maj-recon": "center-deep-lead",
};

describe("buildOrgTree", () => {
  it("renders the hierarchy Brigade states", () => {
    const tree = buildOrgTree(withLines(STATED));
    expect(tree.root?.id).toBe("the-general");
    expect(tree.parentOf.get("motion-drafter")).toBe("perry");
    expect(tree.parentOf.get("maj-recon")).toBe("center-deep-lead");
    expect([...tree.childrenById.get("the-general")!].sort()).toEqual([
      "center-deep-lead",
      "gflow",
      "majik",
      "perry",
    ]);
    // Every edge came from the registry, not a guess.
    expect([...tree.sourceOf.values()].every((s) => s === "brigade")).toBe(true);
  });

  it("follows reports_to even when it contradicts rank and domain", () => {
    // Deliberately NOT what rank/domain would produce: a Senior Counsel leads
    // legal and the General Counsel reports to a researcher. If the chart still
    // shows perry -> the-general, it is re-deriving instead of reading.
    const tree = buildOrgTree(
      withLines({ ...STATED, perry: "center-deep-lead", "motion-drafter": "the-general" }),
    );
    expect(tree.root?.id).toBe("the-general");
    expect(tree.parentOf.get("perry")).toBe("center-deep-lead");
    expect(tree.parentOf.get("motion-drafter")).toBe("the-general");
  });

  it("falls back to the rank/domain derivation when Brigade states nothing", () => {
    // The safety net for a stale Brigade: identical to the pre-registry tree.
    const tree = buildOrgTree(ROSTER);
    expect(tree.root?.id).toBe("the-general");
    expect(tree.parentOf.get("majik")).toBe("the-general");
    expect(tree.parentOf.get("gflow")).toBe("the-general");
    expect(tree.parentOf.get("perry")).toBe("the-general");
    expect(tree.parentOf.get("motion-drafter")).toBe("perry");
    expect(tree.parentOf.get("maj-recon")).toBe("center-deep-lead");
    expect([...tree.sourceOf.values()].every((s) => s === "derived")).toBe(true);
  });

  it("derives a line only for the agents Brigade left unstated", () => {
    const partial = { ...STATED };
    delete partial["maj-recon"]; // a newly registered agent with no line yet
    const tree = buildOrgTree(withLines(partial));
    expect(tree.parentOf.get("maj-recon")).toBe("center-deep-lead");
    expect(tree.sourceOf.get("maj-recon")).toBe("derived");
    expect(tree.sourceOf.get("motion-drafter")).toBe("brigade");
  });

  it("ignores a reporting line whose target is not on the roster", () => {
    const tree = buildOrgTree(withLines({ ...STATED, "gap-analyzer": "someone-who-left" }));
    expect(tree.parentOf.get("gap-analyzer")).toBe("perry"); // derived, not dropped
    expect(tree.byId.size).toBe(ROSTER.length);
  });

  it("does not hang on a cycle in the registry", () => {
    // A loop would be an infinite walk, not just a wrong-looking chart.
    const tree = buildOrgTree(
      withLines({ ...STATED, perry: "motion-drafter", "motion-drafter": "perry" }),
    );
    expect(tree.root?.id).toBe("the-general");
    // Everyone still lands somewhere, and no node is its own ancestor.
    for (const a of ROSTER) {
      if (a.id === tree.root!.id) continue;
      const seen = new Set<string>();
      let cursor: string | undefined = a.id;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = tree.parentOf.get(cursor);
      }
      expect(cursor).toBeUndefined();
      expect(seen.has(tree.root!.id)).toBe(true);
    }
  });
});
