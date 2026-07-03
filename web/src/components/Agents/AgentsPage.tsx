import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Bot, Search, Network, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { type Agent } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import {
  AFFIL_META,
  TIER_META,
  relatedByDomain,
  type Affiliation,
  type Tier,
} from "./agentClass";
import { AgentOrgChart } from "./AgentOrgChart";
import { AgentList } from "./AgentList";
import { AgentChatModal } from "./AgentChatModal";

type View = "chart" | "list";

/**
 * The agent roster — two views of the same roster (from Brigade): an org-chart
 * (orchestration → domain teams) and a flat card list. Click any agent to open a
 * popup that starts a chat with that agent or several at once. Classification:
 * affiliation = side-border, model tier = chip; rank + tools shown.
 */
export function AgentsPage() {
  const agents = useAppStore((s) => s.agents);
  const [view, setView] = useState<View>("chart");
  const [query, setQuery] = useState("");
  const [modalAgent, setModalAgent] = useState<Agent | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        (a.display_name || a.name).toLowerCase().includes(q) ||
        (a.title || "").toLowerCase().includes(q) ||
        (a.domain || "").toLowerCase().includes(q) ||
        (a.description || "").toLowerCase().includes(q) ||
        (a.capabilities || []).some((c) => c.toLowerCase().includes(q)) ||
        (a.tools || []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [agents, query]);

  const onlineCount = useMemo(
    () => agents.filter((a) => a.status !== "offline").length,
    [agents],
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {/* Hero */}
        <header className="card relative mb-6 overflow-hidden px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_90%_at_88%_0%,rgba(139,92,246,0.14),transparent_62%),radial-gradient(40%_70%_at_100%_100%,rgba(34,211,238,0.1),transparent_65%),radial-gradient(28%_55%_at_60%_100%,rgba(52,211,153,0.07),transparent_70%)]"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-2.5 flex items-center gap-2.5">
              <span className="gradient-bg flex h-7 w-7 items-center justify-center rounded-lg">
                <Bot className="h-4 w-4 text-white" />
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Agent roster
              </span>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              <span className="text-slate-50">Your </span>
              <span className="gradient-text-aurora">residents</span>
            </h1>
            <p className="mt-1.5 text-sm text-slate-400">
              <span className="tabular-nums">{agents.length}</span> resident
              {agents.length === 1 ? "" : "s"} ·{" "}
              <span className="inline-flex items-center gap-1.5">
                <span className="animate-live h-1.5 w-1.5 rounded-full bg-stable-mint" />
                <span className="tabular-nums">{onlineCount}</span> online
              </span>{" "}
              · click any to start a chat (one or several)
            </p>
          </div>
        </header>

        {/* Toolbar: view toggle + search */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 self-start rounded-xl border border-line bg-surface-1 p-1 shadow-soft">
            <button
              onClick={() => setView("chart")}
              className={clsx(
                "focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                view === "chart"
                  ? "gradient-bg text-white shadow-sm"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
              )}
            >
              <Network className="h-3.5 w-3.5" />
              Org chart
            </button>
            <button
              onClick={() => setView("list")}
              className={clsx(
                "focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                view === "list"
                  ? "gradient-bg text-white shadow-sm"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              List
            </button>
          </div>
          <div className="relative sm:w-80">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search name, role, domain, tool…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-xl border border-line bg-slate-950/60 py-2.5 pl-10 pr-3.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
              aria-label="Search agents"
            />
          </div>
        </div>

        {/* Legend — two axes */}
        <div className="mb-5 flex flex-col gap-2 text-[11px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Affiliation
            </span>
            {(
              ["employee", "contractor", "third_party", "frontier"] as Affiliation[]
            ).map((a) => (
              <span
                key={a}
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5",
                  AFFIL_META[a].chip,
                )}
              >
                <span className={clsx("h-3 w-1 rounded-full", AFFIL_META[a].bar)} />
                <span className={clsx("font-medium", AFFIL_META[a].text)}>
                  {AFFIL_META[a].label}
                </span>
              </span>
            ))}
          </span>
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Model
            </span>
            {(["local", "frontier", "flexible"] as Tier[]).map((t) => (
              <span
                key={t}
                className={clsx(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1",
                  TIER_META[t].chip,
                )}
              >
                {TIER_META[t].label}
              </span>
            ))}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-200 ring-1 ring-amber-500/30">
              $
            </span>
            <span className="font-medium text-amber-200/80">tool costs money</span>
          </span>
        </div>

        {/* Active view */}
        {view === "chart" ? (
          <AgentOrgChart
            agents={filtered}
            onOpen={setModalAgent}
            expandAll={query.trim().length > 0}
          />
        ) : (
          <AgentList agents={filtered} onOpen={setModalAgent} />
        )}
      </div>

      <AnimatePresence>
        {modalAgent && (
          <AgentChatModal
            focusAgent={modalAgent}
            agents={agents}
            preselectIds={relatedByDomain(modalAgent, agents).map((a) => a.id)}
            onClose={() => setModalAgent(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
