import { useEffect } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, X, CornerDownRight } from "lucide-react";
import { identityFor } from "@/lib/identity";
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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="glass-heavy fixed inset-y-0 right-0 z-40 flex h-full w-[min(90vw,320px)] flex-col shadow-2xl md:static md:z-auto md:w-80 md:shadow-none"
      aria-label="Pinned messages"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2 text-slate-200">
          <Pin className="h-4 w-4 text-stable-gold/90" />
          <h3 className="font-display text-sm font-semibold">Pinned</h3>
          {pins.length > 0 && (
            <span className="text-xs tabular-nums text-slate-500">
              ({pins.length})
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Close pins"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {pins.length === 0 ? (
          <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-10 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-gold/10 text-stable-gold shadow-[0_0_24px_rgba(251,191,36,0.15)]">
              <Pin className="h-5 w-5" />
            </div>
            <p className="font-display text-sm font-semibold text-slate-200">
              Nothing pinned yet
            </p>
            <p className="text-xs text-slate-500">
              Hover any message and click the pin icon.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pins.map((m: Message) => (
              <li
                key={m.id}
                className="rounded-xl border border-line bg-surface-1/80 p-2.5 transition-colors hover:border-line-strong"
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
                      <span
                        className="text-xs font-semibold"
                        style={{
                          color: identityFor(m.sender_id, m.sender_name).text,
                        }}
                      >
                        {m.sender_name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                        {new Date(m.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-slate-300">
                      {m.content}
                    </p>
                    <div className="mt-1.5 flex gap-3 text-[10px]">
                      <button
                        onClick={() => setThreadMessageId(m.id)}
                        className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-stable-purple-light"
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
                        className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-rose-300"
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
