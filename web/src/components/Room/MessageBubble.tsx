import { useState, useRef, useEffect, createElement } from "react";
import {
  AlertTriangle,
  RotateCw,
  BriefcaseBusiness,
  Copy as CopyIcon,
  Link2,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
  CornerDownRight,
  Smile,
  Pin,
  Quote,
  Bookmark,
  LayoutPanelLeft,
  RefreshCw,
  Square,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict, format } from "date-fns";
import { api, type ApiError, type Message, type ProjectOpsProject } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { Avatar } from "@/components/Avatar";

const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🤔", "✅", "🚀", "👀"];
const PO_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

type ProjectOpsPriority = (typeof PO_PRIORITIES)[number];

function projectOpsMeta(message: Message) {
  return (message.metadata as {
    projectops_task?: {
      id: string;
      project_number: string;
      task_number?: string | null;
      task_url?: string;
    };
  } | undefined)?.projectops_task;
}

/**
 * Reads the canvas-artifact pointer a Majik message carries when it authored an
 * artifact. The backend stamps `metadata.artifact_id` (+ optional
 * `metadata.artifact_title`); returns null when the message isn't tied to one.
 */
function artifactMeta(message: Message): { artifactId: string; artifactTitle: string | null } | null {
  const meta = message.metadata as {
    artifact_id?: string;
    artifact_title?: string;
  } | undefined;
  if (!meta?.artifact_id) return null;
  return { artifactId: meta.artifact_id, artifactTitle: meta.artifact_title ?? null };
}

function defaultTaskTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact || "Command Center message follow-up";
}

function buildDescriptionPreview(message: Message, note: string) {
  const content =
    message.content.length > 2048
      ? `${message.content.slice(0, 2048).trimEnd()}\n\n[Command Center message truncated at 2048 characters]`
      : message.content;
  const permalink = `${window.location.origin}/c/${message.room_id}?message=${message.id}`;
  const parts = [];
  if (note.trim()) {
    parts.push(note.trim(), "");
  }
  parts.push(
    "Command Center source message",
    `Permalink: ${permalink}`,
    `Sender: ${message.sender_name}`,
    `Timestamp: ${message.created_at}`,
    "",
    "Message:",
    content,
  );
  const metadata = { ...message.metadata };
  delete (metadata as { reactions?: unknown }).reactions;
  if (Object.keys(metadata).length > 0) {
    parts.push("", "Metadata:", JSON.stringify(metadata, null, 2));
  }
  return parts.join("\n");
}

function errorMessage(err: unknown) {
  const apiErr = err as ApiError;
  return apiErr?.detail || apiErr?.message || (err instanceof Error ? err.message : "Request failed");
}

// Lazy-import highlight.js so the main bundle stays small. First code block
// in any message triggers the load, then it's cached for the session.
let _hljs: typeof import("highlight.js").default | null = null;
let _hljsLoading: Promise<void> | null = null;
function loadHljs(): Promise<void> {
  if (_hljs) return Promise.resolve();
  if (_hljsLoading) return _hljsLoading;
  _hljsLoading = import("highlight.js").then((m) => {
    _hljs = m.default;
  });
  return _hljsLoading;
}

function CodeBlock({ lang, content }: { lang: string | null; content: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    loadHljs().then(() => {
      if (!active || !_hljs) return;
      try {
        const result =
          lang && _hljs.getLanguage(lang)
            ? _hljs.highlight(content, { language: lang, ignoreIllegals: true })
            : _hljs.highlightAuto(content);
        setHtml(result.value);
      } catch {
        setHtml(null);
      }
    });
    return () => {
      active = false;
    };
  }, [lang, content]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }
  return (
    <div className="group/code relative my-1">
      {/* Hover "Copy" — standard in OpenWebUI/Discord/Slack. The lang chip
          doubles as a label when present. */}
      <button
        onClick={copy}
        className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-slate-800/90 px-1.5 py-1 text-[10px] font-medium text-slate-300 opacity-0 ring-1 ring-slate-700/60 transition-opacity hover:bg-slate-700 hover:text-slate-100 focus:opacity-100 group-hover/code:opacity-100"
        aria-label="Copy code"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-green-400" />
            Copied
          </>
        ) : (
          <>
            <CopyIcon className="h-3 w-3" />
            {lang || "Copy"}
          </>
        )}
      </button>
      <pre className="overflow-x-auto rounded-lg bg-slate-950/80 p-3 text-xs">
        {html ? (
          <code
            className={`hljs ${lang ? `language-${lang}` : ""} text-slate-200`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code className="text-slate-300">{content}</code>
        )}
      </pre>
    </div>
  );
}

function QuickReact({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
        aria-label="Add reaction"
      >
        <Smile className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-1 flex gap-0.5 rounded-lg border border-slate-700/60 bg-slate-900 p-1 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          {QUICK_EMOJI.map((e) => (
            <button
              key={e}
              onClick={async () => {
                setOpen(false);
                try {
                  await api.toggleReaction(messageId, e);
                } catch (err) {
                  console.error("react failed", err);
                }
              }}
              className="rounded px-1 py-0.5 text-base hover:bg-slate-800"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolFooter({ rawHtml }: { rawHtml: string }) {
  // Brigade emits inner HTML with <br>, code, etc. Strip tags and split into
  // bullet items for a clean chip view. Preserves text content.
  const text = rawHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
  const items = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return (
    <details className="mt-2 rounded-md border border-slate-700/60 bg-slate-950/40 p-2 text-xs">
      <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
        🔧 Tools used ({items.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-2 text-slate-300">
        {items.map((it, i) => (
          <li key={i} className="font-mono text-[11px] leading-relaxed">
            {it}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PollCard({
  messageId,
  poll,
  reactions,
}: {
  messageId: string;
  poll: { question: string; options: string[] };
  reactions: Record<string, string[]> | null;
}) {
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  // Encode votes as reaction emojis: 1️⃣ 2️⃣ … so they share storage with
  // normal reactions (no new schema). 10 max options.
  const VOTE_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const totalVotes = poll.options.reduce(
    (sum, _opt, i) => sum + ((reactions?.[VOTE_EMOJI[i]!] ?? []).length),
    0,
  );
  return (
    <div className="my-2 max-w-md rounded-lg border border-stable-purple/30 bg-stable-purple/5 p-3">
      <p className="mb-2 text-sm font-medium text-slate-100">{poll.question}</p>
      <ul className="flex flex-col gap-1.5">
        {poll.options.map((opt, i) => {
          const emoji = VOTE_EMOJI[i]!;
          const voters = reactions?.[emoji] ?? [];
          const mine = currentUserId ? voters.includes(currentUserId) : false;
          const pct = totalVotes > 0 ? Math.round((voters.length / totalVotes) * 100) : 0;
          return (
            <li key={i}>
              <button
                onClick={() => api.toggleReaction(messageId, emoji).catch(() => {})}
                className={clsx(
                  "relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                  mine
                    ? "border-stable-purple bg-stable-purple/20 text-slate-100"
                    : "border-slate-700 text-slate-300 hover:bg-slate-800/60",
                )}
              >
                <span
                  className="absolute inset-y-0 left-0 bg-stable-purple/20"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative">{emoji}</span>
                <span className="relative flex-1 truncate">{opt}</span>
                <span className="relative text-[10px] tabular-nums text-slate-400">
                  {voters.length} ({pct}%)
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] text-slate-500">
        {totalVotes} {totalVotes === 1 ? "vote" : "votes"} · click to vote
      </p>
    </div>
  );
}

function ReactionRow({
  messageId,
  reactions,
}: {
  messageId: string;
  reactions: Record<string, string[]> | null;
}) {
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {Object.entries(reactions).map(([emoji, users]) => {
        const mine = currentUserId ? users.includes(currentUserId) : false;
        return (
          <button
            key={emoji}
            onClick={() => api.toggleReaction(messageId, emoji).catch(() => {})}
            className={clsx(
              "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors",
              mine
                ? "border-stable-purple/60 bg-stable-purple/20 text-stable-purple-light"
                : "border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800",
            )}
            aria-label={`${emoji} ${users.length}`}
          >
            <span>{emoji}</span>
            <span className="text-[10px] tabular-nums">{users.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function PromoteToProjectOpsModal({
  message,
  onClose,
  onPromoted,
}: {
  message: Message;
  onClose: () => void;
  onPromoted: (data: {
    task_id: string;
    project_number: string;
    task_url: string;
    task_number: string | null;
  }) => void;
}) {
  const [projects, setProjects] = useState<ProjectOpsProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectNumber, setProjectNumber] = useState("");
  const [title, setTitle] = useState(defaultTaskTitle(message.content));
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<ProjectOpsPriority>("MEDIUM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingProjects(true);
    api
      .getProjectOpsProjects()
      .then((rows) => {
        if (!active) return;
        setProjects(rows);
        setProjectNumber((current) => current || rows[0]?.projectNumber || "");
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoadingProjects(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const preview = buildDescriptionPreview(message, description);

  async function submit() {
    if (!projectNumber || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.promoteToProjectOpsTask(message.id, {
        project_number: projectNumber,
        title,
        description,
        priority,
      });
      onPromoted(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-lg border border-slate-700/70 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <BriefcaseBusiness className="h-4 w-4 text-stable-purple-light" />
            <h2 className="text-sm font-semibold text-slate-100">
              Promote to Project Ops task
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-4 py-3">
          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Project
            <select
              value={projectNumber}
              onChange={(e) => setProjectNumber(e.target.value)}
              disabled={loadingProjects}
              className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple"
            >
              {loadingProjects && <option>Loading projects...</option>}
              {!loadingProjects && projects.length === 0 && <option>No projects found</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.projectNumber}>
                  {project.projectNumber} - {project.title}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple"
            />
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as ProjectOpsPriority)}
              className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple"
            >
              {PO_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Description note
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="resize-none rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple"
            />
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Description preview
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-950 p-2.5 text-xs font-normal text-slate-300">
              {preview}
            </pre>
          </label>

          {error && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!projectNumber || submitting}
            className="rounded-md bg-stable-purple px-3 py-1.5 text-sm font-medium text-white hover:bg-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onReply: (messageId: string) => void;
  onRetry?: (messageId: string) => Promise<void>;
  /** When this becomes true, the bubble enters edit mode (one-shot rising edge). */
  forceEditTick?: number;
}

export function MessageBubble({
  message,
  isOwn,
  showAvatar,
  onEdit,
  onDelete,
  onReply,
  onRetry,
  forceEditTick,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const promoted = projectOpsMeta(message);
  const artifact = artifactMeta(message);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateMessage = useAppStore((s) => s.updateMessage);

  // Close context menu on any window click or escape.
  useEffect(() => {
    if (!ctxMenu) return;
    function onAway() {
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    window.addEventListener("click", onAway);
    window.addEventListener("contextmenu", onAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onAway);
      window.removeEventListener("contextmenu", onAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);
  const [editing, setEditing] = useState(false);
  const failed = Boolean(
    (message.metadata as { failed?: boolean } | undefined)?.failed,
  );
  const failedError = (message.metadata as { failed_error?: string } | undefined)?.failed_error;
  const [editContent, setEditContent] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.selectionStart = editRef.current.value.length;
    }
  }, [editing]);

  // Cmd+Up trigger from MessageInput — enter edit on rising-edge tick.
  useEffect(() => {
    if (forceEditTick && forceEditTick > 0 && !editing) {
      setEditContent(message.content);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEditTick]);

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

  function handlePromoted(result: {
    task_id: string;
    project_number: string;
    task_url: string;
    task_number: string | null;
  }) {
    const nextMeta = {
      ...message.metadata,
      projectops_task: {
        id: result.task_id,
        project_number: result.project_number,
        task_number: result.task_number,
        task_url: result.task_url,
      },
    };
    updateMessage(message.room_id, message.id, { metadata: nextMeta });
    pushToast({
      title: `Task created: ${result.task_number || result.project_number}`,
      body: result.task_url,
    });
    setPromoteOpen(false);
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

  const isAgent = message.sender_type === "agent";
  // An agent reply that is still being produced. Driven purely by the ws
  // streaming flag (set on the placeholder, cleared on finalize) — NOT the "…"
  // content, so a persisted/crashed placeholder can never strand a Stop pill on
  // a message with no live responder behind it.
  const isGenerating = isAgent && message.streaming === true;

  if (message.content_type === "action") {
    const decision = (
      message.metadata as { decision?: "approved" | "rejected"; decided_by_name?: string } | undefined
    )?.decision;
    const decidedBy = (
      message.metadata as { decided_by_name?: string } | undefined
    )?.decided_by_name;
    return (
      <div className="my-2 flex justify-center px-4">
        <div className="glass max-w-md rounded-xl p-4">
          <div className="mb-3 flex items-start gap-2">
            <Avatar
              name={message.sender_name}
              src={message.sender_avatar}
              size="sm"
              isAgent={isAgent}
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-200">
                {message.sender_name} requests approval
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
                {message.content}
              </p>
            </div>
          </div>
          {decision ? (
            <div
              className={clsx(
                "rounded-md px-3 py-1.5 text-xs font-medium",
                decision === "approved"
                  ? "bg-green-500/15 text-green-300"
                  : "bg-red-500/15 text-red-300",
              )}
            >
              {decision === "approved" ? "✓ Approved" : "✗ Rejected"}
              {decidedBy ? ` by ${decidedBy}` : ""}
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() =>
                  api
                    .decideAction(message.id, "approved")
                    .catch((e) => alert("Approve failed: " + (e as Error).message))
                }
                className="flex-1 rounded-lg bg-green-500/20 py-1.5 text-xs font-medium text-green-400 transition-colors hover:bg-green-500/30"
              >
                Approve
              </button>
              <button
                onClick={() =>
                  api
                    .decideAction(message.id, "rejected")
                    .catch((e) => alert("Reject failed: " + (e as Error).message))
                }
                className="flex-1 rounded-lg bg-red-500/20 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/30"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Detect Brigade's tool-use footer (HTML `<details>` block) and split it
  // off so we can render the body normally and the tools as a styled chip.
  function splitToolsFooter(content: string): { body: string; tools: string | null } {
    const m = content.match(/<details>\s*<summary>(?:🔧|🛠️)?\s*([^<]*)<\/summary>([\s\S]*?)<\/details>/i);
    if (!m) return { body: content, tools: null };
    const before = content.slice(0, m.index ?? 0).trimEnd();
    const after = content.slice((m.index ?? 0) + m[0].length).trimStart();
    return {
      body: (before + (after ? "\n\n" + after : "")).trim(),
      tools: (m[2] ?? "").trim(),
    };
  }

  function renderContent(content: string) {
    // Pull fenced code blocks out first; whatever's left is inline+block markdown.
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
    if (parts.length === 0) parts.push({ type: "text", content });

    return parts.map((part, i) => {
      if (part.type === "code") {
        return <CodeBlock key={i} lang={part.lang ?? null} content={part.content} />;
      }
      return <span key={i}>{renderTextBlock(part.content)}</span>;
    });
  }

  /**
   * Block-level markdown for a chunk of plain text (no fenced code in here).
   * Recognises: # / ## / ### headings, > blockquote, -/* unordered list,
   * 1. ordered list, otherwise paragraph. Inline formatting runs inside each.
   */
  function renderTextBlock(text: string): React.ReactNode {
    const lines = text.split("\n");
    const out: React.ReactElement[] = [];
    let i = 0;
    let key = 0;

    function pushLines(rendered: React.ReactNode[]) {
      out.push(<span key={key++}>{rendered}</span>);
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";

      // Heading
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1]!.length;
        const body = heading[2]!;
        const cls =
          level === 1
            ? "text-base font-bold text-slate-100 mt-1"
            : level === 2
              ? "text-sm font-bold text-slate-100 mt-1"
              : "text-sm font-semibold text-slate-200 mt-1";
        const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
        out.push(
          createElement(
            tag,
            { key: key++, className: cls },
            renderInlineContent(body),
          ),
        );
        i++;
        continue;
      }

      // Blockquote run
      if (line.startsWith("> ") || line === ">") {
        const buf: string[] = [];
        while (
          i < lines.length &&
          (lines[i]!.startsWith("> ") || lines[i] === ">")
        ) {
          buf.push((lines[i]!.replace(/^>\s?/, "")) || "");
          i++;
        }
        out.push(
          <blockquote
            key={key++}
            className="my-1 border-l-2 border-stable-purple/50 pl-2 text-slate-400"
          >
            {buf.map((b, bi) => (
              <span key={bi}>
                {renderInlineContent(b)}
                {bi < buf.length - 1 && <br />}
              </span>
            ))}
          </blockquote>,
        );
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
          items.push(lines[i]!.replace(/^[-*]\s+/, ""));
          i++;
        }
        out.push(
          <ul key={key++} className="my-1 list-disc pl-5 marker:text-slate-500">
            {items.map((it, idx) => (
              <li key={idx}>{renderInlineContent(it)}</li>
            ))}
          </ul>,
        );
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
          items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
          i++;
        }
        out.push(
          <ol key={key++} className="my-1 list-decimal pl-5 marker:text-slate-500">
            {items.map((it, idx) => (
              <li key={idx}>{renderInlineContent(it)}</li>
            ))}
          </ol>,
        );
        continue;
      }

      // Plain line(s)
      const buf: React.ReactNode[] = [];
      while (i < lines.length) {
        const ln = lines[i] ?? "";
        if (
          ln.match(/^(#{1,3})\s+/) ||
          ln.startsWith("> ") || ln === ">" ||
          /^[-*]\s+/.test(ln) ||
          /^\d+\.\s+/.test(ln)
        ) {
          break;
        }
        if (buf.length > 0) buf.push(<br key={`br-${i}`} />);
        buf.push(<span key={`ln-${i}`}>{renderInlineContent(ln)}</span>);
        i++;
      }
      if (buf.length > 0) pushLines(buf);
    }
    return out;
  }

  function renderInlineContent(text: string) {
    // Inline: URL, `code`, **bold**, *italic*/_italic_, ~~strike~~.
    // Build a non-overlapping set of spans, longest-first to win on overlaps.
    const elements: Array<{
      type: "url" | "code" | "bold" | "italic" | "strike" | "mention";
      content: string;
      start: number;
      end: number;
    }> = [];
    const collect = (
      re: RegExp,
      type: "url" | "code" | "bold" | "italic" | "strike" | "mention",
      group: number,
    ) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        elements.push({
          type,
          content: m[group] ?? m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    };
    collect(/(@channel\b|@here\b|@[\w-]+)/g, "mention", 0);
    collect(/(https?:\/\/[^\s]+)/g, "url", 0);
    collect(/`([^`\n]+)`/g, "code", 1);
    collect(/\*\*([^*\n]+)\*\*/g, "bold", 1);
    collect(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "italic", 1);
    collect(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "italic", 1);
    collect(/~~([^~\n]+)~~/g, "strike", 1);

    if (elements.length === 0) return text;

    // Resolve overlaps: prefer earlier start, then larger span.
    elements.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - a.start));
    const filtered: typeof elements = [];
    let lastEnd = -1;
    for (const el of elements) {
      if (el.start >= lastEnd) {
        filtered.push(el);
        lastEnd = el.end;
      }
    }

    const result: Array<string | React.ReactElement> = [];
    let cursor = 0;
    filtered.forEach((el, i) => {
      if (el.start > cursor) result.push(text.slice(cursor, el.start));
      if (el.type === "url") {
        result.push(
          <a
            key={`link-${i}`}
            href={el.content}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stable-cyan underline decoration-stable-cyan/30 hover:text-stable-cyan-light"
          >
            {el.content}
          </a>,
        );
      } else if (el.type === "code") {
        result.push(
          <code
            key={`c-${i}`}
            className="rounded bg-slate-800 px-1 py-0.5 text-xs text-pink-400"
          >
            {el.content}
          </code>,
        );
      } else if (el.type === "bold") {
        result.push(
          <strong key={`b-${i}`} className="font-semibold">
            {el.content}
          </strong>,
        );
      } else if (el.type === "italic") {
        result.push(
          <em key={`i-${i}`} className="italic">
            {el.content}
          </em>,
        );
      } else if (el.type === "strike") {
        result.push(
          <s key={`s-${i}`} className="text-slate-500">
            {el.content}
          </s>,
        );
      } else if (el.type === "mention") {
        const isBroad = el.content === "@channel" || el.content === "@here";
        result.push(
          <span
            key={`m-${i}`}
            className={
              isBroad
                ? "rounded bg-amber-500/20 px-1 py-0.5 font-medium text-amber-300"
                : "rounded bg-stable-purple/20 px-1 py-0.5 font-medium text-stable-purple-light"
            }
          >
            {el.content}
          </span>,
        );
      }
      cursor = el.end;
    });
    if (cursor < text.length) result.push(text.slice(cursor));
    return result;
  }

  return (
    <div
      className={clsx(
        "group relative flex gap-3 rounded-lg px-2 py-1 transition-colors",
        hovered && "bg-slate-800/30",
        !showAvatar && "pl-12",
        failed && "border-l-2 border-red-500/70 bg-red-500/5",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      role="article"
      aria-label={`Message from ${message.sender_name}`}
    >
      {showAvatar && (
        <div className="mt-0.5 shrink-0">
          <Avatar
            name={message.sender_name}
            src={message.sender_avatar}
            size="md"
            isAgent={isAgent}
          />
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
            {promoted && (
              <a
                href={promoted.task_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/20"
                title="Open Project Ops task"
              >
                <BriefcaseBusiness className="h-3 w-3" />
                {promoted.task_number || promoted.project_number}
              </a>
            )}
            {artifact && (
              <button
                type="button"
                onClick={() =>
                  void useCanvasStore.getState().openArtifactById(artifact.artifactId)
                }
                className="inline-flex items-center gap-1 rounded bg-stable-purple/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-purple-light hover:bg-stable-purple/20"
                title={artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              >
                <LayoutPanelLeft className="h-3 w-3" />
                {artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              </button>
            )}
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
            {(() => {
              const split = splitToolsFooter(message.content);
              return (
                <>
                  {renderContent(split.body)}
                  {split.tools && (
                    <ToolFooter rawHtml={split.tools} />
                  )}
                </>
              );
            })()}
            {message.edited && (
              <span className="ml-1 text-[10px] text-slate-600">(edited)</span>
            )}
            {promoted && !showAvatar && (
              <a
                href={promoted.task_url}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/20"
                title="Open Project Ops task"
              >
                <BriefcaseBusiness className="h-3 w-3" />
                {promoted.task_number || promoted.project_number}
              </a>
            )}
            {artifact && !showAvatar && (
              <button
                type="button"
                onClick={() =>
                  void useCanvasStore.getState().openArtifactById(artifact.artifactId)
                }
                className="ml-2 inline-flex items-center gap-1 rounded bg-stable-purple/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-purple-light hover:bg-stable-purple/20"
                title={artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              >
                <LayoutPanelLeft className="h-3 w-3" />
                {artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              </button>
            )}
            {Array.isArray(
              (message.metadata as { attachments?: unknown[] } | undefined)
                ?.attachments,
            ) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {((message.metadata as {
                  attachments: Array<{
                    url: string;
                    filename: string;
                    content_type: string;
                    size: number;
                  }>;
                }).attachments).map((a, i) =>
                  a.content_type.startsWith("image/") ? (
                    <a
                      key={i}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block max-w-xs overflow-hidden rounded-lg border border-slate-700/60"
                    >
                      <img
                        src={a.url}
                        alt={a.filename}
                        className="max-h-64 w-full object-cover"
                      />
                    </a>
                  ) : (
                    <a
                      key={i}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-800/50 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      📎 <span className="truncate max-w-[20ch]">{a.filename}</span>
                      <span className="text-slate-500">
                        ({Math.round(a.size / 1024)} KB)
                      </span>
                    </a>
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {(() => {
          const poll = (message.metadata as { poll?: { question: string; options: string[] } } | undefined)?.poll;
          if (!poll) return null;
          return <PollCard messageId={message.id} poll={poll} reactions={(message.metadata as { reactions?: Record<string, string[]> } | undefined)?.reactions ?? null} />;
        })()}

        <ReactionRow
          messageId={message.id}
          reactions={
            (message.metadata as { reactions?: Record<string, string[]> } | undefined)
              ?.reactions ?? null
          }
        />

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
        <div className="absolute -top-3 right-2 z-10 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-end gap-0.5 rounded-lg border border-slate-700/50 bg-slate-800 p-0.5 shadow-lg animate-fade-in md:max-w-none md:flex-nowrap">
          <QuickReact messageId={message.id} />
          <button
            onClick={() => onReply(message.id)}
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Reply in thread"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              const quote = `> **${message.sender_name}:** ${message.content}\n\n`;
              useAppStore.getState().requestInsert(message.room_id, quote);
            }}
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Quote reply"
            title="Quote and reply"
          >
            <Quote className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => api.toggleSave(message.id).catch(() => {})}
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Save message"
            title="Save to your bookmarks"
          >
            <Bookmark className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setPromoteOpen(true)}
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Promote to Project Ops task"
            title="Promote to Project Ops task"
          >
            <BriefcaseBusiness className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() =>
              api.togglePin(message.room_id, message.id).catch(() => {})
            }
            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            aria-label="Pin / unpin message"
            title="Pin or unpin"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          {isAgent && !isGenerating && (
            <button
              disabled={regenerating}
              onClick={(e) => {
                e.stopPropagation();
                if (regenerating) return;
                setRegenerating(true);
                void api
                  .regenerateReply(message.id)
                  .catch((err) => {
                    // 409 = someone already regenerated this reply (double-tap /
                    // two members). Benign and expected — don't alarm the user.
                    if ((err as ApiError)?.status === 409) return;
                    alert("Regenerate failed: " + (err as Error).message);
                  })
                  .finally(() => setRegenerating(false));
              }}
              className="rounded p-1.5 text-slate-400 transition-colors hover:bg-stable-purple/20 hover:text-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Regenerate reply"
              title="Regenerate this reply"
            >
              <RefreshCw
                className={clsx("h-3.5 w-3.5", regenerating && "animate-spin")}
              />
            </button>
          )}
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
                onClick={() => {
                  // Confirm here too — the hover toolbar deleted instantly
                  // while only the context-menu path asked (easy mis-click).
                  if (window.confirm("Delete this message?")) {
                    void onDelete(message.id);
                  }
                }}
                className="rounded p-1.5 text-slate-400 transition-colors hover:bg-red-500/20 hover:text-red-400"
                aria-label="Delete message"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {isGenerating && (
        <div className="absolute -bottom-3 right-3 z-10">
          <button
            onClick={(e) => {
              e.stopPropagation();
              void api.stopGenerating(message.id).catch(() => {});
            }}
            className="flex items-center gap-1 rounded-full border border-slate-600/70 bg-slate-800/95 px-2 py-0.5 text-[11px] font-medium text-slate-300 shadow-lg backdrop-blur-sm transition-colors hover:border-red-500/50 hover:text-red-300"
            aria-label="Stop generating"
            title="Stop generating"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
        </div>
      )}

      {failed && onRetry && (
        <div
          className="absolute -right-2 top-1 flex items-center gap-1 rounded-md border border-red-500/50 bg-red-500/15 px-1.5 py-0.5 text-xs text-red-300"
          title={failedError || "Send failed"}
        >
          <AlertTriangle className="h-3 w-3" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              void onRetry(message.id);
            }}
            className="flex items-center gap-1 hover:text-red-200"
          >
            <RotateCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}
      {ctxMenu && (
        <ul
          className="fixed z-50 min-w-[180px] rounded-md border border-slate-700/60 bg-slate-900/95 p-1 text-sm shadow-xl backdrop-blur"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <li>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.content);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-slate-200 hover:bg-slate-800"
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy text
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                const url = `${window.location.origin}/c/${message.room_id}?message=${message.id}`;
                void navigator.clipboard.writeText(url);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-slate-200 hover:bg-slate-800"
            >
              <Link2 className="h-3.5 w-3.5" /> Copy link
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                onReply(message.id);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-slate-200 hover:bg-slate-800"
            >
              ↪ Reply / quote
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                setPromoteOpen(true);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-slate-200 hover:bg-slate-800"
            >
              <BriefcaseBusiness className="h-3.5 w-3.5" /> Promote to Project Ops task
            </button>
          </li>
          {isOwn && (
            <>
              <li>
                <button
                  onClick={() => {
                    setEditing(true);
                    setCtxMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-slate-200 hover:bg-slate-800"
                >
                  ✏️ Edit
                </button>
              </li>
              <li>
                <button
                  onClick={() => {
                    if (window.confirm("Delete this message?")) {
                      void onDelete(message.id);
                    }
                    setCtxMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-red-300 hover:bg-red-500/15"
                >
                  🗑 Delete
                </button>
              </li>
            </>
          )}
        </ul>
      )}
      {promoteOpen && (
        <PromoteToProjectOpsModal
          message={message}
          onClose={() => setPromoteOpen(false)}
          onPromoted={handlePromoted}
        />
      )}
    </div>
  );
}
