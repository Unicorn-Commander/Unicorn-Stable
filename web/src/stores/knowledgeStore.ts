import { create } from "zustand";
import { api } from "@/services/api";
import type { Collection, KbDocument } from "@/types/knowledge";

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

  /** Attach a collection to the current room, then refresh attachments. */
  attach: (collectionId: string) => Promise<void>;
  /** Detach a collection from the current room, then refresh attachments. */
  detach: (collectionId: string) => Promise<void>;
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
  error: null,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  setRoom: (roomId) => {
    const prev = get().roomId;
    if (prev === roomId) return;
    // Switching rooms drops the per-room attachment state (but keeps the global
    // collection listing — it isn't room-scoped).
    set({ roomId, attached: [], error: null });
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
    set({ openCollection: null, documents: [], error: null }),

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
}));
