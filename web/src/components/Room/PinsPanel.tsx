import { useEffect } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, X, CornerDownRight } from "lucide-react";
import { api, type Message } from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { useAppStore } from "@/stores/appStore";
import { ws, type WsEventPayload } from "@/services/websocket";

interface PinsPanelProps {
  roomId: string;
  onClose: () => void;
}

export function PinsPanel({ roomId, onClose }: PinsPanelProps) {
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  const qc = useQueryClient();
  const { data: pins = [], refetch } = useQuery({
    queryKey: ["pins", roomId],
    queryFn: () => api.getPins(roomId),
  });

  // Refetch when WS announces a pin change for this room
  useEffect(() => {
    return ws.on("pins_changed", (data: WsEventPayload) => {
      const e = data as unknown as { room_id: string };
      if (e.room_id === roomId) refetch();
    });
  }, [roomId, refetch]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.aside
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-y-0 right-0 z-40 flex h-full w-[min(90vw,320px)] flex-col border-l border-slate-700/50 bg-slate-900/95 shadow-2xl md:static md:z-auto md:w-80 md:shadow-none"
      aria-label="Pinned messages"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-700/50 px-3">
        <div className="flex items-center gap-2 text-slate-200">
          <Pin className="h-4 w-4 text-slate-500" />
          <h3 className="text-sm font-semibold">Pinned</h3>
          {pins.length > 0 && (
            <span className="text-xs text-slate-500">({pins.length})</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          aria-label="Close pins"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {pins.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-slate-500">
            No pinned messages yet. Hover any message and click the pin icon.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pins.map((m: Message) => (
              <li
                key={m.id}
                className="rounded-md border border-slate-700/50 bg-slate-900 p-2"
              >
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
                        onClick={() => setThreadMessageId(m.id)}
                        className="text-slate-500 hover:text-slate-300"
                      >
                        <CornerDownRight className="inline h-3 w-3" /> Open
                        thread
                      </button>
                      <button
                        onClick={async () => {
                          await api.togglePin(roomId, m.id);
                          await qc.invalidateQueries({
                            queryKey: ["pins", roomId],
                          });
                        }}
                        className="text-slate-500 hover:text-slate-300"
                      >
                        Unpin
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </motion.aside>
  );
}
