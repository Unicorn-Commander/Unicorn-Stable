import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Bot, Search, Network, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { type Agent } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import {
  AFFIL_META,
  TIER_META,
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
        <header className="relative mb-6 overflow-hidden rounded-2xl border border-stable-glass-border bg-slate-800/30 px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-stable-cyan/25 blur-3xl"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute -bottom-24 right-40 h-44 w-44 rounded-full bg-stable-purple/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-2 flex items-center gap-2">
              <span className="gradient-bg flex h-6 w-6 items-center justify-center rounded-md">
                <Bot className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Agent Roster
              </span>
            </div>
            <h1 className="text-2xl font-bold sm:text-3xl">
              <span className="text-slate-50">Your </span>
              <span className="gradient-text">agents</span>
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {agents.length} agent{agents.length === 1 ? "" : "s"} ·{" "}
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {onlineCount} online
              </span>{" "}
              · click any to start a chat (one or several)
            </p>
          </div>
        </header>

        {/* Toolbar: view toggle + search */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 self-start rounded-lg bg-slate-800/50 p-0.5">
            <button
              onClick={() => setView("chart")}
              className={clsx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                view === "chart"
                  ? "bg-stable-purple text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200",
              )}
            >
              <Network className="h-3.5 w-3.5" />
              Org Chart
            </button>
            <button
              onClick={() => setView("list")}
              className={clsx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                view === "list"
                  ? "bg-stable-purple text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200",
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              List
            </button>
          </div>
          <div className="relative sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search name, role, domain, tool…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg bg-slate-800/80 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 outline-none ring-1 ring-slate-700/50 transition-colors focus:ring-stable-purple/50"
              aria-label="Search agents"
            />
          </div>
        </div>

        {/* Legend — two axes */}
        <div className="mb-5 flex flex-col gap-2 text-[11px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold uppercase tracking-wide text-slate-600">
              Affiliation
            </span>
            {(
              ["employee", "contractor", "third_party", "frontier"] as Affiliation[]
            ).map((a) => (
              <span key={a} className="inline-flex items-center gap-1.5">
                <span className={clsx("h-3 w-1 rounded-full", AFFIL_META[a].bar)} />
                <span className={clsx("font-medium", AFFIL_META[a].text)}>
                  {AFFIL_META[a].label}
                </span>
              </span>
            ))}
          </span>
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold uppercase tracking-wide text-slate-600">
              Model
            </span>
            {(["local", "frontier", "flexible"] as Tier[]).map((t) => (
              <span
                key={t}
                className={clsx(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 font-medium ring-1",
                  TIER_META[t].chip,
                )}
              >
                {TIER_META[t].label}
              </span>
            ))}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-200 ring-1 ring-amber-500/30">
              $
            </span>
            <span className="font-medium text-amber-200/80">tool costs money</span>
          </span>
        </div>

        {/* Active view */}
        {view === "chart" ? (
          <AgentOrgChart agents={filtered} onOpen={setModalAgent} />
        ) : (
          <AgentList agents={filtered} onOpen={setModalAgent} />
        )}
      </div>

      <AnimatePresence>
        {modalAgent && (
          <AgentChatModal
            focusAgent={modalAgent}
            agents={agents}
            onClose={() => setModalAgent(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
