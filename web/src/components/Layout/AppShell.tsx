import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  X,
  Bookmark,
  Settings,
  LogOut,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { login, logout } from "@/services/auth";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { useChannelCategories } from "@/stores/categoryStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import {
  isDirectoryPath,
  isNavV1Enabled,
  isNavV2Enabled,
  shellDestinationForPath,
  useNavStore,
  viewForRoom,
} from "@/stores/navStore";
import {
  buildConversationRows,
  buildSidebarModel,
  flattenConversationRows,
  flattenSidebarOrder,
  type SidebarView,
} from "@/components/Sidebar/sidebarModel";
import { useFederationStore } from "@/stores/federationStore";
import { useThemeStore } from "@/stores/themeStore";
import { useFacePrefStore } from "@/stores/facePrefStore";
import { Identity, PhotoNudge, useSelfFace, useShowPhotoNudge } from "@/components/ui/Identity";
import { identityFor } from "@/lib/identity";
import { StableMark } from "@/components/StableMark";
import { OPEN_ACTIVITY_EVENT } from "@/lib/shellEvents";
import { getNotifyLevel } from "@/utils/mute";
import { badgeCount, prepareRoomsForSidebar } from "@/utils/unreadModel";
import { useGlobalNotifications } from "@/hooks/useGlobalNotifications";
import { useRecordingReceipts } from "@/hooks/useRecordingReceipts";
import { useCallDeepLink } from "@/hooks/useCallDeepLink";
import { useAppHeight } from "@/hooks/useAppHeight";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { Header } from "./Header";
import { ToastStack } from "./ToastStack";
import { CheatsheetModal } from "./CheatsheetModal";
import { SettingsModal } from "./SettingsModal";
import { SavedPanel } from "./SavedPanel";
import { PeopleDrawer } from "./PeopleDrawer";
import { ActivityCenter, type ActivityTab } from "./ActivityCenter";
import { QuickSwitcher } from "./QuickSwitcher";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { ServerRail } from "@/components/ServerRail";
import { AddServerModal } from "./AddServerModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RoomList } from "@/components/Sidebar/RoomList";
import { CreateRoomModal } from "@/components/Sidebar/CreateRoomModal";
import { NewSheet } from "@/components/Sidebar/NewSheet";
import { useConversationUi } from "@/stores/conversationUiStore";
import { Plus } from "lucide-react";
import { IncomingCallBanner } from "@/components/Call/IncomingCallBanner";
import { OutgoingCallStatus } from "@/components/Call/OutgoingCallStatus";

// Keep route-specific surfaces out of the authenticated shell. In particular,
// the call stack and org-chart renderer are substantial and are not needed on
// the home or bridge views.
const RoomView = lazy(() =>
  import("@/components/Room/RoomView").then((module) => ({
    default: module.RoomView,
  })),
);
const HomeDashboard = lazy(() =>
  import("@/components/Home/HomeDashboard").then((module) => ({
    default: module.HomeDashboard,
  })),
);
const AgentsPage = lazy(() =>
  import("@/components/Agents/AgentsPage").then((module) => ({
    default: module.AgentsPage,
  })),
);
const BridgePage = lazy(() =>
  import("@/components/Bridge/BridgePage").then((module) => ({
    default: module.BridgePage,
  })),
);

/** The width the room-list sidebar was designed around, in px.
 *
 * Desktop makes it the resizable default; phones keep it fixed, because there
 * the sidebar is an off-canvas overlay drawer with no handle and no stored
 * width. Named because three places have to agree on it — the resize hook's
 * default, the animated container, and the fixed-width content inside it.
 */
const SIDEBAR_DRAWER_WIDTH = 280;

function SurfaceLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-500"
      role="status"
    >
      Loading workspace…
    </div>
  );
}

/**
 * The sidebar's visible room order, flattened for Alt+↑/↓.
 *
 * Derived from the SAME model RoomList renders (see sidebarModel.ts), not from
 * a second description of the layout. There used to be one here, hand-written
 * to mirror the sidebar, and it silently rotted the moment the sidebar changed:
 * human DMs collapsed to one row per person, group DMs moved into their own
 * section, sections and folders learned to collapse — and the keyboard went on
 * walking an order that matched none of it. A copy that has to be kept in sync
 * by hand is the bug, so there is no copy.
 */
function sidebarRoomOrder(): string[][] {
  const { rooms, activeRoomId, unreadCounts, mentionUnreads } =
    useAppStore.getState();
  const { categories, people, folders, collapsed } =
    useChannelCategories.getState();
  const { searchQuery, expandedPeople, focusMode } = useSidebarUi.getState();
  const scope = useFederationStore.getState().activeInstanceId;
  const isUnread = (room: { id: string; unread_count?: number }) => {
    const raw = unreadCounts[room.id] ?? room.unread_count ?? 0;
    return badgeCount(room.id, raw) > 0 || mentionUnreads[room.id] === true;
  };
  // One list: same filter and order RoomList renders. Focused mode is a
  // five-view control and must not hide rows the Unread filter would show.
  if (isNavV2Enabled()) {
    const destination = shellDestinationForPath(
      window.location.pathname,
      useNavStore.getState().v2Destination,
    );
    if (destination !== "conversations") return [];
    return flattenConversationRows(
      buildConversationRows({
        rooms,
        searchQuery,
        scope,
        categories,
        people,
        folders,
        expandedPeople,
        filter: useNavStore.getState().conversationFilter,
        isUnread,
        activeRoomId,
      }),
    );
  }
  // Same filter/sort as RoomList so Alt+↑/↓ walks what is on screen.
  const prepared = prepareRoomsForSidebar(rooms, focusMode, (room) => ({
    unread: unreadCounts[room.id] ?? room.unread_count ?? 0,
    hasMention: mentionUnreads[room.id] === true,
    notifyLevel: getNotifyLevel(room.id),
    isActive: room.id === activeRoomId,
  }));
  // View-based shell: same destination filter RoomList applies.
  const view: SidebarView = isNavV1Enabled()
    ? useNavStore.getState().activeView
    : "all";
  return flattenSidebarOrder(
    buildSidebarModel({
      rooms: prepared,
      searchQuery,
      scope,
      categories,
      people,
      folders,
      collapsed,
      expandedPeople,
      view,
    }),
  );
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export function AppShell() {
  useGlobalNotifications();
  useRecordingReceipts();
  // Keep the app pinned to the visible viewport (collapsing toolbar + keyboard).
  useAppHeight();
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  // Desktop drag-to-resize for the room-list sidebar. On phones the sidebar is
  // an off-canvas overlay drawer at a fixed 280px — no handle, no stored width.
  const isDesktop = useIsDesktop();
  const sidebarResize = usePanelResize("sidebar", {
    defaultWidth: SIDEBAR_DRAWER_WIDTH,
    min: 220,
    max: 480,
    edge: "right",
  });
  // THE sidebar width — one value, read by the animated container AND by the
  // fixed-width content wrapper inside it. They must be the same number or the
  // content reflows during the open/close animation; see the note on the
  // wrapper below for what that looked like.
  const sidebarWidth = isDesktop ? sidebarResize.width : SIDEBAR_DRAWER_WIDTH;
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  // `/c/<id>?join=1…` — open the room already in its call (native app entry).
  useCallDeepLink(routeRoomId);
  const location = useLocation();
  const isAgentsView = location.pathname === "/agents";
  const isBridgeView = location.pathname === "/bridge";
  const navigate = useNavigate();
  const setRooms = useAppStore((s) => s.setRooms);
  const setAgents = useAppStore((s) => s.setAgents);
  const createRoomModalOpen = useAppStore((s) => s.ui.createRoomModalOpen);
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const openSettings = useAppStore((s) => s.openSettings);
  const savedOpen = useAppStore((s) => s.ui.savedOpen);
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const peopleDrawerOpen = useAppStore((s) => s.ui.peopleDrawerOpen);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const currentUser = useAppStore((s) => s.currentUser);
  // Palette is stored per user, so it can only be resolved once we know who is
  // signed in. Doing this here rather than in the settings modal matters: if it
  // lived in the modal, your saved palette would not appear until you opened
  // Settings, which is not "saved" in any sense a user would accept.
  const scopePalette = useThemeStore((s) => s.scopeToUser);
  // Face-style preference is stored per user exactly like the palette, and for
  // the same reason: restored here, not in the settings modal, so it applies
  // to the first call tile of the session, not the first visit to Settings.
  const scopeFacePref = useFacePrefStore((s) => s.scopeToUser);
  useEffect(() => {
    scopePalette(currentUser?.id ?? null);
    scopeFacePref(currentUser?.id ?? null);
  }, [currentUser?.id, scopePalette, scopeFacePref]);
  // Identity hue for the signed-in resident (rings the drawer-footer avatar).
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);
  const selfFace = useSelfFace();
  const showPhotoNudge = useShowPhotoNudge();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const quickSwitcherNonce = useConversationUi((s) => s.quickSwitcherNonce);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<ActivityTab>("approvals");
  useEffect(() => {
    function onOpenActivity() {
      setActivityTab("approvals");
      setActivityOpen(true);
    }
    window.addEventListener(OPEN_ACTIVITY_EVENT, onOpenActivity);
    return () => window.removeEventListener(OPEN_ACTIVITY_EVENT, onOpenActivity);
  }, []);
  // Federated multi-server: the active instance id keys the per-server
  // react-query caches; a switch clears the cache and returns to the home view.
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);
  const switching = useFederationStore((s) => s.switching);
  const addServerOpen = useFederationStore((s) => s.addServerOpen);
  const queryClient = useQueryClient();
  const previousInstanceId = useRef(activeInstanceId);

  useEffect(() => {
    if (!activeInstanceId) return;
    if (previousInstanceId.current === null) {
      previousInstanceId.current = activeInstanceId;
      return;
    }
    if (previousInstanceId.current === activeInstanceId) return;
    previousInstanceId.current = activeInstanceId;
    // Rooms/agents (and everything derived from them) belonged to the old
    // server — drop the whole react-query cache and land on the home view.
    queryClient.removeQueries();
    void queryClient.invalidateQueries();
    navigate("/", { replace: true });
  }, [activeInstanceId, navigate, queryClient]);

  // Poll the OTHER reachable servers for unread so the rail can badge them.
  // Cheap + fail-safe (inactive instances only, every 60s); no-op single-server.
  useEffect(() => {
    const fed = useFederationStore.getState();
    if (fed.accessibleInstances.length <= 1) return;
    void fed.refreshInstanceUnread();
    const timer = setInterval(
      () => void useFederationStore.getState().refreshInstanceUnread(),
      60_000,
    );
    return () => clearInterval(timer);
  }, [activeInstanceId]);

  // Tab title: "(unread) #room — Stable" so background tabs can notify AND the
  // tab strip identifies which conversation this window is sitting in.
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const storeRooms = useAppStore((s) => s.rooms);
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    const active = storeRooms.find((r) => r.id === activeRoomId);
    const prefix = total > 0 ? `(${total > 99 ? "99+" : total}) ` : "";
    const roomLabel = active
      ? `${active.type === "channel" ? "#" : ""}${active.name} — `
      : "";
    document.title = `${prefix}${roomLabel}Stable`;
    return () => {
      document.title = "Stable";
    };
  }, [unreadCounts, storeRooms, activeRoomId]);

  // Favicon unread badge: draw the site icon onto a 64px canvas with a red
  // count pill and swap the <link rel="icon"> href to the data URL; restore
  // the original href when unread returns to 0. The badge label ("1".."99",
  // capped) is the redraw key — same label means no redraw, so a stream of
  // messages into an already-badged bucket can't thrash the icon.
  const faviconLinkRef = useRef<HTMLLinkElement | null>(null);
  const faviconOriginalRef = useRef<string | null>(null);
  const faviconLabelRef = useRef<string>("");
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    const label = total <= 0 ? "" : total > 99 ? "99" : String(total);
    if (label === faviconLabelRef.current) return;
    faviconLabelRef.current = label;

    const link =
      faviconLinkRef.current ??
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    faviconLinkRef.current = link;
    // Cache the pristine href once (link.href resolves to an absolute URL,
    // which is exactly what Image.src and the restore path both want).
    if (faviconOriginalRef.current === null) {
      faviconOriginalRef.current = link.href;
    }
    const originalHref = faviconOriginalRef.current;

    if (!label) {
      link.href = originalHref;
      return;
    }

    // Stale-draw guard: the icon loads async, so by the time it arrives a
    // newer effect run may have moved the label on (or cleared it). Compare
    // against the ref instead of a cleanup flag — a cleanup flag would also
    // cancel the draw on StrictMode's mount->cleanup->remount cycle, where the
    // rerun early-returns on the unchanged label and the badge never renders.
    const drawBadge = (img: HTMLImageElement | null) => {
      if (faviconLabelRef.current !== label) return;
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // Base icon; on load failure we fall through to a badge-only canvas
        // so the unread signal still shows.
        if (img) ctx.drawImage(img, 0, 0, size, size);
        // Pill in the top-right quadrant — red (#ef4444) beats Aurora purple
        // for 16px legibility. Wider pill for 2-digit counts. Manual arc path
        // (not roundRect) for older canvas implementations.
        const h = 34;
        const r = h / 2;
        const w = label.length > 1 ? 46 : h;
        const x = size - w;
        const y = 0;
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(x + r, y + h);
        ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font =
          "bold 26px system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + w / 2, y + h / 2 + 1);
        // Only swap after toDataURL succeeds (it throws on a tainted canvas),
        // so a failure leaves the real favicon untouched.
        link.href = canvas.toDataURL("image/png");
      } catch {
        // Cosmetic — never let the favicon break anything.
      }
    };

    // The favicon is same-origin (SVG or PNG both drawImage fine), but it
    // loads async — badge once it arrives; badge-only if it never does.
    const img = new Image();
    img.onload = () => drawBadge(img);
    img.onerror = () => drawBadge(null);
    img.src = originalHref;
  }, [unreadCounts]);

  // Restore the pristine favicon if the shell ever unmounts mid-badge.
  // Clearing the label ref first also voids any still-inflight badge draw.
  useEffect(() => {
    return () => {
      faviconLabelRef.current = "";
      if (faviconLinkRef.current && faviconOriginalRef.current) {
        faviconLinkRef.current.href = faviconOriginalRef.current;
      }
    };
  }, []);

  // Global shortcuts, one listener: Cmd/Ctrl+/ cheatsheet, Cmd/Ctrl+K quick
  // switcher, Alt+↑/↓ previous/next room in the sidebar's visual order.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        useAppStore.getState().toggleCheatsheet();
        return;
      }
      // Bare "?" (Shift+/) opens the same cheatsheet — the near-universal
      // "help" shortcut. Skipped while typing so it never eats a literal "?".
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        useAppStore.getState().toggleCheatsheet();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setGlobalSearchOpen(true);
        return;
      }
      // ⌘N opens the New sheet. ⌘⇧N starts a thread in the room you're in.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        const roomId = useAppStore.getState().activeRoomId;
        if (!roomId) return;
        e.preventDefault();
        void import("@/lib/beginThread").then(({ beginThread }) =>
          beginThread({ roomId, navigate }),
        );
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "n" &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        useConversationUi.getState().openNewSheet();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen(true);
        return;
      }
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        // Not while typing — Alt+arrows are word/line motions in editors.
        if (isEditableTarget(e.target)) return;
        const entries = sidebarRoomOrder();
        if (entries.length === 0) return;
        e.preventDefault();
        const current = useAppStore.getState().activeRoomId;
        const idx = entries.findIndex((ids) =>
          ids.includes(current ?? ""),
        );
        const delta = e.key === "ArrowUp" ? -1 : 1;
        // No active room: enter the list from the end you're moving toward.
        const next =
          idx === -1
            ? delta === 1
              ? 0
              : entries.length - 1
            : Math.min(Math.max(idx + delta, 0), entries.length - 1);
        const target = entries[next]?.[0];
        if (target && target !== current) {
          useAppStore.getState().clearUnread(target);
          navigate(`/c/${target}`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    if (quickSwitcherNonce > 0) setSwitcherOpen(true);
  }, [quickSwitcherNonce]);

  const { data: rooms } = useQuery({
    queryKey: ["rooms", activeInstanceId],
    queryFn: () => api.getRooms(),
    refetchInterval: 60_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents", activeInstanceId],
    queryFn: () => api.getAgents(),
    // The roster now carries live `availability` (RoomList renders the sidebar
    // agent dots from it for every thread whose room is not open), so it has to
    // actually refresh. A 120s staleTime with no interval froze it for the
    // whole session — an agent disabled in Brigade, or a bridge that went away,
    // would keep reading available until a reload.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (rooms) {
      setRooms(rooms);
    }
  }, [rooms, setRooms]);

  // ---------------------------------------------------------------------------
  // ROUTING: the URL is the SINGLE, ONE-DIRECTIONAL source of truth for the
  // active room. The flow is always URL -> store, never store -> URL:
  //
  //   user action (sidebar click, quick-switcher, create/leave, deep-link)
  //     -> navigate("/c/<id>")        (handlers navigate; they never setActiveRoomId)
  //     -> routeRoomId changes
  //     -> the single effect below sets activeRoomId
  //     -> RoomView mounts off activeRoomId
  //
  // There is intentionally NO store -> URL effect. A prior attempt (reverted,
  // commit 6c36874) had TWO effects syncing both ways plus a branch that nulled
  // activeRoomId when the route param had not caught up; they raced every render
  // and settled with activeRoomId=null, leaving the main pane on the welcome
  // empty-state even though the URL + sidebar updated. DO NOT re-add a
  // store->URL effect or call setActiveRoomId from a click handler: navigate()
  // is the only entry point and this single idempotent effect is the only writer.

  // Legacy permalink shim: /?room=X(&message=Y) -> /c/X(?message=Y). This is a
  // URL -> URL redirect (not store -> URL), so it cannot join a sync loop;
  // previously-shared ?room= links still resolve.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const legacyRoom = search.get("room");
    if (!legacyRoom) return;
    const msg = search.get("message");
    navigate(
      `/c/${legacyRoom}${msg ? `?message=${encodeURIComponent(msg)}` : ""}`,
      { replace: true },
    );
  }, [navigate]);

  // URL -> store: the ONLY writer of activeRoomId from routing. Depends on
  // routeRoomId alone and is idempotent, so it converges in a single pass for
  // every entry path (sidebar click, deep-link, refresh on /c/:id, browser
  // back/forward) and is safe under React StrictMode double-invocation.
  // The "/" route (no param) clears the active room.
  useEffect(() => {
    setActiveRoomId(routeRoomId ?? null);
  }, [routeRoomId, setActiveRoomId]);

  // Deep-link / room open → select the matching nav destination and remember
  // last room for that view×server. Rooms may not be loaded yet on first paint
  // (hard refresh on /c/:id); re-run when the rooms list arrives.
  // Do NOT force Home when routeRoomId is null: the user may be on Chats with
  // no room open (URL still `/`) after clicking the view switcher.
  useEffect(() => {
    const nav = useNavStore.getState();
    // One list: a room is a conversation, including standing rooms. Do not
    // steer the rail from metadata.conference. Remember the v1 view anyway so
    // turning the flag off still restores Meetings / Direct / Channels.
    if (isNavV2Enabled()) {
      if (isDirectoryPath(location.pathname)) {
        if (nav.v2Destination !== "directory") nav.setV2Destination("directory");
        return;
      }
      // Back from /agents used to leave "directory" selected on Home, which
      // replaced the list with the directory note. Directory is the URL.
      if (!routeRoomId) {
        if (nav.v2Destination === "directory") nav.setV2Destination("home");
        return;
      }
      const room = storeRooms.find((r) => r.id === routeRoomId);
      if (!room) {
        if (nav.v2Destination === "directory") nav.setV2Destination("home");
        return;
      }
      nav.setV2Destination("conversations");
      if (activeInstanceId) {
        nav.rememberRoom(activeInstanceId, viewForRoom(room), routeRoomId);
      }
      return;
    }
    if (!isNavV1Enabled()) return;
    if (!routeRoomId) return;
    const room = storeRooms.find((r) => r.id === routeRoomId);
    if (!room) return;
    const view = viewForRoom(room);
    nav.setActiveView(view);
    if (activeInstanceId) {
      nav.rememberRoom(activeInstanceId, view, routeRoomId);
    }
  }, [routeRoomId, storeRooms, activeInstanceId, location.pathname]);

  useEffect(() => {
    if (agents) {
      setAgents(agents);
    }
  }, [agents, setAgents]);

  // Auto-close sidebar on small screens when a room is opened
  useEffect(() => {
    if (typeof window === "undefined") return;
    // <768px = phone (the off-canvas drawer). 768px itself is desktop (Tailwind
    // `md`), so use 767 — at exactly 768 the sidebar is in-flow and must NOT be
    // auto-collapsed.
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = (small: boolean) => {
      const ui = useAppStore.getState().ui;
      if (small && activeRoomId && ui.sidebarOpen) {
        useAppStore.setState({
          ui: { ...ui, sidebarOpen: false },
        });
      }
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [activeRoomId]);

  return (
    // Transparent root: the page tone comes from body (surface-0) + the aurora
    // field behind it, so glass/translucent surfaces actually pick it up.
    <div
      className="relative flex w-full max-w-[100vw] flex-col overflow-hidden"
      style={{
        // Fill the visible viewport exactly (see useAppHeight). Reserve the
        // notch/status-bar inset up top so content clears it in standalone PWA
        // mode. No left/right inset here on purpose: the drawers + backdrop are
        // `fixed` (viewport-anchored), so insetting only the root would leave a
        // seam in landscape — edge-to-edge is correct for those overlays.
        height: "var(--app-height, 100dvh)",
        paddingTop: "env(safe-area-inset-top)",
      }}
      data-testid="app-shell"
    >
      <ConnectionBanner />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Discord-style server rail — 72px, far left, desktop only. Renders null
          unless the user can reach more than one federated instance. */}
      <ServerRail />
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: sidebarWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            // While the handle is being dragged the width must track the
            // pointer 1:1 — a tween here would rubber-band behind the cursor.
            // Open/close keeps the original ease.
            transition={
              sidebarResize.isDragging
                ? { duration: 0 }
                : { duration: 0.2, ease: "easeInOut" }
            }
            // md:relative (not md:static): the resize handle is absolutely
            // positioned against this aside, which must stay a containing block.
            className="section-nav absolute inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-line-strong bg-surface-0/85 backdrop-blur-xl md:relative md:z-auto"
            aria-label="Room list sidebar"
          >
            {/* THE CONTENT HAS ITS OWN, FIXED WIDTH — and that is the fix.
             *
             * The aside's width is ANIMATED (0 <-> open) and its children used
             * to size themselves against it, so every frame of a 200ms open or
             * close relaid out the entire sidebar at a width no layout was ever
             * designed for. Measured mid-close at 14px: the "Pick a destination
             * above…" paragraph reflowed to a 4px column 371px tall (one
             * character per line), the ViewSwitcher pills kept their natural
             * widths and were pushed to NEGATIVE x where they overlapped each
             * other, and the wordmark simply overhung the box. `overflow-hidden`
             * on the aside was already there and was never the problem: it
             * clipped the overflow but could not stop the reflow that produced
             * it.
             *
             * Pinning the content to the OPEN width makes the animation a clean
             * wipe — the layout is computed once, at the width it was designed
             * for, and the container reveals or covers it. Same variable feeds
             * `animate` above, so the two can never drift apart; a drag on the
             * handle still resizes both together, which is what resizing means.
             *
             * Nothing needs hiding when collapsed: AnimatePresence UNMOUNTS the
             * whole aside once the exit finishes, so the collapsed steady state
             * renders no sidebar content at all. The defect was only ever the
             * transition. */}
            <div className="flex min-h-0 flex-1 flex-col" style={{ width: sidebarWidth }}>
              {/* Mobile server switcher — horizontal strip atop the drawer. */}
              <ServerRail mobile />
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
                <h1 className="flex min-w-0 items-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (isNavV2Enabled()) {
                        useNavStore.getState().setV2Destination("home");
                      } else if (isNavV1Enabled()) {
                        useNavStore.getState().setActiveView("home");
                      }
                      navigate("/");
                    }}
                    className="focus-ring flex items-center gap-2.5 rounded-lg py-1 pr-1 transition-opacity hover:opacity-80"
                    title="Home — Unicorn Stable"
                    aria-label="Go to Home"
                    data-testid="nav-home"
                  >
                    <StableMark className="h-7 w-7 shrink-0" />
                    <span className="gradient-text font-display text-lg font-bold tracking-tight">
                      Stable
                    </span>
                  </button>
                </h1>
                {/* The hamburger is hidden behind the open drawer on phones, so
                    give the drawer its own close affordance. Desktop closes via
                    the header toggle. */}
                <button
                  onClick={toggleSidebar}
                  className="focus-ring -mr-1 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:hidden"
                  aria-label="Close sidebar"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <RoomList />
              {/* Mobile-only account footer. On phones the top Header (with the
                  avatar menu) is hidden while a room is open, so account actions
                  live at the foot of the drawer. Desktop keeps the Header menu. */}
              <div className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
                {showPhotoNudge && (
                  <div className="mb-1 px-1">
                    <PhotoNudge
                      onAdd={() => {
                        openSettings("appearance");
                      }}
                    />
                  </div>
                )}
                <div className="mb-1 flex items-center gap-2.5 px-2.5 py-2">
                  <span
                    className="inline-flex shrink-0 rounded-full"
                    style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
                  >
                    <Identity {...selfFace} presence={null} size={24} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {currentUser?.displayName}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {currentUser?.email}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setPeopleDrawerOpen(true);
                    toggleSidebar();
                  }}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
                >
                  <UserRound className="h-4 w-4 text-slate-400" />
                  People
                </button>
                <button
                  onClick={() => {
                    setActivityOpen(true);
                    toggleSidebar();
                  }}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
                >
                  <Activity className="h-4 w-4 text-slate-400" />
                  Activity Center
                </button>
                <button
                  onClick={() => {
                    setSavedOpen(true);
                    toggleSidebar();
                  }}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
                >
                  <Bookmark className="h-4 w-4 text-slate-400" />
                  Saved messages
                </button>
                <button
                  onClick={() => {
                    toggleSettings();
                    toggleSidebar();
                  }}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
                  data-testid="open-settings"
                >
                  <Settings className="h-4 w-4 text-slate-400" />
                  Settings
                </button>
                <button
                  onClick={() => logout()}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-500/10"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
            {/* Desktop-only drag handle (double-click resets, arrows nudge).
                The phone drawer keeps its fixed width. Stays OUTSIDE the
                fixed-width content wrapper: it is absolutely positioned against
                the aside's animating edge, which is where a resize grip belongs
                — inside the wrapper it would sit at the content's static right
                edge and drift out of the panel during an open or close. */}
            <div
              {...sidebarResize.dragHandleProps}
              aria-label="Resize sidebar"
              title="Drag to resize · double-click to reset"
              className={clsx(
                PANEL_RESIZE_HANDLE_CLASS,
                "right-0 hidden md:block",
              )}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm md:hidden"
          aria-hidden="true"
          onClick={toggleSidebar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          hideOnMobile={!!activeRoomId}
          onOpenActivity={() => setActivityOpen(true)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
          <Suspense fallback={<SurfaceLoading />}>
            {activeRoomId ? (
              <ErrorBoundary key={activeRoomId}>
                <RoomView roomId={activeRoomId} />
              </ErrorBoundary>
            ) : isAgentsView ? (
              <ErrorBoundary>
                <AgentsPage />
              </ErrorBoundary>
            ) : isBridgeView ? (
              <ErrorBoundary>
                <BridgePage />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary>
                <HomeDashboard onOpenActivity={(tab) => { setActivityTab(tab); setActivityOpen(true); }} />
              </ErrorBoundary>
            )}
          </Suspense>
        </div>
      </main>

      <AnimatePresence>
        {createRoomModalOpen && <CreateRoomModal />}
      </AnimatePresence>
      <NewSheet />
      {!activeRoomId && (
        <button
          type="button"
          onClick={() => useConversationUi.getState().openNewSheet()}
          className="focus-ring fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-stable-purple text-white shadow-pop md:hidden"
          aria-label="New"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      <CheatsheetModal />

      <AnimatePresence>
        {settingsOpen && <SettingsModal onClose={toggleSettings} />}
      </AnimatePresence>

      <AnimatePresence>
        {savedOpen && <SavedPanel onClose={() => setSavedOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {peopleDrawerOpen && (
          <PeopleDrawer onClose={() => setPeopleDrawerOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activityOpen && (
          <ActivityCenter initialTab={activityTab} onClose={() => setActivityOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {switcherOpen && (
          <QuickSwitcher
            onClose={() => setSwitcherOpen(false)}
            onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {globalSearchOpen && (
          <GlobalSearchModal onClose={() => setGlobalSearchOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {addServerOpen && <AddServerModal />}
      </AnimatePresence>

      {switching && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40">
          <div className="rounded-xl bg-slate-800 px-4 py-3 text-sm text-slate-200 shadow-xl">
            Switching Stable instance…
          </div>
        </div>
      )}

      <IncomingCallBanner />
      <OutgoingCallStatus />
      <ToastStack />
      </div>
    </div>
  );
}

/**
 * Slim top-of-app banner for websocket health. websocket.ts already reconnects
 * with backoff and emits "connected"/"disconnected" — this only renders that
 * state. Debounced: a drop that recovers within 2s (backoff attempt #1) never
 * shows, so brief blips don't flash the UI. After a real outage reconnects, a
 * green "Reconnected" confirmation lingers ~2s then dismisses itself.
 *
 * The `expired` phase is terminal and deliberately NOT debounced or
 * self-dismissing: it means the refresh token is dead, so the socket has
 * stopped retrying entirely. Without it the app would render fine at HTTP 200
 * while silently receiving nothing — the exact "Stable went offline" symptom
 * this banner exists to make visible. It offers the only action that can fix
 * it, and outranks "lost" because reconnecting is no longer what's happening.
 */
function ConnectionBanner() {
  const [phase, setPhase] = useState<
    "hidden" | "lost" | "stalled" | "restored" | "expired"
  >("hidden");
  // Brief reconnect/recovery notices are dismissible. A stalled or expired
  // account session is actionable and stays visible until it is resolved.
  const [dismissed, setDismissed] = useState(false);
  // Why the stall happened. "auth" = token/session problems a re-login can
  // fix; "transport" = the socket path itself is unreachable, where telling
  // the user their session failed sends them to a fix that cannot work.
  const [stallCause, setStallCause] = useState<"auth" | "transport">(
    "transport",
  );

  useEffect(() => {
    let lostTimer: number | null = null;
    let restoredTimer: number | null = null;

    const offDown = ws.on("disconnected", () => {
      if (restoredTimer !== null) {
        window.clearTimeout(restoredTimer);
        restoredTimer = null;
      }
      // A fresh outage should re-show even if the user dismissed the last one.
      setDismissed(false);
      // Never DOWNGRADE: "expired" is terminal and "stalled" is a strictly
      // more accurate account of the same outage, so a fresh `disconnected`
      // from a retry that also failed must not walk either back to "lost".
      setPhase((p) =>
        p === "expired" || p === "stalled"
          ? p
          : p === "restored"
            ? "lost"
            : p,
      );
      if (lostTimer !== null) return;
      lostTimer = window.setTimeout(() => {
        lostTimer = null;
        setPhase((p) => (p === "expired" || p === "stalled" ? p : "lost"));
      }, 2000);
    });

    const offExpired = ws.on("auth_expired", () => {
      if (lostTimer !== null) {
        window.clearTimeout(lostTimer);
        lostTimer = null;
      }
      if (restoredTimer !== null) {
        window.clearTimeout(restoredTimer);
        restoredTimer = null;
      }
      setDismissed(false);
      setPhase("expired");
    });

    // Reconnection is still being attempted, but it has been failing long
    // enough that "reconnecting…" alone leaves the user with no way out. This
    // upgrades the SAME banner with a sign-in action; it is not terminal, and
    // a socket that comes back on its own still clears it.
    const offStalled = ws.on("auth_stalled", (payload) => {
      const cause = (payload as unknown as { cause?: "auth" | "transport" })
        ?.cause;
      setStallCause(cause === "auth" ? "auth" : "transport");
      if (lostTimer !== null) {
        window.clearTimeout(lostTimer);
        lostTimer = null;
      }
      if (restoredTimer !== null) {
        window.clearTimeout(restoredTimer);
        restoredTimer = null;
      }
      setDismissed(false);
      setPhase((p) => (p === "expired" ? p : "stalled"));
    });

    const offUp = ws.on("connected", () => {
      if (lostTimer !== null) {
        // Recovered inside the debounce window — the transient "lost" banner
        // never needs to show. Cancel the timer but DO NOT return: the phase
        // may already be a terminal one ("expired"/"stalled") set before this
        // blip, and returning here left that stale red banner up forever over
        // a fully working socket. Fall through and let the reducer decide.
        window.clearTimeout(lostTimer);
        lostTimer = null;
      }
      setPhase((p) => {
        // "expired" clears here as well as "lost". It is terminal for a GIVEN
        // session, not for the app: a federated server switch re-points auth at
        // another instance and reconnects, so a live socket is proof the
        // expired-session banner no longer describes reality. Without this the
        // socket would recover while the banner kept telling the user to sign
        // in again for a server whose session is fine.
        if (p !== "lost" && p !== "expired" && p !== "stalled") return p;
        if (restoredTimer !== null) window.clearTimeout(restoredTimer);
        restoredTimer = window.setTimeout(() => {
          restoredTimer = null;
          setPhase((q) => (q === "restored" ? "hidden" : q));
        }, 2000);
        return "restored";
      });
    });

    // The socket can reach the terminal state before this effect subscribes
    // (e.g. a reconnect that resolves during mount). Read it once so the banner
    // can't miss the event and leave the app looking silently offline.
    if (ws.sessionExpired) setPhase("expired");
    else if (ws.connectionStalled) setPhase("stalled");

    return () => {
      offDown();
      offUp();
      offExpired();
      offStalled();
      if (lostTimer !== null) window.clearTimeout(lostTimer);
      if (restoredTimer !== null) window.clearTimeout(restoredTimer);
    };
  }, []);

  // Stalled/expired states are not decorative: realtime is unavailable and a
  // user action may be required. Keep those visible; only transient states can
  // be dismissed.
  const visible =
    phase !== "hidden" &&
    (phase === "expired" || phase === "stalled" || !dismissed);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={phase}
          initial={{ y: -32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -32, opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          role={phase === "expired" || phase === "stalled" ? "alert" : "status"}
          aria-live={
            phase === "expired" || phase === "stalled" ? "assertive" : "polite"
          }
          className="relative z-[60] shrink-0"
        >
          <div
            className={clsx(
              "flex min-h-10 flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-3 py-2 text-center text-xs font-medium backdrop-blur-md sm:px-4",
              phase === "expired"
                ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                : phase === "lost" || phase === "stalled"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  : "border-stable-mint/30 bg-stable-mint/10 text-stable-mint",
            )}
          >
            {phase === "expired" ? (
              <>
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span>Your session expired. Live updates are paused.</span>
                <button
                  type="button"
                  onClick={() => login()}
                  className="focus-ring rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 font-semibold text-rose-100 hover:bg-rose-500/20"
                >
                  Sign in again
                </button>
              </>
            ) : phase === "stalled" ? (
              <>
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {stallCause === "auth"
                    ? "Session refresh failed. Live updates are paused."
                    : "Live updates can't get through right now. Still retrying…"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPhase("lost");
                    ws.manualReconnect();
                  }}
                  className="focus-ring rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-500/20"
                >
                  Retry now
                </button>
                {stallCause === "auth" && (
                  <button
                    type="button"
                    onClick={() => login()}
                    className="focus-ring rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-500/20"
                  >
                    Sign in again
                  </button>
                )}
              </>
            ) : phase === "lost" ? (
              <>
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span>Reconnecting to live updates…</span>
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  className="focus-ring rounded px-2 py-1 text-amber-200/80 underline-offset-2 hover:bg-amber-500/15 hover:underline"
                  aria-label="Dismiss connection banner"
                >
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <Wifi className="h-3.5 w-3.5 shrink-0" />
                Reconnected
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  className="focus-ring rounded px-2 py-1 text-stable-mint/80 underline-offset-2 hover:bg-stable-mint/15 hover:underline"
                  aria-label="Dismiss reconnected banner"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
