// Chain-of-command tree for the agent roster — the apex orchestrator at the
// root, domain leads reporting to it, and each domain's members under their
// lead. Mirrors Brigade's buildOrgTree (rank-aware domain fallback), adapted to
// Stable's Agent shape. Honors an explicit `reports_to` if the API ever adds it.
import type { Agent } from "@/services/api";
import { rankWeight, isOrchestrator } from "./agentClass";

export interface OrgTree {
  agents: Agent[];
  byId: Map<string, Agent>;
  root: Agent | null;
  parentOf: Map<string, string>;
  childrenById: Map<string, string[]>;
  edges: { id: string; source: string; target: string }[];
}

function label(a: Agent): string {
  return a.display_name || a.name;
}

function byRankThenName(a: Agent, b: Agent): number {
  return rankWeight(b.rank) - rankWeight(a.rank) || label(a).localeCompare(label(b));
}

export function buildOrgTree(agents: Agent[]): OrgTree {
  const list = (agents || []).filter(Boolean);
  const byId = new Map(list.map((a) => [a.id, a]));

  // Apex = highest-rank orchestrator; fall back to the highest-rank agent.
  //
  // The orchestrator tier is a TIE (every one of them is a Field Marshal), and
  // an alphabetical tie-break put a *personal* orchestrator for another org at
  // the head of the whole company. So break the tie on supremacy first: the
  // agent whose title claims the org-wide role outranks the per-person ones.
  const isSupreme = (a: Agent): boolean =>
    /supreme/i.test(a.title || "") || a.id === "the-general";
  const orchestrators = list.filter(isOrchestrator).sort(byRankThenName);
  const root =
    [...orchestrators].sort(
      (a, b) => Number(isSupreme(b)) - Number(isSupreme(a)),
    )[0] ||
    [...list].sort(byRankThenName)[0] ||
    null;

  const parentOf = new Map<string, string>();
  if (root) {
    const orchIds = new Set(orchestrators.map((a) => a.id));
    // Other orchestrators report straight to the apex.
    for (const o of orchestrators) {
      if (o.id !== root.id) parentOf.set(o.id, root.id);
    }
    // Everyone else groups by domain; the highest-rank member leads, reporting
    // to the apex, and the rest report to that lead.
    const rest = list.filter((a) => a.id !== root.id && !orchIds.has(a.id));
    const byDomain = new Map<string, Agent[]>();
    for (const a of rest) {
      const d = (a.domain || "general").toLowerCase();
      const arr = byDomain.get(d);
      if (arr) arr.push(a);
      else byDomain.set(d, [a]);
    }
    for (const members of byDomain.values()) {
      const sorted = [...members].sort(byRankThenName);
      const lead = sorted[0]!;
      parentOf.set(lead.id, root.id);
      for (const m of sorted.slice(1)) parentOf.set(m.id, lead.id);
    }
  }

  const childrenById = new Map<string, string[]>(list.map((a) => [a.id, []]));
  for (const [id, pid] of parentOf) childrenById.get(pid)?.push(id);
  for (const kids of childrenById.values()) {
    kids.sort((x, y) => rankWeight(byId.get(y)?.rank) - rankWeight(byId.get(x)?.rank));
  }

  const edges = [...parentOf.entries()].map(([id, pid]) => ({
    id: `e-${pid}-${id}`,
    source: pid,
    target: id,
  }));

  return { agents: list, byId, root, parentOf, childrenById, edges };
}

export default buildOrgTree;
