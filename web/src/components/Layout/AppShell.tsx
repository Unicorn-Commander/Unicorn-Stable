import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useGlobalNotifications } from "@/hooks/useGlobalNotifications";
import { Header } from "./Header";
import { ToastStack } from "./ToastStack";
import { CheatsheetModal } from "./CheatsheetModal";
import { SettingsModal } from "./SettingsModal";
import { QuickSwitcher } from "./QuickSwitcher";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RoomList } from "@/components/Sidebar/RoomList";
import { CreateRoomModal } from "@/components/Sidebar/CreateRoomModal";
import { RoomView } from "@/components/Room/RoomView";

export function AppShell() {
  useGlobalNotifications();
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const setRooms = useAppStore((s) => s.setRooms);
  const setAgents = useAppStore((s) => s.setAgents);
  const createRoomModalOpen = useAppStore((s) => s.ui.createRoomModalOpen);
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Tab title shows total unread so background tabs can notify.
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) Stable` : "Stable";
    return () => {
      document.title = "Stable";
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
    const mq = window.matchMedia("(max-width: 768px)");
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
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900">
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
            <div className="flex h-14 shrink-0 items-center border-b border-slate-700/50 px-4">
              <h1 className="gradient-text text-lg font-bold tracking-tight">
                Stable
              </h1>
            </div>
            <RoomList />
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="flex min-w-0 flex-1 flex-col">
        <Header />
        <div className="flex min-h-0 flex-1">
          {activeRoomId ? (
            <ErrorBoundary key={activeRoomId}>
              <RoomView roomId={activeRoomId} />
            </ErrorBoundary>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="gradient-bg flex h-16 w-16 items-center justify-center rounded-2xl">
                  <span className="text-2xl font-bold text-white">S</span>
                </div>
                <h2 className="text-lg font-semibold text-slate-200">
                  Welcome to Stable
                </h2>
                <p className="max-w-sm text-sm text-slate-400">
                  Select a room from the sidebar to start chatting, or create a
                  new room to begin a conversation with humans and AI agents.
                </p>
              </div>
            </div>
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
        {switcherOpen && (
          <QuickSwitcher onClose={() => setSwitcherOpen(false)} />
        )}
      </AnimatePresence>

      <ToastStack />
    </div>
  );
}
