import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  AtSign,
  Bell,
  BellOff,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  Hash,
  Lock,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Room } from "@/services/api";
import { ws } from "@/services/websocket";
import {
  isMuted,
  getNotifyLevel,
  setNotifyLevel,
  onMutedChange,
  type NotifyLevel,
} from "@/utils/mute";
import { exportRoomToMarkdown } from "@/utils/exportRoom";
import { identityFor } from "@/lib/identity";
import { agentPresence, humanPresence } from "@/lib/agentStatus";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import {
  useChannelCategories,
  foldersFor,
  type FolderSection,
} from "@/stores/categoryStore";
import {
  buildSidebarModel,
  isPrivateChannel,
  SECTION_KEYS,
  type PersonEntry,
  type SidebarGroup,
  type SidebarRow,
} from "./sidebarModel";
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
  // Search + per-person expansion live in a store, not here: they change which
  // rows are on screen, and Alt+↑/↓ walks that same visible order. See
  // sidebarModel.ts.
  const searchQuery = useSidebarUi((s) => s.searchQuery);
  const setSearchQuery = useSidebarUi((s) => s.setSearchQuery);
  const expandedPeople = useSidebarUi((s) => s.expandedPeople);
  const togglePersonExpanded = useSidebarUi((s) => s.togglePersonExpanded);
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

  // Personal folders (client-side; see categoryStore). Folder identity is
  // (instance, section, name), so everything here is scoped by the active
  // instance id — one server's folders must never reach another's.
  const scope = useFederationStore((s) => s.activeInstanceId);
  const categories = useChannelCategories((s) => s.categories);
  const peopleByScope = useChannelCategories((s) => s.people);
  const collapsed = useChannelCategories((s) => s.collapsed);
  const folderDefs = useChannelCategories((s) => s.folders);
  const setCategory = useChannelCategories((s) => s.setCategory);
  const setPeopleCategory = useChannelCategories((s) => s.setPeopleCategory);
  const toggleCollapsed = useChannelCategories((s) => s.toggleCollapsed);
  const ensureFolder = useChannelCategories((s) => s.ensureFolder);
  const renameFolder = useChannelCategories((s) => s.renameFolder);
  const removeFolder = useChannelCategories((s) => s.removeFolder);
  const adoptLegacyCategories = useChannelCategories(
    (s) => s.adoptLegacyCategories,
  );
  const adoptLegacyPeopleFolders = useChannelCategories(
    (s) => s.adoptLegacyPeopleFolders,
  );

  // THE sidebar structure. RoomList renders it; AppShell flattens the same
  // model for Alt+↑/↓. There is no second model to keep in sync.
  const model = useMemo(
    () =>
      buildSidebarModel({
        rooms,
        searchQuery,
        scope,
        categories,
        people: peopleByScope,
        folders: folderDefs,
        collapsed,
        expandedPeople,
      }),
    [
      rooms,
      searchQuery,
      scope,
      categories,
      peopleByScope,
      folderDefs,
      collapsed,
      expandedPeople,
    ],
  );

  // Attribute channel folders saved before `categories` was per-instance to the
  // server that actually owns those rooms. Convergent and self-limiting: it
  // only claims room ids this backend serves, and consumes what it claims.
  useEffect(() => {
    if (scope) adoptLegacyCategories(scope, model.roomKinds);
  }, [scope, model.roomKinds, adoptLegacyCategories]);

  // Rescue people filed by the previous build, which recorded the folder on
  // every one of the person's ROOM ids. Rooms arrive updated_at DESC, so a
  // newly created thread became threads[0] and the old read path landed on an
  // unassigned thread — the person visibly fell out of their folder. The folder
  // hangs off the PERSON now; this carries the already-saved assignments over
  // rather than orphaning them. Safe on every room refresh: it consumes the
  // room-id entries it adopts, so it converges and can never resurrect a
  // cleared assignment.
  useEffect(() => {
    if (!scope || model.allPersonThreads.length === 0) return;
    adoptLegacyPeopleFolders(scope, model.allPersonThreads);
  }, [scope, model.allPersonThreads, adoptLegacyPeopleFolders]);

  const channelFolders = useMemo(
    () => foldersFor(folderDefs, scope, "channels"),
    [folderDefs, scope],
  );
  const peopleFolders = useMemo(
    () => foldersFor(folderDefs, scope, "people"),
    [folderDefs, scope],
  );
  /** roomId -> folder / personKey -> folder, for the server on screen. */
  const channelsFiled = useMemo(
    () => (scope ? categories[scope] : undefined),
    [categories, scope],
  );
  const peopleFiled = useMemo(
    () => (scope ? peopleByScope[scope] : undefined),
    [peopleByScope, scope],
  );

  // Menu + inline-input state. The key is a room id for channels, a person /
  // agent key for people, and `folder:<section>:<name>` for a folder header, so
  // exactly one menu is open at a time across all three.
  const [menuKey, setMenuKeyRaw] = useState<string | null>(null);
  // Inline "New folder" input inside the ⋮ menu (null = collapsed to the
  // button). Never survives a menu open/close, hence the wrapped setter.
  const [newCatDraft, setNewCatDraft] = useState<string | null>(null);
  // Rename-in-place draft and the two-step delete confirm, both scoped to the
  // folder menu that is currently open.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const setMenuKey = (key: string | null) => {
    setMenuKeyRaw(key);
    setNewCatDraft(null);
    setRenameDraft(null);
    setConfirmingDelete(false);
  };
  // Header "new folder" inputs, one per section.
  const [newFolderFor, setNewFolderFor] = useState<FolderSection | null>(null);
  const [newFolderDraft, setNewFolderDraft] = useState("");

  // mute.ts persists to localStorage outside React — bump on its change event
  // so isMuted() is re-read and muted badges/menu labels stay in sync.
  const [, setMutedVersion] = useState(0);
  useEffect(() => onMutedChange(() => setMutedVersion((v) => v + 1)), []);

  function commitHeaderFolder() {
    const name = newFolderDraft.trim();
    if (name && newFolderFor && scope) ensureFolder(scope, name, newFolderFor);
    setNewFolderFor(null);
    setNewFolderDraft("");
  }

  function assignCategory(roomIds: string | string[], category: string | null) {
    setCategory(scope, roomIds, category);
    setMenuKey(null);
  }

  function assignPersonCategory(personKey: string, category: string | null) {
    if (scope) setPeopleCategory(scope, personKey, category);
    setMenuKey(null);
  }

  function commitNewCategory(apply: (name: string) => void) {
    const name = (newCatDraft ?? "").trim();
    if (name) apply(name);
    setMenuKey(null);
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
    setMenuKey(null);
  }

  /** The "Move to folder" block, shared by the channel and people menus.
   *  `apply` is what actually records the choice — channels file by room id,
   *  people file by person key — because the menu itself is identical either
   *  way and only the thing being filed differs. */
  function renderFolderMenuItems(
    apply: (category: string | null) => void,
    currentCat: string | undefined,
    section: FolderSection,
  ) {
    const names = section === "channels" ? channelFolders : peopleFolders;
    return (
      <>
        <p className="mt-0.5 border-t border-line px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Move to folder
        </p>
        {names.map((c) => (
          <button
            key={c}
            role="menuitem"
            onClick={() => apply(c)}
            className={clsx(
              "focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06]",
              c === currentCat ? "text-stable-purple-light" : "text-slate-300",
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
            New folder…
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
                  commitNewCategory(apply);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setNewCatDraft(null);
                }
              }}
              placeholder="Folder name"
              aria-label="New folder name"
              className="w-full min-w-0 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60"
            />
          </div>
        )}
        {currentCat && (
          <button
            role="menuitem"
            onClick={() => apply(null)}
            className="focus-ring mt-0.5 flex w-full items-center gap-2 border-t border-line px-3 py-1.5 text-left text-sm text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            Remove from “{currentCat}”
          </button>
        )}
      </>
    );
  }

  /**
   * The ⋮ trigger. Hover-reveal is a DESKTOP-only affordance: a touch device
   * has no hover, and an invisible-but-tappable button is not a feature. Below
   * md it is permanently visible.
   */
  function renderMenuTrigger(key: string, label: string, alwaysVisible = false) {
    const open = menuKey === key;
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMenuKey(open ? null : key);
        }}
        className={clsx(
          "focus-ring mr-1 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1",
          open || alwaysVisible
            ? "opacity-100"
            : "opacity-70 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
        )}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
    );
  }

  function renderMenuShell(children: ReactNode) {
    return (
      <>
        <button
          className="fixed inset-0 z-20 cursor-default"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMenuKey(null)}
        />
        <div
          role="menu"
          className="glass-heavy animate-fade-in absolute right-2 top-9 z-30 w-48 overflow-hidden rounded-xl py-1 shadow-pop"
        >
          {children}
        </div>
      </>
    );
  }

  function renderNotifyItems(room: Room) {
    const level = getNotifyLevel(room.id);
    return (
      <>
        <p className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Notifications
        </p>
        {(
          [
            { key: "all", label: "All messages", Icon: Bell },
            { key: "mentions", label: "Mentions only", Icon: AtSign },
            { key: "muted", label: "Muted", Icon: BellOff },
          ] as { key: NotifyLevel; label: string; Icon: typeof Bell }[]
        ).map(({ key, label, Icon }) => (
          <button
            key={key}
            role="menuitemradio"
            aria-checked={level === key}
            onClick={() => {
              setNotifyLevel(room.id, key);
              setMenuKey(null);
            }}
            className={clsx(
              "focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06]",
              level === key ? "text-stable-purple-light" : "text-slate-300",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="flex-1">{label}</span>
            {level === key && (
              <Check className="h-3.5 w-3.5 shrink-0 text-stable-purple-light" />
            )}
          </button>
        ))}
        <div className="my-0.5 border-t border-line" />
        <button
          role="menuitem"
          onClick={() => markRoomRead(room)}
          className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          <CheckCheck className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Mark as read
        </button>
        <button
          role="menuitem"
          onClick={() => {
            setMenuKey(null);
            void exportRoomToMarkdown(room);
          }}
          className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          <Download className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Export as Markdown
        </button>
      </>
    );
  }

  function renderChannelRow(room: Room) {
    const isActive = activeRoomId === room.id;
    const unread = unreadCounts[room.id] ?? 0;
    const cat = channelsFiled?.[room.id];
    const menuOpen = menuKey === room.id;
    const muted = isMuted(room.id);
    const priv = isPrivateChannel(room);
    const Icon = priv ? Lock : Hash;
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
            <Icon
              className={clsx(
                "h-4 w-4 shrink-0",
                priv
                  ? "text-amber-300/70"
                  : isActive
                    ? "text-stable-cyan"
                    : "text-stable-cyan/70",
              )}
              aria-label={priv ? "Private channel" : "Public channel"}
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
          {renderMenuTrigger(room.id, `Options for ${room.name}`)}
        </div>

        {menuOpen &&
          renderMenuShell(
            <>
              {renderNotifyItems(room)}
              {renderFolderMenuItems(
                (name) => assignCategory(room.id, name),
                cat,
                "channels",
              )}
            </>,
          )}
      </li>
    );
  }

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

  /**
   * One row per resident/person. Multiple conversations collapse into a thread
   * history: the row opens the newest thread, the chevron reveals the rest, the
   * "+" starts a fresh thread (agents only — a human DM is a single room).
   */
  function renderPersonEntry(entry: PersonEntry, expanded: boolean) {
    const isAgent = entry.kind === "agent";
    const threads = entry.threads;
    const name = isAgent
      ? agentDisplayName(entry.agentId, threads)
      : entry.name;
    const ident = identityFor(isAgent ? entry.agentId : entry.key, name);
    const latest = threads[0];
    const hasActive = threads.some((r) => r.id === activeRoomId);
    const unreadTotal = threads.reduce((n, r) => n + (r.unread_count ?? 0), 0);
    const menuOpen = menuKey === entry.key;
    const cat = peopleFiled?.[entry.key];
    const others = (participantsByRoom[latest?.id ?? ""] ?? []).filter(
      (p) => (p.participant_id || p.user_id) !== currentUserId,
    );
    // Two sources, in priority order. The room's own member row is the richest
    // (it also knows whether the agent is IN a call), but `/members` is polled
    // only for the ACTIVE room — every other agent thread in this sidebar has
    // no row at all. The Brigade roster covers those: availability is a
    // property of the agent, not of the room, so the fallback is not a
    // degraded guess. An agent in neither lands on "unknown", which renders as
    // a dim ring, not as available.
    // Humans keep the connected-or-nothing model: `is_online` alone — see
    // ParticipantStrip; the old global online set was add-only, so OR'ing it in
    // kept departed peers green. Availability is an agent concept only.
    const agentMember = others.find((p) => p.participant_type === "agent");
    const rosterAgent = isAgent
      ? agents.find((a) => a.id === entry.agentId)
      : undefined;
    const badge = isAgent
      ? agentPresence({
          isOnline: agentMember?.is_online,
          availability: agentMember?.availability ?? rosterAgent?.availability,
          availabilityReason:
            agentMember?.availability_reason ??
            rosterAgent?.availability_reason,
          name,
        })
      : humanPresence(others.some((p) => p.is_online));
    return (
      <li key={entry.key} className="relative">
        <div
          className={clsx(
            "group relative flex w-full items-center rounded-lg pr-1 transition-colors",
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
              {isAgent ? (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: ident.color }}
                />
              ) : (
                <MessageSquare className="h-4 w-4 opacity-60" />
              )}
              {badge && (
                <span
                  className={clsx(
                    "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border",
                    badge.dotClass,
                  )}
                  aria-label={badge.label}
                  title={badge.label}
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-sm font-medium"
                  style={isAgent ? { color: ident.text } : undefined}
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
          {isAgent && (
            <button
              onClick={() => startAgentChat(entry.agentId, name)}
              disabled={startingChat}
              className="focus-ring rounded-md p-1 text-slate-500 opacity-60 transition-all hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              aria-label={`Start a new chat with ${name}`}
              title={`New chat with ${name}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          {renderMenuTrigger(entry.key, `Options for ${name}`)}
          {threads.length > 1 && (
            <button
              onClick={() => togglePersonExpanded(entry.key)}
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

        {menuOpen &&
          renderMenuShell(
            <>
              {latest && renderNotifyItems(latest)}
              {/* Filed against the person, so every thread with them — including
                  ones that do not exist yet — comes along automatically. */}
              {renderFolderMenuItems(
                (name) => assignPersonCategory(entry.key, name),
                cat,
                "people",
              )}
            </>,
          )}

        {expanded && threads.length > 1 && (
          <ul role="list" className="ml-3 border-l border-line pl-1">
            {threads.map((room) => renderThreadRow(room, ident.color))}
          </ul>
        )}
      </li>
    );
  }

  function renderPrivateGroup(room: Room) {
    const isActive = activeRoomId === room.id;
    const menuOpen = menuKey === room.id;
    const others = (participantsByRoom[room.id] ?? []).filter(
      (p) => (p.participant_id || p.user_id) !== currentUserId,
    );
    const badge = humanPresence(others.some((p) => p.is_online));
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
              "focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
              isActive
                ? "text-slate-50"
                : "text-slate-300 hover:text-slate-100",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              <Users
                className="h-4 w-4 text-amber-300/70"
                aria-label="Private group — invite only"
              />
              {badge && (
                <span
                  className={clsx(
                    "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border",
                    badge.dotClass,
                  )}
                  aria-label={badge.label}
                  title={badge.label}
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{room.name}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {room.member_count > 0 && (
                    <span className="text-[10px] tabular-nums text-slate-600">
                      {room.member_count}
                    </span>
                  )}
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
          {renderMenuTrigger(room.id, `Options for ${room.name}`)}
        </div>
        {menuOpen && renderMenuShell(renderNotifyItems(room))}
      </li>
    );
  }

  function renderRow(row: SidebarRow): ReactNode {
    switch (row.kind) {
      case "channel":
        return renderChannelRow(row.room);
      case "group":
        return renderPrivateGroup(row.room);
      case "person":
        return renderPersonEntry(row.entry, row.expanded);
    }
  }

  // ---- Section + folder chrome ---------------------------------------------

  function renderSectionHeader(
    key: string,
    title: string,
    hint: string,
    actions?: ReactNode,
  ) {
    const shut = collapsed[key];
    return (
      <div className="flex items-center justify-between px-2.5 pb-1">
        <button
          onClick={() => toggleCollapsed(key)}
          className="focus-ring group flex min-w-0 items-center gap-1 rounded-md py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
          aria-expanded={!shut}
          title={hint}
        >
          <ChevronDown
            className={clsx(
              "h-3 w-3 shrink-0 transition-transform duration-150",
              shut && "-rotate-90",
            )}
          />
          <span className="truncate">{title}</span>
        </button>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
    );
  }

  function renderNewFolderButton(section: FolderSection) {
    return (
      <button
        onClick={() => {
          setNewFolderFor(section);
          setNewFolderDraft("");
        }}
        className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:p-0.5"
        aria-label={`New ${section === "channels" ? "channel" : "people"} folder`}
        title="New folder"
      >
        <FolderPlus className="h-3.5 w-3.5" />
      </button>
    );
  }

  function renderNewFolderInput(section: FolderSection) {
    if (newFolderFor !== section) return null;
    return (
      <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg border border-line bg-slate-950/60 px-2 py-1">
        <FolderPlus className="h-3.5 w-3.5 shrink-0 text-stable-purple-light/80" />
        <input
          autoFocus
          value={newFolderDraft}
          onChange={(e) => setNewFolderDraft(e.target.value)}
          onBlur={commitHeaderFolder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commitHeaderFolder();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setNewFolderFor(null);
              setNewFolderDraft("");
            }
          }}
          placeholder="Folder name"
          aria-label="New folder name"
          className="w-full min-w-0 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
        />
      </div>
    );
  }

  function commitRename(section: FolderSection, from: string) {
    const to = (renameDraft ?? "").trim();
    if (scope && to && to !== from) renameFolder(scope, section, from, to);
    setMenuKey(null);
  }

  /**
   * The folder ⋮ menu: rename in place, or delete.
   *
   * Both live behind an explicit, always-visible button rather than a
   * hover-reveal — this sidebar is a touch surface, and a folder you can only
   * rename with a mouse is a folder a phone user is stuck with forever.
   * Deleting asks first, in-menu (a second tap, not a native confirm() a
   * touch keyboard can hide), and it UNFILES the rows rather than removing
   * them: a folder is a view over rooms, never a container that owns them.
   */
  function renderFolderMenu(section: FolderSection, name: string) {
    if (renameDraft !== null) {
      return renderMenuShell(
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Pencil className="h-3.5 w-3.5 shrink-0 text-stable-purple-light/80" />
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitRename(section, name);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setRenameDraft(null);
              }
            }}
            placeholder="Folder name"
            aria-label={`Rename folder ${name}`}
            className="w-full min-w-0 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60"
          />
        </div>,
      );
    }
    if (confirmingDelete) {
      return renderMenuShell(
        <>
          <p className="px-3 pb-1 pt-1.5 text-[11px] leading-snug text-slate-400">
            Delete “{name}”? The{" "}
            {section === "channels" ? "channels" : "people"} in it stay — they
            move back to the ungrouped list.
          </p>
          <button
            role="menuitem"
            onClick={() => {
              if (scope) removeFolder(scope, section, name);
              setMenuKey(null);
            }}
            className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            Delete folder
          </button>
          <button
            role="menuitem"
            onClick={() => setConfirmingDelete(false)}
            className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
          >
            Cancel
          </button>
        </>,
      );
    }
    return renderMenuShell(
      <>
        <p className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Folder
        </p>
        <button
          role="menuitem"
          onClick={() => setRenameDraft(name)}
          className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Rename…
        </button>
        <button
          role="menuitem"
          onClick={() => setConfirmingDelete(true)}
          className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Delete folder…
        </button>
      </>,
    );
  }

  /** A folder header + its rows. Empty folders still render: the header is
   *  where rename/delete live, and a folder you cannot see is a folder you
   *  cannot fix. */
  function renderFolder(group: SidebarGroup) {
    const name = group.folder!;
    const section = group.section!;
    const key = group.collapseKey!;
    const menuId = `folder:${section}:${name}`;
    const menuOpen = menuKey === menuId;
    return (
      <div key={key} className="relative mb-0.5">
        <div className="group flex items-center rounded-md">
          <button
            onClick={() => toggleCollapsed(key)}
            className="focus-ring flex min-w-0 flex-1 items-center gap-1 rounded-md px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
            aria-expanded={!group.collapsed}
          >
            <ChevronDown
              className={clsx(
                "h-3 w-3 shrink-0 transition-transform duration-150",
                group.collapsed && "-rotate-90",
              )}
            />
            <Folder className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
            <span className="truncate">{name}</span>
            <span className="ml-auto tabular-nums text-slate-500">
              {group.rows.length}
            </span>
          </button>
          {renderMenuTrigger(menuId, `Options for folder ${name}`, true)}
        </div>
        {menuOpen && renderFolderMenu(section, name)}
        {!group.collapsed &&
          (group.rows.length > 0 ? (
            <ul role="list" className="ml-1.5 border-l border-line pl-1">
              {group.rows.map(renderRow)}
            </ul>
          ) : (
            <p className="ml-1.5 border-l border-line py-1 pl-3 text-[11px] italic text-slate-600">
              Empty — use a row’s ⋮ menu to file something here
            </p>
          ))}
      </div>
    );
  }

  function renderSectionBody(section: (typeof model.sections)[number]) {
    return (
      <>
        {section.groups.map((group, i) =>
          group.folder !== null ? (
            renderFolder(group)
          ) : (
            <ul role="list" key={`ungrouped-${i}`}>
              {group.rows.map(renderRow)}
            </ul>
          ),
        )}
      </>
    );
  }

  const [channelSection, peopleSection, groupsSection] = model.sections;
  const channelCount = channelSection.groups.reduce(
    (n, g) => n + g.rows.length,
    0,
  );
  const peopleCount = peopleSection.groups.reduce(
    (n, g) => n + g.rows.length,
    0,
  );
  const groupCount = groupsSection.groups.reduce((n, g) => n + g.rows.length, 0);

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
          {renderSectionHeader(
            SECTION_KEYS.channels,
            "Channels",
            "Public — anyone on this server can find and join these",
            <>
              {renderNewFolderButton("channels")}
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
            </>,
          )}

          {!channelSection.collapsed && (
            <>
              {renderNewFolderInput("channels")}

              {channelCount === 0 && (
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

              {renderSectionBody(channelSection)}
            </>
          )}
        </section>

        <section>
          {renderSectionHeader(
            SECTION_KEYS.people,
            "People & agents",
            "Private — direct conversations, one row per person you talk to",
            <>
              {renderNewFolderButton("people")}
              <button
                onClick={() => setCreateDmOpen(true)}
                className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:p-0.5"
                aria-label="New direct message"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </>,
          )}

          {!peopleSection.collapsed && (
            <>
              {renderNewFolderInput("people")}

              {peopleCount === 0 && groupCount === 0 && (
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

              {renderSectionBody(peopleSection)}
            </>
          )}
        </section>

        {/* Private groups only exist once you are in one — no stray header. */}
        {groupCount > 0 && (
          <section>
            {renderSectionHeader(
              SECTION_KEYS.groups,
              "Private groups",
              "Invite only — these never appear in Browse channels",
            )}
            {!groupsSection.collapsed && renderSectionBody(groupsSection)}
          </section>
        )}
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
