import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Search, MessageSquarePlus, Cpu } from "lucide-react";
import clsx from "clsx";
import { api, type Agent } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

const STATUS_LABEL: Record<Agent["status"], string> = {
  active: "Online",
  idle: "Idle",
  working: "Working",
  offline: "Offline",
};

function statusDot(status: Agent["status"]): string {
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

// Sourcing classification — a colored side-border tells you at a glance whether
// an agent runs on a model we own (local) vs a frontier/3rd-party model, or can
// flex between the two per task. v1 is DERIVED from the agent's model routing;
// the canonical plan is to persist this on the agent record (brigade_db.agents)
// so Brigade's org chart shows the same badges — see the cross-repo follow-up.
type SourceClass = "employee" | "frontier" | "flexible";

const SOURCE_META: Record<
  SourceClass,
  { label: string; bar: string; text: string; hint: string }
> = {
  employee: {
    label: "Employee",
    bar: "bg-emerald-400",
    text: "text-emerald-300",
    hint: "Local model — owned by us",
  },
  frontier: {
    label: "Frontier",
    bar: "bg-violet-400",
    text: "text-violet-300",
    hint: "3rd-party / frontier model",
  },
  flexible: {
    label: "Flexible",
    bar: "bg-cyan-400",
    text: "text-cyan-300",
    hint: "Local or frontier, per task",
  },
};

const SOURCE_BORDER: Record<SourceClass, string> = {
  employee: "border-l-emerald-400",
  frontier: "border-l-violet-400",
  flexible: "border-l-cyan-400",
};

function classifySource(agent: Agent): SourceClass {
  const m = (agent.model || "").toLowerCase();
  const name = (agent.display_name || agent.name || "").toLowerCase();
  // Orchestrators / model-switchers can pick either tier per task.
  if (
    name === "majik" ||
    agent.id === "majik" ||
    m.includes("switch") ||
    m.includes("auto") ||
    m.includes("router")
  ) {
    return "flexible";
  }
  // Models we host locally (owned).
  if (
    m.startsWith("local/") ||
    m.startsWith("ollama") ||
    /\b(qwen|llama|gemma|mistral|phi|deepseek)\b/.test(m)
  ) {
    return "employee";
  }
  // Everything else (anthropic / openai / google / uc gateway / claude / gpt).
  return "frontier";
}

/**
 * The agent roster ("org chart") — every agent as a card, click one to open a
 * 1:1 chat. Reads the already-loaded `agents` store (AppShell fetches it), so
 * there's no extra request. Online agents sort first; search matches name,
 * description, and capabilities.
 */
export function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useAppStore((s) => s.agents);
  const [query, setQuery] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? agents.filter(
          (a) =>
            (a.display_name || a.name).toLowerCase().includes(q) ||
            (a.description || "").toLowerCase().includes(q) ||
            (a.capabilities || []).some((c) => c.toLowerCase().includes(q)),
        )
      : agents;
    const rank = (a: Agent) => (a.status === "offline" ? 1 : 0);
    return [...list].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.display_name || a.name).localeCompare(b.display_name || b.name),
    );
  }, [agents, query]);

  const onlineCount = useMemo(
    () => agents.filter((a) => a.status !== "offline").length,
    [agents],
  );

  async function startChat(agent: Agent) {
    if (startingId) return;
    setStartingId(agent.id);
    try {
      const room = await api.createAgentDm(
        agent.id,
        `Chat with ${agent.display_name || agent.name}`,
      );
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      navigate(`/c/${room.id}`);
    } catch (err) {
      console.error("start agent chat failed", err);
      alert("Couldn't start a chat — " + (err as Error).message);
    } finally {
      setStartingId(null);
    }
  }

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
              · click any to start a chat
            </p>
          </div>
        </header>

        {/* Search */}
        <div className="relative mb-6 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search agents by name, role, or capability…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg bg-slate-800/80 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 outline-none ring-1 ring-slate-700/50 transition-colors focus:ring-stable-purple/50"
            aria-label="Search agents"
          />
        </div>

        {/* Source legend — matches the colored side-border on each card. */}
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <span className="font-semibold uppercase tracking-wide text-slate-600">
            Source
          </span>
          {(["employee", "frontier", "flexible"] as SourceClass[]).map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5">
              <span
                className={clsx("h-3 w-1 rounded-full", SOURCE_META[c].bar)}
              />
              <span className={clsx("font-medium", SOURCE_META[c].text)}>
                {SOURCE_META[c].label}
              </span>
              <span className="text-slate-600">— {SOURCE_META[c].hint}</span>
            </span>
          ))}
        </div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-16 text-center">
            <Bot className="h-6 w-6 text-slate-600" />
            <p className="text-sm text-slate-500">
              {agents.length === 0
                ? "No agents available yet."
                : "No agents match your search."}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((agent) => {
              const name = agent.display_name || agent.name;
              const busy = startingId === agent.id;
              const source = classifySource(agent);
              const meta = SOURCE_META[source];
              return (
                <li key={agent.id}>
                  <button
                    onClick={() => startChat(agent)}
                    disabled={!!startingId}
                    title={meta.hint}
                    className={clsx(
                      "group flex h-full w-full flex-col rounded-xl border border-l-4 border-slate-700/50 bg-slate-800/30 p-4 text-left transition-colors hover:border-stable-purple/40 hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-60",
                      SOURCE_BORDER[source],
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-stable-purple-light">
                        {agent.avatar_url ? (
                          <img
                            src={agent.avatar_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
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
                        <p className="truncate text-sm font-semibold text-slate-100">
                          {name}
                        </p>
                        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span
                            className={clsx(
                              "h-1.5 w-1.5 rounded-full",
                              statusDot(agent.status),
                            )}
                          />
                          {STATUS_LABEL[agent.status]}
                          <span
                            className={clsx(
                              "ml-auto font-semibold uppercase tracking-wide",
                              meta.text,
                            )}
                          >
                            {meta.label}
                          </span>
                        </p>
                      </div>
                    </div>
                    {agent.description && (
                      <p className="mt-3 line-clamp-2 text-xs text-slate-400">
                        {agent.description}
                      </p>
                    )}
                    <div className="mt-3 flex flex-1 flex-wrap items-end gap-1.5">
                      {(agent.capabilities || []).slice(0, 3).map((c) => (
                        <span
                          key={c}
                          className="rounded-md bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-slate-700/40 pt-3">
                      <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
                        <Cpu className="h-3 w-3 shrink-0" />
                        <span className="max-w-[10rem] truncate">
                          {agent.model || "—"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-stable-purple-light opacity-0 transition-opacity group-hover:opacity-100">
                        <MessageSquarePlus className="h-3.5 w-3.5" />
                        {busy ? "Starting…" : "Chat"}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
