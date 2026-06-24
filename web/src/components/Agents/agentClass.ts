// Shared agent-classification helpers used by the org-chart, the card list, and
// the chat popup. Keeping them in one place keeps the two views consistent.
import type { Agent } from "@/services/api";

export const STATUS_LABEL: Record<Agent["status"], string> = {
  active: "Online",
  idle: "Idle",
  working: "Working",
  offline: "Offline",
};

export function statusDot(status: Agent["status"]): string {
  switch (status) {
    case "working":
      return "bg-amber-400";
    case "active":
      return "bg-emerald-400";
    case "idle":
      return "bg-slate-400";
    default:
      return "bg-slate-600";
  }
}

// ── Axis 1: AFFILIATION (who operates the agent) — the colored side-border ──
export type Affiliation = "employee" | "contractor" | "third_party";

export const AFFIL_META: Record<
  Affiliation,
  { label: string; border: string; bar: string; text: string }
> = {
  employee: {
    label: "Employee",
    border: "border-l-emerald-400",
    bar: "bg-emerald-400",
    text: "text-emerald-300",
  },
  contractor: {
    label: "Contractor",
    border: "border-l-amber-400",
    bar: "bg-amber-400",
    text: "text-amber-300",
  },
  third_party: {
    label: "3rd-party",
    border: "border-l-rose-400",
    bar: "bg-rose-400",
    text: "text-rose-300",
  },
};

export function affiliationOf(agent: Agent): Affiliation {
  const a = (agent.affiliation || "").toLowerCase();
  if (a === "contractor") return "contractor";
  if (a === "third_party" || a === "third-party" || a === "3rd_party") {
    return "third_party";
  }
  return "employee";
}

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
  return (
    id === "majik" ||
    id.includes("general") ||
    id.includes("orchestrat") ||
    n.includes("general") ||
    n.includes("orchestrat") ||
    rankWeight(agent.rank) >= 11
  );
}
