import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  const [searchParams] = useSearchParams();
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

  // Legacy deep-link shim: /?room=X(&message=Y) → /c/X(?message=Y).
  // Permalinks shared before URL routing still resolve.
  useEffect(() => {
    const legacyRoom = searchParams.get("room");
    if (!legacyRoom) return;
    const msg = searchParams.get("message");
    navigate(`/c/${legacyRoom}${msg ? `?message=${msg}` : ""}`, { replace: true });
  }, [searchParams, navigate]);

  // URL → store: the route param is the source of truth for the active room.
  useEffect(() => {
    if (routeRoomId && routeRoomId !== activeRoomId) {
      setActiveRoomId(routeRoomId);
    }
    // Landing on "/" (no room) after a room was open should clear it.
    if (!routeRoomId && activeRoomId && !searchParams.get("room")) {
      setActiveRoomId(null);
    }
  }, [routeRoomId, activeRoomId, setActiveRoomId, searchParams]);

  // store → URL: clicking a room in the sidebar / quick-switcher updates the
  // store; reflect that into the path so refresh + back/forward stay in sync.
  useEffect(() => {
    if (searchParams.get("room")) return; // let the legacy shim run first
    if (activeRoomId && activeRoomId !== routeRoomId) {
      navigate(`/c/${activeRoomId}`);
    } else if (!activeRoomId && routeRoomId) {
      navigate("/");
    }
  }, [activeRoomId, routeRoomId, navigate, searchParams]);

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
