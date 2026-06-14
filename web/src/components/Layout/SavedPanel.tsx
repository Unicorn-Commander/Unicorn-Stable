import { useEffect } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, X } from "lucide-react";
import { api, type Message } from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { useAppStore } from "@/stores/appStore";

interface SavedPanelProps {
  onClose: () => void;
}

export function SavedPanel({ onClose }: SavedPanelProps) {
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[10vh]"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <Bookmark className="h-4 w-4 text-stable-purple" />
            <h2 className="text-base font-semibold text-slate-100">Saved</h2>
            {saved.length > 0 && (
              <span className="text-xs text-slate-500">({saved.length})</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          {saved.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">
              No saved messages yet.
              <br />
              Hover any message and click the bookmark icon to save it here.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {saved.map((m: Message) => (
                <li key={m.id} className="p-3">
                  <div className="flex items-start gap-2">
                    <Avatar
                      name={m.sender_name}
                      src={m.sender_avatar}
                      size="sm"
                      isAgent={m.sender_type === "agent"}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-200">
                          {m.sender_name}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate-500">
                          {new Date(m.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-slate-300">
                        {m.content}
                      </p>
                      <div className="mt-1.5 flex gap-3 text-[10px]">
                        <button
                          onClick={() => {
                            setActiveRoomId(m.room_id);
                            onClose();
                          }}
                          className="text-slate-500 hover:text-slate-300"
                        >
                          Jump to channel
                        </button>
                        <button
                          onClick={async () => {
                            await api.toggleSave(m.id);
                            await qc.invalidateQueries({ queryKey: ["saved"] });
                          }}
                          className="text-slate-500 hover:text-slate-300"
                        >
                          Unsave
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
