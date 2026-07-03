import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, X } from "lucide-react";
import { api, type Message } from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { identityFor } from "@/lib/identity";

interface SavedPanelProps {
  onClose: () => void;
}

export function SavedPanel({ onClose }: SavedPanelProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: saved = [] } = useQuery({
    queryKey: ["saved"],
    queryFn: () => api.getSaved(),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="glass-heavy w-full max-w-xl overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-stable-purple/15">
              <Bookmark className="h-4 w-4 text-stable-purple-light" />
            </span>
            <h2 className="font-display text-base font-semibold text-slate-100">
              Saved
            </h2>
            {saved.length > 0 && (
              <span className="text-xs text-slate-500 tabular-nums">
                ({saved.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close saved messages"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          {saved.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-14 text-center">
              <div className="relative mb-4">
                <div
                  className="absolute -inset-3 rounded-full bg-stable-purple/20 blur-xl"
                  aria-hidden="true"
                />
                <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2">
                  <Bookmark className="h-6 w-6 text-stable-purple-light" />
                </div>
              </div>
              <h3 className="font-display text-base font-semibold text-slate-100">
                Nothing saved yet
              </h3>
              <p className="mt-1 max-w-xs text-xs text-slate-500">
                Hover any message and click the bookmark icon to keep it here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {saved.map((m: Message) => {
                const ident = identityFor(m.sender_id, m.sender_name);
                return (
                  <li
                    key={m.id}
                    className="p-3.5 transition-colors hover:bg-white/[0.02]"
                  >
                    <div className="flex items-start gap-2.5">
                      <Avatar
                        name={m.sender_name}
                        src={m.sender_avatar}
                        size="sm"
                        isAgent={m.sender_type === "agent"}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className="truncate text-xs font-semibold"
                            style={{ color: ident.text }}
                          >
                            {m.sender_name}
                          </span>
                          <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">
                            {new Date(m.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                          {m.content}
                        </p>
                        <div className="mt-1.5 flex gap-3 text-[10px]">
                          <button
                            onClick={() => {
                              onClose();
                              navigate(`/c/${m.room_id}`);
                            }}
                            className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-stable-purple-light"
                          >
                            Jump to channel
                          </button>
                          <button
                            onClick={async () => {
                              await api.toggleSave(m.id);
                              await qc.invalidateQueries({ queryKey: ["saved"] });
                            }}
                            className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-rose-300"
                          >
                            Unsave
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
