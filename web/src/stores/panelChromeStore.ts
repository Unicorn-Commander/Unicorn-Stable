/**
 * Presentation chrome for resizable / floatable / pop-out panels.
 *
 * Each named panel (people, saved, …) remembers:
 *  - presentation: dock | float | overlay
 *  - float geometry (x/y/w/h) for in-app floating windows
 *
 * True browser pop-outs are ephemeral (browser may block); we only remember
 * that the user prefers popout so reopen can try again.
 */

import { create } from "zustand";
import {
  applyPreset,
  clonePanelMap,
  defaultPanelMap,
  loadRoomPanels,
  panelOf,
  parseUserPresets,
  PRESET_STORAGE_KEY,
  reducePanels,
  removeUserPreset,
  saveRoomPanels,
  upsertUserPreset,
  type BuiltinPresetId,
  type KeyValueStore,
  type PanelDock,
  type PanelGeometry,
  type PanelMap,
  type PanelMode,
  type PanelRecord,
  type RoomPanelId,
  type UserPreset,
} from "./panelRegistry";

export type {
  BuiltinPresetId,
  PanelDock,
  PanelGeometry,
  PanelMap,
  PanelMode,
  PanelRecord,
  RoomPanelId,
  UserPreset,
};
export {
  BUILTIN_PRESET_IDS,
  CHAT_DOCK_WIDTH,
  ROOM_PANEL_IDS,
  builtinPreset,
} from "./panelRegistry";

export type PanelPresentation = "dock" | "float" | "overlay";

export type PanelId = "people" | "saved" | "activity";

export interface FloatGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PRES_KEY = (id: string) => `stable.panel.presentation.${id}.v1`;
const FLOAT_KEY = (id: string) => `stable.panel.float.${id}.v1`;

function readPresentation(id: PanelId, fallback: PanelPresentation): PanelPresentation {
  try {
    const raw = localStorage.getItem(PRES_KEY(id));
    if (raw === "dock" || raw === "float" || raw === "overlay") return raw;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writePresentation(id: PanelId, value: PanelPresentation) {
  try {
    localStorage.setItem(PRES_KEY(id), value);
  } catch {
    /* ignore */
  }
}

function readFloat(id: PanelId, fallback: FloatGeometry): FloatGeometry {
  try {
    const raw = localStorage.getItem(FLOAT_KEY(id));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<FloatGeometry>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.w === "number" &&
      typeof parsed.h === "number"
    ) {
      return {
        x: Math.round(parsed.x),
        y: Math.round(parsed.y),
        w: Math.round(parsed.w),
        h: Math.round(parsed.h),
      };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeFloat(id: PanelId, geom: FloatGeometry) {
  try {
    localStorage.setItem(FLOAT_KEY(id), JSON.stringify(geom));
  } catch {
    /* ignore */
  }
}

function defaultFloat(id: PanelId): FloatGeometry {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  if (id === "people") {
    return { x: Math.max(24, vw - 420), y: 72, w: 380, h: Math.min(640, vh - 96) };
  }
  return { x: Math.max(48, vw / 2 - 280), y: 80, w: 520, h: Math.min(560, vh - 120) };
}

/** Live room maps. Popped windows live here for the session only. */
const liveRooms = new Map<string, PanelMap>();

function browserStorage(): KeyValueStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readLiveRoom(roomId: string): PanelMap {
  const hit = liveRooms.get(roomId);
  if (hit) return hit;
  const storage = browserStorage();
  const loaded = storage ? loadRoomPanels(roomId, storage) : defaultPanelMap();
  liveRooms.set(roomId, loaded);
  return loaded;
}

function commitRoom(
  roomId: string,
  panels: PanelMap,
): PanelMap {
  const next = clonePanelMap(panels);
  liveRooms.set(roomId, next);
  const storage = browserStorage();
  if (storage) saveRoomPanels(roomId, next, storage);
  return next;
}

function loadPresets(): UserPreset[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    return parseUserPresets(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function writePresets(list: UserPreset[]) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

interface PanelChromeState {
  presentation: Record<PanelId, PanelPresentation>;
  floatGeom: Record<PanelId, FloatGeometry>;
  /** In-app: prefer browser pop-out when available (desktop). */
  preferPopout: Partial<Record<PanelId, boolean>>;
  setPresentation: (id: PanelId, mode: PanelPresentation) => void;
  setFloatGeom: (id: PanelId, geom: FloatGeometry) => void;
  setPreferPopout: (id: PanelId, prefer: boolean) => void;

  /** Per-room panel registry. Missing until {@link ensureRoom}. */
  rooms: Record<string, PanelMap>;
  /** Bumped when a preset is applied so the chat split adopts its width. */
  layoutEpoch: Record<string, number>;
  userPresets: UserPreset[];
  ensureRoom: (roomId: string) => void;
  getPanel: (roomId: string, id: RoomPanelId) => PanelRecord;
  setPanelMode: (roomId: string, id: RoomPanelId, mode: PanelMode) => void;
  setPanelDock: (roomId: string, id: RoomPanelId, dock: PanelDock) => void;
  setPanelGeometry: (
    roomId: string,
    id: RoomPanelId,
    geometry: PanelGeometry,
  ) => void;
  replaceRoomPanels: (roomId: string, panels: PanelMap, fromPreset?: boolean) => void;
  saveUserPreset: (name: string, panels: PanelMap) => void;
  deleteUserPreset: (id: string) => void;
}

export const usePanelChromeStore = create<PanelChromeState>((set, get) => ({
  presentation: {
    people: readPresentation("people", "dock"),
    saved: readPresentation("saved", "float"),
    activity: readPresentation("activity", "float"),
  },
  floatGeom: {
    people: readFloat("people", defaultFloat("people")),
    saved: readFloat("saved", defaultFloat("saved")),
    activity: readFloat("activity", defaultFloat("activity")),
  },
  preferPopout: {},
  rooms: {},
  layoutEpoch: {},
  userPresets: loadPresets(),
  ensureRoom: (roomId) => {
    const loaded = readLiveRoom(roomId);
    set((s) =>
      s.rooms[roomId] ? s : { rooms: { ...s.rooms, [roomId]: loaded } },
    );
  },
  getPanel: (roomId, id) => panelOf(readLiveRoom(roomId), id),
  setPanelMode: (roomId, id, mode) => {
    const next = commitRoom(
      roomId,
      reducePanels(readLiveRoom(roomId), { type: "setMode", id, mode }),
    );
    set((s) => ({ rooms: { ...s.rooms, [roomId]: next } }));
  },
  setPanelDock: (roomId, id, dock) => {
    const next = commitRoom(
      roomId,
      reducePanels(readLiveRoom(roomId), { type: "setDock", id, dock }),
    );
    set((s) => ({ rooms: { ...s.rooms, [roomId]: next } }));
  },
  setPanelGeometry: (roomId, id, geometry) => {
    const next = commitRoom(
      roomId,
      reducePanels(readLiveRoom(roomId), {
        type: "setGeometry",
        id,
        geometry,
      }),
    );
    set((s) => ({ rooms: { ...s.rooms, [roomId]: next } }));
  },
  replaceRoomPanels: (roomId, panels, fromPreset = false) => {
    const next = commitRoom(roomId, applyPreset(readLiveRoom(roomId), panels));
    set((s) => ({
      rooms: { ...s.rooms, [roomId]: next },
      layoutEpoch: fromPreset
        ? { ...s.layoutEpoch, [roomId]: (s.layoutEpoch[roomId] ?? 0) + 1 }
        : s.layoutEpoch,
    }));
  },
  saveUserPreset: (name, panels) => {
    const next = upsertUserPreset(get().userPresets, name, panels);
    writePresets(next);
    set({ userPresets: next });
  },
  deleteUserPreset: (id) => {
    const next = removeUserPreset(get().userPresets, id);
    writePresets(next);
    set({ userPresets: next });
  },
  setPresentation: (id, mode) => {
    writePresentation(id, mode);
    set((s) => ({
      presentation: { ...s.presentation, [id]: mode },
      preferPopout: { ...s.preferPopout, [id]: false },
    }));
  },
  setFloatGeom: (id, geom) => {
    writeFloat(id, geom);
    set((s) => ({
      floatGeom: { ...s.floatGeom, [id]: geom },
    }));
  },
  setPreferPopout: (id, prefer) =>
    set((s) => ({
      preferPopout: { ...s.preferPopout, [id]: prefer },
    })),
}));
