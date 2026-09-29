import { lastLinePreview } from "@/lib/systemLines";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  AtSign,
  Bell,
  BellOff,
  Bot,
  Check,
  CheckCheck,
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  Hash,
  Lock,
  MoreVertical,
  Pencil,
  Phone,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Message, type Room } from "@/services/api";
import { ws } from "@/services/websocket";
import {
  isMuted,
  getNotifyLevel,
  setNotifyLevel,
  onMutedChange,
  type NotifyLevel,
} from "@/utils/mute";
import {
  badgeCount,
  prepareRoomsForSidebar,
  roomsNeedingMarkRead,
} from "@/utils/unreadModel";
import { exportRoomToMarkdown } from "@/utils/exportRoom";
import { stripMarkdown } from "@/utils/messagePreview";
import { displayName } from "@/lib/instances";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { Identity } from "@/components/ui/Identity";
import { MeetingsRecordings } from "@/components/Meetings/RecordingsList";
import { agentPresence, humanPresence } from "@/lib/agentStatus";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import {
  isNavV1Enabled,
  isNavV2Enabled,
  shellDestinationForPath,
  useNavStore,
  viewForRoom,
  type ConversationFilter,
} from "@/stores/navStore";
import {
  useChannelCategories,
  foldersFor,
  type FolderSection,
} from "@/stores/categoryStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { useLiveCalls } from "@/hooks/useLiveCalls";
import {
  buildConversationRows,
  buildSidebarModel,
  groupFaceRoom,
  isPrivateChannel,
  roomsForView,
  roomsOnConversationRow,
  SECTION_KEYS,
  type PersonEntry,
  type SidebarGroup,
  type SidebarRow,
  type SidebarView,
} from "./sidebarModel";
import { ViewSwitcher } from "./ViewSwitcher";
import { CrewSection } from "./CrewSection";
import { CreateDmModal } from "./CreateDmModal";
import { ChannelBrowser } from "./ChannelBrowser";
import { LiveCallBadge } from "./LiveCallBadge";
import { resolveDefaultAgent } from "./newChat";
import { beginThread } from "@/lib/beginThread";
import { olderArchivedLabel, roomLabel } from "@/lib/conversation";
import { AgentModeChip } from "@/components/Room/AgentModeChip";
import { useConversationUi } from "@/stores/conversationUiStore";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import { usePresenceStore } from "@/stores/presenceStore";
import type { PeopleDirectoryEntry } from "@/services/api";

import { hasDraft, subscribeDrafts } from "@/utils/drafts";
import { HomeRail } from "@/components/Home/HomeRail";
import { useIsDesktop } from "@/hooks/usePanelResize";

/** Active workspace, pinned above the one Conversations list. */
function WorkspaceTitle() {
  const activeId = useFederationStore((s) => s.activeInstanceId);
  const instances = useFederationStore((s) => s.instances);
  const accessible = useFederationStore((s) => s.accessibleInstances);
  const metaByInstance = useFederationStore((s) => s.metaByInstance);
  const pool = accessible.length > 0 ? accessible : instances;
  const instance = pool.find((item) => item.id === activeId) ?? pool[0];
  const name = instance
    ? displayName(instance, activeId ? metaByInstance[activeId] : undefined)
    : "Stable";
  return (
    <div
      className="flex h-6 shrink-0 items-baseline gap-2 px-1"
      data-testid="conversation-list-header"
    >
      <p
        data-testid="workspace-name"
        className="min-w-0 truncate text-sm font-semibold text-slate-50"
      >
        {name}
      </p>
      <h2 className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Conversations
      </h2>
    </div>
  );
}

/**
 * Bump-version subscription to the draft store. localStorage is not reactive,
 * so the sidebar re-reads `hasDraft` on every save/clear (typing a message
 * shows the pencil instantly; sending hides it).
 */
function PendingInvites() {
  const rows = useConversationUi((s) => s.pendingInvites);
  const dismiss = useConversationUi((s) => s.dismissInvite);
  if (rows.length === 0) return null;
  return (
    <ul className="border-b border-line px-2 py-2" aria-label="Pending invites">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300">
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <button
            type="button"
            onClick={() => dismiss(row.id)}
            className="focus-ring text-[10px] text-slate-500 hover:text-slate-200"
          >
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}

function useDraftVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeDrafts(() => setVersion((n) => n + 1)), []);
  return version;
}

/** Small pencil glyph for rows with an unsaved draft (Slack's affordance). */
function DraftPencil() {
  return (
    <Pencil
      aria-label="Draft saved"
      className="ml-1 h-3 w-3 shrink-0 text-slate-500"
    />
  );
}

/** "Name: line" for a message; a system line is its own sentence, unnamed. */
function LastLine({
  message,
  nameClassName,
  format,
}: {
  message: Message;
  nameClassName: string;
  format: (content: string) => string;
}) {
  const line = lastLinePreview(message);
  return (
    <>
      {line.sender && (
        <>
          <span className={nameClassName}>{line.sender}:</span>{" "}
        </>
      )}
      {format(line.text)}
    </>
  );
}

export function RoomList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const rooms = useAppStore((s) => s.rooms);
  const roomsLoaded = useAppStore((s) => s.roomsLoaded);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const participantsByRoom = useAppStore((s) => s.participants);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const agents = useAppStore((s) => s.agents);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const setDefaultAgentId = useAppStore((s) => s.setDefaultAgentId);
  // Nav v2 (default on) is one Conversations list. Off restores the five-view
  // shell, which itself falls back to the classic tree when nav v1 is off.
  const navV2 = isNavV2Enabled();
  const navV1 = isNavV1Enabled();
  const activeView = useNavStore((s) => s.activeView);
  const storedV2Destination = useNavStore((s) => s.v2Destination);
  const isDesktop = useIsDesktop();
  // Directory follows the URL. A stored "directory" on any other path is Home.
  const routedV2Destination = shellDestinationForPath(
    location.pathname,
    storedV2Destination,
  );
  // Crew and Calls are phone tabs (Nav v3 §2.6). On a desktop the crew is a
  // section above the one list and standing rooms are channel rows in it.
  const v2Destination =
    isDesktop && (routedV2Destination === "crew" || routedV2Destination === "calls")
      ? "conversations"
      : routedV2Destination;
  const conversationFilter = useNavStore((s) => s.conversationFilter);
  const setV2Destination = useNavStore((s) => s.setV2Destination);
  const rememberRoom = useNavStore((s) => s.rememberRoom);
  const setActiveView = useNavStore((s) => s.setActiveView);
  const scope = useFederationStore((s) => s.activeInstanceId);
  // Live call rejoin (Meetings empty/rail) — same source as Home.
  const { isConnected } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  // Which rooms have a live call RIGHT NOW — the one shared source of truth
  // (home-summary poll + call_occupancy WS nudges). Read once here; every row
  // renderer below does a map lookup, so there is no per-row polling.
  const { byRoomId: liveCallByRoomId } = useLiveCalls();
  // Draft pencils: bump on every draft save/clear so rows stay truthful.
  useDraftVersion();
  // Model view: classic mode always builds the full tree. The one list builds
  // its own rows (view "all") so a Meetings/Direct activeView cannot hide them.
  // The phone's Calls tab is the standing-room list (the v1 Meetings body).
  const modelView: SidebarView = navV2
    ? v2Destination === "calls"
      ? "meetings"
      : "all"
    : navV1
      ? activeView
      : "all";
  // The agent the "New chat" button + the primary conversation section key off
  // (the user's chosen default, else Majik, else the first agent).
  const defaultAgent = resolveDefaultAgent(agents, defaultAgentId);
  // THE single source of truth for a room's badge, everywhere in this file.
  // `unreadCounts` is the live map: setRooms seeds it from the backend's
  // cold-load `unread_count` the first time a room is seen, WS arrivals
  // increment it, clearUnread zeroes it. `room.unread_count` is only that
  // cold-load snapshot and is NEVER cleared by opening a room — rows that read
  // it directly (the DM/person and private-group rows) showed a badge that
  // clearUnread could not touch, so it sat there until the next refetch.
  // Muted rooms always report 0 so badges never shout for silenced channels
  // (mute.ts "muted" level; matches rail + Focused filter).
  const rawUnreadFor = (room: Room) =>
    unreadCounts[room.id] ?? room.unread_count ?? 0;
  const unreadFor = (room: Room) => badgeCount(room.id, rawUnreadFor(room));
  // Same rooms the unread-first sort counts (parent + threads, hub included).
  // Expanded rows badge only the room the row itself is; nested rows badge
  // themselves. A collapsed channel or agent hub otherwise showed no badge
  // while the sort still treated the row as unread.
  const rowBadgeCount = (row: SidebarRow): number => {
    const all = roomsOnConversationRow(row);
    if (row.kind === "person") {
      if (!row.expanded) return all.reduce((n, item) => n + unreadFor(item), 0);
      const hubListed = row.entry.threads.some(
        (thread) => thread.id === row.entry.hub.id,
      );
      return hubListed ? 0 : unreadFor(row.entry.hub);
    }
    if (row.expanded) return unreadFor(row.room);
    return all.reduce((n, item) => n + unreadFor(item), 0);
  };

  // Open a room by navigating; the route param drives activeRoomId (see
  // AppShell). We still clear unread locally for snappy badge feedback.
  // lastRoom memory is keyed by the room's own destination, not the UI view
  // the user happened to open it from (deep links / cross-view clicks).
  const openRoom = (id: string) => {
    clearUnread(id);
    const room = useAppStore.getState().rooms.find((r) => r.id === id);
    if (room && scope) {
      const view = viewForRoom(room);
      rememberRoom(scope, view, id);
      // Standing rooms stay channels in the one list. viewForRoom still
      // records the v1 slot so the five-view fallback can restore Meetings.
      // A room opened from the phone's Crew or Calls tab keeps that tab.
      if (navV2) {
        if (v2Destination !== "crew" && v2Destination !== "calls") {
          setV2Destination("conversations");
        }
      } else if (navV1) setActiveView(view);
    }
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
  const [createDmOpen, setCreateDmOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  // Search + per-person expansion live in a store, not here: they change which
  // rows are on screen, and Alt+↑/↓ walks that same visible order. See
  // sidebarModel.ts.
  const searchQuery = useSidebarUi((s) => s.searchQuery);
  const setSearchQuery = useSidebarUi((s) => s.setSearchQuery);
  const expandedPeople = useSidebarUi((s) => s.expandedPeople);
  const togglePersonExpanded = useSidebarUi((s) => s.togglePersonExpanded);
  const focusMode = useSidebarUi((s) => s.focusMode);

  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const pushToast = useAppStore((s) => s.pushToast);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const presenceById = usePresenceStore((s) => s.byId);
  const { data: myPreferences } = useQuery({
    queryKey: ["my-preferences", scope],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
    enabled: !navV2 && navV1 && activeView === "direct",
  });
  const { data: peopleDirectory = [] } = useQuery({
    queryKey: ["people-directory", scope, ""],
    queryFn: () => api.getPeopleDirectory(""),
    staleTime: 30_000,
    enabled: !navV2 && navV1 && activeView === "direct",
  });
  const favoritePeople: PeopleDirectoryEntry[] = (() => {
    const ids = myPreferences?.favorite_people_ids ?? [];
    if (!ids.length) return [];
    const set = new Set(ids);
    return peopleDirectory
      .filter((p) => set.has(p.id))
      .sort((a, b) => {
        const ao = presenceById[a.id]?.isOnline ?? a.is_online;
        const bo = presenceById[b.id]?.isOnline ?? b.is_online;
        return Number(bo) - Number(ao) || a.display_name.localeCompare(b.display_name);
      });
  })();

  async function openFavoritePerson(person: PeopleDirectoryEntry) {
    try {
      const room = await ensureHumanDm(person);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      const state = useAppStore.getState();
      if (!state.rooms.some((r) => r.id === room.id)) {
        state.setRooms([room, ...state.rooms]);
      }
      setActiveRoomId(room.id);
      navigate(`/c/${room.id}`);
    } catch (e) {
      pushToast({
        title: "Couldn't open chat",
        body: e instanceof Error ? e.message : "Request failed",
      });
    }
  }

  // ---- Archive / unarchive --------------------------------------------------

  const [archivedRooms, setArchivedRooms] = useState<Room[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  // The archived list is per server. Clear it on switch so A's rooms cannot
  // be opened while B is the active instance, then refetch.
  useEffect(() => {
    let cancelled = false;
    setArchivedRooms([]);
    setShowArchived(false);
    if (scope) {
      api
        .getArchivedRooms()
        .then((next) => {
          if (!cancelled) setArchivedRooms(next);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [scope]);

  async function handleArchiveRoom(room: Room) {
    try {
      await api.archiveRoom(room.id);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      setArchivedRooms((prev) => [...prev, { ...room, is_archived: true }]);
      pushToast({ title: "Chat archived", body: `${room.name} moved to Archived` });
    } catch (e) {
      pushToast({ title: "Couldn't archive", body: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setMenuKey(null);
    }
  }

  async function handleUnarchiveRoom(room: Room) {
    try {
      await api.unarchiveRoom(room.id);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      setArchivedRooms((prev) => prev.filter((r) => r.id !== room.id));
      pushToast({ title: "Chat unarchived", body: `${room.name} restored` });
    } catch (e) {
      pushToast({ title: "Couldn't unarchive", body: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setMenuKey(null);
    }
  }

  function canArchive(room: Room): boolean {
    return room.is_archived === false && (room.type === "dm" || room.type === "group_dm");
  }

  function renderFavoritePeopleStrip() {
    if (!navV1 || activeView !== "direct") return null;
    return (
      <div className="mb-3 px-1">
        <div className="mb-1.5 flex items-center justify-between px-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Favorites
          </h3>
          <button
            type="button"
            onClick={() => setPeopleDrawerOpen(true)}
            className="focus-ring rounded-md px-1.5 py-0.5 text-[10px] font-medium text-stable-cyan hover:bg-stable-cyan/10"
          >
            People
          </button>
        </div>
        {favoritePeople.length === 0 ? (
          <button
            type="button"
            onClick={() => setPeopleDrawerOpen(true)}
            className="focus-ring w-full rounded-xl border border-dashed border-line px-3 py-3 text-left text-xs text-slate-500 transition-colors hover:border-stable-cyan/40 hover:text-slate-300"
          >
            Star coworkers in People — they show up here for one-tap DMs.
          </button>
        ) : (
          <ul className="flex gap-2 overflow-x-auto px-0.5 pb-1" role="list">
            {favoritePeople.map((person) => {
              const online = presenceById[person.id]?.isOnline ?? person.is_online;
              return (
                <li key={person.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => void openFavoritePerson(person)}
                    className="focus-ring flex w-14 flex-col items-center gap-1 rounded-lg p-1 text-center transition-colors hover:bg-white/[0.04]"
                    title={person.display_name}
                  >
                    <span className="relative">
                      <Identity
                        {...resolveIdentity({
                          ...person,
                          participant_type: "human",
                        })}
                        presence={null}
                        size={36}
                      />
                      <span
                        className={
                          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-0 " +
                          (online ? "bg-stable-mint" : "bg-slate-600")
                        }
                      />
                    </span>
                    <span className="w-full truncate text-[10px] text-slate-400">
                      {person.display_name.split(" ")[0]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  const setFocusMode = useSidebarUi((s) => s.setFocusMode);
  const [seeding, setSeeding] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);
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

  // The "+" on a row starts a thread under that room. It does not mint a
  // second conversation with the same agent.
  async function startThreadOn(roomId: string) {
    if (startingChat) return;
    setStartingChat(true);
    try {
      const thread = await beginThread({ roomId, navigate });
      if (thread) await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } finally {
      setStartingChat(false);
    }
  }
  const startDefaultChat = () => {
    useConversationUi.getState().openNewSheet("agent");
  };

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

  // mute.ts persists to localStorage outside React — bump so Focused filter /
  // badgeCount re-read getNotifyLevel after a mute change.
  const [mutedVersion, setMutedVersion] = useState(0);
  useEffect(() => onMutedChange(() => setMutedVersion((v) => v + 1)), []);

  // Focused mode filter/sort (slice 3) before view filter so classic + nav-v1
  // share the same attention rules. The one list hides that toggle, so a
  // saved Focused mode must not narrow it. AppShell mirrors this for Alt+↑/↓.
  const preparedRooms = useMemo(
    () =>
      prepareRoomsForSidebar(rooms, navV2 ? "all" : focusMode, (room) => ({
        unread: unreadCounts[room.id] ?? room.unread_count ?? 0,
        hasMention: mentionUnreads[room.id] === true,
        notifyLevel: getNotifyLevel(room.id),
        isActive: room.id === activeRoomId,
      })),
    // mutedVersion forces recompute when notify levels change outside React.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    [
      rooms,
      navV2,
      focusMode,
      unreadCounts,
      mentionUnreads,
      activeRoomId,
      mutedVersion,
    ],
  );

  // THE sidebar structure. RoomList renders it; AppShell flattens the same
  // model for Alt+↑/↓. There is no second model to keep in sync. `modelView`
  // filters rooms so keyboard order matches the visible list per destination.
  const model = useMemo(
    () =>
      buildSidebarModel({
        rooms: preparedRooms,
        searchQuery,
        scope,
        categories,
        people: peopleByScope,
        folders: folderDefs,
        collapsed,
        expandedPeople,
        view: modelView,
      }),
    [
      preparedRooms,
      searchQuery,
      scope,
      categories,
      peopleByScope,
      folderDefs,
      collapsed,
      expandedPeople,
      modelView,
    ],
  );

  const roomIsUnread = (room: Room) => {
    const raw = unreadCounts[room.id] ?? room.unread_count ?? 0;
    return badgeCount(room.id, raw) > 0 || mentionUnreads[room.id] === true;
  };
  // One list. Raw rooms, not the Focused subset: All / Unread / People /
  // Channels is the only narrowing, and it is not a destination.
  const conversationRows = useMemo(
    () =>
      navV2 && v2Destination === "conversations"
        ? buildConversationRows({
            rooms,
            searchQuery,
            scope,
            categories,
            people: peopleByScope,
            folders: folderDefs,
            expandedPeople,
            filter: conversationFilter,
            isUnread: roomIsUnread,
            activeRoomId,
          })
        : [],
    // mutedVersion recomputes badges when a mute lands outside React.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roomIsUnread closes over the maps above
    [
      navV2,
      v2Destination,
      rooms,
      searchQuery,
      scope,
      categories,
      peopleByScope,
      folderDefs,
      expandedPeople,
      conversationFilter,
      activeRoomId,
      unreadCounts,
      mentionUnreads,
      mutedVersion,
    ],
  );

  // The mark-read label and the click use this same list. Under v2 that is
  // the filtered, searched rows on screen — not every room in the server.
  const visibleUnreadTargets = roomsNeedingMarkRead(
    navV2
      ? conversationRows.flatMap((row) => roomsOnConversationRow(row))
      : roomsForView(preparedRooms, modelView),
    rawUnreadFor,
  );

  // Standing conference catalog for the Meetings empty state / entry points.
  const { data: conferenceCatalog = [] } = useQuery({
    queryKey: ["conference-catalog", scope],
    queryFn: () => api.getConferenceCatalog(),
    staleTime: 5 * 60_000,
    enabled:
      (!navV2 && navV1 && activeView === "meetings") ||
      (navV2 && v2Destination === "calls"),
  });
  // Hide catalog entries the user already joined (matched by display label).
  const unjoinedConferenceCatalog = useMemo(() => {
    if (conferenceCatalog.length === 0) return conferenceCatalog;
    const joinedLabels = new Set(
      rooms
        .filter((r) => r.is_conference)
        .flatMap((r) =>
          [r.display_name, r.name].filter(Boolean).map((s) => s!.toLowerCase()),
        ),
    );
    return conferenceCatalog.filter(
      (c) => !joinedLabels.has(c.display_name.toLowerCase()),
    );
  }, [conferenceCatalog, rooms]);
  const [enteringConference, setEnteringConference] = useState<string | null>(
    null,
  );
  async function enterConference(slug: string) {
    if (enteringConference) return;
    setEnteringConference(slug);
    try {
      const room = await api.enterConferenceRoom(slug);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      openRoom(room.id);
    } catch (err) {
      console.error("enter conference failed", err);
      useAppStore.getState().pushToast({
        title: "Couldn't open the meeting room",
        body: (err as Error).message,
      });
    } finally {
      setEnteringConference(null);
    }
  }

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

  /**
   * Mark the rooms the label counted. Under v2 that is the filtered list
   * (search included), not every room on the server. Focused mode does not
   * apply there. Sequential mark_read frames — there is no batch API yet.
   */
  function markVisibleSectionRead() {
    if (markingAllRead) return;
    const targets = visibleUnreadTargets;
    if (targets.length === 0) return;
    setMarkingAllRead(true);
    try {
      for (const room of targets) {
        if (room.last_message) {
          ws.send("mark_read", {
            room_id: room.id,
            message_id: room.last_message.id,
          });
        }
        clearUnread(room.id);
      }
    } finally {
      setMarkingAllRead(false);
    }
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
    // The one list ignores folders. Filing a row there would hide it from
    // the order the user is looking at.
    if (navV2) return null;
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
          // At rest on a desktop the trigger takes no room (it used to
          // reserve a column while invisible); hover or keyboard focus in
          // the row brings it, and a touch device always has it.
          open || alwaysVisible
            ? "opacity-100"
            : "opacity-70 md:hidden md:opacity-100 md:group-hover:block md:group-focus-within:block [@media(hover:none)]:block",
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

  function renderChannelRow(
    room: Room,
    threads: Room[] = [],
    expanded = false,
    archivedCount = 0,
  ) {
    const isActive = activeRoomId === room.id;
    const unread = rowBadgeCount({
      kind: "channel",
      id: room.id,
      room,
      threads,
      expanded,
      archivedCount,
    });
    const cat = channelsFiled?.[room.id];
    const menuOpen = menuKey === room.id;
    const muted = isMuted(room.id);
    const priv = isPrivateChannel(room);
    const Icon = priv ? Lock : Hash;
    return (
      <li
        key={room.id}
        className="relative"
        data-shape="channel"
        data-testid="conversation-row"
      >
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
            {navV2 && <span className="sr-only">Channel. </span>}
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
                  {room.project_number && (
                    <span className="ml-1 rounded border border-stable-cyan/30 bg-stable-cyan/10 px-1 font-mono text-[9px] font-semibold text-stable-cyan">
                      {room.project_number}
                    </span>
                  )}
                </span>
                <LiveCallBadge call={liveCallByRoomId[room.id]} />
                {muted && (
                  <BellOff
                    aria-label="Muted"
                    className="ml-1 h-3 w-3 shrink-0 text-slate-500"
                  />
                )}
                {hasDraft(room.id) && <DraftPencil />}
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
                  {formatLastMessage(lastLinePreview(room.last_message).text)}
                </p>
              )}
            </div>
          </button>
          <button
            type="button"
            onClick={() => void startThreadOn(room.id)}
            disabled={startingChat}
            className="focus-ring rounded-md p-1 text-slate-500 opacity-60 hover:bg-white/[0.06] hover:text-slate-200 md:opacity-0 md:group-hover:opacity-100"
            aria-label={`New thread in ${room.name}`}
            title="New thread"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {threads.length > 0 && (
            <button
              type="button"
              onClick={() => togglePersonExpanded(room.id)}
              className="focus-ring rounded-md p-1 text-slate-500"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} threads in ${room.name}`}
            >
              <ChevronDown className={clsx("h-3 w-3", !expanded && "-rotate-90")} />
            </button>
          )}
          {renderMenuTrigger(room.id, `Options for ${room.name}`)}
        </div>
        {!expanded && olderArchivedLabel(threads.length, archivedCount) && (
          <p className="px-8 pb-1 text-[10px] text-slate-500">
            {olderArchivedLabel(threads.length, archivedCount)}
          </p>
        )}
        {expanded && threads.length > 0 && (
          <ul role="list" className="ml-3 border-l border-line pl-1">
            {threads.map((thread) => renderThreadRow(thread, "#8B7CFF"))}
          </ul>
        )}

        {menuOpen &&
          renderMenuShell(
            <>
              {renderNotifyItems(room)}
              {renderFolderMenuItems(
                (name) => assignCategory(room.id, name),
                cat,
                "channels",
              )}
              <div className="my-0.5 border-t border-line" />
              {!room.is_archived && canArchive(room) && (
                <button
                  role="menuitem"
                  onClick={() => handleArchiveRoom(room)}
                  className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
                >
                  <Archive className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  Archive chat
                </button>
              )}
            </>,
          )}
      </li>
    );
  }

  function agentDisplayName(agentId: string, hub: Room | null, threads: Room[]): string {
    const rosterAgent = agents.find((a) => a.id === agentId);
    if (rosterAgent) return rosterAgent.display_name || rosterAgent.name;
    // A runner seat is never in the Brigade roster: its hub names it. Only
    // a legacy DM with no hub falls back to the newest room's label (minus
    // its "Chat with " prefix) — never a thread's title.
    const label =
      hub?.counterpart?.display_name ||
      hub?.display_name ||
      hub?.name ||
      threads[0]?.display_name ||
      threads[0]?.name ||
      agentId;
    return label.replace(/^chat with /i, "");
  }

  function formatLastMessage(content: string): string {
    const flat = stripMarkdown(content).replace(/\s+/g, " ").trim();
    if (flat.length <= 40) return flat;
    return flat.slice(0, 40) + "...";
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
    const unread = unreadFor(room);
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
                    <LastLine message={room.last_message} nameClassName="font-medium" format={formatLastMessage} />
                  </>
                ) : (
                  <span className="italic text-slate-500">
                    New conversation
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <LiveCallBadge call={liveCallByRoomId[room.id]} />
                {hasDraft(room.id) && <DraftPencil />}
                {room.last_message && (
                  <span className="text-[10px] tabular-nums text-slate-500">
                    {formatTimestamp(room.last_message.created_at)}
                  </span>
                )}
                {unread > 0 && (
                  <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                    {unread > 99 ? "99+" : unread}
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
      ? agentDisplayName(entry.agentId, entry.hub, threads)
      : entry.name;
    const ident = identityFor(isAgent ? entry.agentId : entry.key, name);
    const latest = threads[0];
    const hasActive = threads.some((r) => r.id === activeRoomId);
    const unreadTotal = rowBadgeCount({
      kind: "person",
      id: entry.key,
      entry,
      expanded,
    });
    // A live call in ANY thread with this person badges the collapsed row;
    // the expanded thread rows carry their own badge.
    const liveThread = threads.find((r) => liveCallByRoomId[r.id]);
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
    const nested = threads.filter((t) => t.id !== entry.hub.id);
    const older = expanded
      ? 0
      : entry.kind === "agent"
        ? Math.max(0, nested.length - 1)
        : nested.length;
    const threadHint = olderArchivedLabel(older, expanded ? 0 : entry.archivedCount);
    const directFace = navV2
      ? resolveIdentity(entry.hub, {
          selfId: currentUserId,
          agents,
          members: participantsByRoom[entry.hub.id],
        })
      : null;
    return (
      <li
        key={entry.key}
        className="relative"
        data-shape="direct"
        data-testid="conversation-row"
      >
        <div
          className={clsx(
            "group relative flex w-full items-center rounded-lg pr-1 transition-colors",
            hasActive && !expanded
              ? "bg-white/[0.06]"
              : "hover:bg-white/[0.04]",
          )}
          onPointerDown={(e) => {
            if (e.pointerType === "mouse") return;
            if ((e.target as HTMLElement).closest("button")) return;
            const timer = window.setTimeout(() => void startThreadOn(entry.hub.id), 550);
            const clear = () => window.clearTimeout(timer);
            e.currentTarget.addEventListener("pointerup", clear, { once: true });
            e.currentTarget.addEventListener("pointercancel", clear, { once: true });
          }}
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
            {navV2 && <span className="sr-only">Direct. </span>}
            <span
              className={clsx(
                "relative flex shrink-0 items-center justify-center",
                navV2 ? "h-7 w-7" : "h-6 w-6",
              )}
            >
              {navV2 && directFace ? (
                <Identity {...directFace} presence={null} size={28} />
              ) : isAgent ? (
                <Identity
                  {...resolveIdentity(
                    rosterAgent
                      ? {
                          ...rosterAgent,
                          participant_type: "agent",
                          avatar_url:
                            agentMember?.avatar_url ?? rosterAgent.avatar_url,
                          is_online: agentMember?.is_online,
                          availability:
                            agentMember?.availability ?? rosterAgent.availability,
                        }
                      : {
                          id: entry.agentId,
                          display_name: name,
                          avatar_url: agentMember?.avatar_url,
                          participant_type: "agent",
                          is_online: agentMember?.is_online,
                          availability: agentMember?.availability,
                        },
                  )}
                  presence={null}
                  size={20}
                />
              ) : (
                <Identity
                  {...resolveIdentity(latest ?? entry.hub, {
                    selfId: currentUserId,
                    agents,
                  })}
                  presence={null}
                  size={20}
                />
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
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="min-w-[3.5rem] truncate text-sm font-medium"
                    style={isAgent ? { color: ident.text } : undefined}
                  >
                    {name}
                  </span>
                  {/* Only a mode that differs from a private conversation's
                      default says anything; "Answers everyone" on every hub
                      was noise that cost the name its room. When shown, the
                      chip gives way before the name does. */}
                  {isAgent &&
                    entry.kind === "agent" &&
                    entry.mode &&
                    entry.mode !== "answers_all" && (
                      <AgentModeChip mode={entry.mode} compact className="min-w-0 shrink-[3]" />
                    )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <LiveCallBadge
                    call={
                      liveThread ? liveCallByRoomId[liveThread.id] : undefined
                    }
                  />
                  {latest && hasDraft(latest.id) && <DraftPencil />}
                  {latest?.last_message && (
                    <span className="text-[10px] tabular-nums text-slate-500">
                      {formatTimestamp(latest.last_message.created_at)}
                    </span>
                  )}
                  {unreadTotal > 0 && (
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
              {threadHint && (
                <p className="truncate text-[10px] text-slate-500">{threadHint}</p>
              )}
            </div>
          </button>
          <button
            onClick={() => void startThreadOn(entry.hub.id)}
            disabled={startingChat}
            className="focus-ring rounded-md p-1 text-slate-500 opacity-60 transition-all hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-40 md:hidden md:opacity-100 md:group-hover:block md:group-focus-within:block [@media(hover:none)]:block"
            aria-label={`New thread with ${name}`}
            title={`New thread with ${name}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
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
              <div className="my-0.5 border-t border-line" />
              {latest && !latest.is_archived && (
                <button
                  role="menuitem"
                  onClick={() => handleArchiveRoom(latest)}
                  className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
                >
                  <Archive className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  Archive chat
                </button>
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

  function renderPrivateGroup(
    room: Room,
    threads: Room[] = [],
    expanded = false,
    archivedCount = 0,
  ) {
    const isActive = activeRoomId === room.id;
    const unread = rowBadgeCount({
      kind: "group",
      id: room.id,
      room,
      threads,
      expanded,
      archivedCount,
    });
    const menuOpen = menuKey === room.id;
    const others = (participantsByRoom[room.id] ?? []).filter(
      (p) => (p.participant_id || p.user_id) !== currentUserId,
    );
    const badge = humanPresence(others.some((p) => p.is_online));
    const loadedMembers = participantsByRoom[room.id];
    const groupIdentity = navV2
      ? resolveIdentity(
          groupFaceRoom(room, [currentUserId, currentParticipantId]),
          {
            selfId: currentUserId,
            members:
              loadedMembers && loadedMembers.length > 0
                ? loadedMembers
                : room.members,
            agents,
          },
        )
      : null;
    // One resolved face is the last-sender fallback (members come back empty
    // on the list). A group mark is the stack glyph until two faces exist.
    const groupPile =
      groupIdentity?.faces && groupIdentity.faces.length >= 2
        ? groupIdentity
        : null;
    return (
      <li
        key={room.id}
        className="relative"
        data-shape="group"
        data-testid="conversation-row"
      >
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
            {navV2 && <span className="sr-only">Group. </span>}
            <span
              className={clsx(
                "relative flex shrink-0 items-center justify-center",
                navV2 ? "h-7 w-7" : "h-4 w-4",
              )}
            >
              {groupPile ? (
                <Identity {...groupPile} presence={null} size={28} />
              ) : (
                <Users
                  className="h-4 w-4 text-amber-300/70"
                  aria-label="Private group — invite only"
                />
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
                <span className="truncate text-sm font-medium">
                  {roomLabel(room, participantsByRoom[room.id])}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <LiveCallBadge call={liveCallByRoomId[room.id]} />
                  {hasDraft(room.id) && <DraftPencil />}
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
                  {unread > 0 && (
                    <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </div>
              </div>
              {room.last_message && (
                <p className="truncate text-[11px] text-slate-500">
                  <LastLine message={room.last_message} nameClassName="font-medium text-slate-500" format={formatLastMessage} />
                </p>
              )}
            </div>
          </button>
          <button
            type="button"
            onClick={() => void startThreadOn(room.id)}
            disabled={startingChat}
            className="focus-ring rounded-md p-1 text-slate-500 opacity-60 hover:text-slate-200 md:opacity-0 md:group-hover:opacity-100"
            aria-label={`New thread in ${roomLabel(room, participantsByRoom[room.id])}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {renderMenuTrigger(room.id, `Options for ${room.name}`)}
        </div>
        {!expanded && olderArchivedLabel(threads.length, archivedCount) && (
          <p className="px-8 pb-1 text-[10px] text-slate-500">
            {olderArchivedLabel(threads.length, archivedCount)}
          </p>
        )}
        {expanded && threads.length > 0 && (
          <ul role="list" className="ml-3 border-l border-line pl-1">
            {threads.map((thread) => renderThreadRow(thread, "#F5C16C"))}
          </ul>
        )}
        {menuOpen &&
          renderMenuShell(
            <>
              {renderNotifyItems(room)}
              <div className="my-0.5 border-t border-line" />
              {!room.is_archived && canArchive(room) && (
                <button
                  role="menuitem"
                  onClick={() => handleArchiveRoom(room)}
                  className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
                >
                  <Archive className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  Archive chat
                </button>
              )}
            </>,
          )}
      </li>
    );
  }

  function renderRow(row: SidebarRow): ReactNode {
    switch (row.kind) {
      case "channel":
        return renderChannelRow(row.room, row.threads, row.expanded, row.archivedCount);
      case "group":
        return renderPrivateGroup(row.room, row.threads, row.expanded, row.archivedCount);
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

  // sections tuple is [people, groups, channels] — keep names explicit so a
  // future reorder cannot silently swap labels and bodies.
  const peopleSection = model.sections.find((s) => s.id === "people")!;
  const groupsSection = model.sections.find((s) => s.id === "groups")!;
  const channelSection = model.sections.find((s) => s.id === "channels")!;
  const channelCount = channelSection.groups.reduce(
    (n, g) => n + g.rows.length,
    0,
  );
  const peopleCount = peopleSection.groups.reduce(
    (n, g) => n + g.rows.length,
    0,
  );
  const groupCount = groupsSection.groups.reduce((n, g) => n + g.rows.length, 0);

  function closeMobileSidebar() {
    if (
      window.matchMedia("(max-width: 767px)").matches &&
      useAppStore.getState().ui.sidebarOpen
    ) {
      useAppStore.getState().toggleSidebar();
    }
  }

  function renderBrowseAgentsLink() {
    return (
      <button
        onClick={() => {
          navigate("/agents");
          closeMobileSidebar();
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
    );
  }

  function renderBridgeLink() {
    return (
      <button
        onClick={() => {
          navigate("/bridge");
          closeMobileSidebar();
        }}
        className={clsx(
          "focus-ring group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors md:py-1.5",
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
    );
  }

  function renderPeopleSection(opts?: {
    title?: string;
    hint?: string;
    emptyAgentCta?: boolean;
    testId?: string;
  }) {
    const title = opts?.title ?? "Direct messages";
    const hint =
      opts?.hint ?? "Private — people and agents you talk to one-on-one";
    return (
      <section data-testid={opts?.testId}>
        {renderSectionHeader(
          SECTION_KEYS.people,
          title,
          hint,
          <>
            {renderNewFolderButton("people")}
            <button
              onClick={() => useConversationUi.getState().openNewSheet("person")}
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

            {roomsLoaded &&
              peopleCount === 0 &&
              groupCount === 0 &&
              focusMode !== "focused" && (
              <div className="mx-2 mb-1 flex flex-col gap-1">
                {opts?.emptyAgentCta !== false && (
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
                )}
                <button
                  onClick={() => setCreateDmOpen(true)}
                  className="focus-ring w-full rounded-lg px-3 py-1 text-left text-xs text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300"
                >
                  {opts?.emptyAgentCta === false
                    ? "Message a person"
                    : "…or message a person"}
                </button>
              </div>
            )}

            {renderSectionBody(peopleSection)}
          </>
        )}
      </section>
    );
  }

  function renderGroupsSection() {
    if (groupCount === 0) return null;
    return (
      <section>
        {renderSectionHeader(
          SECTION_KEYS.groups,
          "Private groups",
          "Invite only — these never appear in Browse channels",
        )}
        {!groupsSection.collapsed && renderSectionBody(groupsSection)}
      </section>
    );
  }

  function renderArchivedSection() {
    if (archivedRooms.length === 0) return null;
    const collapsed = showArchived;
    return (
      <section>
        <div className="flex items-center justify-between px-2.5 pb-1">
          <button
            onClick={() => setShowArchived(!collapsed)}
            className="focus-ring group flex min-w-0 items-center gap-1 rounded-md py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
            aria-expanded={collapsed}
            title="Archived direct messages and groups"
          >
            <Archive className="h-3 w-3 shrink-0 opacity-60" />
            <span className="truncate">Archived</span>
            <span className="ml-auto tabular-nums text-slate-500">
              {archivedRooms.length}
            </span>
            <ChevronDown
              className={clsx(
                "h-3 w-3 shrink-0 transition-transform duration-150",
                collapsed && "-rotate-90",
              )}
            />
          </button>
        </div>
        {collapsed && (
          <ul role="list" className="ml-1.5 border-l border-line pl-1">
            {archivedRooms.map((room) => (
              <li key={room.id} className="relative">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      openRoom(room.id);
                      setShowArchived(false);
                    }}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200 md:py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {room.last_message ? (
                        <>
                          <LastLine message={room.last_message} nameClassName="font-medium" format={formatLastMessage} />
                        </>
                      ) : (
                        <span className="italic text-slate-500">
                          New conversation
                        </span>
                      )}
                    </span>
                    {room.last_message && (
                      <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                        {formatTimestamp(room.last_message.created_at)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setMenuKey(menuKey === room.id ? null : room.id)
                    }
                    className="focus-ring shrink-0 rounded-md p-1 text-slate-500 hover:text-slate-200"
                    aria-label={`Options for ${room.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuKey === room.id}
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </div>
                {menuKey === room.id &&
                  renderMenuShell(
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleUnarchiveRoom(room)}
                      className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06]"
                    >
                      <Archive className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      Unarchive chat
                    </button>,
                  )}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  function renderChannelsSection() {
    return (
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
              onClick={() => useConversationUi.getState().openNewSheet("channel")}
              className="focus-ring rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:p-0.5"
              aria-label="Create a room"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </>,
        )}

        {!channelSection.collapsed && (
          <>
            {renderNewFolderInput("channels")}

            {roomsLoaded &&
              channelCount === 0 &&
              focusMode !== "focused" && (
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
    );
  }

  /** Meetings: live rejoin + joined conference rooms + catalog entry points. */
  function renderMeetingsBody() {
    const hasActiveCall = Boolean(isConnected && activeCallRoomId);
    const activeCallRoom = hasActiveCall
      ? rooms.find((r) => r.id === activeCallRoomId) ?? null
      : null;
    const showCatalog = unjoinedConferenceCatalog.length > 0;
    const showEmpty = channelCount === 0 && !hasActiveCall;

    return (
      <section>
        {hasActiveCall && activeCallRoomId && (
          <div className="mx-2 mb-2">
            <button
              type="button"
              onClick={() => openRoom(activeCallRoomId)}
              className="focus-ring flex w-full items-center gap-2.5 rounded-lg border border-stable-mint/35 bg-stable-mint/10 px-2.5 py-2 text-left transition-colors hover:border-stable-mint/55 hover:bg-stable-mint/15"
            >
              <Phone className="h-4 w-4 shrink-0 text-stable-mint" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-slate-100">
                    Return to call
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-stable-mint/30 bg-stable-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-stable-mint">
                    <span className="h-1 w-1 animate-pulse rounded-full bg-stable-mint" />
                    live
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                  {activeCallRoom?.display_name ||
                    activeCallRoom?.name ||
                    "Your active call"}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-stable-mint">
                Rejoin
              </span>
            </button>
          </div>
        )}

        {renderSectionHeader(
          SECTION_KEYS.channels,
          "Standing rooms",
          "Always-on conference rooms and call spaces",
        )}
        {!channelSection.collapsed && (
          <>
            {channelCount > 0 && renderSectionBody(channelSection)}

            {showEmpty && (
              <div className="mx-2 mb-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs text-slate-500">
                <p className="font-medium text-slate-400">No meetings yet</p>
                <p className="mt-1 leading-relaxed">
                  {showCatalog
                    ? "Enter a standing conference room below, or start a call from any chat. Hang-up auto-exports captions to Meeting-Ops when enabled."
                    : "Standing conference rooms appear here once you enter them. You can also start a call from any chat."}
                </p>
              </div>
            )}

            {showCatalog && (
              <div className="mx-2 mt-2 space-y-1">
                <p className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {channelCount > 0 ? "More rooms" : "Enter a room"}
                </p>
                {unjoinedConferenceCatalog.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={() => void enterConference(c.slug)}
                    disabled={enteringConference === c.slug}
                    className="focus-ring flex w-full items-start gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left transition-colors hover:border-stable-purple/40 hover:bg-white/[0.04] disabled:opacity-50"
                  >
                    <Video className="mt-0.5 h-4 w-4 shrink-0 text-stable-cyan/80" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-200">
                        {enteringConference === c.slug
                          ? "Opening…"
                          : c.display_name}
                      </span>
                      {c.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                          {c.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <MeetingsRecordings roomId={activeRoomId} />
      </section>
    );
  }

  /** Home: crew and conversations. The destination switcher stays on the rail. */
  function renderHomeBody() {
    return <HomeRail onOpenRoom={openRoom} />;
  }

  const EMPTY_COPY: Record<ConversationFilter, { title: string; hint: string }> = {
    all: {
      title: "No conversations yet",
      hint: "Message a person, talk to an agent, or open a channel.",
    },
    unread: {
      title: "Nothing unread",
      hint: "Directs with new messages and rooms where you were mentioned show up here.",
    },
    people: {
      title: "No people yet",
      hint: "Directs and groups live here. Channels stay under the Channels filter.",
    },
    channels: {
      title: "No channels yet",
      hint: "Named places, including standing rooms you call into, show up here.",
    },
  };

  /** One recency list. Shape is the mark on the row, not a tab. */
  function renderConversationBody() {
    const q = searchQuery.trim();
    const copy = q
      ? {
          title: `No conversations match “${q}”`,
          hint: "Try another name, or clear the search.",
        }
      : EMPTY_COPY[conversationFilter];
    const activeRoom = activeRoomId
      ? rooms.find((room) => room.id === activeRoomId)
      : undefined;
    return (
      <>
        {/* Desktop: the crew pinned above the list (Nav v3 §2.1). The phone
            has a Crew tab instead, and the section renders nothing there. */}
        <CrewSection variant="section" onOpenRoom={openRoom} />
        <div>
          {/* The workspace title and the filters stay put while the list
              scrolls under them; Mark read sits beside the filters, where it
              reads as a Conversations action, not a Crew one. */}
          <div
            className="sticky top-0 z-10 -mx-2 bg-surface-0/95 px-2 pb-1 backdrop-blur-md"
            data-testid="conversation-list-sticky"
          >
            <WorkspaceTitle />
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <ViewSwitcher />
              </div>
              {renderMarkReadButton(true)}
            </div>
          </div>
      <section data-testid="conversations-card" aria-label="Conversations">
        {conversationFilter === "channels" && (
          <div className="flex items-center justify-between px-2.5 pb-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Channels
            </h3>
            <button
              type="button"
              onClick={() => setBrowseOpen(true)}
              className="focus-ring rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
              aria-label="Browse channels"
              title="Browse channels you can join"
              data-testid="browse-channels"
            >
              Browse
            </button>
          </div>
        )}
        {roomsLoaded && conversationRows.length === 0 && (
          <div className="mx-2 mb-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs text-slate-500">
            <p className="font-medium text-slate-400">{copy.title}</p>
            <p className="mt-1 leading-relaxed">{copy.hint}</p>
            {conversationFilter === "channels" && (
              <button
                type="button"
                onClick={() => setBrowseOpen(true)}
                className="focus-ring mt-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stable-cyan transition-colors hover:bg-stable-cyan/10"
                aria-label="Browse channels"
              >
                Browse channels
              </button>
            )}
          </div>
        )}
        <ul role="list">{conversationRows.map(renderRow)}</ul>
        {renderArchivedSection()}
        <MeetingsRecordings
          roomId={activeRoomId}
          collapsible
          relevantOnly
          standing={activeRoom?.is_conference === true}
        />
      </section>
        </div>
      </>
    );
  }

  /** The phone's Crew tab: everyone, grouped, no cap (Nav v3 §2.6). */
  function renderCrewBody() {
    return <CrewSection variant="page" onOpenRoom={openRoom} />;
  }

  /** Directory is the Agents page in the main pane, not a second conversation list. */
  function renderDirectoryBody() {
    return (
      <div className="px-3 py-3" data-testid="directory-sidebar-note">
        <p className="text-sm font-semibold text-slate-100">Directory</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Roster and org chart are open in the main pane. Agent hubs stay in
          Conversations, with everyone else.
        </p>
      </div>
    );
  }

  /** First-load placeholder: the rooms payload hasn't landed yet, so the
   *  sidebar must not flash "No conversations yet" / "No channels yet"
   *  empty states or a stub list. Shimmer rows match the ChatPanel skeleton
   *  idiom. */
  function renderNavSkeleton() {
    return (
      <div
        className="mx-2 space-y-1"
        aria-hidden="true"
        aria-busy="true"
      >
        {[64, 48, 72, 40, 58].map((w, i) => (
          <div
            key={i}
            className="flex animate-pulse-soft items-center gap-2.5 rounded-lg px-2.5 py-2"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <div className="h-6 w-6 shrink-0 rounded-full bg-white/[0.05]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div
                className="h-2.5 rounded bg-white/[0.06]"
                style={{ width: `${w}%` }}
              />
              <div className="h-2 rounded bg-white/[0.04]" style={{ width: `${w - 18}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  /** Classic tree, five-view shell, or the one Conversations list. */
  function renderNavBody() {
    if (!roomsLoaded) return renderNavSkeleton();
    if (navV2) {
      if (v2Destination === "home") return renderHomeBody();
      if (v2Destination === "directory") return renderDirectoryBody();
      if (v2Destination === "crew") return renderCrewBody();
      if (v2Destination === "calls") return renderMeetingsBody();
      return renderConversationBody();
    }
    if (!navV1) {
      return (
        <>
          {renderBrowseAgentsLink()}
          <div className="-mt-2">{renderBridgeLink()}</div>
          {renderPeopleSection()}
          {renderGroupsSection()}
          {renderArchivedSection()}
          {renderChannelsSection()}
        </>
      );
    }

    switch (activeView) {
      case "home":
        return renderHomeBody();
      case "direct":
        return (
          <>
            {renderFavoritePeopleStrip()}
            {renderPeopleSection({
              title: "Direct messages",
              hint: "Human direct messages",
              testId: "conversations-card",
              emptyAgentCta: false,
            })}
            {renderGroupsSection()}
            {roomsLoaded &&
              peopleCount === 0 &&
              groupCount === 0 &&
              focusMode !== "focused" && (
              <div className="mx-3 mt-2 rounded-xl border border-line bg-surface-2/40 px-3 py-4 text-center">
                <p className="text-xs text-slate-400">
                  No direct conversations yet. Open{" "}
                  <button
                    type="button"
                    onClick={() => setPeopleDrawerOpen(true)}
                    className="focus-ring font-medium text-stable-cyan underline-offset-2 hover:underline"
                  >
                    People
                  </button>{" "}
                  or start a new chat above.
                </p>
              </div>
            )}
          </>
        );
      case "channels":
        return renderChannelsSection();
      case "meetings":
        return renderMeetingsBody();
      case "agents":
        return (
          <>
            {renderBrowseAgentsLink()}
            {renderPeopleSection({
              title: "Agent conversations",
              hint: "DMs with resident agents",
              emptyAgentCta: true,
            })}
          </>
        );
      default:
        return null;
    }
  }

  /** Mark every visible unread room read. Compact = icon only, beside the filters. */
  function renderMarkReadButton(compact: boolean) {
    return (
      <button
        type="button"
        onClick={markVisibleSectionRead}
        disabled={markingAllRead || visibleUnreadTargets.length === 0}
        className={clsx(
          "focus-ring shrink-0 rounded-lg border border-line text-xs font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40",
          compact ? "p-1.5" : "px-2 py-1",
        )}
        aria-label={
          visibleUnreadTargets.length === 0
            ? "No unread rooms to mark as read"
            : `Mark ${visibleUnreadTargets.length} visible room${visibleUnreadTargets.length === 1 ? "" : "s"} as read`
        }
        title="Mark all visible as read"
        data-testid="mark-visible-read"
      >
        <span className="inline-flex items-center gap-1">
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {!compact && <span className="hidden sm:inline">Mark read</span>}
        </span>
      </button>
    );
  }

  // Search + New chat: hide on Home. The one list and the Crew tab show them;
  // Directory and Calls do not.
  const showToolbar = navV2
    ? v2Destination === "conversations" || v2Destination === "crew"
    : !navV1 || activeView !== "home";
  const searchPlaceholder = navV2
    ? v2Destination === "crew"
      ? "Search crew…"
      : "Search conversations…"
    : activeView === "agents"
      ? "Search agents…"
      : activeView === "channels"
        ? "Search channels…"
        : activeView === "meetings"
          ? "Search meetings…"
          : activeView === "direct"
            ? "Search direct…"
            : "Search rooms…";

  const focusedEmpty =
    !navV2 &&
    focusMode === "focused" &&
    showToolbar &&
    peopleCount === 0 &&
    groupCount === 0 &&
    channelCount === 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {navV1 && <PendingInvites />}

      {showToolbar && (
        <div className="shrink-0 space-y-2 px-3 py-3">
          <button
            type="button"
            onClick={() => useConversationUi.getState().openNewSheet()}
            className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/[0.07]"
            data-testid="new-room-button"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-line bg-slate-950/60 py-2 pl-9 pr-3 text-base md:text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
              aria-label={searchPlaceholder}
            />
          </div>
          {/* Five-view shell keeps Focused / All. The one list uses the filters under the workspace name. */}
          <div className="flex items-center gap-1.5">
            {!navV2 && (
            <div
              role="group"
              aria-label="Unread filter"
              className="flex min-w-0 flex-1 rounded-lg border border-line bg-slate-950/40 p-0.5"
            >
              <button
                type="button"
                onClick={() => setFocusMode("focused")}
                aria-pressed={focusMode === "focused"}
                aria-label="Focused: show direct messages with unread and rooms with unread mentions"
                className={clsx(
                  "focus-ring flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  focusMode === "focused"
                    ? "bg-white/[0.08] text-slate-50"
                    : "text-slate-500 hover:text-slate-300",
                )}
              >
                Focused
              </button>
              <button
                type="button"
                onClick={() => setFocusMode("all")}
                aria-pressed={focusMode === "all"}
                aria-label="All: show every room in this list"
                className={clsx(
                  "focus-ring flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  focusMode === "all"
                    ? "bg-white/[0.08] text-slate-50"
                    : "text-slate-500 hover:text-slate-300",
                )}
              >
                All
              </button>
            </div>
            )}
            {/* The one list carries Mark read beside its filters instead. */}
            {!navV2 && renderMarkReadButton(false)}
          </div>
        </div>
      )}

      <nav
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4"
        aria-label="Room navigation"
      >
        {roomsLoaded && focusedEmpty && (
          <div className="mx-2 rounded-lg border border-dashed border-line px-3 py-3 text-xs text-slate-500">
            <p className="font-medium text-slate-400">Nothing needs attention</p>
            <p className="mt-1">
              Focused shows DMs with unread and rooms where you were @-mentioned.
              Switch to{" "}
              <button
                type="button"
                onClick={() => setFocusMode("all")}
                className="focus-ring font-medium text-stable-purple-light underline-offset-2 hover:underline"
              >
                All
              </button>{" "}
              to browse every room.
            </p>
          </div>
        )}
        {renderNavBody()}
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
