import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import {
  X,
  Plus,
  ChevronLeft,
  ChevronRight,
  History,
  RotateCcw,
  FileText,
  Code2,
  Eye,
  GitCompare,
  PanelLeft,
  Bot,
  User as UserIcon,
} from "lucide-react";
import { api } from "@/services/api";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  PANEL_RESIZE_ACTIVE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { useCanvasStore } from "@/stores/canvasStore";
import type { ArtifactKind, ArtifactResponse } from "@/types/artifact";
import { CanvasRenderer } from "./canvas/CanvasRenderer";
import DiffView from "./canvas/DiffView";

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: "Markdown",
  code: "Code",
  html: "HTML",
  svg: "SVG",
  mermaid: "Mermaid",
  react: "React",
  sheet: "Sheet",
};

const KIND_OPTIONS: ArtifactKind[] = [
  "markdown",
  "code",
  "html",
  "svg",
  "mermaid",
  "react",
  "sheet",
];

/** Kinds whose HEAD is editable in-canvas (whole-buffer rewrite). */
const EDITABLE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "code",
  "html",
  "svg",
  "mermaid",
  "react",
  "sheet",
]);

interface CanvasPanelProps {
  roomId: string;
  onClose: () => void;
}

/** The "create artifact" inline form (title + kind + optional language). */
function NewArtifactForm({
  roomId,
  onDone,
  onCancel,
}: {
  roomId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const createDraft = useCanvasStore((s) => s.createDraft);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ArtifactKind>("markdown");
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const created = await createDraft(
      roomId,
      t,
      kind,
      "",
      kind === "code" && language.trim() ? language.trim() : undefined,
    );
    setBusy(false);
    if (created) onDone();
    else setError("Couldn't create the artifact.");
  }

  return (
    <div className="border-b border-slate-700/50 bg-slate-900/80 p-3">
      <div className="mb-2 text-xs font-semibold text-slate-300">
        New artifact
      </div>
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder="Title"
          className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-stable-purple"
        />
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ArtifactKind)}
            className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-stable-purple"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {kind === "code" && (
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="language (e.g. python)"
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-stable-purple"
            />
          )}
        </div>
        {error && <p className="text-xs text-rose-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!title.trim() || busy}
            className="rounded-md bg-stable-purple px-2.5 py-1 text-sm font-medium text-white hover:bg-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The list of room artifacts to switch between (shown when none is open). */
function ArtifactList({
  artifacts,
  loading,
  onOpen,
}: {
  artifacts: ArtifactResponse[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  if (loading && artifacts.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-slate-500">Loading…</p>
    );
  }
  if (artifacts.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-slate-500">
        No artifacts yet. Create one to start co-working — docs, code, diagrams.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-2">
      {artifacts.map((a) => (
        <li key={a.id}>
          <button
            onClick={() => onOpen(a.id)}
            className="flex w-full items-center gap-2 rounded-md border border-slate-700/50 bg-slate-900 px-2.5 py-2 text-left hover:border-stable-purple/40 hover:bg-slate-800/60"
          >
            <FileText className="h-4 w-4 shrink-0 text-slate-500" />
            <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
              {a.title}
            </span>
            <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
              {KIND_LABEL[a.kind]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CanvasPanel({ roomId, onClose }: CanvasPanelProps) {
  const {
    artifacts,
    artifactsLoading,
    openArtifact,
    versions,
    viewIndex,
    loading,
    error,
    openArtifactById,
    refreshOpen,
    closeArtifact,
    setViewIndex,
  } = useCanvasStore();

  const [showNew, setShowNew] = useState(false);
  const [showList, setShowList] = useState(false);
  // Markdown: toggle source-edit vs rendered preview. Other kinds render natively.
  const [mdSource, setMdSource] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  // Desktop drag-to-resize (persisted). Mobile stays a full-screen takeover,
  // so the inline width is gated to md+ where the panel is a docked column.
  const isDesktop = useIsDesktop();
  const resize = usePanelResize("canvas", {
    defaultWidth: 560,
    min: 360,
    max: 900,
    edge: "left",
  });

  // The canvas store is scoped to the active room by RoomView (which remounts
  // per room), so the room's artifact list is already loading by the time this
  // panel mounts. Nothing to do here for room scoping.

  // Esc closes the panel (mirrors the other right-drawers).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The version being shown: -1 ⇒ HEAD (openArtifact.content), else versions[idx].
  const atHead = viewIndex === -1;
  const shownVersion =
    !atHead && viewIndex >= 0 ? versions[viewIndex] : undefined;
  const headContent = openArtifact?.content ?? "";
  const shownContent = atHead ? headContent : (shownVersion?.content ?? "");

  // Seq/author label for the toolbar.
  const headSeq = openArtifact?.current_seq ?? versions.at(-1)?.seq ?? null;
  const shownSeq = atHead ? headSeq : (shownVersion?.seq ?? null);
  const shownAuthorKind = atHead
    ? versions.at(-1)?.author_kind
    : shownVersion?.author_kind;

  // "prev/next version" navigation. The cursor runs over the versions array;
  // -1 is HEAD which equals the last version, so newest-historic == HEAD.
  const lastIdx = versions.length - 1;
  // Effective index for navigation (HEAD maps to the last version).
  const effIdx = atHead ? lastIdx : viewIndex;
  const canPrev = effIdx > 0;
  const canNext = !atHead && viewIndex < lastIdx;

  function goPrev() {
    if (!canPrev) return;
    setViewIndex(effIdx - 1);
    setShowDiff(false);
  }
  function goNext() {
    if (effIdx >= lastIdx - 1) {
      // Returning to the newest version === HEAD.
      setViewIndex(-1);
    } else {
      setViewIndex(effIdx + 1);
    }
    setShowDiff(false);
  }

  // Diff: compare the shown version against its parent (previous seq).
  const diffBefore = useMemo(() => {
    if (versions.length === 0) return "";
    const targetIdx = atHead ? lastIdx : viewIndex;
    const prev = targetIdx > 0 ? versions[targetIdx - 1] : undefined;
    return prev?.content ?? "";
  }, [versions, atHead, viewIndex, lastIdx]);

  async function handleSave(content: string) {
    if (!openArtifact) return;
    // Whole-buffer rewrite → new version. Throws on failure (surfaced by the
    // editor); the broadcast will also refresh, but refresh here too so the
    // author sees it immediately even without the data channel.
    await api.rewriteArtifact(openArtifact.id, { content });
    await refreshOpen();
  }

  async function handleRestore() {
    if (!openArtifact || !shownVersion) return;
    try {
      await api.restoreArtifactVersion(openArtifact.id, shownVersion.id);
      await refreshOpen(); // snaps back to HEAD
      setShowDiff(false);
    } catch (e) {
      const apiErr = e as { detail?: string | null; message?: string };
      alert(
        "Restore failed: " +
          (apiErr?.detail || apiErr?.message || "unknown error"),
      );
    }
  }

  const kind = openArtifact?.kind;
  // HEAD is editable for editable kinds; markdown is editable only in source mode.
  const isEditableNow =
    atHead &&
    !!kind &&
    (EDITABLE_KINDS.has(kind) || (kind === "markdown" && mdSource));
  const readOnly = !isEditableNow;

  return (
    <motion.aside
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      // Mobile: full-screen takeover (the owner is often on a phone — a cramped
      // column is unusable for editing). Desktop: a wide right column docked
      // beside chat (the co-working layout), user-resizable via the left-edge
      // handle (inline width below; md:relative keeps the handle anchored here).
      className="fixed inset-0 z-40 flex h-full w-full flex-col border-l border-slate-700/50 bg-slate-900 shadow-2xl md:relative md:z-auto md:shadow-none"
      style={isDesktop ? { width: resize.width } : undefined}
      aria-label="Canvas"
    >
      <div
        {...resize.dragHandleProps}
        aria-label="Resize canvas panel"
        title="Drag to resize · double-click to reset"
        className={clsx(
          PANEL_RESIZE_HANDLE_CLASS,
          "left-0 hidden md:block",
          resize.isDragging && PANEL_RESIZE_ACTIVE_CLASS,
        )}
      />
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-700/50 px-3">
        <div className="flex min-w-0 items-center gap-2">
          {openArtifact ? (
            <>
              <button
                onClick={() => {
                  closeArtifact();
                  setShowList(true);
                  setShowDiff(false);
                }}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                aria-label="Back to artifact list"
                title="All artifacts"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <span className="min-w-0 truncate text-sm font-semibold text-slate-100">
                {openArtifact.title}
              </span>
              <span className="shrink-0 rounded bg-stable-purple/15 px-1.5 py-0.5 text-[10px] font-medium text-stable-purple-light">
                {KIND_LABEL[openArtifact.kind]}
                {openArtifact.kind === "code" && openArtifact.language
                  ? ` · ${openArtifact.language}`
                  : ""}
              </span>
            </>
          ) : (
            <span className="text-sm font-semibold text-slate-200">Canvas</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!openArtifact && (
            <button
              onClick={() => setShowNew((v) => !v)}
              className="flex items-center gap-1 rounded-md bg-stable-purple/20 px-2 py-1 text-xs text-stable-purple-light hover:bg-stable-purple/30"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close canvas"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* New-artifact form (toggled) */}
      {showNew && !openArtifact && (
        <NewArtifactForm
          roomId={roomId}
          onDone={() => setShowNew(false)}
          onCancel={() => setShowNew(false)}
        />
      )}

      {/* Error banner */}
      {error && (
        <p className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">
          {error}
        </p>
      )}

      {/* No artifact open → the list */}
      {!openArtifact ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ArtifactList
            artifacts={artifacts}
            loading={artifactsLoading}
            onOpen={(id) => {
              setShowList(false);
              setShowNew(false);
              void openArtifactById(id);
            }}
          />
        </div>
      ) : (
        <>
          {/* Version toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-700/50 bg-slate-900/60 px-3 py-1.5">
            <div className="flex items-center gap-0.5">
              <button
                onClick={goPrev}
                disabled={!canPrev}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
                aria-label="Previous version"
                title="Previous version"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="flex items-center gap-1 px-1 text-[11px] text-slate-400">
                <History className="h-3 w-3" />
                v{shownSeq ?? "?"}
                {headSeq != null ? ` / ${headSeq}` : ""}
              </span>
              <button
                onClick={goNext}
                disabled={!canNext}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
                aria-label="Next version"
                title="Next version"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {shownAuthorKind && (
              <span
                className={clsx(
                  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                  shownAuthorKind === "agent"
                    ? "bg-stable-cyan/10 text-stable-cyan"
                    : "bg-slate-800 text-slate-400",
                )}
                title={`Authored by ${shownAuthorKind}`}
              >
                {shownAuthorKind === "agent" ? (
                  <Bot className="h-3 w-3" />
                ) : (
                  <UserIcon className="h-3 w-3" />
                )}
                {shownAuthorKind}
              </span>
            )}

            {!atHead && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                viewing history
              </span>
            )}

            <div className="ml-auto flex items-center gap-1">
              {/* Diff toggle (vs the previous version). */}
              {versions.length > 1 && (
                <button
                  onClick={() => setShowDiff((v) => !v)}
                  className={clsx(
                    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
                    showDiff
                      ? "bg-slate-700 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                  )}
                  title="Show changes vs previous version"
                >
                  <GitCompare className="h-3 w-3" />
                  Diff
                </button>
              )}

              {/* Markdown source/preview toggle. */}
              {openArtifact.kind === "markdown" && atHead && !showDiff && (
                <button
                  onClick={() => setMdSource((v) => !v)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  title={mdSource ? "Show rendered" : "Edit source"}
                >
                  {mdSource ? (
                    <>
                      <Eye className="h-3 w-3" /> Preview
                    </>
                  ) : (
                    <>
                      <Code2 className="h-3 w-3" /> Source
                    </>
                  )}
                </button>
              )}

              {/* Restore — only when viewing a historic version. */}
              {!atHead && shownVersion && (
                <button
                  onClick={handleRestore}
                  className="flex items-center gap-1 rounded bg-stable-purple/20 px-1.5 py-0.5 text-[11px] text-stable-purple-light hover:bg-stable-purple/30"
                  title="Restore this version as a new version"
                >
                  <RotateCcw className="h-3 w-3" />
                  Restore
                </button>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {loading ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                Loading…
              </div>
            ) : showDiff ? (
              <DiffView before={diffBefore} after={shownContent} />
            ) : openArtifact.kind === "markdown" && mdSource && atHead ? (
              // Markdown editing: source via CodeRenderer (markdown grammar) → save.
              <CanvasRenderer
                kind="code"
                content={headContent}
                language="markdown"
                readOnly={false}
                onSave={handleSave}
              />
            ) : (
              <CanvasRenderer
                // Key by version id so the renderer (e.g. CodeMirror buffer)
                // resets cleanly when paging through history.
                key={atHead ? "head" : (shownVersion?.id ?? "v")}
                kind={openArtifact.kind}
                content={shownContent}
                language={openArtifact.language}
                readOnly={readOnly}
                onSave={isEditableNow ? handleSave : undefined}
              />
            )}
          </div>
        </>
      )}

      {/* When a fetch error left no artifact + the list is hidden, offer a way back */}
      {!openArtifact && showList && artifacts.length === 0 && !artifactsLoading && (
        <div className="border-t border-slate-700/50 p-2 text-center">
          <button
            onClick={() => setShowNew(true)}
            className="text-xs text-stable-purple-light hover:underline"
          >
            Create the first artifact
          </button>
        </div>
      )}
    </motion.aside>
  );
}
