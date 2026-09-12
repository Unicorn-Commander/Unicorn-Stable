import { CALL_KIND_LABEL, type CallKind } from "@/lib/callEntry";
import { residentAgentIds } from "@/services/api";
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
  Video,
  BellOff,
} from "lucide-react";
import clsx from "clsx";
import { EmojiPicker } from "@/components/EmojiPicker";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useCallUiStore } from "@/stores/callUiStore";
import { useDirectCall } from "@/hooks/useDirectCall";
import { emojiSuggestions, ensureEmojiIndex, replaceEmojiShortcodes } from "@/utils/emoji";
import { clearDraft, getDraft, saveDraft } from "@/utils/drafts";
import { FormatToolbar, type FormatKind } from "./FormatToolbar";

/** Rough width of the format bar (6 icon buttons + padding) used to clamp its
 * left offset so it can't overflow the composer on long lines. */
const FORMAT_BAR_WIDTH = 200;

// Touch devices get the native selection callout — our floating format bar
// would collide with it (iOS draws its own bar over the same selection).
const isCoarsePointer =
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Pixel coordinates of the caret at `position` within a textarea, relative to
 * the textarea's own box. Measured with a hidden mirror element that copies the
 * textarea's typography + padding — the standard technique for anchoring UI to
 * a caret, since the DOM exposes no direct caret rect for form controls. Used
 * only to place the floating format bar over the current selection.
 */
function measureCaret(
  el: HTMLTextAreaElement,
  position: number,
): { top: number; left: number } {
  const div = document.createElement("div");
  const style = div.style;
  const computed = window.getComputedStyle(el);
  const props = [
    "width",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "font-family",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-indent",
    "text-transform",
    "word-spacing",
    "tab-size",
  ];
  for (const p of props) style.setProperty(p, computed.getPropertyValue(p));
  // getComputedStyle width is the content-box width, so mirror as content-box
  // and let the copied padding/border reproduce the internal text offset.
  style.boxSizing = "content-box";
  style.position = "absolute";
  style.top = "0";
  style.left = "0";
  style.visibility = "hidden";
  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";
  style.height = "auto";

  div.textContent = el.value.slice(0, position);
  const span = document.createElement("span");
  // A non-empty marker keeps layout at end-of-text / on a blank line.
  span.textContent = el.value.slice(position) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  document.body.removeChild(div);
  return { top, left };
}

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
    case "research":
      // Ask this room's agent to run deep web research via Center Deep and
      // cite its sources. The agent surfaces a "🔬 Researching…" status while
      // the cdr_deep_research tool runs. Purely a framed message — no special
      // backend path; the research metadata is forward-compat and inert today.
      if (!rest) {
        useAppStore.getState().pushToast({
          title: "Usage: /research <question>",
          body: "Runs deep web research with citations via Center Deep.",
          kind: "info",
        });
        return { text: null };
      }
      return {
        text: `🔬 Research request: ${rest}\n\nPlease run deep web research and cite your sources.`,
        metadata: { research: { mode: "deep" } },
      };
    case "facilitate":
    case "team":
      // Ask the room's orchestrator to route this to the right specialist,
      // who then answers in-room as itself (see backend facilitator). Best in
      // a DM with an orchestrator (Majik / GFlow / The General). The
      // `facilitate` flag rides in metadata; the text is just the question.
      if (!rest) {
        useAppStore.getState().pushToast({
          title: "Usage: /facilitate <question>",
          body: "Your orchestrator routes it to the best specialist, who answers here.",
          kind: "info",
        });
        return { text: null };
      }
      return { text: rest, metadata: { facilitate: true } };
    case "council":
      // Answer under several models in parallel and synthesize one reply
      // (backend council.py). The `council` flag rides in metadata; the text
      // is just the question. Best in a DM with an agent.
      if (!rest) {
        useAppStore.getState().pushToast({
          title: "Usage: /council <question>",
          body: "Several models answer in parallel, then one synthesis is posted.",
          kind: "info",
        });
        return { text: null };
      }
      return { text: rest, metadata: { council: true } };
    case "poll": {
      const poll = parsePoll(rest);
      if (!poll) {
        useAppStore.getState().pushToast({
          title: 'Usage: /poll "Question?" option1 option2…',
          body: "Use double-quotes for multi-word options.",
          kind: "info",
        });
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
  { name: "research", args: "<question>", description: "Deep web research with citations (Center Deep)" },
  { name: "facilitate", args: "<question>", description: "Orchestrator routes to the best specialist" },
  { name: "council", args: "<question>", description: "Several models answer + synthesis" },
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

/** An attach-time upload in flight (or failed). Completed uploads leave this
 * list and land in `pending` as a normal attachment chip. */
interface UploadTask {
  id: number;
  file: File;
  /** 0–1 fraction from the XHR upload progress events. */
  progress: number;
  status: "uploading" | "error";
}

export function MessageInput({ roomId, onSend, onTyping, onEditLast, disabledReason, placeholder }: MessageInputProps) {
  const [content, setContent] = useState(() => getDraft(roomId));
  const [dragOver, setDragOver] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  // AbortControllers for in-flight uploads, keyed by UploadTask.id. Kept in a
  // ref (not state) — aborting must not depend on a render cycle.
  const uploadControllersRef = useRef(new Map<number, AbortController>());
  const uploadIdRef = useRef(0);
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
  // Floating markdown format bar — anchored (top/left px, relative to the
  // textarea wrapper) over the current selection, null when hidden.
  const [formatBar, setFormatBar] = useState<{ top: number; left: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPanelRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Same guard as ThreadPanel.tsx:31-37 — focus only on pointer devices so
    // touch doesn't pop the keyboard on room open. Remounts per room via
    // AppShell's keyed boundary, so [] deps fire on every room switch.
    if (window.matchMedia("(hover: hover)").matches) {
      textareaRef.current?.focus();
    }
  }, []);

  // Close the emoji picker on click-outside (clicks on the toggle button are
  // its own concern — it flips the state itself).
  useEffect(() => {
    if (!showEmojiPanel) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (
        emojiPanelRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target)
      ) {
        return;
      }
      setShowEmojiPanel(false);
    }
    // touchstart too: on touch a scroll/drag gesture never produces a
    // mousedown, so without it the panel only dismisses on a full tap.
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [showEmojiPanel]);

  // Warm the emoji shortcode index (async chunk) so the : autocomplete has
  // the full derived set by the time the user types, not just legacy codes.
  useEffect(() => {
    void ensureEmojiIndex();
  }, []);

  // Abort any in-flight uploads when the composer unmounts (room switch).
  useEffect(() => {
    const controllers = uploadControllersRef.current;
    return () => {
      controllers.forEach((c) => c.abort());
      controllers.clear();
    };
  }, []);

  const participants = useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  // The active call's room (persists across navigation). Start-call keys off
  // THIS rather than the global "in a call" flag, so the button correctly shows
  // in every room except the one that already owns the live call.
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  // Shared call (VoiceProvider): tapping the phone/mic just calls connect();
  // mic publish + agent dispatch + audio playback all happen in the provider.
  const { isConnected, isConnecting } = useStableRoom();
  // The START-a-call seam: a DM rings the person, a channel just joins.
  const { startCall } = useDirectCall();
  const callRoom = useAppStore((s) => s.rooms.find((room) => room.id === roomId));
  const quietJoin = callRoom?.type === "group_dm" || (callRoom?.type === "dm" && residentAgentIds(callRoom).length > 0);

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

  // Re-measure when the textarea's size context changes (rotation, keyboard-
  // driven shell resize, side-panel open/close): a width change re-wraps the
  // text, so the px height stamped for the OLD width goes stale, and the
  // viewport-aware cap in adjustHeight needs the fresh height.
  //
  // Two bindings on purpose: the composer row is shrink-0, so when the
  // keyboard shrinks the shell the message list absorbs ALL of it and the
  // wrapper's own box never resizes — the ResizeObserver alone would miss
  // keyboard show/hide, leaving an already-tall composer un-clamped exactly
  // when the 35%-of-viewport cap matters. visualViewport resize covers that;
  // the observer covers width-driven re-wraps (rotation, panel toggles).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onResize = () => adjustHeight();
    window.visualViewport?.addEventListener("resize", onResize);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(el.parentElement ?? el);
    }
    return () => {
      window.visualViewport?.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  // Persist draft per room. Restoring on switch is handled by re-mounting:
  // when roomId changes the parent ChatPanel keys MessageInput by roomId,
  // so this component remounts and useState's lazy init reads the new draft.
  useEffect(() => {
    saveDraft(roomId, content);
  }, [roomId, content]);

  // Re-load draft when the room changes (covers same-component reuse).
  useEffect(() => {
    setContent(getDraft(roomId));
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
    // Viewport-aware cap: with the keyboard open a small iPhone's shell is only
    // ~250-330px tall, so a fixed 160px composer would eat the whole chat.
    const maxH = Math.min(
      160,
      Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.35),
    );
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);
    onTyping();

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    const emojiMatch = textBeforeCursor.match(/:([a-z0-9_+-]{2,})$/i);
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

  /**
   * Wrap the current selection (or the caret) in markdown, routed THROUGH the
   * controlled `setContent` so drafts + auto-grow stay consistent, then restore
   * the selection: around the wrapped text, or between empty markers when there
   * was no selection. Only emits markdown MessageBubble actually renders.
   */
  function applyFormat(kind: FormatKind) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end);
    const before = content.slice(0, start);
    const after = content.slice(end);

    let next: string;
    let selStart: number;
    let selEnd: number;

    if (kind === "codeblock") {
      // Triple-backtick fence on its own lines; add a break only where the
      // surrounding text would otherwise run into the fence.
      const open = (before && !before.endsWith("\n") ? "\n" : "") + "```\n";
      const close = "\n```" + (after && !after.startsWith("\n") ? "\n" : "");
      next = before + open + selected + close + after;
      selStart = before.length + open.length;
      selEnd = selStart + selected.length;
    } else if (kind === "blockquote") {
      // Prefix "> " to every line the selection touches — or the whole current
      // line when the selection is collapsed.
      const lineStart = before.lastIndexOf("\n") + 1;
      const nlAfter = content.indexOf("\n", end);
      const regionEnd = nlAfter === -1 ? content.length : nlAfter;
      const head = content.slice(0, lineStart);
      const tail = content.slice(regionEnd);
      const region = content.slice(lineStart, regionEnd);
      const quoted = region
        .split("\n")
        .map((ln) => (ln.startsWith("> ") ? ln : `> ${ln}`))
        .join("\n");
      next = head + quoted + tail;
      selStart = head.length;
      selEnd = head.length + quoted.length;
    } else {
      const marker =
        kind === "bold" ? "**" : kind === "italic" ? "*" : kind === "strike" ? "~~" : "`";
      next = before + marker + selected + marker + after;
      selStart = start + marker.length;
      selEnd = selStart + selected.length;
    }

    setContent(next);
    onTyping();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  /**
   * Track the textarea selection and drive the floating format bar. Shown only
   * for a non-empty selection, and never while an autocomplete menu is open —
   * so it can't collide with the mention/slash/emoji popovers.
   */
  function syncFormatBar() {
    if (isCoarsePointer) {
      setFormatBar(null);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (
      start === end ||
      showMentions ||
      showEmojiPicker ||
      showSlashMenu ||
      showEmojiPanel
    ) {
      setFormatBar(null);
      return;
    }
    const coords = measureCaret(el, start);
    const maxLeft = Math.max(4, el.clientWidth - FORMAT_BAR_WIDTH);
    setFormatBar({
      top: coords.top - el.scrollTop,
      left: Math.min(Math.max(4, coords.left), maxLeft),
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Markdown shortcuts (Discord/OpenWebUI): ⌘/Ctrl+B/I/E wrap the selection
    // (or drop empty markers with the caret between them). Meta/ctrl-gated, so
    // they never interfere with typing, Enter=send, or the menu nav keys below.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "e") {
        e.preventDefault();
        applyFormat(k === "b" ? "bold" : k === "i" ? "italic" : "code");
        return;
      }
    }
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

    // On touch keyboards there is no Shift+Enter, so Enter must insert a
    // newline (the Send button sends). Desktop keeps Enter-to-send.
    if (e.key === "Enter" && !e.shiftKey && !isCoarsePointer) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = content.trim();
    if (!trimmed && pending.length === 0) return;
    // Attachments upload on attach; hold the send until they've all landed so
    // a message never goes out silently missing an in-flight file.
    if (uploads.some((t) => t.status === "uploading")) return;

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
    setFormatBar(null);
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
      uploadFiles(files);
    }
  }

  function handleFileSelect() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      uploadFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  /** Kick off one attach-time upload with live progress. On success the task
   * chip is swapped for a normal pending-attachment chip; on failure it turns
   * red with a Retry affordance; aborting (the chip's ×) drops it silently. */
  const startUpload = (file: File) => {
    const id = ++uploadIdRef.current;
    const controller = new AbortController();
    uploadControllersRef.current.set(id, controller);
    setUploads((u) => [...u, { id, file, progress: 0, status: "uploading" }]);
    api
      .uploadFile(file, {
        signal: controller.signal,
        onProgress: (fraction) => {
          setUploads((u) =>
            u.map((t) => (t.id === id ? { ...t, progress: fraction } : t)),
          );
        },
      })
      .then((att) => {
        uploadControllersRef.current.delete(id);
        setUploads((u) => u.filter((t) => t.id !== id));
        setPending((p) => [...p, att]);
      })
      .catch((err: unknown) => {
        uploadControllersRef.current.delete(id);
        if (err instanceof DOMException && err.name === "AbortError") {
          // Cancelled from the chip (or unmount) — nothing to surface.
          setUploads((u) => u.filter((t) => t.id !== id));
          return;
        }
        console.error("upload failed", err);
        setUploads((u) =>
          u.map((t) => (t.id === id ? { ...t, status: "error" as const } : t)),
        );
      });
  };

  function uploadFiles(files: File[]) {
    for (const f of files) {
      startUpload(f);
    }
  }

  /** Cancel an in-flight upload (aborts the XHR) or dismiss a failed chip. */
  function dismissUpload(id: number) {
    const controller = uploadControllersRef.current.get(id);
    uploadControllersRef.current.delete(id);
    controller?.abort();
    setUploads((u) => u.filter((t) => t.id !== id));
  }

  function retryUpload(id: number) {
    const task = uploads.find((t) => t.id === id);
    if (!task) return;
    setUploads((u) => u.filter((t) => t.id !== id));
    startUpload(task.file);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      uploadFiles(files);
    }
  }

  function removePending(index: number) {
    setPending((p) => p.filter((_, i) => i !== index));
  }

  function handleStartCall(kind: CallKind = "voice") {
    if (isConnecting) return;
    // Already in THIS room's call → nothing to start (the call surface is on
    // screen). Connected to a DIFFERENT room's call → connect() treats this as
    // an explicit call-switch (tear the old one down, join here).
    if (isConnected && activeCallRoomId === roomId) return;
    // DM -> ring the person (and tell me what happened); channel -> plain join.
    // Voice connects straight in; Video turns the camera on (lib/callEntry).
    void startCall(roomId, { kind });
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
  // would actually do something (text or pending attachments) — and dims
  // while attachments are still uploading (handleSend blocks then too).
  const uploadsInFlight = uploads.some((t) => t.status === "uploading");
  const canSend =
    (content.trim().length > 0 || pending.length > 0) && !uploadsInFlight;

  return (
    <div
      className={clsx(
        "relative min-w-0 shrink-0 px-2 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-3 md:px-6",
        dragOver && "bg-stable-purple/5 ring-2 ring-inset ring-stable-purple/30",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* The composer shares the message column's measure. It used to span the
          full content width (1307px beside an 832px message column at 1904px
          viewport), so the input visibly overhung the conversation above it —
          two different documents stacked. `relative` moves with it so the
          emoji/slash popovers anchor to the column, not the viewport edge. */}
      <div className="relative mx-auto w-full max-w-[52rem]">
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

      {(pending.length > 0 || uploads.length > 0) && (
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
                className="ml-1 inline-flex min-h-9 min-w-9 items-center justify-center rounded text-slate-500 transition-colors touch-manipulation hover:text-rose-400 focus-ring md:min-h-0 md:min-w-0"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </div>
          ))}
          {uploads.map((t) => (
            <div
              key={`upload-${t.id}`}
              className={clsx(
                "relative flex items-center gap-2 overflow-hidden rounded-lg border px-2 py-1 text-xs",
                t.status === "error"
                  ? "border-rose-400/40 bg-rose-400/[0.06] text-rose-300"
                  : "border-line bg-surface-2 text-slate-300",
              )}
            >
              <Paperclip
                className={clsx(
                  "h-3.5 w-3.5",
                  t.status === "error" ? "text-rose-400" : "text-slate-400",
                )}
              />
              <span className="max-w-[16ch] truncate">{t.file.name}</span>
              {t.status === "uploading" ? (
                <span className="tabular-nums text-slate-500">
                  {Math.round(t.progress * 100)}%
                </span>
              ) : (
                <button
                  onClick={() => retryUpload(t.id)}
                  className="inline-flex min-h-9 items-center rounded px-1 font-medium text-rose-300 underline-offset-2 transition-colors touch-manipulation hover:text-rose-200 hover:underline focus-ring md:min-h-0 md:px-0"
                  aria-label={`Retry uploading ${t.file.name}`}
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => dismissUpload(t.id)}
                className="ml-1 inline-flex min-h-9 min-w-9 items-center justify-center rounded text-slate-500 transition-colors touch-manipulation hover:text-rose-400 focus-ring md:min-h-0 md:min-w-0"
                aria-label={
                  t.status === "uploading"
                    ? `Cancel upload of ${t.file.name}`
                    : `Dismiss ${t.file.name}`
                }
              >
                ×
              </button>
              {t.status === "uploading" && (
                <div
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.08]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(t.progress * 100)}
                  aria-label={`Uploading ${t.file.name}`}
                >
                  {/* Width transition only — safe under prefers-reduced-motion. */}
                  <div
                    className="h-full bg-stable-purple transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.round(t.progress * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex min-w-0 items-end gap-0.5 rounded-2xl border border-line bg-stable-glass px-1 py-1.5 shadow-soft backdrop-blur-xl transition focus-within:border-stable-purple/50 focus-within:ring-2 focus-within:ring-stable-purple/15 sm:gap-1 sm:px-1.5">
        <div className="flex shrink-0 items-center pb-0.5 sm:gap-0.5 sm:pb-1">
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
            onSelect={syncFormatBar}
            onScroll={syncFormatBar}
            onBlur={() => setFormatBar(null)}
            placeholder={placeholder ?? "Type a message, paste images, or drop files…"}
            rows={1}
            className="w-full resize-none bg-transparent px-1.5 py-2.5 pr-11 text-base text-slate-100 placeholder:text-slate-500 outline-none sm:px-2.5 md:pr-10 md:text-sm"
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

          {/* Selection format bar — gated off whenever an autocomplete menu is
              open so the two popovers can never overlap. */}
          {formatBar &&
            !showMentions &&
            !showEmojiPicker &&
            !showSlashMenu &&
            !showEmojiPanel && (
              <FormatToolbar position={formatBar} onFormat={applyFormat} />
            )}
        </div>

        {/* One tap per verb, on every screen size: Video call, Voice call —
            both connect immediately (lib/callEntry). Rooms whose call would
            ring people also get "join without ringing" as its own button
            instead of hiding all three behind a menu. */}
        {activeCallRoomId !== roomId && !isConnecting && (
          <>
            {quietJoin && (
              <button
                onClick={() => void startCall(roomId, { kind: "voice", ring: false })}
                className="shrink-0 rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-stable-mint focus-ring md:p-1.5 md:pb-2.5"
                aria-label="Join without ringing"
                title="Join the call without ringing anyone"
                data-testid="composer-quiet-join"
              >
                <BellOff className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => handleStartCall("video")}
              className="shrink-0 rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-stable-mint focus-ring md:p-1.5 md:pb-2.5"
              aria-label={
                isConnected ? "Move the call here as a video call" : CALL_KIND_LABEL.video
              }
              title={
                isConnected ? "Move the call here as a video call" : CALL_KIND_LABEL.video
              }
              data-testid="composer-video-call"
            >
              <Video className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleStartCall("voice")}
              className="shrink-0 rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-stable-mint focus-ring md:p-1.5 md:pb-2.5"
              aria-label={
                isConnected ? "Move the call to this room" : CALL_KIND_LABEL.voice
              }
              title={
                isConnected ? "Move the call to this room" : CALL_KIND_LABEL.voice
              }
              data-testid="composer-voice-call"
            >
              <Phone className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

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
