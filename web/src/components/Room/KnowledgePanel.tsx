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
} from "lucide-react";
import { useKnowledgeStore } from "@/stores/knowledgeStore";
import type { Collection, KbDocument, KbDocumentStatus } from "@/types/knowledge";

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
    <div className="border-b border-slate-700/50 bg-slate-900/80 p-3">
      <div className="mb-2 text-xs font-semibold text-slate-300">
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
          className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-stable-purple"
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
          className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-stable-purple"
        />
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || busy}
            className="rounded-md bg-stable-purple px-2.5 py-1 text-sm font-medium text-white hover:bg-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
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
      <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300">
        <AlertTriangle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
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
      <p className="px-3 py-6 text-center text-xs text-slate-500">Loading…</p>
    );
  }
  if (collections.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-slate-500">
        No knowledge bases yet. Create one, upload documents, then attach it to
        this room so the agent can search it.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-2">
      {collections.map((c) => {
        const attached = attachedIds.has(c.id);
        const busy = busyId === c.id;
        return (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-md border border-slate-700/50 bg-slate-900 px-2 py-1.5 hover:border-stable-purple/40"
          >
            <button
              onClick={() => onOpen(c.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title="Open — upload & view documents"
            >
              <Database className="h-4 w-4 shrink-0 text-slate-500" />
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
                "flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] disabled:opacity-50",
                attached
                  ? "bg-stable-cyan/15 text-stable-cyan hover:bg-stable-cyan/25"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
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
}: {
  documents: KbDocument[];
  loading: boolean;
  uploading: boolean;
  onUpload: (files: FileList) => void;
  onRefresh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const indexingCount = documents.filter((d) => d.status === "indexing").length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-slate-700/50 p-3">
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
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-slate-700 bg-slate-950/60 px-3 py-3 text-sm text-slate-300 hover:border-stable-purple/50 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Documents{documents.length > 0 ? ` (${documents.length})` : ""}
        </span>
        {/* Indexing is async — offer a manual refresh to poll status. */}
        {(indexingCount > 0 || documents.length > 0) && (
          <button
            onClick={onRefresh}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="Refresh indexing status"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        )}
      </div>

      {loading && documents.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-500">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-500">
          No documents yet. Upload a file to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 px-2 pb-3">
          {documents.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-2 rounded-md border border-slate-700/50 bg-slate-900 px-2.5 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-200">
                  {d.filename}
                </span>
                <span className="block truncate text-[11px] text-slate-500">
                  {d.status === "ready" && d.chunk_count > 0
                    ? `${d.chunk_count} chunk${d.chunk_count === 1 ? "" : "s"}`
                    : d.content_type || "document"}
                </span>
              </span>
              <StatusChip status={d.status} />
            </li>
          ))}
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
    error,
    refreshCollections,
    refreshAttached,
    openCollectionById,
    closeCollection,
    refreshDocuments,
    uploadDocument,
    attach,
    detach,
  } = useKnowledgeStore();

  const [showNew, setShowNew] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Which collection row is mid attach/detach (for its spinner).
  const [attachBusyId, setAttachBusyId] = useState<string | null>(null);

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
      // Mobile: full-screen takeover. Desktop: a docked right column beside chat
      // (matches the canvas panel's footprint, a touch narrower).
      className="fixed inset-0 z-40 flex h-full w-full flex-col border-l border-slate-700/50 bg-slate-900 shadow-2xl md:static md:z-auto md:w-[clamp(320px,32vw,460px)] md:shadow-none"
      aria-label="Knowledge bases"
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-700/50 px-3">
        <div className="flex min-w-0 items-center gap-2">
          {openCollection ? (
            <>
              <button
                onClick={closeCollection}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                aria-label="Back to knowledge bases"
                title="All knowledge bases"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <span className="min-w-0 truncate text-sm font-semibold text-slate-100">
                {openCollection.name}
              </span>
            </>
          ) : (
            <>
              <Database className="h-4 w-4 shrink-0 text-stable-cyan" />
              <span className="text-sm font-semibold text-slate-200">
                Knowledge
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!openCollection && (
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
        <p className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}

      {openCollection ? (
        <CollectionDetail
          documents={documents}
          loading={documentsLoading}
          uploading={uploading}
          onUpload={handleUpload}
          onRefresh={() => void refreshDocuments()}
        />
      ) : (
        <>
          {/* Context line: what attaching does. */}
          <p className="shrink-0 border-b border-slate-700/50 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-500">
            Attached knowledge bases are searched by this room's agent. Open one
            to upload documents.
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
