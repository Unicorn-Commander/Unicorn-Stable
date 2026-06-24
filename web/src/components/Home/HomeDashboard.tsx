import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Hash,
  MessageSquare,
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
import { useAppStore } from "@/stores/appStore";

// Keep in sync with RoomList — Majik is the user's resident orchestrator
// persona. Rooms whose brigade_agent_id is "majik" are 1:1 Majik chats and get
// the sparkle treatment in the feed.
const MAJIK_AGENT_ID = "majik";

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
 * The landing view shown on `/` when no room is selected — the Command Center
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
  const clearUnread = useAppStore((s) => s.clearUnread);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);

  const [filter, setFilter] = useState<Filter>("all");
  const [startingChat, setStartingChat] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [enteringConf, setEnteringConf] = useState<string | null>(null);

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
  const majikOnline = onlineAgents.some(
    (a) => a.name?.toLowerCase() === "majik" || a.id === MAJIK_AGENT_ID,
  );

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
  // "New chat with Majik" button and by every row in the Agents rail.
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

  function handleNewMajikChat() {
    void handleAgentChat(MAJIK_AGENT_ID, "Chat with Majik");
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
  if (majikOnline) statusBits.push("Majik is online");

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {/* Hero banner — gradient glow for color + presence */}
        <header className="relative mb-6 overflow-hidden rounded-2xl border border-stable-glass-border bg-slate-800/30 px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-stable-purple/25 blur-3xl"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute -bottom-24 right-40 h-44 w-44 rounded-full bg-stable-cyan/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-2 flex items-center gap-2">
              <span className="gradient-bg flex h-6 w-6 items-center justify-center rounded-md">
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Unicorn Command Center
              </span>
            </div>
            <h1 className="text-2xl font-bold sm:text-3xl">
              <span className="text-slate-50">{greetingFor(hour)}, </span>
              <span className="gradient-text">{firstName}</span>
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-400">
              {statusBits.map((bit, i) => (
                <span key={bit} className="flex items-center gap-2">
                  {i > 0 && (
                    <span className="text-slate-600" aria-hidden="true">
                      ·
                    </span>
                  )}
                  {bit === "Majik is online" ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
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

        {/* Quick actions */}
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={handleNewMajikChat}
            disabled={startingChat}
            className="gradient-bg group flex items-center gap-3 rounded-xl px-4 py-3.5 text-left text-white shadow-lg shadow-stable-purple/20 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <SquarePen className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                {startingChat ? "Starting…" : "New chat with Majik"}
              </span>
              <span className="block truncate text-xs text-white/70">
                Ask your orchestrator anything
              </span>
            </span>
          </button>

          <button
            onClick={() => setCreateRoomModalOpen(true)}
            className="group flex items-center gap-3 rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3.5 text-left text-slate-200 transition-colors hover:border-stable-cyan/40 hover:bg-slate-800"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan-light transition-colors group-hover:bg-stable-cyan/25">
              <Plus className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">New channel</span>
              <span className="block truncate text-xs text-slate-500">
                Spin up a room for humans + agents
              </span>
            </span>
          </button>

          <button
            onClick={() => navigate("/bridge")}
            className="group flex items-center gap-3 rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3.5 text-left text-slate-200 transition-colors hover:border-stable-purple/40 hover:bg-slate-800"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light transition-colors group-hover:bg-stable-purple/25">
              <Plug className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Connect a bridge</span>
              <span className="block truncate text-xs text-slate-500">
                Wire Claude or any agent into Stable (MCP)
              </span>
            </span>
          </button>
        </div>

        {/* Standing conference rooms */}
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <Video className="h-4 w-4 text-stable-cyan-light" />
            <h2 className="text-sm font-semibold text-slate-200">
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
                className="group flex items-center gap-3 rounded-xl border border-slate-700/60 bg-gradient-to-br from-stable-cyan/[0.06] to-slate-800/40 px-4 py-3.5 text-left text-slate-200 transition-colors hover:border-stable-cyan/40 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan-light transition-colors group-hover:bg-stable-cyan/25">
                  <Video className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{c.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {c.blurb}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-stable-cyan-light">
                  {enteringConf === c.slug ? "Opening…" : "Join"}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Stat ribbon — each stat gets its own accent */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          <button
            onClick={() => setFilter("unread")}
            className={clsx(
              "flex flex-col rounded-xl border px-4 py-3 text-left transition-colors",
              totalUnread > 0
                ? "border-stable-purple/40 bg-stable-purple/10 hover:bg-stable-purple/15"
                : "border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/50",
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stable-purple-light">
              <Inbox className="h-3.5 w-3.5" />
              Unread
            </span>
            <span className="mt-1 text-2xl font-bold text-slate-50">
              {totalUnread}
            </span>
          </button>
          <div className="flex flex-col rounded-xl border border-stable-cyan/30 bg-stable-cyan/[0.07] px-4 py-3">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stable-cyan-light">
              <MessagesSquare className="h-3.5 w-3.5" />
              Conversations
            </span>
            <span className="mt-1 text-2xl font-bold text-slate-50">
              {rooms.length}
            </span>
          </div>
          <div className="flex flex-col rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-400">
              <Bot className="h-3.5 w-3.5" />
              Agents online
            </span>
            <span className="mt-1 text-2xl font-bold text-slate-50">
              {onlineAgents.length}
            </span>
          </div>
        </div>

        {/* Main grid: messages feed (wide) + agents rail */}
        <div className="grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-200">Messages</h2>
              <div className="flex items-center gap-1 rounded-lg bg-slate-800/50 p-0.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={clsx(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      filter === f.key
                        ? "bg-stable-purple text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {f.label}
                    {f.key === "unread" && totalUnread > 0 && (
                      <span className="ml-1 text-[10px] opacity-80">
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
                onNewChat={handleNewMajikChat}
              />
            ) : (
              <ul className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/20">
                {shown.map((room, i) => {
                const unread = unreadFor(room);
                const m = room.last_message;
                const isMajik = room.brigade_agent_id === MAJIK_AGENT_ID;
                const isChannel = room.type === "channel";
                return (
                  <li key={room.id}>
                    <button
                      onClick={() => open(room.id)}
                      className={clsx(
                        "flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-slate-800/60",
                        i > 0 && "border-t border-slate-700/40",
                        unread > 0 && "bg-stable-purple/[0.06]",
                      )}
                    >
                      <span
                        className={clsx(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          isMajik
                            ? "bg-stable-purple/20 text-stable-purple-light"
                            : "bg-slate-700/50 text-slate-400",
                        )}
                      >
                        {isMajik ? (
                          <Sparkles className="h-4 w-4" />
                        ) : isChannel ? (
                          <Hash className="h-4 w-4" />
                        ) : (
                          <MessageSquare className="h-4 w-4" />
                        )}
                      </span>
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
                              <span className="text-[11px] text-slate-500">
                                {timestamp(m.created_at)}
                              </span>
                            )}
                            {unread > 0 && (
                              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-stable-purple px-1 text-[10px] font-bold text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </div>
                        {m ? (
                          <p
                            className={clsx(
                              "mt-0.5 truncate text-xs",
                              unread > 0 ? "text-slate-300" : "text-slate-500",
                            )}
                          >
                            <span className="text-slate-500">
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
            agents={onlineAgents.slice(0, 8)}
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
        <h2 className="text-sm font-semibold text-slate-200">Agents</h2>
        <span className="text-[11px] text-slate-500">
          {agents.length} online · {total} total
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/20">
        {agents.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-slate-500">
            No agents online right now.
          </p>
        ) : (
          <ul>
            {agents.map((a, i) => {
              const label = a.display_name || a.name;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => onChat(a.id, `Chat with ${label}`)}
                    disabled={disabled}
                    className={clsx(
                      "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-60",
                      i > 0 && "border-t border-slate-700/40",
                    )}
                  >
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-stable-purple-light">
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
                      <span
                        className={clsx(
                          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
                          statusDot(a.status),
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-200">
                        {label}
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
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-stable-purple/40 hover:text-slate-200"
      >
        <Bot className="h-3.5 w-3.5" />
        Browse all agents
      </button>
    </aside>
  );
}

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
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-12 text-center">
        <span className="gradient-bg flex h-12 w-12 items-center justify-center rounded-2xl">
          <Sparkles className="h-6 w-6 text-white" />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-200">
            Welcome to your Command Center
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            Start a conversation with Majik or seed your business channels to
            get going.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onNewChat}
            className="gradient-bg flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            <SquarePen className="h-3.5 w-3.5" />
            New chat with Majik
          </button>
          <button
            onClick={onSeed}
            disabled={seeding}
            className="flex items-center gap-1.5 rounded-lg border border-stable-purple/30 bg-stable-purple/10 px-3.5 py-2 text-xs font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/20 disabled:opacity-50"
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
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-10 text-center">
      <Search className="h-5 w-5 text-slate-600" />
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}
