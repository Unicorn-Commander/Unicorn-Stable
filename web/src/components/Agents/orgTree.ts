// Chain-of-command tree for the agent roster.
//
// The hierarchy is READ from Brigade, not re-derived here. Brigade is the
// registry for agent identity — name, rank, title and avatar are all chosen at
// registration and every consumer just renders them — and the reporting line
// belongs with them: `agents.reports_to`, served on the roster as `reports_to`.
// Stable used to infer parentage from rank + domain in its own port of
// Brigade's `buildOrgTree`, which meant two implementations in two languages
// asserting a chain of command that neither had actually been told, free to
// drift apart at any time.
//
// The rank/domain derivation survives as a per-agent FALLBACK: it places anyone
// Brigade has not stated a line for — a brand-new agent, or a Brigade too old
// to carry the column at all — so a stale registry degrades to the old guess
// instead of dropping people off the chart.
import type { Agent } from "@/services/api";
import { rankWeight, isOrchestrator } from "./agentClass";

export interface OrgTree {
  agents: Agent[];
  byId: Map<string, Agent>;
  root: Agent | null;
  parentOf: Map<string, string>;
  childrenById: Map<string, string[]>;
  edges: { id: string; source: string; target: string }[];
  /** Where each parent link came from — "brigade" (stated) or "derived". */
  sourceOf: Map<string, "brigade" | "derived">;
}

function label(a: Agent): string {
  return a.display_name || a.name;
}

function byRankThenName(a: Agent, b: Agent): number {
  return rankWeight(b.rank) - rankWeight(a.rank) || label(a).localeCompare(label(b));
}

/**
 * Apex when nobody has stated one: highest-rank orchestrator, else the
 * highest-rank agent.
 *
 * The orchestrator tier is a TIE (every one of them is a Field Marshal), and an
 * alphabetical tie-break put a *personal* orchestrator for another org at the
 * head of the whole company. So break the tie on supremacy first: the agent
 * whose title claims the org-wide role outranks the per-person ones.
 */
function deriveRoot(list: Agent[]): Agent | null {
  const isSupreme = (a: Agent): boolean =>
    /supreme/i.test(a.title || "") || a.id === "the-general";
  const orchestrators = list.filter(isOrchestrator).sort(byRankThenName);
  return (
    [...orchestrators].sort((a, b) => Number(isSupreme(b)) - Number(isSupreme(a)))[0] ||
    [...list].sort(byRankThenName)[0] ||
    null
  );
}

function domainOf(a: Agent): string {
  return (a.domain || "general").toLowerCase();
}

/**
 * The rank/domain guess, applied ONLY to whoever Brigade left unplaced.
 *
 * Other orchestrators report straight to the apex; everyone else groups by
 * domain, the highest-rank member of each group leads it and reports to the
 * apex, and the rest report to that lead. Writes no parent for an agent that
 * already has one, so against a fully-stated roster it does nothing, and
 * against a roster with no stated lines at all it reproduces exactly the tree
 * this file drew before Brigade owned the hierarchy.
 *
 * Domains are grouped over the WHOLE roster rather than the unplaced subset,
 * because a domain can be PARTLY stated: register one new specialist under
 * Legal without a reporting line and, grouped among the unplaced alone, they
 * would be the only candidate and get promoted to lead — a brand-new hire
 * standing beside the apex while their actual chief sits a level below. Judging
 * them against every peer in their domain lands them under the existing lead.
 */
function deriveInto(
  parentOf: Map<string, string>,
  root: Agent,
  list: Agent[],
  unplaced: Agent[],
): void {
  const unplacedIds = new Set(unplaced.map((a) => a.id));

  const needsDomain: Agent[] = [];
  for (const a of unplaced) {
    if (isOrchestrator(a)) parentOf.set(a.id, root.id);
    else needsDomain.push(a);
  }
  if (!needsDomain.length) return;

  const wanted = new Set(needsDomain.map(domainOf));
  const byDomain = new Map<string, Agent[]>();
  for (const a of list) {
    if (a.id === root.id || isOrchestrator(a)) continue;
    const d = domainOf(a);
    if (!wanted.has(d)) continue;
    const arr = byDomain.get(d);
    if (arr) arr.push(a);
    else byDomain.set(d, [a]);
  }
  for (const members of byDomain.values()) {
    const sorted = [...members].sort(byRankThenName);
    const lead = sorted[0]!;
    if (unplacedIds.has(lead.id)) parentOf.set(lead.id, root.id);
    for (const m of sorted.slice(1)) {
      if (unplacedIds.has(m.id)) parentOf.set(m.id, lead.id);
    }
  }
}

export function buildOrgTree(agents: Agent[]): OrgTree {
  const list = (agents || []).filter(Boolean);
  const byId = new Map(list.map((a) => [a.id, a]));

  // ── 1. What Brigade states ──────────────────────────────────────────────
  // Only edges we can actually draw: the target has to be on this roster, and
  // nobody reports to themselves.
  const stated = new Map<string, string>();
  for (const a of list) {
    const pid = a.reports_to;
    if (pid && pid !== a.id && byId.has(pid)) stated.set(a.id, pid);
  }

  // Brigade's database is not a trust boundary Stable controls, and a cycle in
  // it would be an infinite walk in this UI rather than merely a wrong-looking
  // chart. Drop every edge whose ancestor chain fails to terminate; those
  // agents fall through to the derivation below instead.
  const terminates = new Map<string, boolean>();
  for (const start of stated.keys()) {
    if (terminates.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = start;
    let ok: boolean | undefined;
    while (cursor !== undefined) {
      const memo = terminates.get(cursor);
      if (memo !== undefined) {
        ok = memo;
        break;
      }
      if (onPath.has(cursor)) {
        ok = false; // looped back onto our own path
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = stated.get(cursor);
    }
    if (ok === undefined) ok = true; // ran off the top = a real apex
    for (const id of path) terminates.set(id, ok);
  }
  for (const [id, ok] of terminates) {
    if (!ok) stated.delete(id);
  }

  // ── 2. The apex ─────────────────────────────────────────────────────────
  // Root selection must follow the SAME source as parentage or the chart
  // contradicts itself — parenting everyone by `reports_to` while picking the
  // root by rank can hang the real apex under an impostor. So when Brigade
  // states a hierarchy, walk one of its lines to the top.
  let root: Agent | null = null;
  const firstStated = stated.keys().next();
  if (!firstStated.done) {
    let cursorId: string = firstStated.value;
    for (let up = stated.get(cursorId); up !== undefined; up = stated.get(cursorId)) {
      cursorId = up;
    }
    root = byId.get(cursorId) ?? null;
  }
  if (!root) root = deriveRoot(list);

  // ── 3. Fill the gaps ────────────────────────────────────────────────────
  const parentOf = new Map<string, string>(stated);
  if (root) {
    parentOf.delete(root.id); // the apex reports to nobody, whatever a stale row says
    const apex = root;
    const unplaced = list.filter((a) => a.id !== apex.id && !parentOf.has(a.id));
    if (unplaced.length) deriveInto(parentOf, apex, list, unplaced);
  }

  const sourceOf = new Map<string, "brigade" | "derived">();
  for (const [id, pid] of parentOf) {
    sourceOf.set(id, stated.get(id) === pid ? "brigade" : "derived");
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

  return { agents: list, byId, root, parentOf, childrenById, edges, sourceOf };
}

export default buildOrgTree;
