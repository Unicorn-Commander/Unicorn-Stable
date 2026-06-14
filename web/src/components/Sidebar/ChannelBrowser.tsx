import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Search, X } from "lucide-react";
import { api, type Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

interface ChannelBrowserProps {
  onClose: () => void;
}

export function ChannelBrowser({ onClose }: ChannelBrowserProps) {
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { data: channels = [], refetch } = useQuery({
    queryKey: ["browse-channels", debounced],
    queryFn: () => api.browseChannels(debounced),
  });

  async function join(room: Room) {
    if (joiningId) return;
    setJoiningId(room.id);
    try {
      await api.joinRoom(room.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["rooms"] }),
        refetch(),
      ]);
      setActiveRoomId(room.id);
      onClose();
    } catch (err) {
      console.error("join failed", err);
      alert("Couldn't join — " + (err as Error).message);
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-700/50 px-3 py-2.5">
          <Search className="h-4 w-4 text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Browse channels you can join…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
          />
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="max-h-96 overflow-y-auto divide-y divide-slate-800">
          {channels.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-500">
              You're already in every channel.
            </li>
          ) : (
            channels.map((c) => (
              <li key={c.id} className="flex items-center gap-3 p-3">
                <Hash className="h-4 w-4 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {c.name}
                  </p>
                  {c.description && (
                    <p className="truncate text-xs text-slate-500">
                      {c.description}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => join(c)}
                  disabled={joiningId === c.id}
                  className="shrink-0 rounded-md bg-stable-purple/20 px-2.5 py-1 text-xs text-stable-purple hover:bg-stable-purple/30 disabled:opacity-50"
                >
                  {joiningId === c.id ? "Joining…" : "Join"}
                </button>
              </li>
            ))
          )}
        </ul>
      </motion.div>
    </motion.div>
  );
}
