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
} from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import { useStableRoom } from "@/hooks/useStableRoom";
import { emojiSuggestions, replaceEmojiShortcodes } from "@/utils/emoji";
import { clearDraft, getDraft, saveDraft } from "@/utils/drafts";

interface PollSpec {
  question: string;
  options: string[];
}

/**
 * Parse `/poll "Lunch today?" pizza ramen "fish tacos"` into a structured
 * spec. Quotes group multi-word options. Returns null if the input doesn't
 * look like a poll.
 */
function parsePoll(rest: string): PollSpec | null {
  // tokens: quoted "..." OR bare words
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    tokens.push(m[1] ?? m[2] ?? "");
  }
  if (tokens.length < 2) return null;
  const question = tokens[0]!;
  const options = tokens.slice(1).filter(Boolean);
  if (options.length < 2 || options.length > 10) return null;
  return { question, options };
}

/** A slash command can produce text and/or message metadata. */
interface SlashResult {
  text: string | null;
  metadata?: Record<string, unknown>;
}

/** Returns text+metadata to send, or text=null to consume input silently. */
function applySlashCommand(input: string): SlashResult {
  if (!input.startsWith("/")) return { text: input };
  const space = input.indexOf(" ");
  const cmd = (space === -1 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const rest = space === -1 ? "" : input.slice(space + 1).trim();

  switch (cmd) {
    case "me":
      return { text: rest ? `*${rest}*` : input };
    case "shrug":
      return { text: (rest ? rest + " " : "") + "¯\\_(ツ)_/¯" };
    case "tableflip":
      return { text: (rest ? rest + " " : "") + "(╯°□°）╯︵ ┻━┻" };
    case "unflip":
      return { text: (rest ? rest + " " : "") + "┬─┬ ノ( ゜-゜ノ)" };
    case "agent":
      if (!rest) return { text: input };
      return { text: "@" + rest };
    case "poll": {
      const poll = parsePoll(rest);
      if (!poll) {
        alert(
          'Usage: /poll "Question?" option1 option2 [option3...]\n' +
            "Use double-quotes for multi-word options.",
        );
        return { text: null };
      }
      return {
        text: "📊 " + poll.question,
        metadata: { poll },
      };
    }
    case "help":
      // Defer to the global cheatsheet modal — same content shown via Cmd+/.
      useAppStore.getState().toggleCheatsheet();
      return { text: null };
    default:
      return { text: input };
  }
}

interface PendingAttachment {
  url: string;
  filename: string;
  content_type: string;
  size: number;
}

interface MessageInputProps {
  roomId: string;
  onSend: (
    content: string,
    threadId?: string,
    attachments?: PendingAttachment[],
    extraMetadata?: Record<string, unknown>,
  ) => void;
  onTyping: () => void;
  onEditLast?: () => void;
}

interface MentionSuggestion {
  id: string;
  name: string;
  type: "human" | "agent";
}

export function MessageInput({ roomId, onSend, onTyping, onEditLast }: MessageInputProps) {
  const [content, setContent] = useState(() => getDraft(roomId));
  const [dragOver, setDragOver] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const emojiMatches = emojiSuggestions(emojiQuery, 8);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const participants = useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  const voiceActive = useAppStore((s) => s.voiceActive);
  const setVoiceActive = useAppStore((s) => s.setVoiceActive);
  const {
    room: lkRoom,
    connect: lkConnect,
    isConnected,
    isConnecting,
  } = useStableRoom(voiceActive ? roomId : null);

  // Room detail carries the resident Brigade agent id. Same query key as
  // RoomView/Header so react-query dedupes the fetch (no extra round-trip).
  const { data: roomDetail } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });
  const brigadeAgentId = roomDetail?.brigade_agent_id ?? null;

  // Call guards: enable mic + dispatch the resident agent once per connection;
  // wantCall captures the user's intent so only this surface initiates connect.
  const micEnabledOnConnect = useRef(false);
  const agentDispatched = useRef(false);
  const wantCall = useRef(false);

  // Drive connect once the hook re-arms with a real roomId (voiceActive true).
  useEffect(() => {
    if (
      wantCall.current &&
      voiceActive &&
      roomId &&
      !isConnected &&
      !isConnecting
    ) {
      void lkConnect();
    }
  }, [voiceActive, roomId, isConnected, isConnecting, lkConnect]);

  // On connect: publish the human's mic on the SAME room instance lkConnect()
  // connected, and dispatch the room's resident Brigade agent into the call.
  useEffect(() => {
    if (!isConnected || !lkRoom) {
      if (!isConnected) {
        micEnabledOnConnect.current = false;
        agentDispatched.current = false;
      }
      return;
    }
    if (!micEnabledOnConnect.current) {
      micEnabledOnConnect.current = true;
      void lkRoom.localParticipant
        .setMicrophoneEnabled(true)
        .catch((err) => {
          console.error("failed to enable microphone on call start", err);
        });
    }
    if (!agentDispatched.current && roomId && brigadeAgentId) {
      agentDispatched.current = true;
      // A failed agent dispatch must never break the human's call.
      void api.inviteBrigadeAgent(roomId, brigadeAgentId).catch((err) => {
        console.error("failed to dispatch agent into voice call", err);
      });
    }
  }, [isConnected, lkRoom, roomId, brigadeAgentId]);

  // Brigade roster — all 22 personas. Fetched once, cached in react-query.
  // We let users @mention any agent regardless of room membership; the agent
  // can then be invited explicitly via the picker if they're not already in.
  const { data: brigadeAgents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
  });

  const mentionSuggestions: MentionSuggestion[] = useCallback(() => {
    const q = mentionQuery.toLowerCase();
    const humanSuggestions: MentionSuggestion[] = participants
      .filter((p) => p.display_name.toLowerCase().includes(q))
      .map((p) => ({
        id: p.user_id || p.participant_id || "",
        name: p.display_name,
        type: "human" as const,
      }));

    // Brigade ids are slugs (col-finance, sql-analyst). Match q against both
    // id and human-readable name so "@col" finds "Col. Finance" and "@sql".
    const agentSuggestions: MentionSuggestion[] = brigadeAgents
      .filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q),
      )
      .slice(0, 8)
      .map((a) => ({ id: a.id, name: a.id, type: "agent" as const }));

    return [...agentSuggestions, ...humanSuggestions];
  }, [mentionQuery, participants, brigadeAgents])();

  useEffect(() => {
    adjustHeight();
  }, [content]);

  // Persist draft per room. Restoring on switch is handled by re-mounting:
  // when roomId changes the parent ChatPanel keys MessageInput by roomId,
  // so this component remounts and useState's lazy init reads the new draft.
  useEffect(() => {
    saveDraft(roomId, content);
  }, [roomId, content]);

  // Re-load draft when the room changes (covers same-component reuse).
  useEffect(() => {
    setContent(getDraft(roomId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Quote-reply: another component can request text be inserted into this
  // input. We poll the store on a short interval — cheap, no subscription
  // tangles — and consume the slot when we see something for our roomId.
  const pendingInsert = useAppStore((s) => s.pendingInsert);
  useEffect(() => {
    if (!pendingInsert || pendingInsert.roomId !== roomId) return;
    const text = useAppStore.getState().consumeInsert(roomId);
    if (!text) return;
    setContent((prev) => (prev ? prev + "\n" + text : text));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [pendingInsert, roomId]);

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
    const emojiMatch = textBeforeCursor.match(/:([a-z0-9_+\-]{2,})$/i);

    if (mentionMatch) {
      setShowMentions(true);
      setMentionQuery(mentionMatch[1] ?? "");
      setMentionIndex(0);
      setShowEmojiPicker(false);
    } else if (emojiMatch) {
      setShowEmojiPicker(true);
      setEmojiQuery(emojiMatch[1] ?? "");
      setEmojiIndex(0);
      setShowMentions(false);
    } else {
      setShowMentions(false);
      setMentionQuery("");
      setShowEmojiPicker(false);
      setEmojiQuery("");
    }
  }

  function insertEmoji(suggestion: { name: string; emoji: string }) {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textBeforeCursor = content.slice(0, cursorPos);
    const colonIdx = textBeforeCursor.lastIndexOf(":");
    if (colonIdx === -1) return;
    const before = content.slice(0, colonIdx);
    const after = content.slice(cursorPos);
    const next = `${before}${suggestion.emoji}${after}`;
    setContent(next);
    setShowEmojiPicker(false);
    setEmojiQuery("");
    requestAnimationFrame(() => {
      const pos = before.length + suggestion.emoji.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
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
    // Cmd+Up (or plain Up on empty) → edit last own message.
    if (
      e.key === "ArrowUp" &&
      !showEmojiPicker &&
      !showMentions &&
      content.trim() === "" &&
      onEditLast
    ) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (showEmojiPicker && emojiMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEmojiIndex((p) => (p < emojiMatches.length - 1 ? p + 1 : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEmojiIndex((p) => (p > 0 ? p - 1 : emojiMatches.length - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const sel = emojiMatches[emojiIndex];
        if (sel) insertEmoji(sel);
        return;
      }
      if (e.key === "Escape") {
        setShowEmojiPicker(false);
        return;
      }
    }
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
    if (!trimmed && pending.length === 0) return;

    // Slash command preprocessing — see SLASH_HELP for the catalog.
    const cmd = applySlashCommand(trimmed);
    if (cmd.text === null) {
      setContent("");
      requestAnimationFrame(() => adjustHeight());
      return;
    }
    // Replace :shortcode: emoji on send so the network only sees the rendered
    // glyph (and other clients display correctly without our dictionary).
    const transformed = replaceEmojiShortcodes(cmd.text);

    onSend(
      transformed,
      undefined,
      pending.length ? pending : undefined,
      cmd.metadata,
    );
    setContent("");
    clearDraft(roomId);
    setPending([]);
    setShowMentions(false);
    setShowEmojiPicker(false);
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
      void uploadFiles(files);
    }
  }

  function handleFileSelect() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      void uploadFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function uploadFiles(files: File[]) {
    setUploading(true);
    try {
      for (const f of files) {
        const att = await api.uploadFile(f);
        setPending((p) => [...p, att]);
      }
    } catch (err) {
      console.error("upload failed", err);
      alert((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  }

  function removePending(index: number) {
    setPending((p) => p.filter((_, i) => i !== index));
  }

  function handleStartCall() {
    if (isConnected || isConnecting) return;
    // Capture intent + arm the hook. The connect-arming effect calls
    // lkConnect() once the hook re-renders with the real roomId; the
    // mic-publish + agent-dispatch effect fires when the call connects.
    wantCall.current = true;
    setVoiceActive(true);
  }

  return (
    <div
      className={clsx(
        "relative shrink-0 border-t border-slate-700/50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        dragOver && "bg-stable-purple/5 ring-2 ring-inset ring-stable-purple/30",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showEmojiPicker && emojiMatches.length > 0 && (
        <div
          className="glass absolute bottom-full left-4 z-30 mb-1 max-h-48 w-72 overflow-y-auto rounded-xl p-1 shadow-xl animate-slide-up"
          role="listbox"
          aria-label="Emoji suggestions"
        >
          {emojiMatches.map((s, idx) => (
            <button
              key={s.name}
              role="option"
              aria-selected={idx === emojiIndex}
              onClick={() => insertEmoji(s)}
              onMouseEnter={() => setEmojiIndex(idx)}
              className={clsx(
                "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left",
                idx === emojiIndex
                  ? "bg-stable-purple/15 text-slate-100"
                  : "text-slate-300 hover:bg-slate-800/60",
              )}
            >
              <span className="text-base">{s.emoji}</span>
              <span className="text-xs text-slate-400">:{s.name}:</span>
            </button>
          ))}
        </div>
      )}

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

      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
            >
              {a.content_type.startsWith("image/") ? (
                <img
                  src={a.url}
                  alt={a.filename}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip className="h-3.5 w-3.5 text-slate-400" />
              )}
              <span className="max-w-[16ch] truncate">{a.filename}</span>
              <button
                onClick={() => removePending(i)}
                className="ml-1 text-slate-500 hover:text-slate-300"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </div>
          ))}
          {uploading && (
            <div className="flex items-center gap-1.5 rounded-md bg-slate-800/60 px-2 py-1 text-xs text-slate-400">
              Uploading…
            </div>
          )}
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
            onPaste={handlePaste}
            placeholder="Type a message, paste images, or drop files…"
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
