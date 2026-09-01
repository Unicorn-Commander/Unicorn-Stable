import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { X, Send, CornerDownRight, MessagesSquare } from "lucide-react";
import { identityFor } from "@/lib/identity";
import { newClientMsgId } from "@/lib/sendPipeline";
import { api, type Message } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { Avatar } from "@/components/Avatar";
import { MessageBubble } from "./MessageBubble";

interface ThreadPanelProps {
  roomId: string;
  parentId: string;
  onClose: () => void;
}

export function ThreadPanel({ roomId, parentId, onClose }: ThreadPanelProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const messagesState = useAppStore((s) => s.messages[roomId]);
  // Memoized: `?? []` would mint a new array every render and re-fire the
  // thread-refresh effect below on every store change.
  const messages = useMemo(() => messagesState?.items ?? [], [messagesState]);
  const parent = messages.find((m) => m.id === parentId);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  // Idempotency id for the CURRENT draft: pressing send again after a failure
  // replays the same client_msg_id, so the server dedupes if the first
  // attempt actually persisted and only its response got lost. Regenerated
  // whenever the text changes — a same-id send must always mean the same
  // content — and cleared on success.
  const replySendRef = useRef<{ clientMsgId: string; text: string } | null>(null);

  const { data: replies = [], refetch } = useQuery({
    queryKey: ["thread", parentId],
    queryFn: () => api.getThread(parentId),
  });

  useEffect(() => {
    // Only autofocus on pointer devices — on touch it pops the keyboard
    // over an input the user hasn't tapped yet.
    if (window.matchMedia("(hover: hover)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  // Auto-grow the reply textarea like the main composer (capped at 120px).
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [reply]);

  // Refresh thread when a new message hits the room and matches our thread_id
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.thread_id === parentId) {
      refetch();
    }
  }, [messages, parentId, refetch]);

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    if (!replySendRef.current || replySendRef.current.text !== text) {
      replySendRef.current = { clientMsgId: newClientMsgId(), text };
    }
    try {
      await api.sendMessage(roomId, {
        content: text,
        content_type: "text",
        thread_id: parentId,
        client_msg_id: replySendRef.current.clientMsgId,
      });
      replySendRef.current = null;
      setReply("");
      await refetch();
      // Also refresh main room messages so reply_count badge updates
      qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      // The draft stays in the composer (only success clears it); say WHY the
      // reply isn't in the thread instead of un-happening silently.
      console.error("thread reply failed", e);
      useAppStore.getState().pushToast({
        title: "Reply not sent",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setSending(false);
    }
  }

  // Thread replies live in react-query (not the room store), so edit/delete
  // hit the message-scoped API directly and refetch. Mirrors what ChatPanel
  // wires for the main timeline; the room query is invalidated so reply_count
  // and last_message badges stay in sync.
  async function handleEdit(messageId: string, content: string): Promise<boolean> {
    const trimmed = content.trim();
    if (!trimmed) return true;
    try {
      await api.editMessage(roomId, messageId, trimmed);
      await refetch();
      qc.invalidateQueries({ queryKey: ["room", roomId] });
      return true;
    } catch (e) {
      console.error("thread edit failed", e);
      useAppStore.getState().pushToast({
        title: "Edit failed",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message,
        kind: "error",
      });
      return false;
    }
  }

  async function handleDelete(messageId: string) {
    try {
      await api.deleteMessage(roomId, messageId);
      await refetch();
      qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      console.error("thread delete failed", e);
      useAppStore.getState().pushToast({
        title: "Delete failed",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message,
        kind: "error",
      });
    }
  }

  return (
    <motion.aside
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="glass-heavy absolute inset-y-0 right-0 z-40 flex h-full w-[min(90vw,320px)] flex-col shadow-2xl md:static md:z-auto md:w-80 md:shadow-none"
      aria-label="Thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2 text-slate-200">
          <CornerDownRight className="h-4 w-4 text-stable-purple-light/80" />
          <h3 className="font-display text-sm font-semibold">Thread</h3>
          {replies.length > 0 && (
            <span className="text-xs tabular-nums text-slate-500">
              ({replies.length})
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {parent && (
          <div className="border-b border-line bg-white/[0.02] px-3 py-3">
            <div className="flex gap-2">
              <Avatar
                name={parent.sender_name}
                src={parent.sender_avatar}
                size="sm"
                isAgent={parent.sender_type === "agent"}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-300">
                  <span
                    className="font-semibold"
                    style={{
                      color: identityFor(parent.sender_id, parent.sender_name)
                        .text,
                    }}
                  >
                    {parent.sender_name}
                  </span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-300">
                  {parent.content}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="px-1 py-2">
          {replies.length === 0 ? (
            <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-8 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-purple/10 text-stable-purple-light shadow-[0_0_24px_rgba(139,92,246,0.18)]">
                <MessagesSquare className="h-5 w-5" />
              </div>
              <p className="font-display text-sm font-semibold text-slate-200">
                No replies yet
              </p>
              <p className="text-xs text-slate-500">Be the first to reply.</p>
            </div>
          ) : (
            replies.map((r: Message, i, arr) => (
              <MessageBubble
                key={r.id}
                message={r}
                showAvatar={i === 0 || arr[i - 1]?.sender_id !== r.sender_id}
                isOwn={r.sender_id === currentUser?.id}
                onReply={() => {}}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Reply…"
            className="flex-1 resize-none rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
          />
          <button
            onClick={send}
            disabled={!reply.trim() || sending}
            className="focus-ring gradient-bg shrink-0 rounded-xl px-3 py-2 text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send reply"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.aside>
  );
}
