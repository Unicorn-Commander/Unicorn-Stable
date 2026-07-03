import { Bot, Cpu, Star, MessageSquarePlus } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  agentIdentity,
  TIER_META,
  tierOf,
  statusDot,
  STATUS_LABEL,
  toolCostInfo,
} from "./agentClass";
import { PaidToolsBadge } from "./AgentBadges";

/** The flat card grid (kept under "List"). Click a card to open the chat popup. */
export function AgentList({
  agents,
  onOpen,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="card animate-fade-in flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="glass glow-iris flex h-12 w-12 items-center justify-center rounded-2xl text-stable-purple-light">
          <Bot className="h-6 w-6" />
        </span>
        <div>
          <p className="font-display text-sm font-semibold text-slate-200">
            No residents match
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Try a different name, role, domain, or tool.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {agents.map((agent) => {
        const name = agent.display_name || agent.name;
        const affil = affiliationOf(agent);
        const affilMeta = AFFIL_META[affil];
        const tierMeta = TIER_META[tierOf(agent)];
        const ident = agentIdentity(agent);
        const subtitle = agent.title || agent.domain || "";
        const tools = agent.tools || [];
        const paidNames = new Set(toolCostInfo(agent).paidTools.map((t) => t.name));
        return (
          <li key={agent.id}>
            <button
              onClick={() => onOpen(agent)}
              title={`${affilMeta.label} · ${tierMeta.label} model`}
              className="card card-hover focus-ring group relative flex h-full w-full flex-col overflow-hidden p-4 pl-5 text-left"
            >
              {/* Affiliation legend — the colored left edge (a legend with meaning). */}
              <span
                aria-hidden="true"
                className={clsx("absolute inset-y-0 left-0 w-1", affilMeta.bar)}
              />
              <div className="flex items-start gap-3">
                <span
                  className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl text-lg text-white/90 shadow-soft"
                  style={{ background: ident.gradient }}
                >
                  {agent.avatar_url ? (
                    <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : agent.emoji ? (
                    <span aria-hidden="true">{agent.emoji}</span>
                  ) : (
                    <Bot className="h-5 w-5" />
                  )}
                  <span
                    className={clsx(
                      "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-1",
                      statusDot(agent.status),
                    )}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-slate-100">{name}</p>
                    <span className="flex shrink-0 items-center gap-1">
                      <PaidToolsBadge agent={agent} />
                      <span
                        className={clsx(
                          "inline-flex items-center rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1",
                          tierMeta.chip,
                        )}
                      >
                        {tierMeta.label}
                      </span>
                    </span>
                  </div>
                  {subtitle && (
                    <p className="truncate text-[11px] text-slate-400">{subtitle}</p>
                  )}
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <span
                      className={clsx("h-1.5 w-1.5 rounded-full", statusDot(agent.status))}
                    />
                    {STATUS_LABEL[agent.status]}
                    {agent.rank && (
                      <span className="ml-auto inline-flex items-center gap-0.5 text-slate-400">
                        <Star className="h-3 w-3" />
                        {agent.rank}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {tools.length > 0 && (
                <div className="mt-3 flex flex-1 flex-wrap content-start gap-1.5">
                  {tools.slice(0, 4).map((t) => (
                    <span
                      key={t}
                      title={paidNames.has(t) ? `${t} · costs money` : t}
                      className={clsx(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
                        paidNames.has(t)
                          ? "bg-amber-500/15 text-amber-200 ring-amber-500/25"
                          : "bg-white/[0.04] text-slate-400 ring-white/[0.06]",
                      )}
                    >
                      {paidNames.has(t) ? `$ ${t}` : t}
                    </span>
                  ))}
                  {tools.length > 4 && (
                    <span className="rounded-md bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-500">
                      +{tools.length - 4}
                    </span>
                  )}
                </div>
              )}

              <div
                className={clsx(
                  "flex items-center justify-between border-t border-line pt-3",
                  tools.length > 0 ? "mt-3" : "mt-3 flex-1 items-end",
                )}
              >
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
                  <Cpu className="h-3 w-3 shrink-0" />
                  <span className="max-w-[9rem] truncate">{agent.model || "—"}</span>
                </span>
                <span
                  className="flex shrink-0 items-center gap-1 text-xs font-semibold opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: ident.text }}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  Chat
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
