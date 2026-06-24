import { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bookmark, Settings, LogOut } from "lucide-react";
import { api } from "@/services/api";
import { logout } from "@/services/auth";
import { useAppStore } from "@/stores/appStore";
import { Avatar } from "@/components/Avatar";
import { useGlobalNotifications } from "@/hooks/useGlobalNotifications";
import { useAppHeight } from "@/hooks/useAppHeight";
import { Header } from "./Header";
import { ToastStack } from "./ToastStack";
import { CheatsheetModal } from "./CheatsheetModal";
import { SettingsModal } from "./SettingsModal";
import { SavedPanel } from "./SavedPanel";
import { QuickSwitcher } from "./QuickSwitcher";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RoomList } from "@/components/Sidebar/RoomList";
import { CreateRoomModal } from "@/components/Sidebar/CreateRoomModal";
import { RoomView } from "@/components/Room/RoomView";
import { HomeDashboard } from "@/components/Home/HomeDashboard";
import { AgentsPage } from "@/components/Agents/AgentsPage";

export function AppShell() {
  useGlobalNotifications();
  // Keep the app pinned to the visible viewport (collapsing toolbar + keyboard).
  useAppHeight();
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const isAgentsView = location.pathname === "/agents";
  const navigate = useNavigate();
  const setRooms = useAppStore((s) => s.setRooms);
  const setAgents = useAppStore((s) => s.setAgents);
  const createRoomModalOpen = useAppStore((s) => s.ui.createRoomModalOpen);
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const savedOpen = useAppStore((s) => s.ui.savedOpen);
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const currentUser = useAppStore((s) => s.currentUser);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Tab title shows total unread so background tabs can notify.
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    document.title =
      total > 0
        ? `(${total > 99 ? "99+" : total}) Unicorn Command Center`
        : "Unicorn Command Center";
    return () => {
      document.title = "Unicorn Command Center";
    };
  }, [unreadCounts]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd+/ or Ctrl+/ → toggle cheatsheet
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        useAppStore.getState().toggleCheatsheet();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // Cmd/Ctrl + K opens the quick switcher
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data: rooms } = useQuery({
    queryKey: ["rooms"],
    queryFn: () => api.getRooms(),
    refetchInterval: 60_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.getAgents(),
    staleTime: 120_000,
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
    <div
      className="relative flex w-screen overflow-hidden bg-slate-900"
      style={{
        // Fill the visible viewport exactly (see useAppHeight). Reserve the
        // notch/status-bar inset up top so content clears it in standalone PWA
        // mode. No left/right inset here on purpose: the drawers + backdrop are
        // `fixed` (viewport-anchored), so insetting only the root would leave a
        // seam in landscape — edge-to-edge is correct for those overlays.
        height: "var(--app-height, 100dvh)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="absolute inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-slate-700/50 bg-slate-900 md:static md:z-auto"
            aria-label="Room list sidebar"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-700/50 px-4">
              <h1
                className="gradient-text text-lg font-bold tracking-tight"
                title="Unicorn Command Center"
              >
                Command Center
              </h1>
              {/* The hamburger is hidden behind the open drawer on phones, so
                  give the drawer its own close affordance. Desktop closes via
                  the header toggle. */}
              <button
                onClick={toggleSidebar}
                className="-mr-1 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 md:hidden"
                aria-label="Close sidebar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <RoomList />
            {/* Mobile-only account footer. On phones the top Header (with the
                avatar menu) is hidden while a room is open, so account actions
                live at the foot of the drawer. Desktop keeps the Header menu. */}
            <div className="shrink-0 border-t border-slate-700/50 p-2 md:hidden">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Avatar
                  name={currentUser?.displayName ?? "U"}
                  src={currentUser?.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {currentUser?.displayName}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {currentUser?.email}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setSavedOpen(true);
                  toggleSidebar();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <Bookmark className="h-4 w-4" />
                Saved messages
              </button>
              <button
                onClick={() => {
                  toggleSettings();
                  toggleSidebar();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
              <button
                onClick={() => logout()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/60 md:hidden"
          aria-hidden="true"
          onClick={toggleSidebar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <Header hideOnMobile={!!activeRoomId} />
        <div className="flex min-h-0 flex-1">
          {activeRoomId ? (
            <ErrorBoundary key={activeRoomId}>
              <RoomView roomId={activeRoomId} />
            </ErrorBoundary>
          ) : isAgentsView ? (
            <ErrorBoundary>
              <AgentsPage />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary>
              <HomeDashboard />
            </ErrorBoundary>
          )}
        </div>
      </main>

      <AnimatePresence>
        {createRoomModalOpen && <CreateRoomModal />}
      </AnimatePresence>

      <CheatsheetModal />

      <AnimatePresence>
        {settingsOpen && <SettingsModal onClose={toggleSettings} />}
      </AnimatePresence>

      <AnimatePresence>
        {savedOpen && <SavedPanel onClose={() => setSavedOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {switcherOpen && (
          <QuickSwitcher onClose={() => setSwitcherOpen(false)} />
        )}
      </AnimatePresence>

      <ToastStack />
    </div>
  );
}
