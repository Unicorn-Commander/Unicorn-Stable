import { useRef, useEffect, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { usePresence } from "@/hooks/usePresence";
import { useAppStore } from "@/stores/appStore";
import { ws } from "@/services/websocket";
import { Avatar } from "@/components/Avatar";
import { EMPTY_MEMBERS, EMPTY_READ_RECEIPTS } from "@/stores/selectors";
import { MessageBubble } from "./MessageBubble";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDayLabel(d: Date): string {
  const today = new Date();
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
import { MessageInput } from "./MessageInput";

interface ChatPanelProps {
  roomId: string;
}

export function ChatPanel({ roomId }: ChatPanelProps) {
  const { messages, hasMore, loading, sendMessage, loadMore, editMessage, deleteMessage, retryMessage } =
    useChat(roomId);
  const { typingUsers, sendTypingIndicator } = usePresence(roomId);
  const currentUser = useAppStore((s) => s.currentUser);
  const [editFocusId, setEditFocusId] = useState<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  const readReceipts = useAppStore(
    (s) => s.readReceipts[roomId] ?? EMPTY_READ_RECEIPTS,
  );
  const participants = useAppStore(
    (s) => s.participants[roomId] ?? EMPTY_MEMBERS,
  );

  // Send mark_read for the latest message whenever (a) the room becomes
  // active, (b) a new message arrives while we're at bottom + visible.
  useEffect(() => {
    if (messages.length === 0) return;
    if (document.visibilityState !== "visible") return;
    const last = messages[messages.length - 1];
    if (!last) return;
    ws.send("mark_read", { room_id: roomId, message_id: last.id });
  }, [roomId, messages.length]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "instant",
    });
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current && messages.length > prevMessageCountRef.current) {
      scrollToBottom(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    scrollToBottom(false);
    prevMessageCountRef.current = messages.length;
  }, [roomId, scrollToBottom, messages.length]);

  useEffect(() => {
    const messageId = new URLSearchParams(window.location.search).get("message");
    if (!messageId) return;
    const target = document.getElementById(`m-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("rounded-lg", "ring-1", "ring-emerald-400/60");
    const timeout = window.setTimeout(() => {
      target.classList.remove("rounded-lg", "ring-1", "ring-emerald-400/60");
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [roomId, messages.length]);

  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 80;

    if (container.scrollTop < 100 && hasMore && !loading) {
      const prevScrollHeight = container.scrollHeight;
      loadMore().then(() => {
        requestAnimationFrame(() => {
          if (scrollContainerRef.current) {
            const newScrollHeight = scrollContainerRef.current.scrollHeight;
            scrollContainerRef.current.scrollTop = newScrollHeight - prevScrollHeight;
          }
        });
      });
    }
  }

  function handleSend(
    content: string,
    threadId?: string,
    attachments?: { url: string; filename: string; content_type: string; size: number }[],
    extraMetadata?: Record<string, unknown>,
  ) {
    sendMessage(content, threadId, attachments, extraMetadata);
    requestAnimationFrame(() => scrollToBottom(true));
  }

  function handleReply(messageId: string) {
    setThreadMessageId(messageId);
  }

  function triggerEditLast() {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.sender_id === currentUser?.id && m.content_type !== "system") {
        setEditFocusId(m.id);
        setEditTick((t) => t + 1);
        return;
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex flex-1 flex-col overflow-y-auto px-4 py-2"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
      >
        {loading && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <EmptyChannel
            roomId={roomId}
            participants={participants}
            currentUserId={currentUser?.id}
            onPrompt={(text: string) => {
              void sendMessage(text);
            }}
          />
        )}

        {hasMore && messages.length > 0 && (
          <div className="flex justify-center py-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
            ) : (
              <button
                onClick={() => loadMore()}
                className="text-xs text-slate-500 transition-colors hover:text-slate-300"
              >
                Load older messages
              </button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {messages.map((message, idx) => {
            const prevMessage = idx > 0 ? messages[idx - 1] : undefined;
            const showAvatar =
              !prevMessage ||
              prevMessage.sender_id !== message.sender_id ||
              new Date(message.created_at).getTime() -
                new Date(prevMessage.created_at).getTime() >
                300_000;

            const showDaySeparator =
              !prevMessage ||
              !sameDay(new Date(prevMessage.created_at), new Date(message.created_at));

            return (
              <div key={message.id} id={`m-${message.id}`}>
                {showDaySeparator && (
                  <div className="my-3 flex items-center gap-3 px-2">
                    <div className="h-px flex-1 bg-slate-700/50" />
                    <span className="rounded-full border border-slate-700/50 bg-slate-900 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                      {formatDayLabel(new Date(message.created_at))}
                    </span>
                    <div className="h-px flex-1 bg-slate-700/50" />
                  </div>
                )}
                <MessageBubble
                  message={message}
                  isOwn={message.sender_id === currentUser?.id}
                  showAvatar={showAvatar}
                  onEdit={editMessage}
                  onDelete={deleteMessage}
                  onReply={handleReply}
                  onRetry={retryMessage}
                  forceEditTick={editFocusId === message.id ? editTick : 0}
                />
                {/* "Seen by" pill — only on the most recent OWN message that
                    other participants have read past. Shows up to 3 avatars. */}
                {message.sender_id === currentUser?.id &&
                  idx === messages.length - 1 &&
                  (() => {
                    const seers = participants.filter((p) => {
                      const pid = p.participant_id || p.user_id || "";
                      if (!pid || pid === currentUser?.id) return false;
                      const at = readReceipts[pid];
                      if (!at) return false;
                      return new Date(at) >= new Date(message.created_at);
                    });
                    if (seers.length === 0) return null;
                    return (
                      <div className="ml-12 mt-1 flex items-center gap-1 text-[10px] text-slate-500">
                        <span>Seen by</span>
                        <div className="flex -space-x-1">
                          {seers.slice(0, 3).map((p) => (
                            <Avatar
                              key={p.participant_id || p.user_id}
                              name={p.display_name}
                              src={p.avatar_url}
                              size="xs"
                              className="ring-1 ring-slate-900"
                            />
                          ))}
                        </div>
                        {seers.length > 3 && <span>+{seers.length - 3}</span>}
                      </div>
                    );
                  })()}
              </div>
            );
          })}
        </div>

        <div ref={bottomRef} />
      </div>

      {typingUsers.length > 0 && (
        <div className="shrink-0 px-4 py-1">
          <p className="text-xs text-slate-500 animate-pulse-soft">
            {typingUsers.length === 1
              ? `${typingUsers[0]?.username ?? "Someone"} is typing...`
              : typingUsers.length === 2
                ? `${typingUsers[0]?.username ?? "Someone"} and ${typingUsers[1]?.username ?? "someone"} are typing...`
                : `${typingUsers.length} people are typing...`}
          </p>
        </div>
      )}

      <MessageInput roomId={roomId} onSend={handleSend} onTyping={sendTypingIndicator} onEditLast={triggerEditLast} />
    </div>
  );
}


interface EmptyChannelProps {
  roomId: string;
  participants: Array<{
    participant_id?: string | null;
    user_id?: string | null;
    display_name: string;
    participant_type?: string;
  }>;
  currentUserId?: string;
  onPrompt: (content: string) => void;
}

const AGENT_PROMPTS = [
  "Give me a 30-second intro of what you do best.",
  "What questions should I ask you first?",
  "Walk me through a typical task you handle.",
];

const CHANNEL_PROMPTS = [
  "👋 Say hi",
  "📌 Pin a goal for this channel",
  "🤖 Invite an agent",
];

function EmptyChannel({ participants, currentUserId, onPrompt }: EmptyChannelProps) {
  const others = participants.filter(
    (p) => (p.participant_id || p.user_id) !== currentUserId,
  );
  const onlyAgent = others.length === 1 && others[0]?.participant_type === "agent"
    ? others[0]
    : null;

  if (onlyAgent) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="max-w-md text-center">
          <p className="text-sm font-semibold text-slate-200">
            Chatting privately with {onlyAgent.display_name}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Mentions are off in DMs — every message goes to them.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {AGENT_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onPrompt(p)}
                className="rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-2 text-left text-sm text-slate-300 hover:border-stable-purple/50 hover:bg-slate-800"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold text-slate-200">
          The start of the conversation
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Be the first to say something — others see it the moment you hit enter.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {CHANNEL_PROMPTS.map((p) => (
            <span
              key={p}
              className="rounded-full border border-slate-700/50 bg-slate-800/40 px-2.5 py-1 text-xs text-slate-400"
            >
              {p}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
