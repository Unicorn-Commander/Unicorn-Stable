/**
 * Room panel registry — pure model for layout presets.
 *
 * A panel is `{ mode, dock, geometry }`. Modes: docked (in the room), floating
 * (in-app window), popped (real browser window via the existing pop-out
 * portal), hidden. The map is persisted per room per device; a popped mode
 * does not survive a reload because the window cannot.
 *
 * Presets are just maps. Applying one replaces the room's panels. Users can
 * save a named copy of whatever the room is showing.
 */

export const ROOM_PANEL_IDS = [
  "chat",
  "replies",
  "members",
  "transcript",
  "canvas",
  "tasks",
  "threads",
  "stage",
] as const;

export type RoomPanelId = (typeof ROOM_PANEL_IDS)[number];

export type PanelMode = "docked" | "floating" | "popped" | "hidden";

export type PanelDock = "left" | "right" | "bottom";

export interface PanelGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelRecord {
  mode: PanelMode;
  dock: PanelDock;
  geometry: PanelGeometry;
}

export interface PanelMap {
  chat: PanelRecord;
  replies: PanelRecord;
  members: PanelRecord;
  transcript: PanelRecord;
  canvas: PanelRecord;
  tasks: PanelRecord;
  threads: PanelRecord;
  stage: PanelRecord;
}

/** Docked chat width on desktop. Tiles sit in the stage column beside it. */
export const CHAT_DOCK_WIDTH = 360;

export type BuiltinPresetId = "focus" | "studio" | "text" | "show";

export const BUILTIN_PRESET_IDS: readonly BuiltinPresetId[] = [
  "focus",
  "studio",
  "text",
  "show",
];

export interface UserPreset {
  id: string;
  name: string;
  panels: PanelMap;
}

export type RegistryAction =
  | { type: "setMode"; id: RoomPanelId; mode: PanelMode }
  | { type: "setDock"; id: RoomPanelId; dock: PanelDock }
  | { type: "setGeometry"; id: RoomPanelId; geometry: PanelGeometry }
  | { type: "applyPreset"; panels: PanelMap };

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MODES: ReadonlySet<string> = new Set([
  "docked",
  "floating",
  "popped",
  "hidden",
]);
const DOCKS: ReadonlySet<string> = new Set(["left", "right", "bottom"]);

/** localStorage key for one room on this device. */
export function registryStorageKey(roomId: string): string {
  return `stable.panel.registry.${roomId}.v1`;
}

export const PRESET_STORAGE_KEY = "stable.panel.presets.v1";

function geom(
  x: number,
  y: number,
  w: number,
  h: number,
): PanelGeometry {
  return { x, y, w, h };
}

function rec(
  mode: PanelMode,
  dock: PanelDock,
  geometry: PanelGeometry,
): PanelRecord {
  return { mode, dock, geometry };
}

export function defaultGeometry(id: RoomPanelId): PanelGeometry {
  switch (id) {
    case "chat":
      return geom(880, 72, CHAT_DOCK_WIDTH, 640);
    case "transcript":
      return geom(160, 520, 720, 220);
    case "stage":
      return geom(80, 48, 960, 600);
    case "canvas":
      return geom(420, 64, 640, 720);
    case "members":
      return geom(900, 72, 320, 640);
    case "tasks":
      return geom(860, 96, 360, 560);
    case "threads":
      return geom(780, 88, 380, 560);
    case "replies":
      return geom(720, 80, 400, 640);
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

export function defaultRecord(id: RoomPanelId): PanelRecord {
  switch (id) {
    case "chat":
      return rec("docked", "right", defaultGeometry(id));
    case "transcript":
      // Captions default on today; the registry matches that.
      return rec("docked", "bottom", defaultGeometry(id));
    case "stage":
      return rec("docked", "left", defaultGeometry(id));
    case "replies":
    case "members":
    case "canvas":
    case "tasks":
    case "threads":
      return rec("hidden", "right", defaultGeometry(id));
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

export function defaultPanelMap(): PanelMap {
  return {
    chat: defaultRecord("chat"),
    replies: defaultRecord("replies"),
    members: defaultRecord("members"),
    transcript: defaultRecord("transcript"),
    canvas: defaultRecord("canvas"),
    tasks: defaultRecord("tasks"),
    threads: defaultRecord("threads"),
    stage: defaultRecord("stage"),
  };
}

export function panelOf(panels: PanelMap, id: RoomPanelId): PanelRecord {
  switch (id) {
    case "chat":
      return panels.chat;
    case "replies":
      return panels.replies;
    case "members":
      return panels.members;
    case "transcript":
      return panels.transcript;
    case "canvas":
      return panels.canvas;
    case "tasks":
      return panels.tasks;
    case "threads":
      return panels.threads;
    case "stage":
      return panels.stage;
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

export function clampGeometry(g: PanelGeometry): PanelGeometry {
  const n = (v: number, lo: number, hi: number) =>
    Math.round(Math.min(hi, Math.max(lo, v)));
  return {
    x: n(g.x, -20000, 20000),
    y: n(g.y, -20000, 20000),
    w: n(g.w, 200, 1600),
    h: n(g.h, 120, 1200),
  };
}

function cloneRecord(r: PanelRecord): PanelRecord {
  return {
    mode: r.mode,
    dock: r.dock,
    geometry: { ...r.geometry },
  };
}

export function clonePanelMap(panels: PanelMap): PanelMap {
  return {
    chat: cloneRecord(panels.chat),
    replies: cloneRecord(panels.replies),
    members: cloneRecord(panels.members),
    transcript: cloneRecord(panels.transcript),
    canvas: cloneRecord(panels.canvas),
    tasks: cloneRecord(panels.tasks),
    threads: cloneRecord(panels.threads),
    stage: cloneRecord(panels.stage),
  };
}

function writePanel(
  panels: PanelMap,
  id: RoomPanelId,
  record: PanelRecord,
): PanelMap {
  const next = clonePanelMap(panels);
  const safe = cloneRecord(record);
  switch (id) {
    case "chat":
      next.chat = safe;
      break;
    case "replies":
      next.replies = safe;
      break;
    case "members":
      next.members = safe;
      break;
    case "transcript":
      next.transcript = safe;
      break;
    case "canvas":
      next.canvas = safe;
      break;
    case "tasks":
      next.tasks = safe;
      break;
    case "threads":
      next.threads = safe;
      break;
    case "stage":
      next.stage = safe;
      break;
    default: {
      const _never: never = id;
      return _never;
    }
  }
  return next;
}

export function reducePanels(panels: PanelMap, action: RegistryAction): PanelMap {
  switch (action.type) {
    case "setMode": {
      const cur = panelOf(panels, action.id);
      if (cur.mode === action.mode) return panels;
      return writePanel(panels, action.id, { ...cur, mode: action.mode });
    }
    case "setDock": {
      const cur = panelOf(panels, action.id);
      if (cur.dock === action.dock) return panels;
      return writePanel(panels, action.id, { ...cur, dock: action.dock });
    }
    case "setGeometry": {
      const cur = panelOf(panels, action.id);
      return writePanel(panels, action.id, {
        ...cur,
        geometry: clampGeometry(action.geometry),
      });
    }
    case "applyPreset":
      return clonePanelMap(action.panels);
    default: {
      const _never: never = action;
      return _never;
    }
  }
}

function mapModes(
  base: PanelMap,
  modeFor: (id: RoomPanelId) => PanelMode,
): PanelMap {
  let next = base;
  for (const id of ROOM_PANEL_IDS) {
    next = reducePanels(next, { type: "setMode", id, mode: modeFor(id) });
  }
  return next;
}

/**
 * Order a Show gesture tries windows in. Browsers allow about one
 * `window.open` per click, so only the first panel that is not already
 * open gets a window. The rest stay hidden until the next gesture.
 */
export const POP_GESTURE_ORDER: readonly RoomPanelId[] = [
  "stage",
  "chat",
  "transcript",
  "canvas",
  "members",
  "tasks",
  "replies",
  "threads",
];

export interface PopGesturePlan {
  /** Preset map after panels that will not open this click are hidden. */
  panels: PanelMap;
  /** The one panel to pass to `window.open`, or null when nothing new is popped. */
  toOpen: RoomPanelId | null;
  /** Popped panels this click did not open. They are hidden, not docked. */
  deferred: RoomPanelId[];
}

/**
 * One new browser window per user gesture.
 *
 * `alreadyOpen` panels keep `popped` and do not spend the gesture. Every
 * other popped panel past the first becomes `hidden` — never `docked` — so
 * a blocked or skipped pop cannot leave a Tasks/Threads column or force the
 * members drawer and canvas open.
 */
export function planPopGesture(
  panels: PanelMap,
  alreadyOpen: ReadonlySet<RoomPanelId>,
): PopGesturePlan {
  let toOpen: RoomPanelId | null = null;
  const deferred: RoomPanelId[] = [];
  let next = panels;
  for (const id of POP_GESTURE_ORDER) {
    if (panelOf(panels, id).mode !== "popped") continue;
    if (alreadyOpen.has(id)) continue;
    if (toOpen === null) {
      toOpen = id;
      continue;
    }
    deferred.push(id);
    next = reducePanels(next, { type: "setMode", id, mode: "hidden" });
  }
  return { panels: next, toOpen, deferred };
}

/** A `window.open` that did not open must not be stored as docked. */
export function hideFailedPop(panels: PanelMap, id: RoomPanelId): PanelMap {
  if (panelOf(panels, id).mode !== "popped") return panels;
  return reducePanels(panels, { type: "setMode", id, mode: "hidden" });
}

/**
 * Built-in call layouts. Each is a full panel map.
 *
 * - Focus: stage only.
 * - Studio: stage + chat (360px, right) + transcript.
 * - Text: chat is the main surface; the stage is a small floating window
 *   the call bar also sends to Picture-in-Picture.
 * - Show: the intent map pops every panel. Applying it
 *   ({@link planPopGesture}) opens one window and hides the rest.
 */
export function builtinPreset(id: BuiltinPresetId): PanelMap {
  const base = defaultPanelMap();
  switch (id) {
    case "focus":
      return mapModes(base, (panel) => (panel === "stage" ? "docked" : "hidden"));
    case "studio": {
      let next = mapModes(base, (panel) => {
        if (panel === "stage" || panel === "chat" || panel === "transcript") {
          return "docked";
        }
        return "hidden";
      });
      next = reducePanels(next, {
        type: "setDock",
        id: "chat",
        dock: "right",
      });
      next = reducePanels(next, {
        type: "setDock",
        id: "transcript",
        dock: "bottom",
      });
      const chat = panelOf(next, "chat");
      next = reducePanels(next, {
        type: "setGeometry",
        id: "chat",
        geometry: { ...chat.geometry, w: CHAT_DOCK_WIDTH },
      });
      return next;
    }
    case "text": {
      let next = mapModes(base, (panel) => {
        if (panel === "chat") return "docked";
        if (panel === "stage") return "floating";
        return "hidden";
      });
      const stage = panelOf(next, "stage");
      next = reducePanels(next, {
        type: "setGeometry",
        id: "stage",
        geometry: { ...stage.geometry, x: 24, y: 24, w: 320, h: 180 },
      });
      return next;
    }
    case "show":
      return mapModes(base, () => "popped");
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

export function applyPreset(panels: PanelMap, preset: PanelMap): PanelMap {
  return reducePanels(panels, { type: "applyPreset", panels: preset });
}

function finiteGeom(raw: unknown): PanelGeometry | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Partial<PanelGeometry>;
  if (
    typeof g.x !== "number" ||
    typeof g.y !== "number" ||
    typeof g.w !== "number" ||
    typeof g.h !== "number" ||
    !Number.isFinite(g.x) ||
    !Number.isFinite(g.y) ||
    !Number.isFinite(g.w) ||
    !Number.isFinite(g.h)
  ) {
    return null;
  }
  return clampGeometry({ x: g.x, y: g.y, w: g.w, h: g.h });
}

export function coercePanelRecord(
  id: RoomPanelId,
  raw: unknown,
  opts?: { keepPopped?: boolean },
): PanelRecord {
  const fallback = defaultRecord(id);
  if (!raw || typeof raw !== "object") return cloneRecord(fallback);
  const r = raw as Partial<PanelRecord>;
  const mode = typeof r.mode === "string" && MODES.has(r.mode) ? r.mode : fallback.mode;
  const dock = typeof r.dock === "string" && DOCKS.has(r.dock) ? r.dock : fallback.dock;
  const geometry = finiteGeom(r.geometry) ?? { ...fallback.geometry };
  const persisted: PanelMode =
    mode === "popped" && !opts?.keepPopped ? "docked" : mode;
  return { mode: persisted, dock, geometry };
}

export function coercePanelMap(
  raw: unknown,
  opts?: { keepPopped?: boolean },
): PanelMap {
  const base = defaultPanelMap();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<Record<RoomPanelId, unknown>>;
  let next = base;
  for (const id of ROOM_PANEL_IDS) {
    next = writePanel(
      next,
      id,
      coercePanelRecord(id, obj[id], opts),
    );
  }
  return next;
}

/** Drop popped → docked so a reload never claims a window that is gone. */
export function sanitizeForDisk(panels: PanelMap): PanelMap {
  return coercePanelMap(panels, { keepPopped: false });
}

export function loadRoomPanels(roomId: string, storage: KeyValueStore): PanelMap {
  try {
    const raw = storage.getItem(registryStorageKey(roomId));
    if (!raw) return defaultPanelMap();
    return coercePanelMap(JSON.parse(raw) as unknown, { keepPopped: false });
  } catch {
    return defaultPanelMap();
  }
}

export function saveRoomPanels(
  roomId: string,
  panels: PanelMap,
  storage: KeyValueStore,
): void {
  try {
    storage.setItem(
      registryStorageKey(roomId),
      JSON.stringify(sanitizeForDisk(panels)),
    );
  } catch {
    /* quota / private mode — the in-memory map still applies */
  }
}

const MAX_PRESET_NAME = 40;

export function normalizePresetName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_PRESET_NAME);
}

export function upsertUserPreset(
  list: readonly UserPreset[],
  name: string,
  panels: PanelMap,
): UserPreset[] {
  const clean = normalizePresetName(name);
  if (!clean) return list.slice();
  const panelsCopy = clonePanelMap(panels);
  const existing = list.findIndex(
    (p) => p.name.toLowerCase() === clean.toLowerCase(),
  );
  if (existing >= 0) {
    const next = list.slice();
    const prev = next[existing];
    if (!prev) return next;
    next[existing] = { id: prev.id, name: clean, panels: panelsCopy };
    return next;
  }
  return [
    ...list,
    {
      id: `preset-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${list.length + 1}`,
      name: clean,
      panels: panelsCopy,
    },
  ];
}

export function removeUserPreset(
  list: readonly UserPreset[],
  id: string,
): UserPreset[] {
  return list.filter((p) => p.id !== id);
}

export function parseUserPresets(raw: unknown): UserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: UserPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<UserPreset>;
    if (typeof rec.id !== "string" || typeof rec.name !== "string") continue;
    const name = normalizePresetName(rec.name);
    if (!name) continue;
    out.push({
      id: rec.id,
      name,
      panels: coercePanelMap(rec.panels, { keepPopped: true }),
    });
  }
  return out;
}
