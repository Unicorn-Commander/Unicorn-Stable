import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import {
  X,
  Plus,
  PanelLeft,
  Database,
  FileText,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Link2,
  Link2Off,
  RefreshCw,
  Search,
  ChevronRight,
} from "lucide-react";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { useKnowledgeStore } from "@/stores/knowledgeStore";
import type {
  Collection,
  DocumentContent,
  KbDocument,
  KbDocumentStatus,
  KnowledgeSearchHit,
} from "@/types/knowledge";

interface KnowledgePanelProps {
  roomId: string;
  onClose: () => void;
}

/** The "create collection" inline form (name + optional description). */
function NewCollectionForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const createCollection = useKnowledgeStore((s) => s.createCollection);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    const created = await createCollection(n, description.trim() || undefined);
    setBusy(false);
    if (created) onDone();
    else setError("Couldn't create the collection.");
  }

  return (
    <div className="border-b border-line bg-white/[0.02] p-3">
      <div className="mb-2 font-display text-xs font-semibold text-slate-200">
        New knowledge base
      </div>
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder="Name (e.g. Product Docs)"
          className="rounded-lg border border-line bg-slate-950/60 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder="Description (optional)"
          className="rounded-lg border border-line bg-slate-950/60 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
        />
        {error && <p className="text-xs text-rose-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="focus-ring rounded-lg px-2.5 py-1 text-sm text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || busy}
            className="focus-ring gradient-bg rounded-lg px-2.5 py-1 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A small status chip for a document's indexing state. */
function StatusChip({ status }: { status: KbDocumentStatus }) {
  if (status === "ready") {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-rose-400/20 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
        <AlertTriangle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-md border border-amber-300/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
      <Loader2 className="h-3 w-3 animate-spin" />
      Indexing
    </span>
  );
}

/**
 * The list of all collections, each row showing whether it's attached to this
 * room with an attach/detach toggle. Clicking the name opens its document view.
 */
function CollectionList({
  collections,
  attachedIds,
  loading,
  busyId,
  onOpen,
  onToggleAttach,
}: {
  collections: Collection[];
  attachedIds: Set<string>;
  loading: boolean;
  busyId: string | null;
  onOpen: (id: string) => void;
  onToggleAttach: (id: string, attached: boolean) => void;
}) {
  if (loading && collections.length === 0) {
    return (
      <p className="animate-pulse-soft px-3 py-6 text-center text-xs text-slate-500">
        Loading…
      </p>
    );
  }
  if (collections.length === 0) {
    return (
      <div className="flex animate-fade-in flex-col items-center gap-2 px-4 py-10 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-mint/10 text-stable-mint shadow-[0_0_24px_rgba(52,211,153,0.15)]">
          <Database className="h-5 w-5" />
        </div>
        <p className="font-display text-sm font-semibold text-slate-200">
          No knowledge bases yet
        </p>
        <p className="max-w-[28ch] text-xs text-slate-500">
          Create one, upload documents, then attach it to this room so the
          agent can search it.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 p-2">
      {collections.map((c) => {
        const attached = attachedIds.has(c.id);
        const busy = busyId === c.id;
        return (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface-1/80 px-2.5 py-2 transition-colors hover:border-line-strong hover:bg-white/[0.02]"
          >
            <button
              onClick={() => onOpen(c.id)}
              className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
              title="Open — upload & view documents"
            >
              <Database className="h-4 w-4 shrink-0 text-stable-mint/70" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-200">
                  {c.name}
                </span>
                {c.description && (
                  <span className="block truncate text-[11px] text-slate-500">
                    {c.description}
                  </span>
                )}
              </span>
            </button>
            <button
              onClick={() => onToggleAttach(c.id, attached)}
              disabled={busy}
              aria-pressed={attached}
              className={clsx(
                "focus-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
                attached
                  ? "bg-stable-cyan/15 text-stable-cyan hover:bg-stable-cyan/25"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
              )}
              title={
                attached
                  ? "Attached to this room — click to detach"
                  : "Attach to this room so the agent can search it"
              }
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : attached ? (
                <Link2 className="h-3.5 w-3.5" />
              ) : (
                <Link2Off className="h-3.5 w-3.5" />
              )}
              {attached ? "Attached" : "Attach"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The open-collection view: drop/upload files + the document list. */
function CollectionDetail({
  documents,
  loading,
  uploading,
  onUpload,
  onRefresh,
  onOpenDocument,
}: {
  documents: KbDocument[];
  loading: boolean;
  uploading: boolean;
  onUpload: (files: FileList) => void;
  onRefresh: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const indexingCount = documents.filter((d) => d.status === "indexing").length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line p-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onUpload(e.target.files);
            }
            // Reset so re-selecting the same file fires change again.
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-slate-950/40 px-3 py-3 text-sm text-slate-300 transition-colors hover:border-stable-purple/50 hover:bg-stable-purple/5 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              Upload documents
            </>
          )}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-slate-500">
          PDFs, text, markdown & more — each is chunked and embedded for search.
        </p>
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Documents{documents.length > 0 ? ` (${documents.length})` : ""}
        </span>
        {/* Indexing is async — offer a manual refresh to poll status. */}
        {(indexingCount > 0 || documents.length > 0) && (
          <button
            onClick={onRefresh}
            className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            title="Refresh indexing status"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        )}
      </div>

      {loading && documents.length === 0 ? (
        <p className="animate-pulse-soft px-3 py-6 text-center text-xs text-slate-500">
          Loading…
        </p>
      ) : documents.length === 0 ? (
        <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-8 text-center">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-stable-mint/10 text-stable-mint">
            <FileText className="h-5 w-5" />
          </div>
          <p className="font-display text-sm font-semibold text-slate-200">
            No documents yet
          </p>
          <p className="text-xs text-slate-500">
            Upload a file to get started.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 px-2 pb-3">
          {documents.map((d) => {
            // Only `ready` docs have retrievable chunks to read.
            const readable = d.status === "ready" && d.chunk_count > 0;
            const meta = (
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm text-slate-200">
                  {d.filename}
                </span>
                <span className="block truncate text-[11px] tabular-nums text-slate-500">
                  {readable
                    ? `${d.chunk_count} chunk${d.chunk_count === 1 ? "" : "s"}`
                    : d.content_type || "document"}
                </span>
              </span>
            );
            return (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface-1/80 px-2.5 py-2 transition-colors hover:border-line-strong"
              >
                {readable ? (
                  <button
                    onClick={() => onOpenDocument(d.id)}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
                    title="Read the extracted text"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                    {meta}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                  </button>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                    {meta}
                  </span>
                )}
                <StatusChip status={d.status} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The document reader: a document's extracted text, chunk by chunk. */
function DocumentContentView({
  content,
  loading,
}: {
  content: DocumentContent | null;
  loading: boolean;
}) {
  if (loading && !content) {
    return (
      <p className="animate-pulse-soft px-3 py-6 text-center text-xs text-slate-500">
        Loading extracted text…
      </p>
    );
  }
  if (!content) return null;
  if (content.chunks.length === 0) {
    return (
      <div className="flex animate-fade-in flex-col items-center gap-2 px-4 py-10 text-center">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-500/10 text-slate-400">
          <FileText className="h-5 w-5" />
        </div>
        <p className="font-display text-sm font-semibold text-slate-200">
          No extracted text
        </p>
        <p className="max-w-[30ch] text-xs text-slate-500">
          Nothing was indexed for this document — it may still be indexing, or
          extraction found no readable text.
        </p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {content.chunks.length} chunk{content.chunks.length === 1 ? "" : "s"} ·
        what the agent reads
      </div>
      <ol className="flex flex-col gap-2 px-2 pb-3">
        {content.chunks.map((c) => (
          <li
            key={c.chunk_idx}
            className="rounded-xl border border-line bg-surface-1/80 p-2.5"
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Chunk {c.chunk_idx + 1}
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-300">
              {c.text}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The room-scoped knowledge search: a query box + ranked hits across every
 * attached collection — the SAME retrieval the room's agent runs.
 */
function SearchSection({
  query,
  results,
  searching,
  ran,
  collectionsById,
  onChange,
  onRun,
  onClear,
}: {
  query: string;
  results: KnowledgeSearchHit[];
  searching: boolean;
  ran: boolean;
  collectionsById: Map<string, Collection>;
  onChange: (v: string) => void;
  onRun: () => void;
  onClear: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-line p-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRun();
            } else if (e.key === "Escape" && query) {
              onClear();
            }
          }}
          placeholder="Search the agent's knowledge…"
          aria-label="Search knowledge"
          className="w-full rounded-lg border border-line bg-slate-950/60 px-8 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-cyan/60 focus:ring-2 focus:ring-stable-cyan/20"
        />
        {query && (
          <button
            onClick={onClear}
            aria-label="Clear search"
            className="focus-ring absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {searching && (
        <p className="animate-pulse-soft px-1 pt-3 text-center text-xs text-slate-500">
          Searching…
        </p>
      )}

      {!searching && ran && results.length === 0 && (
        <p className="px-1 pt-3 text-center text-xs text-slate-500">
          No matches in the attached knowledge bases.
        </p>
      )}

      {!searching && results.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {results.map((r, i) => {
            const collection = r.collection_id
              ? collectionsById.get(r.collection_id)
              : undefined;
            const pct = Math.round(Math.max(0, Math.min(1, r.score)) * 100);
            return (
              <li
                key={`${r.collection_id ?? "x"}-${i}`}
                className="rounded-xl border border-line bg-surface-1/80 p-2.5"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-400">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="truncate">{r.filename}</span>
                  </span>
                  <span
                    className="shrink-0 text-[10px] tabular-nums text-slate-500"
                    title="Relevance"
                  >
                    {pct}%
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-300">
                  {r.text}
                </p>
                {collection && (
                  <span className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
                    <Database className="h-2.5 w-2.5" />
                    {collection.name}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function KnowledgePanel({ roomId, onClose }: KnowledgePanelProps) {
  const {
    collections,
    collectionsLoading,
    attached,
    openCollection,
    documents,
    documentsLoading,
    openDocument,
    documentContentLoading,
    searchQuery,
    searchResults,
    searching,
    searchRan,
    error,
    refreshCollections,
    refreshAttached,
    openCollectionById,
    closeCollection,
    refreshDocuments,
    uploadDocument,
    openDocumentById,
    closeDocument,
    setSearchQuery,
    runSearch,
    clearSearch,
    attach,
    detach,
  } = useKnowledgeStore();

  const [showNew, setShowNew] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Which collection row is mid attach/detach (for its spinner).
  const [attachBusyId, setAttachBusyId] = useState<string | null>(null);
  // Desktop drag-to-resize (persisted). Mobile stays a full-screen takeover,
  // so the inline width is gated to md+ where the panel is a docked column.
  const isDesktop = useIsDesktop();
  const resize = usePanelResize("knowledge", {
    defaultWidth: 420,
    min: 320,
    max: 700,
    edge: "left",
  });

  // Load the global list + this room's attachments when the panel opens.
  // (setRoom in RoomView already kicked off refreshAttached, but the panel can
  // open after a room switch, so refresh defensively — both are cheap GETs.)
  useEffect(() => {
    void refreshCollections();
    void refreshAttached(roomId);
  }, [roomId, refreshCollections, refreshAttached]);

  // Esc closes the panel (mirrors the other right-drawers).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const attachedIds = useMemo(
    () => new Set(attached.map((c) => c.id)),
    [attached],
  );
  // For labelling search hits with their source knowledge base.
  const collectionsById = useMemo(
    () => new Map(collections.map((c) => [c.id, c] as const)),
    [collections],
  );

  async function handleToggleAttach(id: string, isAttached: boolean) {
    setAttachBusyId(id);
    try {
      if (isAttached) await detach(id);
      else await attach(id);
    } finally {
      setAttachBusyId(null);
    }
  }

  async function handleUpload(files: FileList) {
    setUploading(true);
    try {
      // Sequential keeps the shared embedding server from being hammered and
      // lets each document's status land before the next upload starts.
      for (const file of Array.from(files)) {
        await uploadDocument(file);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <motion.aside
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      // Mobile: full-screen takeover. Desktop: a docked right column beside
      // chat (a touch narrower than the canvas), user-resizable via the
      // left-edge handle (inline width below; md:relative anchors the handle).
      className="glass-heavy fixed inset-0 z-40 flex h-full w-full flex-col shadow-2xl md:relative md:z-auto md:shadow-none"
      style={isDesktop ? { width: resize.width } : { height: "var(--app-height, 100dvh)", paddingTop: "env(safe-area-inset-top)" }}
      aria-label="Knowledge bases"
    >
      <div
        {...resize.dragHandleProps}
        aria-label="Resize knowledge panel"
        title="Drag to resize · double-click to reset"
        className={clsx(
          PANEL_RESIZE_HANDLE_CLASS,
          "left-0 hidden md:block",
        )}
      />
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-2">
          {openDocument ? (
            <>
              <button
                onClick={closeDocument}
                className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                aria-label="Back to documents"
                title={openCollection ? openCollection.name : "Documents"}
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="min-w-0 truncate font-display text-sm font-semibold text-slate-100">
                {openDocument.filename}
              </span>
            </>
          ) : openCollection ? (
            <>
              <button
                onClick={closeCollection}
                className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                aria-label="Back to knowledge bases"
                title="All knowledge bases"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <span className="min-w-0 truncate font-display text-sm font-semibold text-slate-100">
                {openCollection.name}
              </span>
            </>
          ) : (
            <>
              <Database className="h-4 w-4 shrink-0 text-stable-mint" />
              <span className="font-display text-sm font-semibold text-slate-200">
                Knowledge
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!openCollection && (
            <button
              onClick={() => setShowNew((v) => !v)}
              className="focus-ring flex items-center gap-1 rounded-md bg-stable-purple/20 px-2 py-1 text-xs font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/30"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          )}
          <button
            onClick={onClose}
            className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close knowledge"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* New-collection form (toggled) */}
      {showNew && !openCollection && (
        <NewCollectionForm
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

      {openDocument || documentContentLoading ? (
        <DocumentContentView
          content={openDocument}
          loading={documentContentLoading}
        />
      ) : openCollection ? (
        <CollectionDetail
          documents={documents}
          loading={documentsLoading}
          uploading={uploading}
          onUpload={handleUpload}
          onRefresh={() => void refreshDocuments()}
          onOpenDocument={(id) => void openDocumentById(id)}
        />
      ) : (
        <>
          {/* Room-scoped search — run the same retrieval the agent runs. */}
          <SearchSection
            query={searchQuery}
            results={searchResults}
            searching={searching}
            ran={searchRan}
            collectionsById={collectionsById}
            onChange={setSearchQuery}
            onRun={() => void runSearch(searchQuery)}
            onClear={clearSearch}
          />
          {/* Context line: what attaching does. */}
          <p className="shrink-0 border-b border-line bg-white/[0.02] px-3 py-2 text-[11px] text-slate-500">
            Attached knowledge bases are searched by this room's agent. Open one
            to upload & read documents.
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CollectionList
              collections={collections}
              attachedIds={attachedIds}
              loading={collectionsLoading}
              busyId={attachBusyId}
              onOpen={(id) => {
                setShowNew(false);
                void openCollectionById(id);
              }}
              onToggleAttach={handleToggleAttach}
            />
          </div>
        </>
      )}
    </motion.aside>
  );
}

export default KnowledgePanel;
