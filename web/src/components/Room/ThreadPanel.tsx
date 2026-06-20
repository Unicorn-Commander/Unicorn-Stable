import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { X, Send, CornerDownRight } from "lucide-react";
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
  const messages = useAppStore((s) => s.messages[roomId])?.items ?? [];
  const parent = messages.find((m) => m.id === parentId);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  const { data: replies = [], refetch } = useQuery({
    queryKey: ["thread", parentId],
    queryFn: () => api.getThread(parentId),
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    try {
      await api.sendMessage(roomId, {
        content: text,
        content_type: "text",
        thread_id: parentId,
      });
      setReply("");
      await refetch();
      // Also refresh main room messages so reply_count badge updates
      qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      console.error("thread reply failed", e);
    } finally {
      setSending(false);
    }
  }

  // Thread replies live in react-query (not the room store), so edit/delete
  // hit the message-scoped API directly and refetch. Mirrors what ChatPanel
  // wires for the main timeline; the room query is invalidated so reply_count
  // and last_message badges stay in sync.
  async function handleEdit(messageId: string, content: string) {
    const trimmed = content.trim();
    if (!trimmed) return;
    try {
      await api.editMessage(roomId, messageId, trimmed);
      await refetch();
      qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      console.error("thread edit failed", e);
    }
  }

  async function handleDelete(messageId: string) {
    try {
      await api.deleteMessage(roomId, messageId);
      await refetch();
      qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      console.error("thread delete failed", e);
    }
  }

  return (
    <motion.aside
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-y-0 right-0 z-40 flex h-full w-[min(90vw,320px)] flex-col border-l border-slate-700/50 bg-slate-900/95 shadow-2xl md:static md:z-auto md:w-80 md:shadow-none"
      aria-label="Thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-700/50 px-3">
        <div className="flex items-center gap-2 text-slate-200">
          <CornerDownRight className="h-4 w-4 text-slate-500" />
          <h3 className="text-sm font-semibold">Thread</h3>
          {replies.length > 0 && (
            <span className="text-xs text-slate-500">({replies.length})</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {parent && (
          <div className="border-b border-slate-800/60 px-3 py-3">
            <div className="flex gap-2">
              <Avatar
                name={parent.sender_name}
                src={parent.sender_avatar}
                size="sm"
                isAgent={parent.sender_type === "agent"}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-300">
                  <span className="font-semibold">{parent.sender_name}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-300">
                  {parent.content}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="px-1 py-2">
          {replies.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              No replies yet. Be the first.
            </p>
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

      <div className="shrink-0 border-t border-slate-700/50 p-2">
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
            className="flex-1 resize-none rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-stable-purple focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!reply.trim() || sending}
            className="shrink-0 rounded-md bg-stable-purple px-3 py-2 text-white hover:bg-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send reply"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.aside>
  );
}
