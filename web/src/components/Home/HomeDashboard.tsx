import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ChevronDown,
  Hash,
  Sparkles,
  SquarePen,
  Plus,
  Inbox,
  MessagesSquare,
  Bot,
  Search,
  Video,
  Plug,
} from "lucide-react";
import clsx from "clsx";
import { api, type Room, type Agent } from "@/services/api";
import { identityFor } from "@/lib/identity";
import { Avatar } from "@/components/Avatar";
import { useAppStore } from "@/stores/appStore";
import { resolveDefaultAgent } from "@/components/Sidebar/newChat";
import { AgentChatModal } from "@/components/Agents/AgentChatModal";
import { StatusDot } from "@/components/Agents/StatusDot";

// Standing always-on video rooms (mirrors the backend CONFERENCE_ROOMS list).
// Entering one create-or-gets it and joins, then drops you into the room where
// you can start the call.
const CONFERENCE_ROOMS: { slug: string; name: string; blurb: string }[] = [
  {
    slug: "main-conference",
    name: "Main Conference Hall",
    blurb: "Always-on video room for the whole team.",
  },
  {
    slug: "war-room",
    name: "War Room",
    blurb: "Incidents, deep work, live problem-solving.",
  },
];

// Agent tier is DYNAMIC — derived from Brigade's roster metadata, never a
// hardcoded id list. Brigade tags orchestrator-tier residents (Majik = Magic
// Unicorn's, gflow = Genesis Flow's, the-general = fleet-wide) with
// domain "orchestration" / rank "Field Marshal". Any new orchestrator added in
// Brigade auto-tiers here with no code change.
function isOrchestrator(a: Agent): boolean {
  const domain = (a.domain || "").toLowerCase();
  const rank = (a.rank || "").toLowerCase();
  return domain === "orchestration" || rank === "field marshal";
}

/** Orchestrators first (source order preserved), then everyone else as-is. */
function byTier(list: Agent[]): Agent[] {
  const orch = list.filter(isOrchestrator);
  const rest = list.filter((a) => !isOrchestrator(a));
  return [...orch, ...rest];
}

type Filter = "all" | "unread" | "channels" | "direct";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "channels", label: "Channels" },
  { key: "direct", label: "Direct" },
];

function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + "…" : oneLine;
}

function timestamp(dateStr: string): string {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false });
  } catch {
    return "";
  }
}

/**
 * The landing view shown on `/` when no room is selected — the Stable
 * "home". Aggregates every conversation (channels, DMs, Majik chats) into one
 * recency-sorted feed so logging in lands you on your messages instead of an
 * empty placeholder. Reads entirely from the already-loaded `rooms` store
 * (AppShell keeps it fresh), so there's no extra fetch and unread badges update
 * live over the WebSocket.
 */
export function HomeDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rooms = useAppStore((s) => s.rooms);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const currentUser = useAppStore((s) => s.currentUser);
  const agents = useAppStore((s) => s.agents);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const setDefaultAgentId = useAppStore((s) => s.setDefaultAgentId);
  const defaultAgent = resolveDefaultAgent(agents, defaultAgentId);

  // The default-agent preference is loaded by the sidebar, but hydrate it here
  // too so the Home dashboard is correct even if rendered first. Best-effort.
  useEffect(() => {
    let cancelled = false;
    api
      .getMyPreferences()
      .then((p) => {
        if (!cancelled) setDefaultAgentId(p.default_agent_id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setDefaultAgentId]);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);

  const [filter, setFilter] = useState<Filter>("all");
  const [startingChat, setStartingChat] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [enteringConf, setEnteringConf] = useState<string | null>(null);
  // "New chat with someone else" — opens the agent picker modal instead of the
  // default-agent DM. Needs the full roster Agent object for the modal's focus.
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const pickerFocusAgent = useMemo(
    () => agents.find((a) => a.id === defaultAgent.id) ?? agents[0],
    [agents, defaultAgent.id],
  );

  const unreadFor = (r: Room) => unreadCounts[r.id] ?? r.unread_count ?? 0;

  // Most-recent-first across ALL conversations. Fall back to room.updated_at
  // for rooms that have no messages yet so empty rooms still sort sanely.
  const feed = useMemo(() => {
    return [...rooms].sort((a, b) => {
      const ta = new Date(a.last_message?.created_at ?? a.updated_at).getTime();
      const tb = new Date(b.last_message?.created_at ?? b.updated_at).getTime();
      return tb - ta;
    });
  }, [rooms]);

  const totalUnread = useMemo(
    () => feed.reduce((n, r) => n + unreadFor(r), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, unreadCounts],
  );
  const unreadRoomCount = useMemo(
    () => feed.filter((r) => unreadFor(r) > 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, unreadCounts],
  );

  const onlineAgents = useMemo(
    () => agents.filter((a) => a.status !== "offline"),
    [agents],
  );
  const defaultAgentOnline = onlineAgents.some((a) => a.id === defaultAgent.id);

  const shown = useMemo(() => {
    switch (filter) {
      case "unread":
        return feed.filter((r) => unreadFor(r) > 0);
      case "channels":
        return feed.filter((r) => r.type === "channel");
      case "direct":
        return feed.filter((r) => r.type !== "channel");
      default:
        return feed;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, filter, unreadCounts]);

  const open = (id: string) => {
    clearUnread(id);
    navigate(`/c/${id}`);
  };

  // Start (or resume) a 1:1 chat with any agent and jump into it. Used by the
  // "New chat" button and by every row in the Agents rail.
  async function handleAgentChat(agentId: string, label: string) {
    if (startingChat) return;
    setStartingChat(true);
    try {
      const room = await api.createAgentDm(agentId, label);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      open(room.id);
    } catch (err) {
      console.error("agent chat failed", err);
    } finally {
      setStartingChat(false);
    }
  }

  function startDefaultChat() {
    void handleAgentChat(defaultAgent.id, `Chat with ${defaultAgent.name}`);
  }

  async function enterConference(slug: string) {
    if (enteringConf) return;
    setEnteringConf(slug);
    try {
      const room = await api.enterConferenceRoom(slug);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      open(room.id);
    } catch (err) {
      console.error("enter conference failed", err);
    } finally {
      setEnteringConf(null);
    }
  }

  async function handleSeedDefaults() {
    if (seeding) return;
    setSeeding(true);
    try {
      await api.bootstrapDefaultRooms();
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } catch (e) {
      console.error("bootstrap defaults failed", e);
    } finally {
      setSeeding(false);
    }
  }

  const hour = new Date().getHours();
  const firstName = currentUser?.displayName?.trim().split(/\s+/)[0] ?? "there";

  // A human-readable status subline.
  const statusBits: string[] = [];
  if (totalUnread > 0) {
    statusBits.push(
      `${totalUnread} unread message${totalUnread === 1 ? "" : "s"} across ${unreadRoomCount} conversation${unreadRoomCount === 1 ? "" : "s"}`,
    );
  } else {
    statusBits.push("You're all caught up");
  }
  if (defaultAgentOnline) statusBits.push(`${defaultAgent.name} is online`);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {/* Hero banner — aurora wash for color + presence */}
        <header className="card relative mb-6 overflow-hidden px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_150%_at_100%_0%,rgba(139,92,246,0.14),transparent_55%)]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_82%_100%,rgba(34,211,238,0.10),transparent_60%)]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(38%_70%_at_62%_0%,rgba(52,211,153,0.07),transparent_70%)]"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="gradient-bg glow-iris flex h-7 w-7 items-center justify-center rounded-lg">
                <Sparkles className="h-4 w-4 text-white" />
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Unicorn Stable
              </span>
            </div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              <span className="text-slate-50">{greetingFor(hour)}, </span>
              <span className="gradient-text-aurora">{firstName}</span>
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-400">
              {statusBits.map((bit, i) => (
                <span key={bit} className="flex items-center gap-2">
                  {i > 0 && (
                    <span className="text-slate-600" aria-hidden="true">
                      ·
                    </span>
                  )}
                  {bit.endsWith(" is online") ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="animate-live h-1.5 w-1.5 rounded-full bg-stable-mint" />
                      {bit}
                    </span>
                  ) : (
                    bit
                  )}
                </span>
              ))}
            </p>
          </div>
        </header>

        {/* Quick actions — one hue family per card: iris / aqua / mint */}
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Split card: the wide side starts a chat with your default agent;
              the caret opens the roster picker to chat with anyone (or several). */}
          <div className="gradient-bg glow-iris flex items-stretch overflow-hidden rounded-2xl text-white">
            <button
              onClick={startDefaultChat}
              disabled={startingChat}
              className="focus-ring group flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left transition hover:bg-white/[0.08] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
                <SquarePen className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {startingChat ? "Starting…" : "New chat"}
                </span>
                <span className="block truncate text-xs text-white/70">
                  Ask {defaultAgent.name} anything
                </span>
              </span>
            </button>
            {pickerFocusAgent && (
              <button
                onClick={() => setAgentPickerOpen(true)}
                aria-label="Choose a different agent or orchestrator"
                title="Chat with a different agent — or several at once"
                className="focus-ring flex w-11 shrink-0 items-center justify-center border-l border-white/20 transition hover:bg-white/[0.12]"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
          </div>
          {agentPickerOpen && pickerFocusAgent && (
            <AgentChatModal
              focusAgent={pickerFocusAgent}
              agents={agents}
              onClose={() => setAgentPickerOpen(false)}
            />
          )}

          <button
            onClick={() => setCreateRoomModalOpen(true)}
            className="card card-hover focus-ring group relative flex items-center gap-3 overflow-hidden border-stable-cyan/30 px-4 py-3.5 text-left text-slate-200 hover:glow-aqua active:scale-[0.98]"
          >
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_120%_at_100%_0%,rgba(34,211,238,0.06),transparent_70%)]"
              aria-hidden="true"
            />
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan transition-colors group-hover:bg-stable-cyan/25">
              <Plus className="h-5 w-5" />
            </span>
            <span className="relative min-w-0">
              <span className="block text-sm font-semibold">New channel</span>
              <span className="block truncate text-xs text-slate-400">
                Spin up a room for humans + agents
              </span>
            </span>
          </button>

          <button
            onClick={() => navigate("/bridge")}
            className="card card-hover focus-ring group relative flex items-center gap-3 overflow-hidden border-stable-mint/30 px-4 py-3.5 text-left text-slate-200 hover:glow-mint active:scale-[0.98]"
          >
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_120%_at_100%_0%,rgba(52,211,153,0.06),transparent_70%)]"
              aria-hidden="true"
            />
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-mint/15 text-stable-mint transition-colors group-hover:bg-stable-mint/25">
              <Plug className="h-5 w-5" />
            </span>
            <span className="relative min-w-0">
              <span className="block text-sm font-semibold">Connect a bridge</span>
              <span className="block truncate text-xs text-slate-400">
                Wire Claude or any agent into Stable (MCP)
              </span>
            </span>
          </button>
        </div>

        {/* Standing conference rooms */}
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <Video className="h-4 w-4 text-stable-cyan" />
            <h2 className="font-display text-sm font-semibold text-slate-200">
              Conference rooms
            </h2>
            <span className="text-[11px] text-slate-500">
              always-on · drop in for voice + video
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONFERENCE_ROOMS.map((c) => (
              <button
                key={c.slug}
                onClick={() => enterConference(c.slug)}
                disabled={enteringConf !== null}
                className="card card-hover focus-ring group relative flex items-center gap-3 overflow-hidden px-4 py-3.5 text-left text-slate-200 hover:glow-aqua active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_120%_at_100%_0%,rgba(34,211,238,0.08),transparent_70%)]"
                  aria-hidden="true"
                />
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan transition-colors group-hover:bg-stable-cyan/25">
                  <Video className="h-5 w-5" />
                </span>
                <span className="relative min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {c.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-stable-mint/25 bg-stable-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-stable-mint">
                      <span className="animate-live h-1 w-1 rounded-full bg-stable-mint" />
                      always-on
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-400">
                    {c.blurb}
                  </span>
                </span>
                <span className="relative shrink-0 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors group-hover:border-line-strong group-hover:bg-surface-3">
                  {enteringConf === c.slug ? "Opening…" : "Join"}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Stat ribbon — each stat gets its own hue family */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <button
            onClick={() => setFilter("unread")}
            className={clsx(
              "card card-hover focus-ring relative flex flex-col overflow-hidden p-4 text-left",
              totalUnread > 0 && "border-stable-purple/40",
            )}
          >
            <span
              className={clsx(
                "pointer-events-none absolute inset-0 bg-[radial-gradient(80%_80%_at_100%_0%,rgba(139,92,246,0.12),transparent)]",
                totalUnread === 0 && "opacity-50",
              )}
              aria-hidden="true"
            />
            <span className="relative flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stable-purple-light">
              <Inbox className="h-3.5 w-3.5" />
              Unread
            </span>
            <span className="relative mt-1 font-display text-3xl font-bold tabular-nums text-slate-50">
              {totalUnread}
            </span>
          </button>
          <div className="card card-hover relative flex flex-col overflow-hidden p-4">
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_80%_at_100%_0%,rgba(34,211,238,0.12),transparent)]"
              aria-hidden="true"
            />
            <span className="relative flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stable-cyan-light">
              <MessagesSquare className="h-3.5 w-3.5" />
              Conversations
            </span>
            <span className="relative mt-1 font-display text-3xl font-bold tabular-nums text-slate-50">
              {rooms.length}
            </span>
          </div>
          <div className="card card-hover relative flex flex-col overflow-hidden p-4">
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_80%_at_100%_0%,rgba(52,211,153,0.12),transparent)]"
              aria-hidden="true"
            />
            <span className="relative flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400">
              <Bot className="h-3.5 w-3.5" />
              Agents online
            </span>
            <span className="relative mt-1 font-display text-3xl font-bold tabular-nums text-slate-50">
              {onlineAgents.length}
            </span>
          </div>
        </div>

        {/* Main grid: messages feed (wide) + agents rail */}
        <div className="grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-display text-sm font-semibold text-slate-200">
                Messages
              </h2>
              <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={clsx(
                      "focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      filter === f.key
                        ? "bg-stable-purple text-white shadow-sm"
                        : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                    )}
                  >
                    {f.label}
                    {f.key === "unread" && totalUnread > 0 && (
                      <span className="ml-1 text-[10px] tabular-nums opacity-80">
                        {totalUnread > 99 ? "99+" : totalUnread}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <EmptyFeed
                filter={filter}
                hasRooms={rooms.length > 0}
                seeding={seeding}
                onSeed={handleSeedDefaults}
                onNewChat={startDefaultChat}
              />
            ) : (
              <ul className="card overflow-hidden">
                {shown.map((room, i) => {
                const unread = unreadFor(room);
                const m = room.last_message;
                const isPrimary = room.brigade_agent_id === defaultAgent.id;
                const isChannel = room.type === "channel";
                return (
                  <li key={room.id}>
                    <button
                      onClick={() => open(room.id)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
                        i > 0 && "border-t border-line",
                        unread > 0 && "bg-stable-purple/[0.06]",
                      )}
                    >
                      {isPrimary ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                          <Sparkles className="h-4 w-4" />
                        </span>
                      ) : isChannel ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-stable-cyan/70">
                          <Hash className="h-4 w-4" />
                        </span>
                      ) : (
                        <Avatar
                          id={room.brigade_agent_id ?? undefined}
                          name={room.display_name || room.name}
                          size="md"
                          className="mt-0.5"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={clsx(
                              "truncate text-sm",
                              unread > 0
                                ? "font-semibold text-slate-50"
                                : "font-medium text-slate-200",
                            )}
                          >
                            {room.display_name || room.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {m && (
                              <span className="text-[11px] tabular-nums text-slate-500">
                                {timestamp(m.created_at)}
                              </span>
                            )}
                            {unread > 0 && (
                              <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </div>
                        {m ? (
                          <p
                            className={clsx(
                              "mt-0.5 truncate text-xs",
                              unread > 0 ? "text-slate-300" : "text-slate-400",
                            )}
                          >
                            <span
                              className="font-medium"
                              style={{
                                color: identityFor(m.sender_id, m.sender_name)
                                  .text,
                              }}
                            >
                              {m.sender_name}:
                            </span>{" "}
                            {preview(m.content)}
                          </p>
                        ) : (
                          <p className="mt-0.5 truncate text-xs italic text-slate-600">
                            No messages yet
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          </section>

          <AgentsRail
            agents={byTier(onlineAgents).slice(0, 8)}
            total={agents.length}
            disabled={startingChat}
            onChat={handleAgentChat}
            onBrowse={() => navigate("/agents")}
          />
        </div>
      </div>
    </div>
  );
}

/** Right-rail roster of online agents. Click one to open a 1:1 chat — a small
 *  preview of the fuller org-chart view. */
function AgentsRail({
  agents,
  total,
  disabled,
  onChat,
  onBrowse,
}: {
  agents: Agent[];
  total: number;
  disabled: boolean;
  onChat: (id: string, label: string) => void;
  onBrowse: () => void;
}) {
  return (
    <aside className="lg:col-span-1">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-semibold text-slate-200">
          Agents
        </h2>
        <span className="text-[11px] tabular-nums text-slate-500">
          {agents.length} online · {total} total
        </span>
      </div>
      <div className="card overflow-hidden">
        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]">
              <Bot className="h-5 w-5 text-slate-500" />
            </span>
            <p className="text-xs text-slate-500">
              The stable is quiet — no residents online right now.
            </p>
          </div>
        ) : (
          <ul>
            {agents.map((a, i) => {
              const label = a.display_name || a.name;
              const ident = identityFor(a.id, label);
              return (
                <li key={a.id}>
                  <button
                    onClick={() => onChat(a.id, `Chat with ${label}`)}
                    disabled={disabled}
                    className={clsx(
                      "focus-ring flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60",
                      i > 0 && "border-t border-line",
                    )}
                  >
                    <span
                      className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-white"
                      style={{ background: ident.gradient }}
                    >
                      {a.avatar_url ? (
                        <img
                          src={a.avatar_url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : a.emoji ? (
                        <span aria-hidden="true">{a.emoji}</span>
                      ) : (
                        <Bot className="h-4 w-4" />
                      )}
                      <StatusDot
                        status={a.status}
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 border-2 border-slate-900"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: ident.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate text-sm font-medium text-slate-200">
                          {label}
                        </span>
                        {isOrchestrator(a) && (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-stable-gold/30 bg-stable-gold/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-stable-gold"
                            title={a.title || "Orchestrator — runs the room and can pull in specialist agents"}
                          >
                            <Sparkles className="h-2.5 w-2.5" />
                            Orchestrator
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {a.description || a.model}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button
        onClick={onBrowse}
        className="focus-ring mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-slate-200"
      >
        <Bot className="h-3.5 w-3.5" />
        Browse all agents
      </button>
    </aside>
  );
}

function EmptyFeed({
  filter,
  hasRooms,
  seeding,
  onSeed,
  onNewChat,
}: {
  filter: Filter;
  hasRooms: boolean;
  seeding: boolean;
  onSeed: () => void;
  onNewChat: () => void;
}) {
  // Brand-new account: no rooms at all → onboarding.
  if (!hasRooms) {
    return (
      <div className="card relative flex flex-col items-center gap-4 overflow-hidden px-6 py-12 text-center">
        <span
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(139,92,246,0.10),transparent_70%)]"
          aria-hidden="true"
        />
        <span className="gradient-bg glow-iris relative flex h-12 w-12 items-center justify-center rounded-2xl">
          <Sparkles className="h-6 w-6 text-white" />
        </span>
        <div className="relative">
          <p className="font-display text-base font-semibold text-slate-100">
            Welcome to your Stable
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">
            Start a conversation with Majik or seed your business channels to
            get going.
          </p>
        </div>
        <div className="relative flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onNewChat}
            className="gradient-bg glow-iris focus-ring flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-95 active:scale-[0.98]"
          >
            <SquarePen className="h-3.5 w-3.5" />
            New chat
          </button>
          <button
            onClick={onSeed}
            disabled={seeding}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-stable-purple/30 bg-stable-purple/10 px-3.5 py-2 text-xs font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/20 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {seeding ? "Creating…" : "Seed business channels"}
          </button>
        </div>
      </div>
    );
  }

  // Filter returned nothing.
  const label =
    filter === "unread"
      ? "No unread messages — you're all caught up."
      : filter === "channels"
        ? "No channels yet."
        : filter === "direct"
          ? "No direct messages yet."
          : "No conversations yet.";

  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-line-strong bg-surface-1/50 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]">
        <Search className="h-5 w-5 text-slate-500" />
      </span>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}
