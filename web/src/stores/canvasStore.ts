import { create } from "zustand";
import { api } from "@/services/api";
import type { ArtifactResponse, VersionResponse } from "@/types/artifact";
import type { ArtifactEventMessage } from "@/lib/roomDataProtocol";

/**
 * Canvas store — the co-working artifact surface state.
 *
 * Kept SEPARATE from the big {@link useAppStore} (like the call-UI store) so the
 * audio path never depends on it and the panel re-renders independently.
 *
 * Responsibilities:
 *   1. `panelOpen` per nothing-fancy boolean (the right-drawer toggle).
 *   2. The currently-OPEN artifact + its full version history, plus a
 *      `viewIndex` cursor so the user can page back through versions (read-only
 *      preview) without losing their place at HEAD.
 *   3. The room's artifact LIST (for the switcher).
 *   4. Live updates: {@link handleArtifactEvent} is called from the room
 *      WebSocket subscription AND the VoiceProvider data handler (both outside
 *      React) when the backend broadcasts an artifact_created /
 *      artifact_updated event — it re-fetches the open artifact and refreshes
 *      the list, cheaply no-op'ing when nothing's open.
 *   5. `unseen`: the attention-dot counter for events that landed while the
 *      drawer was shut.
 *
 * The `roomId` the canvas is scoped to is tracked so a stale data-channel event
 * (or a late fetch resolving after the user switched rooms) can be ignored.
 */

interface CanvasState {
  /** Right-drawer / full-screen canvas visible. */
  panelOpen: boolean;
  /**
   * Artifact events that arrived while the panel was CLOSED, since the user
   * last looked. Drives the attention dot on the Canvas toggle — we never
   * auto-open the panel over someone's conversation, so a dot is the only
   * thing that tells them a doc/diagram just landed.
   */
  unseen: number;
  /** Room the canvas is currently scoped to (mirrors the active room). */
  roomId: string | null;

  /** The room's artifacts (metadata listing). Drives the switcher. */
  artifacts: ArtifactResponse[];
  artifactsLoading: boolean;

  /** The artifact currently open in the canvas (full, with content). */
  openArtifact: ArtifactResponse | null;
  /** Full version history of the open artifact, ascending by seq. */
  versions: VersionResponse[];
  /**
   * Which version the canvas is *showing*. -1 ⇒ HEAD (the openArtifact's
   * current content). 0..versions.length-1 ⇒ that historical version (preview).
   * Lets the version toolbar page back without mutating anything.
   */
  viewIndex: number;

  loading: boolean;
  /** Last error (open/refresh/version load). Edit/rewrite errors live in the panel. */
  error: string | null;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  /** Point the canvas at a room: refresh its list, clear any cross-room state. */
  setRoom: (roomId: string | null) => void;

  /** Load a room's artifact list (the switcher source). */
  refreshArtifacts: (roomId: string) => Promise<void>;
  /** Open an artifact by id (fetches content + versions) and reveal the panel. */
  openArtifactById: (artifactId: string) => Promise<void>;
  /** Re-fetch the open artifact + its versions (after an edit/restore). */
  refreshOpen: () => Promise<void>;
  /** Close the open artifact (keeps the panel open on the list). */
  closeArtifact: () => void;

  /** Move the version-view cursor. */
  setViewIndex: (index: number) => void;

  /**
   * Create a new artifact in a room, then open it. Returns the created
   * artifact (or null on failure — error is set on the store).
   */
  createDraft: (
    roomId: string,
    title: string,
    kind: ArtifactResponse["kind"],
    content?: string,
    language?: string,
  ) => Promise<ArtifactResponse | null>;

  /** Clear all server-scoped canvas state on a federated server switch. */
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

export const useCanvasStore = create<CanvasState>((set, get) => ({
  panelOpen: false,
  unseen: 0,
  roomId: null,
  artifacts: [],
  artifactsLoading: false,
  openArtifact: null,
  versions: [],
  viewIndex: -1,
  loading: false,
  error: null,

  // Opening the panel IS seeing it, so both setters clear the dot on open.
  setPanelOpen: (open) => set(open ? { panelOpen: true, unseen: 0 } : { panelOpen: false }),
  togglePanel: () =>
    set((s) => (s.panelOpen ? { panelOpen: false } : { panelOpen: true, unseen: 0 })),

  setRoom: (roomId) => {
    const prev = get().roomId;
    if (prev === roomId) return;
    // Switching rooms drops all per-room canvas state.
    set({
      roomId,
      artifacts: [],
      openArtifact: null,
      versions: [],
      viewIndex: -1,
      error: null,
      // The dot counts *live* arrivals in the room you're looking at; carrying
      // another room's count across a switch would be a lie.
      unseen: 0,
    });
    if (roomId) void get().refreshArtifacts(roomId);
  },

  refreshArtifacts: async (roomId) => {
    set({ artifactsLoading: true });
    try {
      const list = await api.getRoomArtifacts(roomId);
      // Ignore a response that resolved after the user switched rooms.
      if (get().roomId !== roomId) return;
      set({ artifacts: list, artifactsLoading: false });
    } catch (e) {
      if (get().roomId !== roomId) return;
      set({ artifactsLoading: false, error: errMsg(e) });
    }
  },

  openArtifactById: async (artifactId) => {
    set({ loading: true, error: null, panelOpen: true, unseen: 0 });
    try {
      const [artifact, versions] = await Promise.all([
        api.getArtifact(artifactId),
        api.getArtifactVersions(artifactId),
      ]);
      set({
        openArtifact: artifact,
        versions: versions.slice().sort((a, b) => a.seq - b.seq),
        viewIndex: -1, // show HEAD
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: errMsg(e) });
    }
  },

  refreshOpen: async () => {
    const current = get().openArtifact;
    if (!current) return;
    const artifactId = current.id;
    try {
      const [artifact, versions] = await Promise.all([
        api.getArtifact(artifactId),
        api.getArtifactVersions(artifactId),
      ]);
      // Bail if the user closed/swapped the artifact while we were fetching.
      if (get().openArtifact?.id !== artifactId) return;
      set({
        openArtifact: artifact,
        versions: versions.slice().sort((a, b) => a.seq - b.seq),
        // Snap back to HEAD on refresh so a new version is shown immediately.
        viewIndex: -1,
      });
    } catch (e) {
      if (get().openArtifact?.id !== artifactId) return;
      set({ error: errMsg(e) });
    }
  },

  closeArtifact: () =>
    set({ openArtifact: null, versions: [], viewIndex: -1, error: null }),

  setViewIndex: (index) => {
    const { versions } = get();
    // Clamp: -1 (HEAD) .. versions.length-1.
    const clamped = Math.max(-1, Math.min(index, versions.length - 1));
    set({ viewIndex: clamped });
  },

  createDraft: async (roomId, title, kind, content, language) => {
    set({ loading: true, error: null });
    try {
      const created = await api.createArtifact(roomId, {
        title,
        kind,
        content: content ?? "",
        ...(language ? { language } : {}),
      });
      // Refresh the list and open the new artifact.
      await get().refreshArtifacts(roomId);
      await get().openArtifactById(created.id);
      return created;
    } catch (e) {
      set({ loading: false, error: errMsg(e) });
      return null;
    }
  },

  resetForServer: () =>
    set({
      panelOpen: false,
      unseen: 0,
      roomId: null,
      artifacts: [],
      artifactsLoading: false,
      openArtifact: null,
      versions: [],
      viewIndex: -1,
      loading: false,
      error: null,
    }),
}));

/**
 * React to a broadcast artifact event. Called (outside React, via getState())
 * from BOTH realtime planes:
 *   - the room WebSocket subscription in RoomView — the plane that works when
 *     the user is simply in the room and not joined to a call, which is the
 *     common case and was previously not covered at all; and
 *   - the VoiceProvider's LiveKit DataReceived handler, for in-call clients.
 *
 * Both planes fire for the same event, so this must be idempotent — it is:
 * every branch is a re-fetch of current server state, and a duplicate just
 * costs one extra GET.
 *
 * Cheap when nothing relevant is open: it only re-fetches the OPEN artifact when
 * the event targets it, and refreshes the room list when the event is for the
 * canvas's current room. A foreign room's event is ignored entirely.
 */
export function handleArtifactEvent(msg: ArtifactEventMessage): void {
  const store = useCanvasStore.getState();
  // Only care about events for the room the canvas is scoped to.
  if (store.roomId && msg.room_id !== store.roomId) return;

  // If the changed artifact is the one open, re-pull it (content + versions).
  if (store.openArtifact && store.openArtifact.id === msg.artifact_id) {
    void store.refreshOpen();
  }

  // Keep the switcher list fresh (new artifact created, or updated_at bumped).
  // No-op cost is one list GET; only when the canvas has a room context.
  if (store.roomId) {
    void store.refreshArtifacts(store.roomId);
  }

  // Draw the eye to a closed drawer. Deliberately NOT an auto-open: barging the
  // canvas over an active conversation is worse than a missed doc. If the panel
  // is already open the user is looking at it, so there is nothing to flag.
  if (!store.panelOpen) {
    useCanvasStore.setState((s) => ({ unseen: s.unseen + 1 }));
  }
}
