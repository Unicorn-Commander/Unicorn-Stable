import { Bot, Cpu, Star, MessageSquarePlus } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  TIER_META,
  tierOf,
  statusDot,
  STATUS_LABEL,
} from "./agentClass";

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
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-16 text-center">
        <Bot className="h-6 w-6 text-slate-600" />
        <p className="text-sm text-slate-500">No agents match your search.</p>
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
        const subtitle = agent.title || agent.domain || "";
        const tools = agent.tools || [];
        return (
          <li key={agent.id}>
            <button
              onClick={() => onOpen(agent)}
              title={`${affilMeta.label} · ${tierMeta.label} model`}
              className={clsx(
                "group flex h-full w-full flex-col rounded-xl border border-l-4 border-slate-700/50 bg-slate-800/30 p-4 text-left transition-colors hover:border-stable-purple/40 hover:bg-slate-800/60",
                affilMeta.border,
              )}
            >
              <div className="flex items-start gap-3">
                <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-lg text-stable-purple-light">
                  {agent.avatar_url ? (
                    <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : agent.emoji ? (
                    <span aria-hidden="true">{agent.emoji}</span>
                  ) : (
                    <Bot className="h-5 w-5" />
                  )}
                  <span
                    className={clsx(
                      "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-slate-800",
                      statusDot(agent.status),
                    )}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-slate-100">{name}</p>
                    <span
                      className={clsx(
                        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1",
                        tierMeta.chip,
                      )}
                    >
                      {tierMeta.label}
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
                      className="rounded-md bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400"
                    >
                      {t}
                    </span>
                  ))}
                  {tools.length > 4 && (
                    <span className="rounded-md bg-slate-700/30 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                      +{tools.length - 4}
                    </span>
                  )}
                </div>
              )}

              <div
                className={clsx(
                  "flex items-center justify-between border-t border-slate-700/40 pt-3",
                  tools.length > 0 ? "mt-3" : "mt-3 flex-1 items-end",
                )}
              >
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
                  <Cpu className="h-3 w-3 shrink-0" />
                  <span className="max-w-[9rem] truncate">{agent.model || "—"}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-stable-purple-light opacity-0 transition-opacity group-hover:opacity-100">
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
