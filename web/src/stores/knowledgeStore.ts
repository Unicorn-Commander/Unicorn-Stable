import { create } from "zustand";
import { api } from "@/services/api";
import type {
  Collection,
  DocumentContent,
  KbDocument,
  KnowledgeSearchHit,
} from "@/types/knowledge";

/**
 * Knowledge store — the Knowledge Bases panel state.
 *
 * Kept SEPARATE from the big {@link useAppStore} (like the canvas + call-UI
 * stores) so the panel re-renders independently and nothing else depends on it.
 *
 * Two layers of state:
 *   1. GLOBAL: every collection the user can see ({@link collections}), plus the
 *      currently OPENED collection and its documents (for the upload view).
 *   2. ROOM-SCOPED: which collections are ATTACHED to the active room
 *      ({@link attached}). This is the load-bearing link — a room's attached
 *      collections are what the agent (Majik) searches here. `roomId` is tracked
 *      so a late fetch resolving after the user switched rooms is ignored.
 */

interface KnowledgeState {
  /** Right-drawer panel visible. */
  panelOpen: boolean;
  /** Room the panel is scoped to (mirrors the active room). */
  roomId: string | null;

  /** All collections (global listing). */
  collections: Collection[];
  collectionsLoading: boolean;

  /** Collections attached to the current room (the agent searches these). */
  attached: Collection[];
  attachedLoading: boolean;

  /** The collection currently opened for document management (or null). */
  openCollection: Collection | null;
  /** Documents in the open collection. */
  documents: KbDocument[];
  documentsLoading: boolean;

  /** The document whose extracted chunks are being read (or null). */
  openDocument: DocumentContent | null;
  documentContentLoading: boolean;

  /** Room-scoped KB search (the same search the agent runs). */
  searchQuery: string;
  searchResults: KnowledgeSearchHit[];
  searching: boolean;
  /** True once a search has run (drives the "no matches" empty state). */
  searchRan: boolean;
  /**
   * The retrieval plane (vector index / embeddings) could not be reached on the
   * last search — the backend answered 503 rather than pretending nothing
   * matched. Deliberately NOT folded into `searchResults: []`: "we looked and
   * found nothing" and "we could not look" are different facts, and the panel
   * must say which one happened.
   */
  retrievalUnavailable: boolean;
  /** Server-supplied explanation for {@link retrievalUnavailable}. */
  retrievalDetail: string | null;

  /** Last error (surfaced as a banner). */
  error: string | null;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  /** Point the panel at a room: refresh attachments, clear cross-room state. */
  setRoom: (roomId: string | null) => void;

  /** Load every collection (the global listing). */
  refreshCollections: () => Promise<void>;
  /** Load the collections attached to a room. */
  refreshAttached: (roomId: string) => Promise<void>;

  /** Create a collection, then refresh the listing. Returns it (or null). */
  createCollection: (
    name: string,
    description?: string,
  ) => Promise<Collection | null>;

  /** Open a collection's document view (fetches its documents). */
  openCollectionById: (collectionId: string) => Promise<void>;
  /** Close the open collection (back to the list). */
  closeCollection: () => void;
  /** Re-fetch the open collection's documents (to poll indexing status). */
  refreshDocuments: () => Promise<void>;
  /** Upload a file into the open collection, then refresh its documents. */
  uploadDocument: (file: File) => Promise<boolean>;

  /** Open a document's extracted-chunk reader (within the open collection). */
  openDocumentById: (documentId: string) => Promise<void>;
  /** Close the document reader (back to the document list). */
  closeDocument: () => void;

  /** Update the search box text only (does not fire a request). */
  setSearchQuery: (query: string) => void;
  /** Run the room-scoped KB search (searches every attached collection). */
  runSearch: (query: string) => Promise<void>;
  /** Clear the search box + results. */
  clearSearch: () => void;

  /**
   * Open the panel straight onto a cited source: reveal the collection, then
   * the document, so a citation on an answer is clickable through to the text
   * it came from.
   */
  revealSource: (
    collectionId: string,
    documentId?: string | null,
  ) => Promise<void>;

  /** Attach a collection to the current room, then refresh attachments. */
  attach: (collectionId: string) => Promise<void>;
  /** Detach a collection from the current room, then refresh attachments. */
  detach: (collectionId: string) => Promise<void>;

  /** Clear all server-scoped knowledge state on a federated server switch. */
  resetForServer: () => void;
}

function errMsg(e: unknown): string {
  const apiErr = e as { detail?: string | null; message?: string };
  return (
    apiErr?.detail ||
    apiErr?.message ||
    (e instanceof Error ? e.message : "Request failed")
  );
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  panelOpen: false,
  roomId: null,
  collections: [],
  collectionsLoading: false,
  attached: [],
  attachedLoading: false,
  openCollection: null,
  documents: [],
  documentsLoading: false,
  openDocument: null,
  documentContentLoading: false,
  searchQuery: "",
  searchResults: [],
  searching: false,
  searchRan: false,
  retrievalUnavailable: false,
  retrievalDetail: null,
  error: null,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  setRoom: (roomId) => {
    const prev = get().roomId;
    if (prev === roomId) return;
    // Switching rooms drops the per-room attachment state (but keeps the global
    // collection listing — it isn't room-scoped). Search is room-scoped too, so
    // clear it on a room switch.
    set({
      roomId,
      attached: [],
      searchQuery: "",
      searchResults: [],
      searchRan: false,
      // Availability is a property of the server, not the room, but it is only
      // ever learned by searching — so drop the stale claim on a room switch
      // rather than carrying a warning we can no longer justify.
      retrievalUnavailable: false,
      retrievalDetail: null,
      error: null,
    });
    if (roomId) void get().refreshAttached(roomId);
  },

  refreshCollections: async () => {
    set({ collectionsLoading: true });
    try {
      const list = await api.listCollections();
      set({ collections: list, collectionsLoading: false });
    } catch (e) {
      set({ collectionsLoading: false, error: errMsg(e) });
    }
  },

  refreshAttached: async (roomId) => {
    set({ attachedLoading: true });
    try {
      const list = await api.listRoomKnowledge(roomId);
      // Ignore a response that resolved after the user switched rooms.
      if (get().roomId !== roomId) return;
      set({ attached: list, attachedLoading: false });
    } catch (e) {
      if (get().roomId !== roomId) return;
      set({ attachedLoading: false, error: errMsg(e) });
    }
  },

  createCollection: async (name, description) => {
    set({ error: null });
    try {
      const created = await api.createCollection({
        name,
        ...(description ? { description } : {}),
      });
      await get().refreshCollections();
      return created;
    } catch (e) {
      set({ error: errMsg(e) });
      return null;
    }
  },

  openCollectionById: async (collectionId) => {
    set({ documentsLoading: true, error: null });
    try {
      const [collection, documents] = await Promise.all([
        api.getCollection(collectionId),
        api.listKbDocuments(collectionId),
      ]);
      set({
        openCollection: collection,
        documents,
        documentsLoading: false,
      });
    } catch (e) {
      set({ documentsLoading: false, error: errMsg(e) });
    }
  },

  closeCollection: () =>
    set({
      openCollection: null,
      documents: [],
      openDocument: null,
      error: null,
    }),

  refreshDocuments: async () => {
    const open = get().openCollection;
    if (!open) return;
    const collectionId = open.id;
    try {
      const documents = await api.listKbDocuments(collectionId);
      // Bail if the user closed/swapped the collection while we were fetching.
      if (get().openCollection?.id !== collectionId) return;
      set({ documents });
    } catch (e) {
      if (get().openCollection?.id !== collectionId) return;
      set({ error: errMsg(e) });
    }
  },

  uploadDocument: async (file) => {
    const open = get().openCollection;
    if (!open) return false;
    set({ error: null });
    try {
      await api.uploadKbDocument(open.id, file);
      await get().refreshDocuments();
      return true;
    } catch (e) {
      set({ error: errMsg(e) });
      return false;
    }
  },

  openDocumentById: async (documentId) => {
    const open = get().openCollection;
    if (!open) return;
    const collectionId = open.id;
    set({ documentContentLoading: true, openDocument: null, error: null });
    try {
      const content = await api.getKbDocumentContent(collectionId, documentId);
      // Bail if the user closed/swapped the collection while we were fetching.
      if (get().openCollection?.id !== collectionId) return;
      set({ openDocument: content, documentContentLoading: false });
    } catch (e) {
      if (get().openCollection?.id !== collectionId) return;
      set({ documentContentLoading: false, error: errMsg(e) });
    }
  },

  closeDocument: () => set({ openDocument: null }),

  setSearchQuery: (query) => {
    // Text-only; emptying the box also clears any prior results.
    if (!query.trim()) {
      set({ searchQuery: query, searchResults: [], searchRan: false });
    } else {
      set({ searchQuery: query });
    }
  },

  runSearch: async (query) => {
    const roomId = get().roomId;
    const q = query.trim();
    set({ searchQuery: query });
    if (!roomId || !q) {
      set({ searchResults: [], searchRan: false });
      return;
    }
    set({ searching: true, error: null });
    try {
      const results = await api.searchRoomKnowledge(roomId, q);
      // Ignore a response that resolved after the user switched rooms.
      if (get().roomId !== roomId) return;
      set({
        searchResults: results,
        searching: false,
        searchRan: true,
        retrievalUnavailable: false,
        retrievalDetail: null,
      });
    } catch (e) {
      if (get().roomId !== roomId) return;
      // 503 = the backend could not reach the index. Record it as its own
      // state so the panel says "search is down", never "no matches".
      if ((e as { status?: number })?.status === 503) {
        set({
          searching: false,
          searchRan: true,
          searchResults: [],
          retrievalUnavailable: true,
          retrievalDetail: errMsg(e),
          error: null,
        });
        return;
      }
      set({ searching: false, searchRan: true, error: errMsg(e) });
    }
  },

  clearSearch: () =>
    set({ searchQuery: "", searchResults: [], searchRan: false }),

  revealSource: async (collectionId, documentId) => {
    set({ panelOpen: true });
    await get().openCollectionById(collectionId);
    // Only drill into the document if the collection actually opened (it can
    // fail on a 403/404) — otherwise leave the user on the collection list.
    if (documentId && get().openCollection?.id === collectionId) {
      await get().openDocumentById(documentId);
    }
  },

  attach: async (collectionId) => {
    const roomId = get().roomId;
    if (!roomId) return;
    set({ error: null });
    try {
      await api.attachRoomKnowledge(roomId, collectionId);
      await get().refreshAttached(roomId);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  detach: async (collectionId) => {
    const roomId = get().roomId;
    if (!roomId) return;
    set({ error: null });
    try {
      await api.detachRoomKnowledge(roomId, collectionId);
      await get().refreshAttached(roomId);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  resetForServer: () =>
    set({
      panelOpen: false,
      roomId: null,
      collections: [],
      collectionsLoading: false,
      attached: [],
      attachedLoading: false,
      openCollection: null,
      documents: [],
      documentsLoading: false,
      openDocument: null,
      documentContentLoading: false,
      searchQuery: "",
      searchResults: [],
      searching: false,
      searchRan: false,
      retrievalUnavailable: false,
      retrievalDetail: null,
      error: null,
    }),
}));
