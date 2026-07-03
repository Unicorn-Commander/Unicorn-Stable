import { useState, useMemo, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Bot,
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
  // Identity hue for the default agent — drives its rows' dots + active accent.
  const defaultAgentIdent = identityFor(defaultAgent.id, defaultAgent.name);
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

  // ChatGPT-style "New chat": start a fresh conversation bound to the user's
  // default agent and jump into it (the section "+" and empty-state CTA). The
  // split New-chat button has its own per-agent path.
  async function startDefaultChat() {
    if (startingChat) return;
    setStartingChat(true);
    try {
      const room = await api.createAgentDm(
        defaultAgent.id,
        `Chat with ${defaultAgent.name}`,
      );
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      openRoom(room.id);
    } catch (err) {
      console.error("new chat failed", err);
      alert("Couldn't start a new chat — " + (err as Error).message);
    } finally {
      setStartingChat(false);
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
  const [menuRoomId, setMenuRoomId] = useState<string | null>(null);

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

  function promptNewCategory(roomId: string) {
    const name = window.prompt("New category name");
    if (name && name.trim()) setCategory(roomId, name.trim());
    setMenuRoomId(null);
  }

  function renderChannelRow(room: Room) {
    const isActive = activeRoomId === room.id;
    const unread = unreadCounts[room.id] ?? 0;
    const cat = categories[room.id];
    const menuOpen = menuRoomId === room.id;
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
                {unread > 0 && (
                  <span className="gradient-bg ml-1 grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
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
              <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
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
              <button
                role="menuitem"
                onClick={() => promptNewCategory(room.id)}
                className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
              >
                <FolderPlus className="h-3.5 w-3.5 shrink-0 text-stable-purple-light/80" />
                New category…
              </button>
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

  // Conversations with the user's default agent get their own resumable-history
  // section. The rooms query is already ordered most-recent-first by the backend
  // (updated_at DESC), so this slice stays newest → oldest.
  const primaryConversations = useMemo(
    () =>
      filteredRooms.filter(
        (r) =>
          (r.type === "dm" || r.type === "group_dm") &&
          r.brigade_agent_id === defaultAgent.id,
      ),
    [filteredRooms, defaultAgent.id],
  );

  // Everything else that's a DM (other people / other agents). The default
  // agent's conversations are pulled out above so they aren't listed twice.
  const directMessages = useMemo(
    () =>
      filteredRooms.filter(
        (r) =>
          (r.type === "dm" || r.type === "group_dm") &&
          r.brigade_agent_id !== defaultAgent.id,
      ),
    [filteredRooms, defaultAgent.id],
  );

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
              Chats with {defaultAgent.name}
            </h3>
            <button
              onClick={startDefaultChat}
              disabled={startingChat}
              className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-50 md:p-0.5"
              aria-label={`Start a new chat with ${defaultAgent.name}`}
              title={`Start a new chat with ${defaultAgent.name}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {primaryConversations.length === 0 ? (
            <button
              onClick={startDefaultChat}
              disabled={startingChat}
              className="focus-ring mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col items-start gap-0.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-xs text-slate-500 transition-colors hover:border-stable-purple/50 hover:bg-white/[0.04] hover:text-slate-300 disabled:opacity-50"
            >
              <span className="font-medium">No conversations yet</span>
              <span>
                {startingChat
                  ? "Starting…"
                  : `Start a chat with ${defaultAgent.name} — past conversations show up here.`}
              </span>
            </button>
          ) : (
            <ul role="list">
              {primaryConversations.map((room) => {
                const others = (participantsByRoom[room.id] ?? []).filter(
                  (p) => (p.participant_id || p.user_id) !== currentUserId,
                );
                const otherOnline = others.some((p) => {
                  const id = p.participant_id || p.user_id || "";
                  return p.is_online || onlineUsers.includes(id);
                });
                return (
                  <li key={room.id}>
                    <button
                      onClick={() => openRoom(room.id)}
                      className={clsx(
                        "focus-ring relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
                        activeRoomId === room.id
                          ? "bg-white/[0.06] text-slate-50"
                          : "text-slate-300 hover:bg-white/[0.04] hover:text-slate-100",
                      )}
                      aria-current={activeRoomId === room.id ? "page" : undefined}
                    >
                      {activeRoomId === room.id && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
                          style={{ background: defaultAgentIdent.color }}
                        />
                      )}
                      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: defaultAgentIdent.color }}
                        />
                        {otherOnline && (
                          <span
                            className="animate-live absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-slate-900 bg-stable-mint"
                            aria-label="Online"
                          />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {room.name}
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
              })}
            </ul>
          )}
        </section>

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
              aria-label="Create direct message"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {directMessages.length === 0 && (
            <button
              onClick={() => setCreateDmOpen(true)}
              className="focus-ring mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col items-start gap-0.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-xs text-slate-500 transition-colors hover:border-stable-purple/50 hover:bg-white/[0.04] hover:text-slate-300"
            >
              <span className="font-medium">No DMs yet</span>
              <span>Click here to start one — pick one person or several for a group.</span>
            </button>
          )}

          <ul role="list">
            {directMessages.map((room) => {
              const others = (participantsByRoom[room.id] ?? []).filter(
                (p) => (p.participant_id || p.user_id) !== currentUserId,
              );
              const otherOnline = others.some((p) => {
                const id = p.participant_id || p.user_id || "";
                return p.is_online || onlineUsers.includes(id);
              });
              // Agent DMs carry their resident's identity hue (6px dot + active
              // accent); human DMs keep the neutral message glyph.
              const agentIdent = room.brigade_agent_id
                ? identityFor(room.brigade_agent_id, room.name)
                : null;
              return (
              <li key={room.id}>
                <button
                  onClick={() => openRoom(room.id)}
                  className={clsx(
                    "focus-ring relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
                    activeRoomId === room.id
                      ? "bg-white/[0.06] text-slate-50"
                      : "text-slate-300 hover:bg-white/[0.04] hover:text-slate-100",
                  )}
                  aria-current={activeRoomId === room.id ? "page" : undefined}
                >
                  {activeRoomId === room.id && (
                    <span
                      aria-hidden="true"
                      className={clsx(
                        "absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full",
                        !agentIdent && "bg-stable-purple",
                      )}
                      style={agentIdent ? { background: agentIdent.color } : undefined}
                    />
                  )}
                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                    {agentIdent ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: agentIdent.color }}
                      />
                    ) : (
                      <MessageSquare className="h-4 w-4 opacity-60" />
                    )}
                    {otherOnline && (
                      <span
                        className="animate-live absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-slate-900 bg-stable-mint"
                        aria-label="Online"
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {room.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {room.last_message && (
                          <span className="text-[10px] tabular-nums text-slate-500">
                            {formatTimestamp(room.last_message.created_at)}
                          </span>
                        )}
                        {room.unread_count > 0 && (
                          <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                            {room.unread_count > 99
                              ? "99+"
                              : room.unread_count}
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
            })}
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
