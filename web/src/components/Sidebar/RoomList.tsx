import { useState, useMemo, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Bell,
  BellOff,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  MessageSquare,
  MoreVertical,
  Plug,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Room } from "@/services/api";
import { ws } from "@/services/websocket";
import { isMuted, toggleMute, onMutedChange } from "@/utils/mute";
import { identityFor } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";
import {
  useChannelCategories,
  distinctCategories,
} from "@/stores/categoryStore";
import { CreateDmModal } from "./CreateDmModal";
import { ChannelBrowser } from "./ChannelBrowser";
import { NewChatButton } from "./NewChatButton";
import { resolveDefaultAgent } from "./newChat";

export function RoomList() {
  const navigate = useNavigate();
  const location = useLocation();
  const rooms = useAppStore((s) => s.rooms);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const participantsByRoom = useAppStore((s) => s.participants);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const agents = useAppStore((s) => s.agents);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const setDefaultAgentId = useAppStore((s) => s.setDefaultAgentId);
  // The agent the "New chat" button + the primary conversation section key off
  // (the user's chosen default, else Majik, else the first agent).
  const defaultAgent = resolveDefaultAgent(agents, defaultAgentId);
  // Open a room by navigating; the route param drives activeRoomId (see
  // AppShell). We still clear unread locally for snappy badge feedback.
  const openRoom = (id: string) => {
    clearUnread(id);
    navigate(`/c/${id}`);
    // On mobile the sidebar is an overlay drawer; close it after selecting a
    // room so the chat is visible. Desktop (>=768px) keeps it open.
    if (
      window.matchMedia("(max-width: 767px)").matches &&
      useAppStore.getState().ui.sidebarOpen
    ) {
      useAppStore.getState().toggleSidebar();
    }
  };
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const [createDmOpen, setCreateDmOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const queryClient = useQueryClient();

  // Hydrate the server-side default-agent preference once (it follows the user
  // across devices). Best-effort — a failure just keeps the built-in fallback.
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

  // ChatGPT-style "New chat": start a fresh conversation bound to an agent and
  // jump into it (the per-agent "+" in Direct messages and the empty-state
  // CTA). The split New-chat button has its own per-agent path.
  async function startAgentChat(agentId: string, agentName: string) {
    if (startingChat) return;
    setStartingChat(true);
    try {
      const room = await api.createAgentDm(agentId, `Chat with ${agentName}`);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      openRoom(room.id);
    } catch (err) {
      console.error("new chat failed", err);
      alert("Couldn't start a new chat — " + (err as Error).message);
    } finally {
      setStartingChat(false);
    }
  }
  const startDefaultChat = () =>
    startAgentChat(defaultAgent.id, defaultAgent.name);

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

  const filteredRooms = useMemo(() => {
    if (!searchQuery.trim()) return rooms;
    const q = searchQuery.toLowerCase();
    return rooms.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [rooms, searchQuery]);

  const channels = useMemo(
    () => filteredRooms.filter((r) => r.type === "channel"),
    [filteredRooms],
  );

  // Personal channel categories (client-side; see categoryStore).
  const categories = useChannelCategories((s) => s.categories);
  const collapsed = useChannelCategories((s) => s.collapsed);
  const setCategory = useChannelCategories((s) => s.setCategory);
  const toggleCollapsed = useChannelCategories((s) => s.toggleCollapsed);
  const [menuRoomId, setMenuRoomIdRaw] = useState<string | null>(null);
  // Inline "New category" input inside the ⋮ menu (null = collapsed to the
  // button). Never survives a menu open/close, hence the wrapped setter.
  const [newCatDraft, setNewCatDraft] = useState<string | null>(null);
  const setMenuRoomId = (id: string | null) => {
    setMenuRoomIdRaw(id);
    setNewCatDraft(null);
  };

  // mute.ts persists to localStorage outside React — bump on its change event
  // so isMuted() is re-read and muted badges/menu labels stay in sync.
  const [, setMutedVersion] = useState(0);
  useEffect(() => onMutedChange(() => setMutedVersion((v) => v + 1)), []);

  // Group the visible channels by the user's assigned category; everything else
  // stays in a flat "ungrouped" list under the section header.
  const { catGroups, ungrouped } = useMemo(() => {
    const groups = new Map<string, Room[]>();
    const ungrouped: Room[] = [];
    for (const r of channels) {
      const cat = categories[r.id];
      if (cat) {
        const arr = groups.get(cat);
        if (arr) arr.push(r);
        else groups.set(cat, [r]);
      } else {
        ungrouped.push(r);
      }
    }
    const catGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return { catGroups, ungrouped };
  }, [channels, categories]);

  // Every category name the user has ever made (for the "move to" menu), even if
  // its channels are currently filtered out.
  const knownCategories = useMemo(
    () => distinctCategories(categories),
    [categories],
  );

  function assignCategory(roomId: string, category: string | null) {
    setCategory(roomId, category);
    setMenuRoomId(null);
  }

  function commitNewCategory(roomId: string) {
    const name = (newCatDraft ?? "").trim();
    if (name) setCategory(roomId, name);
    setMenuRoomId(null);
  }

  function markRoomRead(room: Room) {
    // Same signal ChatPanel sends when the room is open and visible — the
    // server advances last_read_at; we zero the local badge optimistically.
    if (room.last_message) {
      ws.send("mark_read", {
        room_id: room.id,
        message_id: room.last_message.id,
      });
    }
    clearUnread(room.id);
    setMenuRoomId(null);
  }

  function renderChannelRow(room: Room) {
    const isActive = activeRoomId === room.id;
    const unread = unreadCounts[room.id] ?? 0;
    const cat = categories[room.id];
    const menuOpen = menuRoomId === room.id;
    const muted = isMuted(room.id);
    return (
      <li key={room.id} className="relative">
        <div
          className={clsx(
            "group relative flex items-center rounded-lg transition-colors",
            isActive ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
          )}
        >
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
            />
          )}
          <button
            onClick={() => openRoom(room.id)}
            className={clsx(
              "focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left md:py-1.5",
              isActive
                ? "text-slate-50"
                : "text-slate-300 group-hover:text-slate-100",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            <Hash
              className={clsx(
                "h-4 w-4 shrink-0",
                isActive ? "text-stable-cyan" : "text-stable-cyan/70",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span
                  className={clsx(
                    "truncate text-sm",
                    isActive ? "font-semibold" : "font-medium",
                  )}
                >
                  {room.name}
                </span>
                {muted && (
                  <BellOff
                    aria-label="Muted"
                    className="ml-1 h-3 w-3 shrink-0 text-slate-500"
                  />
                )}
                {unread > 0 && (
                  <span
                    className={clsx(
                      "ml-1 grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                      // Muted rooms keep the count but lose the gradient shout.
                      muted
                        ? "bg-slate-700/70 text-slate-400"
                        : "gradient-bg text-white",
                    )}
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </div>
              {room.last_message && (
                <p className="truncate text-[11px] text-slate-500">
                  {formatLastMessage(room.last_message.content)}
                </p>
              )}
            </div>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuRoomId(menuOpen ? null : room.id);
            }}
            className={clsx(
              "focus-ring mr-1 shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus:opacity-100",
              menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            aria-label="Channel options"
            aria-haspopup="menu"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>

        {menuOpen && (
          <>
            <button
              className="fixed inset-0 z-20 cursor-default"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setMenuRoomId(null)}
            />
            <div
              role="menu"
              className="glass-heavy animate-fade-in absolute right-2 top-9 z-30 w-48 overflow-hidden rounded-xl py-1 shadow-pop"
            >
              <button
                role="menuitem"
                onClick={() => {
                  toggleMute(room.id);
                  setMenuRoomId(null);
                }}
                className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
              >
                {muted ? (
                  <>
                    <Bell className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    Unmute
                  </>
                ) : (
                  <>
                    <BellOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    Mute
                  </>
                )}
              </button>
              <button
                role="menuitem"
                onClick={() => markRoomRead(room)}
                className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
              >
                <CheckCheck className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                Mark as read
              </button>
              <p className="mt-0.5 border-t border-line px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Move to category
              </p>
              {knownCategories.map((c) => (
                <button
                  key={c}
                  role="menuitem"
                  onClick={() => assignCategory(room.id, c)}
                  className={clsx(
                    "focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06]",
                    c === cat ? "text-stable-purple-light" : "text-slate-300",
                  )}
                >
                  <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                  <span className="truncate">{c}</span>
                </button>
              ))}
              {newCatDraft === null ? (
                <button
                  role="menuitem"
                  onClick={() => setNewCatDraft("")}
                  className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-stable-purple-light/80" />
                  New category…
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-stable-purple-light/80" />
                  <input
                    autoFocus
                    value={newCatDraft}
                    onChange={(e) => setNewCatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter confirms, Esc collapses back to the button —
                      // stop both so global handlers never see them.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        commitNewCategory(room.id);
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setNewCatDraft(null);
                      }
                    }}
                    placeholder="Category name"
                    aria-label="New category name"
                    className="w-full min-w-0 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60"
                  />
                </div>
              )}
              {cat && (
                <button
                  role="menuitem"
                  onClick={() => assignCategory(room.id, null)}
                  className="focus-ring mt-0.5 flex w-full items-center gap-2 border-t border-line px-3 py-1.5 text-left text-sm text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
                >
                  Remove from “{cat}”
                </button>
              )}
            </div>
          </>
        )}
      </li>
    );
  }

  // ONE "Direct messages" list: agent conversations group under their resident
  // (a collapsible thread-history per agent, ChatGPT-style), human DMs stay
  // flat, and entries interleave by latest activity. The rooms query is already
  // ordered most-recent-first by the backend (updated_at DESC), so each group's
  // threads and the mixed ordering stay newest → oldest for free (a group sits
  // at its newest thread's position).
  type DmEntry =
    | { kind: "agent"; agentId: string; threads: Room[] }
    | { kind: "human"; room: Room };

  const dmEntries = useMemo<DmEntry[]>(() => {
    const byAgent = new Map<string, Room[]>();
    const entries: DmEntry[] = [];
    for (const room of filteredRooms) {
      if (room.type !== "dm" && room.type !== "group_dm") continue;
      const agentId = room.brigade_agent_id;
      if (agentId) {
        const threads = byAgent.get(agentId);
        if (threads) {
          threads.push(room);
        } else {
          const fresh = [room];
          byAgent.set(agentId, fresh);
          entries.push({ kind: "agent", agentId, threads: fresh });
        }
      } else {
        entries.push({ kind: "human", room });
      }
    }
    return entries;
  }, [filteredRooms]);

  // Collapsed by default — one row per resident; the chevron reveals history.
  // Session-local UI state on purpose (like scroll position).
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleAgentExpanded = (agentId: string) =>
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });

  function agentDisplayName(agentId: string, threads: Room[]): string {
    const rosterAgent = agents.find((a) => a.id === agentId);
    if (rosterAgent) return rosterAgent.display_name || rosterAgent.name;
    // Roster not loaded (or agent retired): fall back to the room label
    // without its "Chat with " prefix.
    const label = threads[0]?.display_name || threads[0]?.name || agentId;
    return label.replace(/^chat with /i, "");
  }

  function formatLastMessage(content: string): string {
    if (content.length <= 40) return content;
    return content.slice(0, 40) + "...";
  }

  function formatTimestamp(dateStr: string): string {
    try {
      return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false });
    } catch {
      return "";
    }
  }


  // ---- Unified Direct-messages renderers -----------------------------------
  // One row per resident. Agents with multiple conversations collapse into a
  // thread-history group (ChatGPT-style): the row opens the newest thread, the
  // chevron reveals the history, the hover "+" starts a fresh thread.

  function renderThreadRow(room: Room, identColor: string) {
    const isActive = activeRoomId === room.id;
    return (
      <li key={room.id}>
        <button
          onClick={() => openRoom(room.id)}
          className={clsx(
            "focus-ring relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors md:py-1.5",
            isActive
              ? "bg-white/[0.06] text-slate-100"
              : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
              style={{ background: identColor }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px]">
                {room.last_message ? (
                  <>
                    <span className="font-medium">
                      {room.last_message.sender_name}:
                    </span>{" "}
                    {formatLastMessage(room.last_message.content)}
                  </>
                ) : (
                  <span className="italic text-slate-500">
                    New conversation
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {room.last_message && (
                  <span className="text-[10px] tabular-nums text-slate-500">
                    {formatTimestamp(room.last_message.created_at)}
                  </span>
                )}
                {room.unread_count > 0 && (
                  <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                    {room.unread_count > 99 ? "99+" : room.unread_count}
                  </span>
                )}
              </div>
            </div>
          </div>
        </button>
      </li>
    );
  }

  function renderAgentGroup(agentId: string, threads: Room[]) {
    const name = agentDisplayName(agentId, threads);
    const ident = identityFor(agentId, name);
    const latest = threads[0];
    const expanded = expandedAgents.has(agentId);
    const hasActive = threads.some((r) => r.id === activeRoomId);
    const unreadTotal = threads.reduce((n, r) => n + (r.unread_count ?? 0), 0);
    const others = (participantsByRoom[latest?.id ?? ""] ?? []).filter(
      (p) => (p.participant_id || p.user_id) !== currentUserId,
    );
    const agentOnline = others.some((p) => {
      const id = p.participant_id || p.user_id || "";
      return p.is_online || onlineUsers.includes(id);
    });
    return (
      <li key={`agent-${agentId}`}>
        <div
          className={clsx(
            "group/agent relative flex w-full items-center rounded-lg pr-1 transition-colors",
            hasActive && !expanded
              ? "bg-white/[0.06]"
              : "hover:bg-white/[0.04]",
          )}
        >
          {hasActive && !expanded && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
              style={{ background: ident.color }}
            />
          )}
          <button
            onClick={() => latest && openRoom(latest.id)}
            className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-slate-300 transition-colors hover:text-slate-100 md:py-1.5"
            title={`Open your latest conversation with ${name}`}
          >
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: ident.color }}
              />
              {agentOnline && (
                <span
                  className="animate-live absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-slate-900 bg-stable-mint"
                  aria-label="Online"
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-sm font-medium"
                  style={{ color: ident.text }}
                >
                  {name}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {latest?.last_message && (
                    <span className="text-[10px] tabular-nums text-slate-500">
                      {formatTimestamp(latest.last_message.created_at)}
                    </span>
                  )}
                  {!expanded && unreadTotal > 0 && (
                    <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                      {unreadTotal > 99 ? "99+" : unreadTotal}
                    </span>
                  )}
                </div>
              </div>
              {latest?.last_message ? (
                <p className="truncate text-[11px] text-slate-500">
                  <span className="font-medium text-slate-500">
                    {latest.last_message.sender_name}:
                  </span>{" "}
                  {formatLastMessage(latest.last_message.content)}
                </p>
              ) : (
                <p className="truncate text-[11px] italic text-slate-600">
                  No messages yet
                </p>
              )}
            </div>
          </button>
          <button
            onClick={() => startAgentChat(agentId, name)}
            disabled={startingChat}
            className="focus-ring rounded-md p-1 text-slate-500 opacity-60 transition-all hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-40 md:opacity-0 md:group-hover/agent:opacity-100 md:focus-visible:opacity-100"
            aria-label={`Start a new chat with ${name}`}
            title={`New chat with ${name}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {threads.length > 1 && (
            <button
              onClick={() => toggleAgentExpanded(agentId)}
              className="focus-ring flex items-center gap-0.5 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} conversation history with ${name} (${threads.length})`}
              title={`${threads.length} conversations`}
            >
              <span className="text-[10px] tabular-nums">{threads.length}</span>
              <ChevronDown
                className={clsx(
                  "h-3 w-3 shrink-0 transition-transform duration-150",
                  !expanded && "-rotate-90",
                )}
              />
            </button>
          )}
        </div>
        {expanded && threads.length > 1 && (
          <ul role="list" className="ml-3 border-l border-line pl-1">
            {threads.map((room) => renderThreadRow(room, ident.color))}
          </ul>
        )}
      </li>
    );
  }

  function renderHumanDm(room: Room) {
    const others = (participantsByRoom[room.id] ?? []).filter(
      (p) => (p.participant_id || p.user_id) !== currentUserId,
    );
    const otherOnline = others.some((p) => {
      const id = p.participant_id || p.user_id || "";
      return p.is_online || onlineUsers.includes(id);
    });
    const isActive = activeRoomId === room.id;
    return (
      <li key={room.id}>
        <button
          onClick={() => openRoom(room.id)}
          className={clsx(
            "focus-ring relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
            isActive
              ? "bg-white/[0.06] text-slate-50"
              : "text-slate-300 hover:bg-white/[0.04] hover:text-slate-100",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
            />
          )}
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            <MessageSquare className="h-4 w-4 opacity-60" />
            {otherOnline && (
              <span
                className="animate-live absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-slate-900 bg-stable-mint"
                aria-label="Online"
              />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{room.name}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {room.last_message && (
                  <span className="text-[10px] tabular-nums text-slate-500">
                    {formatTimestamp(room.last_message.created_at)}
                  </span>
                )}
                {room.unread_count > 0 && (
                  <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                    {room.unread_count > 99 ? "99+" : room.unread_count}
                  </span>
                )}
              </div>
            </div>
            {room.last_message && (
              <p className="truncate text-[11px] text-slate-500">
                <span className="font-medium text-slate-500">
                  {room.last_message.sender_name}:
                </span>{" "}
                {formatLastMessage(room.last_message.content)}
              </p>
            )}
          </div>
        </button>
      </li>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 space-y-2 px-3 py-3">
        <NewChatButton onStarted={openRoom} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search rooms…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-line bg-slate-950/60 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            aria-label="Search rooms"
          />
        </div>
      </div>

      <nav
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4"
        aria-label="Room navigation"
      >
        {/* Top-level: the agent roster / org-chart page. */}
        <button
          onClick={() => {
            navigate("/agents");
            if (
              window.matchMedia("(max-width: 767px)").matches &&
              useAppStore.getState().ui.sidebarOpen
            ) {
              useAppStore.getState().toggleSidebar();
            }
          }}
          className={clsx(
            "focus-ring group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
            location.pathname === "/agents"
              ? "bg-white/[0.06] font-semibold text-slate-50"
              : "text-slate-300 hover:bg-white/[0.04] hover:text-slate-100",
          )}
          aria-current={location.pathname === "/agents" ? "page" : undefined}
        >
          {location.pathname === "/agents" && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
            />
          )}
          <Bot
            className={clsx(
              "h-4 w-4 shrink-0 text-stable-purple-light transition-opacity",
              location.pathname === "/agents"
                ? "opacity-100"
                : "opacity-75 group-hover:opacity-100",
            )}
          />
          <span className="truncate text-sm font-medium">Browse all agents</span>
        </button>

        {/* Top-level: the Bridge / Connect (MCP) page. */}
        <button
          onClick={() => {
            navigate("/bridge");
            if (
              window.matchMedia("(max-width: 767px)").matches &&
              useAppStore.getState().ui.sidebarOpen
            ) {
              useAppStore.getState().toggleSidebar();
            }
          }}
          className={clsx(
            "focus-ring group relative -mt-2 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
            location.pathname === "/bridge"
              ? "bg-white/[0.06] font-semibold text-slate-50"
              : "text-slate-300 hover:bg-white/[0.04] hover:text-slate-100",
          )}
          aria-current={location.pathname === "/bridge" ? "page" : undefined}
        >
          {location.pathname === "/bridge" && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
            />
          )}
          <Plug
            className={clsx(
              "h-4 w-4 shrink-0 text-stable-mint transition-opacity",
              location.pathname === "/bridge"
                ? "opacity-100"
                : "opacity-75 group-hover:opacity-100",
            )}
          />
          <span className="truncate text-sm font-medium">Bridge &amp; connect</span>
        </button>

        <section>
          <div className="flex items-center justify-between px-2.5 pb-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Channels
            </h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setBrowseOpen(true)}
                className="focus-ring rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
                aria-label="Browse channels"
                title="Browse channels you can join"
              >
                Browse
              </button>
              <button
                onClick={() => setCreateRoomModalOpen(true)}
                className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:p-0.5"
                aria-label="Create channel"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {channels.length === 0 && (
            <div className="px-2.5 py-2">
              <p className="mb-2 text-xs text-slate-500">No channels yet</p>
              <button
                onClick={handleSeedDefaults}
                disabled={seeding}
                className="focus-ring flex w-full items-center gap-1.5 rounded-lg border border-stable-purple/30 bg-stable-purple/10 px-2.5 py-1.5 text-xs font-medium text-stable-purple-light transition-colors hover:border-stable-purple/50 hover:bg-stable-purple/20 disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {seeding ? "Creating…" : "Seed business channels"}
              </button>
            </div>
          )}

          {/* Category groups (personal, collapsible) then ungrouped channels. */}
          {catGroups.map(([cat, roomsInCat]) => {
            const isCollapsed = collapsed[cat];
            return (
              <div key={cat} className="mb-0.5">
                <button
                  onClick={() => toggleCollapsed(cat)}
                  className="focus-ring flex w-full items-center gap-1 rounded-md px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown
                    className={clsx(
                      "h-3 w-3 shrink-0 transition-transform duration-150",
                      isCollapsed && "-rotate-90",
                    )}
                  />
                  <span className="truncate">{cat}</span>
                  <span className="ml-auto tabular-nums text-slate-500">
                    {roomsInCat.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul role="list" className="ml-1.5 border-l border-line pl-1">
                    {roomsInCat.map((room) => renderChannelRow(room))}
                  </ul>
                )}
              </div>
            );
          })}

          <ul role="list">{ungrouped.map((room) => renderChannelRow(room))}</ul>
        </section>

        <section>
          <div className="flex items-center justify-between px-2.5 pb-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Direct messages
            </h3>
            <button
              onClick={() => setCreateDmOpen(true)}
              className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:p-0.5"
              aria-label="New direct message"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {dmEntries.length === 0 && (
            <div className="mx-2 mb-1 flex flex-col gap-1">
              <button
                onClick={startDefaultChat}
                disabled={startingChat}
                className="focus-ring flex w-full flex-col items-start gap-0.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-xs text-slate-500 transition-colors hover:border-stable-purple/50 hover:bg-white/[0.04] hover:text-slate-300 disabled:opacity-50"
              >
                <span className="font-medium">No conversations yet</span>
                <span>
                  {startingChat
                    ? "Starting…"
                    : `Start a chat with ${defaultAgent.name} — every resident you talk to shows up here.`}
                </span>
              </button>
              <button
                onClick={() => setCreateDmOpen(true)}
                className="focus-ring w-full rounded-lg px-3 py-1 text-left text-xs text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300"
              >
                …or message a person
              </button>
            </div>
          )}

          <ul role="list">
            {dmEntries.map((entry) =>
              entry.kind === "agent"
                ? renderAgentGroup(entry.agentId, entry.threads)
                : renderHumanDm(entry.room),
            )}
          </ul>
        </section>
      </nav>

      {createDmOpen && (
        <CreateDmModal onClose={() => setCreateDmOpen(false)} />
      )}
      {browseOpen && (
        <ChannelBrowser onClose={() => setBrowseOpen(false)} />
      )}
    </div>
  );
}
