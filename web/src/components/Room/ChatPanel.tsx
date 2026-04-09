import { useRef, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { usePresence } from "@/hooks/usePresence";
import { useAppStore } from "@/stores/appStore";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";

interface ChatPanelProps {
  roomId: string;
}

export function ChatPanel({ roomId }: ChatPanelProps) {
  const { messages, hasMore, loading, sendMessage, loadMore, editMessage, deleteMessage } =
    useChat(roomId);
  const { typingUsers, sendTypingIndicator } = usePresence(roomId);
  const currentUser = useAppStore((s) => s.currentUser);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);

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

  function handleSend(content: string) {
    sendMessage(content);
    requestAnimationFrame(() => scrollToBottom(true));
  }

  function handleReply(messageId: string) {
    setThreadMessageId(messageId);
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
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-slate-400">No messages yet</p>
              <p className="mt-1 text-xs text-slate-600">
                Be the first to say something
              </p>
            </div>
          </div>
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

            return (
              <MessageBubble
                key={message.id}
                message={message}
                isOwn={message.sender_id === currentUser?.id}
                showAvatar={showAvatar}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReply={handleReply}
              />
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

      <MessageInput roomId={roomId} onSend={handleSend} onTyping={sendTypingIndicator} />
    </div>
  );
}
