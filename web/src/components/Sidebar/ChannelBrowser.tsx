import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Search, X } from "lucide-react";
import { api, type Room } from "@/services/api";
import { useModalA11y } from "@/hooks/useModalA11y";

interface ChannelBrowserProps {
  onClose: () => void;
}

export function ChannelBrowser({ onClose }: ChannelBrowserProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);
  // Esc-to-close, focus trap + restore — shared modal a11y.
  const panelRef = useModalA11y(true, onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: channels = [], refetch, isPending, isError } = useQuery({
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
      onClose();
      navigate(`/c/${room.id}`);
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12dvh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Browse channels"
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="glass-heavy w-full max-w-xl overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Browse channels you can join…"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={onClose}
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="max-h-96 divide-y divide-line overflow-y-auto">
          {isPending ? (
            <li className="animate-pulse-soft px-3 py-10 text-center text-xs text-slate-500">
              Loading channels…
            </li>
          ) : isError ? (
            <li className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <p className="font-display text-sm font-semibold text-slate-200">
                Couldn't load channels
              </p>
              <button
                onClick={() => refetch()}
                className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:text-slate-100"
              >
                Try again
              </button>
            </li>
          ) : channels.length === 0 ? (
            <li className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <span className="glow-iris flex h-10 w-10 items-center justify-center rounded-xl bg-stable-purple/15">
                <Hash className="h-5 w-5 text-stable-purple-light" />
              </span>
              <p className="font-display text-sm font-semibold text-slate-200">
                All caught up
              </p>
              <p className="text-xs text-slate-500">
                You're already in every channel.
              </p>
            </li>
          ) : (
            channels.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 p-3 transition-colors hover:bg-white/[0.03]"
              >
                <Hash className="h-4 w-4 shrink-0 text-stable-cyan/70" />
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
                  className="focus-ring shrink-0 rounded-lg border border-stable-purple/30 bg-stable-purple/15 px-3 py-1 text-xs font-medium text-stable-purple-light transition-colors hover:border-stable-purple/50 hover:bg-stable-purple/25 disabled:opacity-50"
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
