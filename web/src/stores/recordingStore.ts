import { create } from "zustand";
import {
  IDLE_RECORDING,
  parseRecordingFrame,
  reduceRecordingState,
  type RecordingState,
  type RecordingTransition,
} from "@/lib/recording";

interface RecordingStore {
  byRoom: Record<string, RecordingState>;
  /** Apply a `recording_state` frame. Null when the frame is unreadable. */
  applyFrame: (roomId: string, raw: unknown) => (RecordingTransition & { roomId: string }) | null;
  /** A guest who joined a room that is already recording, without a chime. */
  seedIfIdle: (roomId: string, state: RecordingState) => void;
  clearRoom: (roomId: string) => void;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  byRoom: {},
  applyFrame: (roomId, raw) => {
    const frame = parseRecordingFrame(raw);
    if (!frame) return null;
    const id = frame.roomId ?? roomId;
    if (!id) return null;
    const prev = get().byRoom[id] ?? IDLE_RECORDING;
    const reduced = reduceRecordingState(prev, frame.state);
    if (
      reduced.transition === "none" &&
      reduced.next.active === prev.active &&
      reduced.next.kind === prev.kind &&
      reduced.next.startedBy === prev.startedBy &&
      reduced.next.startedByName === prev.startedByName &&
      reduced.next.startedAt === prev.startedAt
    ) {
      return { ...reduced, roomId: id };
    }
    set((state) => ({ byRoom: { ...state.byRoom, [id]: reduced.next } }));
    return { ...reduced, roomId: id };
  },
  seedIfIdle: (roomId, state) => {
    if (!roomId || !state.active) return;
    const current = get().byRoom[roomId];
    if (current?.active) return;
    set((store) => ({ byRoom: { ...store.byRoom, [roomId]: state } }));
  },
  clearRoom: (roomId) =>
    set((state) => {
      if (!state.byRoom[roomId]) return state;
      const byRoom = { ...state.byRoom };
      delete byRoom[roomId];
      return { byRoom };
    }),
}));
