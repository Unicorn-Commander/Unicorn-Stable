// Shared agent-classification helpers used by the org-chart, the card list, and
// the chat popup. Keeping them in one place keeps the two views consistent.
import type { Agent } from "@/services/api";
import { identityFor, type Identity } from "@/lib/identity";

/**
 * Identity hue for an agent — one wrapper so every Agents view resolves the
 * same resident to the same hue. Identity color goes on avatar tiles, dots and
 * name accents ONLY — never on the affiliation left-borders below, which are a
 * legend with meaning.
 */
export function agentIdentity(agent: Agent): Identity {
  return identityFor(agent.id, agent.display_name || agent.name);
}

export const STATUS_LABEL: Record<Agent["status"], string> = {
  active: "Online",
  idle: "Idle",
  working: "Working",
  offline: "Offline",
};

/**
 * Background class for an agent's status dot.
 *
 * These map to the `--color-status-*` tokens, NOT to raw Tailwind greys, for
 * two reasons that both bit us:
 *
 *  1. The old values were the text ramp (`bg-slate-400` / `bg-slate-600`).
 *     Retuning that ramp for text legibility silently dragged idle and offline
 *     together until they were 1.54:1 apart — two different states rendering as
 *     the same dot. State colour must not share a scale with something tuned
 *     for a different purpose.
 *  2. `bg-emerald-400` / `bg-amber-400` are fixed palette values that do not
 *     flip with the theme, so in light mode they sat at roughly 1.9:1 on white.
 *
 * The tokens are held to a separation contract by check-contrast.mjs — see
 * STATE_GROUPS there. Prefer the <StatusDot> component over calling this
 * directly; it adds the accessible name these dots otherwise lack.
 */
export function statusDot(status: Agent["status"]): string {
  switch (status) {
    case "working":
      return "bg-status-working";
    case "active":
      return "bg-status-active";
    case "idle":
      return "bg-status-idle";
    default:
      return "bg-status-offline";
  }
}

// ── Axis 1: AFFILIATION (who operates the agent) — the colored side-border ──
// Canonical colors, shared with Brigade's org chart so the two products match.
export type Affiliation = "employee" | "contractor" | "third_party" | "frontier";

export const AFFIL_META: Record<
  Affiliation,
  { label: string; border: string; bar: string; text: string; chip: string }
> = {
  employee: {
    label: "Employee",
    border: "border-l-emerald-400",
    bar: "bg-emerald-400",
    text: "text-emerald-300",
    chip: "border-emerald-400/30 bg-emerald-400/10",
  },
  contractor: {
    label: "Contractor",
    border: "border-l-amber-400",
    bar: "bg-amber-400",
    text: "text-amber-300",
    chip: "border-amber-400/30 bg-amber-400/10",
  },
  third_party: {
    label: "3rd-party",
    border: "border-l-rose-400",
    bar: "bg-rose-400",
    text: "text-rose-300",
    chip: "border-rose-400/30 bg-rose-400/10",
  },
  frontier: {
    label: "Frontier",
    border: "border-l-violet-400",
    bar: "bg-violet-400",
    text: "text-violet-300",
    chip: "border-violet-400/30 bg-violet-400/10",
  },
};

export function affiliationOf(agent: Agent): Affiliation {
  const a = (agent.affiliation || "").toLowerCase();
  if (a === "contractor") return "contractor";
  if (a === "third_party" || a === "third-party" || a === "3rd_party") {
    return "third_party";
  }
  if (a === "frontier") return "frontier";
  if (a === "employee") return "employee";
  // No explicit affiliation: fall back to model tier so the border is still
  // meaningful — a frontier-model agent reads as frontier, everything else as
  // employee (we run it).
  return tierOf(agent) === "frontier" ? "frontier" : "employee";
}

// ── Tool cost / permission (from Brigade's tool_catalog, surfaced per agent) ──
export type CostTier = "free" | "paid" | "subscription";

export interface ToolDetail {
  name: string;
  displayName?: string | null;
  costTier?: CostTier;
  permissionLevel?: number;
  provider?: string | null;
  external?: boolean;
}

export const COST_META: Record<
  Exclude<CostTier, "free">,
  { label: string; chip: string }
> = {
  paid: { label: "Paid", chip: "bg-amber-500/15 text-amber-200 ring-amber-500/30" },
  subscription: {
    label: "Subscription",
    chip: "bg-amber-500/15 text-amber-200 ring-amber-500/30",
  },
};

export interface ToolCostInfo {
  total: number;
  paidCount: number;
  externalCount: number;
  maxPermissionLevel: number;
  paidTools: ToolDetail[];
}

/** Summarize an agent's tool costs from toolDetails (falling back to the
 *  toolCostSummary rollup, then to the bare `tools` string array). */
export function toolCostInfo(agent: Agent): ToolCostInfo {
  const details = agent.tool_details || [];
  if (details.length) {
    const paidTools = details.filter((t) => t.costTier && t.costTier !== "free");
    return {
      total: details.length,
      paidCount: paidTools.length,
      externalCount: details.filter((t) => t.external).length,
      maxPermissionLevel: details.reduce(
        (m, t) => Math.max(m, t.permissionLevel || 0),
        0,
      ),
      paidTools,
    };
  }
  const s = agent.tool_cost_summary;
  return {
    total: s?.total ?? (agent.tools?.length || 0),
    paidCount: s?.paid ?? 0,
    externalCount: s?.external ?? 0,
    maxPermissionLevel: s?.maxPermissionLevel ?? 0,
    paidTools: [],
  };
}

// The clicked agent + its domain teammates (clicked one first), capped — used to
// pre-load the chat popup so "talk to many at once" is one click.
export function relatedByDomain(
  agent: Agent,
  agents: Agent[],
  cap = 6,
): Agent[] {
  const d = (agent.domain || "").toLowerCase();
  if (!d) return [agent];
  const team = agents.filter(
    (a) => a.id !== agent.id && (a.domain || "").toLowerCase() === d,
  );
  return [agent, ...team].slice(0, cap);
}

// Permission level (1..5) → a short human label for tooltips.
export const PERMISSION_LABEL: Record<number, string> = {
  1: "Basic",
  2: "Standard",
  3: "Elevated",
  4: "Sensitive",
  5: "Privileged",
};

// ── Axis 2: MODEL TIER (what powers it) — derived from the model, shown as a chip ──
export type Tier = "local" | "frontier" | "flexible";

export const TIER_META: Record<Tier, { label: string; chip: string; dot: string }> = {
  local: {
    label: "Local",
    chip: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
    dot: "bg-emerald-400",
  },
  frontier: {
    label: "Frontier",
    chip: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
    dot: "bg-violet-400",
  },
  flexible: {
    label: "Flexible",
    chip: "bg-cyan-500/10 text-cyan-300 ring-cyan-500/30",
    dot: "bg-cyan-400",
  },
};

export function tierOf(agent: Agent): Tier {
  const m = (agent.model || "").toLowerCase();
  const name = (agent.display_name || agent.name || "").toLowerCase();
  if (
    name === "majik" ||
    agent.id === "majik" ||
    m.includes("switch") ||
    m.includes("auto") ||
    m.includes("router")
  ) {
    return "flexible";
  }
  if (
    m.startsWith("local/") ||
    m.startsWith("ollama") ||
    /\b(qwen|llama|gemma|mistral|phi|deepseek)\b/.test(m)
  ) {
    return "local";
  }
  return "frontier";
}

// ── Rank → seniority weight (for sorting within a team + picking the lead). ──
// The roster mixes military + professional titles; this is an approximate scale.
const RANK_WEIGHT: Record<string, number> = {
  "field marshal": 11,
  general: 11,
  // C-suite: domain leads that head a function or an Ops app. Deliberately
  // below the orchestrator tier (11) — a chief runs a domain, the apex runs
  // the org — and above every specialist rank so a chief always leads its
  // own domain in the org chart.
  "chief medical officer": 10,
  "chief financial officer": 10,
  "chief marketing officer": 10,
  "chief technology officer": 10,
  "chief operating officer": 10,
  "chief of staff": 10,
  "general counsel": 10,
  "domain lead": 9,
  commander: 9,
  colonel: 8,
  "lieutenant colonel": 7,
  professor: 7,
  "senior counsel": 6,
  major: 6,
  captain: 5,
  "senior investigator": 5,
  "senior analyst": 5,
  "chief warrant officer": 4,
  lieutenant: 4,
  senior: 4,
  "gunnery sergeant": 3,
  "sergeant first class": 3,
  specialist: 2,
  sergeant: 2,
  resident: 1,
};

export function rankWeight(rank?: string | null): number {
  if (!rank) return 0;
  return RANK_WEIGHT[rank.trim().toLowerCase()] ?? 0;
}

// ── Domain → emoji (mirrors Brigade's domain glyphs; falls back to a unicorn). ──
const DOMAIN_EMOJI: Record<string, string> = {
  financial: "💰",
  finance: "💰",
  legal: "⚖️",
  medical: "⚕️",
  health: "⚕️",
  technology: "💻",
  tech: "💻",
  devops: "🛠️",
  engineering: "🧰",
  intelligence: "🧠",
  investigation: "🕵️",
  "crisis-ops": "🚨",
  crisis: "🚨",
  cybersecurity: "🔒",
  security: "🔒",
  compliance: "📋",
  operations: "⚙️",
  ops: "⚙️",
  research: "🔬",
  sales: "📈",
  marketing: "📣",
  content: "✍️",
  data: "📊",
  support: "🎧",
  intake: "📥",
  contacts: "📇",
  customer: "🤝",
  meetings: "🗓️",
  knowledge: "📚",
  general: "🦄",
};

export function domainEmoji(domain?: string | null): string {
  if (!domain) return "🦄";
  return DOMAIN_EMOJI[domain.trim().toLowerCase()] ?? "🦄";
}

export function prettyDomain(domain?: string | null): string {
  if (!domain) return "General";
  return domain
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Is this agent an apex orchestrator (the top of the chart)?
export function isOrchestrator(agent: Agent): boolean {
  const n = (agent.display_name || agent.name || "").toLowerCase();
  const id = (agent.id || "").toLowerCase();
  // "General Counsel" is a LAWYER, not a general. Matching the bare substring
  // "general" promoted Perry to the apex tier and left Legal to be led by a
  // Senior Counsel — so require the standalone word, and never let a counsel
  // title qualify. Same for a domain's "Crisis Ops Orchestrator", who leads a
  // domain rather than the org: an explicit orchestration domain or the
  // orchestrator rank tier is what makes an apex-tier agent.
  const isCounsel = /counsel/.test(n);
  const saysGeneral = /\bgeneral\b/.test(n) || /(^|-)general(-|$)/.test(id);
  const saysOrchestrator =
    id.includes("orchestrat") || n.includes("orchestrat");
  const orchestrationDomain =
    (agent.domain || "").toLowerCase() === "orchestration";
  return (
    id === "majik" ||
    orchestrationDomain ||
    (saysGeneral && !isCounsel) ||
    (saysOrchestrator && !isCounsel && orchestrationDomain) ||
    rankWeight(agent.rank) >= 11
  );
}
