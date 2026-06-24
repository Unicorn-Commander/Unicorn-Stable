import { useMemo } from "react";
import { Bot, Star } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  TIER_META,
  tierOf,
  statusDot,
  rankWeight,
  domainEmoji,
  prettyDomain,
  isOrchestrator,
} from "./agentClass";

function label(a: Agent): string {
  return a.display_name || a.name;
}

/**
 * Hierarchical org chart: an orchestration tier at the top, then domain "teams"
 * below (grouped by `domain`, lead = highest rank). Click any node to open the
 * chat popup. Mirrors Brigade's orchestrator → domain-leaders → members logic.
 */
export function AgentOrgChart({
  agents,
  onOpen,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
}) {
  const { orchestrators, domains } = useMemo(() => {
    const orch = agents
      .filter(isOrchestrator)
      .sort((a, b) => rankWeight(b.rank) - rankWeight(a.rank));
    const orchIds = new Set(orch.map((a) => a.id));
    const rest = agents.filter((a) => !orchIds.has(a.id));

    const byDomain = new Map<string, Agent[]>();
    for (const a of rest) {
      const key = (a.domain || "general").toLowerCase();
      const arr = byDomain.get(key);
      if (arr) arr.push(a);
      else byDomain.set(key, [a]);
    }
    const groups = [...byDomain.entries()]
      .map(([domain, members]) => ({
        domain,
        members: members.sort(
          (a, b) =>
            rankWeight(b.rank) - rankWeight(a.rank) ||
            label(a).localeCompare(label(b)),
        ),
      }))
      .sort((a, b) => b.members.length - a.members.length);
    return { orchestrators: orch, domains: groups };
  }, [agents]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-16 text-center">
        <Bot className="h-6 w-6 text-slate-600" />
        <p className="text-sm text-slate-500">No agents match your search.</p>
      </div>
    );
  }

  return (
    <div>
      {orchestrators.length > 0 && (
        <div className="mb-2 flex flex-col items-center">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Orchestration
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {orchestrators.map((a) => (
              <OrchestratorNode key={a.id} agent={a} onOpen={onOpen} />
            ))}
          </div>
          <div className="my-4 h-8 w-px bg-gradient-to-b from-stable-purple/60 to-transparent" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {domains.map(({ domain, members }) => (
          <section
            key={domain}
            className="rounded-2xl border border-slate-700/50 bg-slate-800/20 p-3"
          >
            <header className="mb-2 flex items-center gap-2 px-1">
              <span className="text-lg" aria-hidden="true">
                {domainEmoji(domain)}
              </span>
              <h3 className="flex-1 truncate text-sm font-semibold text-slate-200">
                {prettyDomain(domain)}
              </h3>
              <span className="rounded-full bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                {members.length}
              </span>
            </header>
            <ul className="space-y-1">
              {members.map((a, i) => (
                <MemberNode
                  key={a.id}
                  agent={a}
                  lead={i === 0 && members.length > 1}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function OrchestratorNode({
  agent,
  onOpen,
}: {
  agent: Agent;
  onOpen: (a: Agent) => void;
}) {
  const tierMeta = TIER_META[tierOf(agent)];
  return (
    <button
      onClick={() => onOpen(agent)}
      className="group flex w-44 flex-col items-center gap-2 rounded-2xl border border-stable-purple/30 bg-gradient-to-b from-stable-purple/10 to-slate-800/40 p-4 text-center transition-colors hover:border-stable-purple/60 hover:bg-slate-800/60"
    >
      <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-stable-purple/40 to-stable-cyan/30 text-2xl text-white shadow-lg shadow-stable-purple/20">
        {agent.avatar_url ? (
          <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : agent.emoji ? (
          <span aria-hidden="true">{agent.emoji}</span>
        ) : (
          <Bot className="h-6 w-6" />
        )}
        <span
          className={clsx(
            "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-slate-900",
            statusDot(agent.status),
          )}
        />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-slate-50">{label(agent)}</p>
        <p className="truncate text-[11px] text-stable-purple-light">
          {agent.title || prettyDomain(agent.domain)}
        </p>
      </div>
      <span
        className={clsx(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1",
          tierMeta.chip,
        )}
      >
        {tierMeta.label}
      </span>
    </button>
  );
}

function MemberNode({
  agent,
  lead,
  onOpen,
}: {
  agent: Agent;
  lead: boolean;
  onOpen: (a: Agent) => void;
}) {
  const affilMeta = AFFIL_META[affiliationOf(agent)];
  const tierMeta = TIER_META[tierOf(agent)];
  return (
    <li>
      <button
        onClick={() => onOpen(agent)}
        title={`${affilMeta.label} · ${tierMeta.label} model`}
        className={clsx(
          "flex w-full items-center gap-2.5 rounded-lg border-l-4 bg-slate-800/40 px-2.5 py-2 text-left transition-colors hover:bg-slate-800",
          affilMeta.border,
        )}
      >
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-stable-purple-light">
          {agent.avatar_url ? (
            <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : agent.emoji ? (
            <span aria-hidden="true">{agent.emoji}</span>
          ) : (
            <Bot className="h-4 w-4" />
          )}
          <span
            className={clsx(
              "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-800",
              statusDot(agent.status),
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-slate-200">
              {label(agent)}
            </span>
            {lead && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-stable-purple/20 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-stable-purple-light">
                <Star className="h-2.5 w-2.5" />
                Lead
              </span>
            )}
          </span>
          <span className="block truncate text-[11px] text-slate-500">
            {agent.title || agent.rank || prettyDomain(agent.domain)}
          </span>
        </span>
        <span
          className={clsx("h-2 w-2 shrink-0 rounded-full", tierMeta.dot)}
          title={`${tierMeta.label} model`}
        />
      </button>
    </li>
  );
}
