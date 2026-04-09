import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { Header } from "./Header";
import { RoomList } from "@/components/Sidebar/RoomList";
import { CreateRoomModal } from "@/components/Sidebar/CreateRoomModal";
import { RoomView } from "@/components/Room/RoomView";

export function AppShell() {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setRooms = useAppStore((s) => s.setRooms);
  const setAgents = useAppStore((s) => s.setAgents);
  const createRoomModalOpen = useAppStore((s) => s.ui.createRoomModalOpen);

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

  useEffect(() => {
    if (agents) {
      setAgents(agents);
    }
  }, [agents, setAgents]);

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
            className="flex h-full shrink-0 flex-col overflow-hidden border-r border-slate-700/50"
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
            <RoomView roomId={activeRoomId} />
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
    </div>
  );
}
