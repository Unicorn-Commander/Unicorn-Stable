import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Send,
  Paperclip,
  Mic,
  Phone,
  AtSign,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { useStableRoom } from "@/hooks/useStableRoom";

interface MessageInputProps {
  roomId: string;
  onSend: (content: string) => void;
  onTyping: () => void;
}

interface MentionSuggestion {
  id: string;
  name: string;
  type: "human" | "agent";
}

export function MessageInput({ roomId, onSend, onTyping }: MessageInputProps) {
  const [content, setContent] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const participants = useAppStore((s) => s.participants[roomId] ?? []);
  const agents = useAppStore((s) => s.agents);
  const rooms = useAppStore((s) => s.rooms);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const { connect: lkConnect, isConnected } = useStableRoom(
    voiceActive ? roomId : null,
  );

  const room = rooms.find((r) => r.id === roomId);
  const roomAgents = room?.agents ?? [];

  const mentionSuggestions: MentionSuggestion[] = useCallback(() => {
    const q = mentionQuery.toLowerCase();
    const humanSuggestions: MentionSuggestion[] = participants
      .filter((p) => p.display_name.toLowerCase().includes(q))
      .map((p) => ({ id: p.user_id, name: p.display_name, type: "human" as const }));

    const agentSuggestions: MentionSuggestion[] = roomAgents
      .map((ra) => agents.find((a) => a.id === ra.id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
      .filter((a) => a.display_name.toLowerCase().includes(q))
      .map((a) => ({ id: a.id, name: a.display_name, type: "agent" as const }));

    return [...agentSuggestions, ...humanSuggestions];
  }, [mentionQuery, participants, agents, roomAgents])();

  useEffect(() => {
    adjustHeight();
  }, [content]);

  function adjustHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);
    onTyping();

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);

    if (mentionMatch) {
      setShowMentions(true);
      setMentionQuery(mentionMatch[1] ?? "");
      setMentionIndex(0);
    } else {
      setShowMentions(false);
      setMentionQuery("");
    }
  }

  function insertMention(suggestion: MentionSuggestion) {
    const el = textareaRef.current;
    if (!el) return;

    const cursorPos = el.selectionStart;
    const textBeforeCursor = content.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");
    if (atIndex === -1) return;

    const before = content.slice(0, atIndex);
    const after = content.slice(cursorPos);
    const newContent = `${before}@${suggestion.name} ${after}`;

    setContent(newContent);
    setShowMentions(false);
    setMentionQuery("");

    requestAnimationFrame(() => {
      const newPos = atIndex + suggestion.name.length + 2;
      el.setSelectionRange(newPos, newPos);
      el.focus();
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showMentions && mentionSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) =>
          prev < mentionSuggestions.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((prev) =>
          prev > 0 ? prev - 1 : mentionSuggestions.length - 1,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = mentionSuggestions[mentionIndex];
        if (selected) {
          insertMention(selected);
        }
        return;
      }
      if (e.key === "Escape") {
        setShowMentions(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setContent("");
    setShowMentions(false);
    requestAnimationFrame(() => adjustHeight());
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const names = files.map((f) => f.name).join(", ");
      setContent((prev) =>
        prev ? `${prev}\n[Attached: ${names}]` : `[Attached: ${names}]`,
      );
    }
  }

  function handleFileSelect() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      const names = files.map((f) => f.name).join(", ");
      setContent((prev) =>
        prev ? `${prev}\n[Attached: ${names}]` : `[Attached: ${names}]`,
      );
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleStartCall() {
    if (!isConnected) {
      lkConnect();
    }
  }

  return (
    <div
      className={clsx(
        "relative shrink-0 border-t border-slate-700/50 px-4 py-3",
        dragOver && "bg-stable-purple/5 ring-2 ring-inset ring-stable-purple/30",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showMentions && mentionSuggestions.length > 0 && (
        <div
          className="glass absolute bottom-full left-4 right-4 z-30 mb-1 max-h-48 overflow-y-auto rounded-xl p-1 shadow-xl animate-slide-up"
          role="listbox"
          aria-label="Mention suggestions"
        >
          {mentionSuggestions.map((suggestion, idx) => (
            <button
              key={suggestion.id}
              role="option"
              aria-selected={idx === mentionIndex}
              onClick={() => insertMention(suggestion)}
              onMouseEnter={() => setMentionIndex(idx)}
              className={clsx(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors",
                idx === mentionIndex
                  ? "bg-stable-purple/15 text-slate-100"
                  : "text-slate-300 hover:bg-slate-800/60",
              )}
            >
              <div
                className={clsx(
                  "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold",
                  suggestion.type === "agent"
                    ? "bg-stable-cyan/20 text-stable-cyan"
                    : "bg-stable-purple/20 text-stable-purple-light",
                )}
              >
                {suggestion.type === "agent" ? (
                  <AtSign className="h-3 w-3" />
                ) : (
                  suggestion.name.charAt(0).toUpperCase()
                )}
              </div>
              <span className="text-sm">{suggestion.name}</span>
              {suggestion.type === "agent" && (
                <span className="ml-auto text-[10px] text-stable-cyan">AI</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          <button
            onClick={handleFileSelect}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
            aria-label="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
            aria-hidden="true"
          />
        </div>

        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="w-full resize-none rounded-xl bg-slate-800/80 px-4 py-2.5 pr-10 text-sm text-slate-100 placeholder-slate-500 outline-none ring-1 ring-slate-700/50 transition-colors focus:ring-stable-purple/50"
            aria-label="Message input"
          />

          {content.trim() ? (
            <button
              onClick={handleSend}
              className="absolute bottom-2 right-2 rounded-lg bg-stable-purple p-1.5 text-white transition-colors hover:bg-stable-purple-light"
              aria-label="Send message"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              onClick={handleStartCall}
              className={clsx(
                "absolute bottom-2 right-2 rounded-lg p-1.5 transition-colors",
                isConnected
                  ? "text-green-400"
                  : "text-slate-500 hover:text-slate-300",
              )}
              aria-label="Start voice call"
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {!isConnected && !voiceActive && (
          <button
            onClick={handleStartCall}
            className="shrink-0 rounded-lg p-1.5 pb-2.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-green-400"
            aria-label="Start call"
          >
            <Phone className="h-4 w-4" />
          </button>
        )}
      </div>

      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-stable-purple/10 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-stable-purple-light">
            <Paperclip className="h-5 w-5" />
            <span className="text-sm font-medium">Drop files to attach</span>
          </div>
        </div>
      )}
    </div>
  );
}
