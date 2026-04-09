import { useState, useRef, useEffect } from "react";
import {
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
  Bot,
  CornerDownRight,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict, format } from "date-fns";
import type { Message } from "@/services/api";

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onReply: (messageId: string) => void;
}

export function MessageBubble({
  message,
  isOwn,
  showAvatar,
  onEdit,
  onDelete,
  onReply,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.selectionStart = editRef.current.value.length;
    }
  }, [editing]);

  function handleEditSubmit() {
    if (editContent.trim() && editContent !== message.content) {
      onEdit(message.id, editContent.trim());
    }
    setEditing(false);
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    }
    if (e.key === "Escape") {
      setEditing(false);
      setEditContent(message.content);
    }
  }

  function renderTimestamp() {
    try {
      const date = new Date(message.created_at);
      const relative = formatDistanceToNowStrict(date, { addSuffix: true });
      const full = format(date, "MMM d, yyyy 'at' h:mm a");
      return (
        <time
          dateTime={message.created_at}
          title={full}
          className="text-[10px] text-slate-600"
        >
          {relative}
        </time>
      );
    } catch {
      return null;
    }
  }

  if (message.sender_type === "system") {
    return (
      <div className="flex justify-center py-2">
        <p className="rounded-full bg-slate-800/60 px-4 py-1 text-xs text-slate-500">
          {message.content}
        </p>
      </div>
    );
  }

  if (message.content_type === "action") {
    return (
      <div className="my-2 flex justify-center px-4">
        <div className="glass max-w-md rounded-xl p-4">
          <p className="mb-3 text-sm text-slate-200">{message.content}</p>
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg bg-green-500/20 py-1.5 text-xs font-medium text-green-400 transition-colors hover:bg-green-500/30">
              Approve
            </button>
            <button className="flex-1 rounded-lg bg-red-500/20 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/30">
              Reject
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isAgent = message.sender_type === "agent";
  const avatarInitial = message.sender_name.charAt(0).toUpperCase();

  function renderContent(content: string) {
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    const parts: Array<{ type: "text" | "code"; content: string; lang?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
      }
      parts.push({ type: "code", content: match[2] ?? "", lang: match[1] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      parts.push({ type: "text", content: content.slice(lastIndex) });
    }

    if (parts.length === 0) {
      parts.push({ type: "text", content });
    }

    return parts.map((part, i) => {
      if (part.type === "code") {
        return (
          <pre
            key={i}
            className="my-1 overflow-x-auto rounded-lg bg-slate-900/80 p-3 text-xs"
          >
            <code className="text-slate-300">{part.content}</code>
          </pre>
        );
      }

      const lines = part.content.split("\n");
      return (
        <span key={i}>
          {lines.map((line, li) => (
            <span key={li}>
              {renderInlineContent(line)}
              {li < lines.length - 1 && <br />}
            </span>
          ))}
        </span>
      );
    });
  }

  function renderInlineContent(text: string) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const inlineCodeRegex = /`([^`]+)`/g;
    const boldRegex = /\*\*([^*]+)\*\*/g;

    let processed = text;
    const elements: Array<{ type: string; content: string; start: number; end: number }> = [];

    let m: RegExpExecArray | null;
    while ((m = urlRegex.exec(text)) !== null) {
      elements.push({ type: "url", content: m[0], start: m.index, end: m.index + m[0].length });
    }
    while ((m = inlineCodeRegex.exec(text)) !== null) {
      elements.push({ type: "code", content: m[1] ?? "", start: m.index, end: m.index + m[0].length });
    }
    while ((m = boldRegex.exec(text)) !== null) {
      elements.push({ type: "bold", content: m[1] ?? "", start: m.index, end: m.index + m[0].length });
    }

    if (elements.length === 0) {
      return processed;
    }

    elements.sort((a, b) => a.start - b.start);

    const result: Array<string | React.ReactElement> = [];
    let cursor = 0;

    elements.forEach((el, i) => {
      if (el.start > cursor) {
        result.push(text.slice(cursor, el.start));
      }

      if (el.type === "url") {
        result.push(
          <a
            key={`link-${i}`}
            href={el.content}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stable-cyan underline decoration-stable-cyan/30 transition-colors hover:text-stable-cyan-light"
          >
            {el.content}
          </a>,
        );
      } else if (el.type === "code") {
        result.push(
          <code
            key={`code-${i}`}
            className="rounded bg-slate-800 px-1 py-0.5 text-xs text-pink-400"
          >
            {el.content}
          </code>,
        );
      } else if (el.type === "bold") {
        result.push(
          <strong key={`bold-${i}`} className="font-semibold">
            {el.content}
          </strong>,
        );
      }

      cursor = el.end;
    });

    if (cursor < text.length) {
      result.push(text.slice(cursor));
    }

    return result;
  }

  return (
    <div
      className={clsx(
        "group relative flex gap-3 rounded-lg px-2 py-1 transition-colors",
        hovered && "bg-slate-800/30",
        !showAvatar && "pl-12",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="article"
      aria-label={`Message from ${message.sender_name}`}
    >
      {showAvatar && (
        <div className="mt-0.5 shrink-0">
          {message.sender_avatar ? (
            <img
              src={message.sender_avatar}
              alt={message.sender_name}
              className={clsx(
                "h-8 w-8 rounded-full object-cover",
                isAgent && "ring-1 ring-stable-cyan/30",
              )}
            />
          ) : (
            <div
              className={clsx(
                "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold",
                isAgent
                  ? "bg-stable-cyan/20 text-stable-cyan"
                  : "bg-stable-purple/20 text-stable-purple-light",
              )}
            >
              {isAgent ? <Bot className="h-4 w-4" /> : avatarInitial}
            </div>
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        {showAvatar && (
          <div className="mb-0.5 flex items-center gap-2">
            <span
              className={clsx(
                "text-sm font-semibold",
                isAgent ? "text-stable-cyan" : "text-slate-100",
              )}
            >
              {message.sender_name}
            </span>
            {isAgent && (
              <span className="rounded bg-stable-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-cyan">
                AI
              </span>
            )}
            {renderTimestamp()}
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-1">
            <textarea
              ref={editRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className="min-h-[2.5rem] resize-none rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-1 ring-stable-purple/50"
              rows={2}
            />
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <span>Escape to cancel</span>
              <span className="mx-1">|</span>
              <span>Enter to save</span>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditContent(message.content);
                  }}
                  className="rounded p-1 text-slate-400 hover:text-slate-200"
                  aria-label="Cancel edit"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleEditSubmit}
                  className="rounded p-1 text-green-400 hover:text-green-300"
                  aria-label="Save edit"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={clsx(
              "whitespace-pre-wrap break-words text-sm",
              isAgent
                ? "text-slate-200"
                : "text-slate-300",
            )}
          >
            {renderContent(message.content)}
            {message.edited && (
              <span className="ml-1 text-[10px] text-slate-600">(edited)</span>
            )}
          </div>
        )}

        {message.reply_count > 0 && !editing && (
          <button
            onClick={() => onReply(message.id)}
            className="mt-1 flex items-center gap-1 text-xs text-stable-purple-light transition-colors hover:text-stable-purple"
          >
            <CornerDownRight className="h-3 w-3" />
            {message.reply_count} {message.reply_count === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>

      {hovered && !editing && (
        <div className="absolute -top-3 right-2 flex items-center gap-0.5 rounded-lg border border-slate-700/50 bg-slate-800 p-0.5 shadow-lg animate-fade-in">
          <button
            onClick={() => onReply(message.id)}
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Reply in thread"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          {isOwn && (
            <>
              <button
                onClick={() => {
                  setEditing(true);
                  setEditContent(message.content);
                }}
                className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                aria-label="Edit message"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onDelete(message.id)}
                className="rounded p-1.5 text-slate-400 transition-colors hover:bg-red-500/20 hover:text-red-400"
                aria-label="Delete message"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
