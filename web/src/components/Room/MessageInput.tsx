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
  Phone,
  AtSign,
  MicOff,
  Smile,
} from "lucide-react";
import clsx from "clsx";
import { EmojiPicker } from "@/components/EmojiPicker";
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

/** Composer autocomplete catalog. Must stay in sync with applySlashCommand
 * above (and the cheatsheet in CheatsheetModal) — list only commands that
 * are actually implemented. */
interface SlashCommandInfo {
  name: string;
  /** Argument hint shown after the name; empty when the command takes none. */
  args: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "me", args: "<action>", description: "Italic narration" },
  { name: "shrug", args: "[message]", description: "Append ¯\\_(ツ)_/¯" },
  { name: "tableflip", args: "[message]", description: "Append (╯°□°）╯︵ ┻━┻" },
  { name: "unflip", args: "[message]", description: "Append ┬─┬ ノ( ゜-゜ノ)" },
  { name: "agent", args: "<id> …", description: "Explicit agent mention" },
  { name: "poll", args: '"Question?" option1 option2 …', description: "Inline poll with vote buttons" },
  { name: "help", args: "", description: "Open the shortcuts cheatsheet" },
];

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
  /** When set, the composer is replaced by this notice (e.g. the user is
   * muted in this room). Posting is also blocked server-side. */
  disabledReason?: string;
  /** Room-aware placeholder, e.g. "Message #general" / "Message Majik". */
  placeholder?: string;
}

interface MentionSuggestion {
  id: string;
  name: string;
  type: "human" | "agent";
}

export function MessageInput({ roomId, onSend, onTyping, onEditLast, disabledReason, placeholder }: MessageInputProps) {
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
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = SLASH_COMMANDS.filter((c) =>
    c.name.startsWith(slashQuery.toLowerCase()),
  );
  // Full emoji picker popover (Smile button) — distinct from the
  // :shortcode: suggestion menu above (showEmojiPicker).
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPanelRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  // Close the emoji picker on click-outside (clicks on the toggle button are
  // its own concern — it flips the state itself).
  useEffect(() => {
    if (!showEmojiPanel) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        emojiPanelRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target)
      ) {
        return;
      }
      setShowEmojiPanel(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [showEmojiPanel]);

  const participants = useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  const voiceActive = useAppStore((s) => s.voiceActive);
  // Shared call (VoiceProvider): tapping the phone/mic just calls connect();
  // mic publish + agent dispatch + audio playback all happen in the provider.
  const {
    connect: lkConnect,
    isConnected,
    isConnecting,
  } = useStableRoom();

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
    // Slash commands are only recognized at position 0 (applySlashCommand
    // does the same). Once a space/newline is typed the menu closes and the
    // message sends literally — matching /help still works on send.
    const slashMatch = value.match(/^\/([a-zA-Z]*)$/);

    if (slashMatch) {
      setShowSlashMenu(true);
      setSlashQuery(slashMatch[1] ?? "");
      setSlashIndex(0);
      setShowMentions(false);
      setShowEmojiPicker(false);
    } else if (mentionMatch) {
      setShowMentions(true);
      setMentionQuery(mentionMatch[1] ?? "");
      setMentionIndex(0);
      setShowEmojiPicker(false);
      setShowSlashMenu(false);
    } else if (emojiMatch) {
      setShowEmojiPicker(true);
      setEmojiQuery(emojiMatch[1] ?? "");
      setEmojiIndex(0);
      setShowMentions(false);
      setShowSlashMenu(false);
    } else {
      setShowMentions(false);
      setMentionQuery("");
      setShowEmojiPicker(false);
      setEmojiQuery("");
      setShowSlashMenu(false);
      setSlashQuery("");
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

  /** Full-picker insertion: splice the emoji at the textarea's cursor
   * (replacing any selection), then restore focus with the cursor placed
   * right after it. The textarea keeps its selection offsets even while the
   * picker's search input has focus, so this works mid-message. */
  function insertEmojiAtCursor(emoji: string) {
    const el = textareaRef.current;
    if (!el) {
      setContent((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? start;
    const next = content.slice(0, start) + emoji + content.slice(end);
    setContent(next);
    onTyping();
    requestAnimationFrame(() => {
      const pos = start + emoji.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function insertSlashCommand(cmd: SlashCommandInfo) {
    const el = textareaRef.current;
    if (!el) return;
    // The menu only shows while the entire input is "/query", so replacing
    // the whole content is safe. Trailing space closes the menu and lets the
    // user type arguments immediately.
    const next = `/${cmd.name} `;
    setContent(next);
    setShowSlashMenu(false);
    setSlashQuery("");
    requestAnimationFrame(() => {
      el.setSelectionRange(next.length, next.length);
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
    // Esc closes the full emoji picker even when focus is back in the
    // textarea (picking an emoji returns focus here while the panel stays
    // open for multi-pick).
    if (e.key === "Escape" && showEmojiPanel) {
      setShowEmojiPanel(false);
      return;
    }
    // Cmd+Up (or plain Up on empty) → edit last own message.
    if (
      e.key === "ArrowUp" &&
      !showEmojiPicker &&
      !showMentions &&
      !showSlashMenu &&
      content.trim() === "" &&
      onEditLast
    ) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (showSlashMenu && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((p) => (p < slashMatches.length - 1 ? p + 1 : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((p) => (p > 0 ? p - 1 : slashMatches.length - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const sel = slashMatches[slashIndex];
        if (sel) insertSlashCommand(sel);
        return;
      }
      if (e.key === "Escape") {
        setShowSlashMenu(false);
        return;
      }
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

    // Slash command preprocessing — see SLASH_COMMANDS for the catalog.
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
    setShowEmojiPanel(false);
    setShowSlashMenu(false);
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
    void lkConnect();
  }

  if (disabledReason) {
    return (
      <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-300/80">
          <MicOff className="h-4 w-4 shrink-0 text-amber-300/80" />
          <span>{disabledReason}</span>
        </div>
      </div>
    );
  }

  // Purely presentational: the send affordance lights up whenever a send
  // would actually do something (text or pending attachments).
  const canSend = content.trim().length > 0 || pending.length > 0;

  return (
    <div
      className={clsx(
        "relative shrink-0 px-3 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6",
        dragOver && "bg-stable-purple/5 ring-2 ring-inset ring-stable-purple/30",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showEmojiPanel && (
        <div
          ref={emojiPanelRef}
          className="absolute bottom-full left-3 z-30 mb-2 md:left-6"
        >
          <EmojiPicker
            onPick={insertEmojiAtCursor}
            onClose={() => {
              setShowEmojiPanel(false);
              textareaRef.current?.focus();
            }}
          />
        </div>
      )}

      {showSlashMenu && slashMatches.length > 0 && (
        <div
          className="glass-heavy absolute bottom-full left-3 right-3 z-30 mb-2 max-h-48 overflow-y-auto rounded-xl p-1 shadow-pop animate-slide-up md:left-6 md:right-6"
          role="listbox"
          aria-label="Slash command suggestions"
        >
          {slashMatches.map((cmd, idx) => (
            <button
              key={cmd.name}
              role="option"
              aria-selected={idx === slashIndex}
              onClick={() => insertSlashCommand(cmd)}
              onMouseEnter={() => setSlashIndex(idx)}
              className={clsx(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors focus-ring",
                idx === slashIndex
                  ? "bg-stable-purple/15 text-slate-100"
                  : "text-slate-300 hover:bg-white/[0.05]",
              )}
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stable-purple/20 text-xs font-semibold text-stable-purple-light">
                /
              </div>
              <span className="text-sm font-medium">/{cmd.name}</span>
              {cmd.args && (
                <span className="truncate text-xs text-slate-500">{cmd.args}</span>
              )}
              <span className="ml-auto shrink-0 truncate text-xs text-slate-400">
                {cmd.description}
              </span>
            </button>
          ))}
        </div>
      )}

      {showEmojiPicker && emojiMatches.length > 0 && (
        <div
          className="glass-heavy absolute bottom-full left-3 z-30 mb-2 max-h-48 w-72 overflow-y-auto rounded-xl p-1 shadow-pop animate-slide-up md:left-6"
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
                "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors focus-ring",
                idx === emojiIndex
                  ? "bg-stable-purple/15 text-slate-100"
                  : "text-slate-300 hover:bg-white/[0.05]",
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
          className="glass-heavy absolute bottom-full left-3 right-3 z-30 mb-2 max-h-48 overflow-y-auto rounded-xl p-1 shadow-pop animate-slide-up md:left-6 md:right-6"
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
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors focus-ring",
                idx === mentionIndex
                  ? "bg-stable-purple/15 text-slate-100"
                  : "text-slate-300 hover:bg-white/[0.05]",
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
                <span className="ml-auto rounded-md bg-stable-cyan/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-stable-cyan">
                  AI
                </span>
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
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-slate-200"
            >
              {a.content_type.startsWith("image/") ? (
                <img
                  src={a.url}
                  alt={a.filename}
                  className="h-8 w-8 rounded-md object-cover"
                />
              ) : (
                <Paperclip className="h-3.5 w-3.5 text-slate-400" />
              )}
              <span className="max-w-[16ch] truncate">{a.filename}</span>
              <button
                onClick={() => removePending(i)}
                className="ml-1 rounded text-slate-500 transition-colors hover:text-rose-400 focus-ring"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </div>
          ))}
          {uploading && (
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-slate-400 animate-pulse-soft">
              Uploading…
            </div>
          )}
        </div>
      )}

      <div className="flex items-end gap-1 rounded-2xl border border-line bg-stable-glass px-1.5 py-1.5 shadow-soft backdrop-blur-xl transition focus-within:border-stable-purple/50 focus-within:ring-2 focus-within:ring-stable-purple/15">
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          <button
            onClick={handleFileSelect}
            className="rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:p-1.5"
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
          <button
            ref={emojiButtonRef}
            onClick={() => setShowEmojiPanel((v) => !v)}
            className={clsx(
              "rounded-lg p-2.5 transition-colors hover:bg-white/[0.06] focus-ring md:p-1.5",
              showEmojiPanel
                ? "bg-stable-purple/15 text-stable-purple-light"
                : "text-slate-400 hover:text-slate-100",
            )}
            aria-label="Insert emoji"
            aria-expanded={showEmojiPanel}
            aria-haspopup="dialog"
          >
            <Smile className="h-4 w-4" />
          </button>
        </div>

        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? "Type a message, paste images, or drop files…"}
            rows={1}
            className="w-full resize-none bg-transparent px-2.5 py-2.5 pr-12 text-sm text-slate-100 placeholder:text-slate-500 outline-none md:pr-10"
            aria-label="Message input"
          />

          <button
            onClick={handleSend}
            aria-disabled={!canSend}
            className={clsx(
              "absolute bottom-1.5 right-1.5 rounded-xl p-2.5 transition md:bottom-2 md:right-2 md:p-1.5",
              canSend
                ? "gradient-bg glow-iris text-white hover:opacity-95 active:scale-[0.98]"
                : "border border-line bg-surface-2 text-slate-500",
            )}
            aria-label="Send message"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>

        {!isConnected && !voiceActive && (
          <button
            onClick={handleStartCall}
            className="shrink-0 rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-stable-mint focus-ring md:p-1.5 md:pb-2.5"
            aria-label="Start call"
          >
            <Phone className="h-4 w-4" />
          </button>
        )}
      </div>

      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl border border-dashed border-stable-purple/40 bg-stable-purple/10 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-stable-purple-light">
            <Paperclip className="h-5 w-5" />
            <span className="text-sm font-medium">Drop files to attach</span>
          </div>
        </div>
      )}
    </div>
  );
}
