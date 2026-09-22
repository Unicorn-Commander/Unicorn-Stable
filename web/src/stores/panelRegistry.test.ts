/**
 * Registry reducer + preset application. Pure: no DOM, no React.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESET_IDS,
  CHAT_DOCK_WIDTH,
  ROOM_PANEL_IDS,
  applyPreset,
  builtinPreset,
  defaultPanelMap,
  loadRoomPanels,
  panelOf,
  parseUserPresets,
  reducePanels,
  registryStorageKey,
  saveRoomPanels,
  upsertUserPreset,
  type KeyValueStore,
  type PanelMap,
} from "./panelRegistry";

function memoryStore(): KeyValueStore & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
  };
}

function modes(panels: PanelMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ROOM_PANEL_IDS) out[id] = panelOf(panels, id).mode;
  return out;
}

describe("panel registry reducer", () => {
  it("starts chat docked on the right at 360px", () => {
    const chat = defaultPanelMap().chat;
    expect(chat.mode).toBe("docked");
    expect(chat.dock).toBe("right");
    expect(chat.geometry.w).toBe(CHAT_DOCK_WIDTH);
    expect(CHAT_DOCK_WIDTH).toBe(360);
  });

  it("setMode hides chat without mutating the previous map", () => {
    const base = defaultPanelMap();
    const next = reducePanels(base, {
      type: "setMode",
      id: "chat",
      mode: "hidden",
    });
    expect(base.chat.mode).toBe("docked");
    expect(next.chat.mode).toBe("hidden");
    expect(next.stage.mode).toBe("docked");
    expect(next).not.toBe(base);
  });

  it("clamps geometry into the persisted range", () => {
    const next = reducePanels(defaultPanelMap(), {
      type: "setGeometry",
      id: "chat",
      geometry: { x: 999999, y: -999999, w: 10, h: 9 },
    });
    expect(next.chat.geometry).toEqual({
      x: 20000,
      y: -20000,
      w: 200,
      h: 120,
    });
  });

  it("storage key includes the room id and round-trips on a device store", () => {
    const roomId = "room-42";
    expect(registryStorageKey(roomId)).toBe("stable.panel.registry.room-42.v1");
    const store = memoryStore();
    const focus = builtinPreset("focus");
    saveRoomPanels(roomId, focus, store);
    expect(store.dump.has(registryStorageKey(roomId))).toBe(true);
    const loaded = loadRoomPanels(roomId, store);
    expect(loaded.chat.mode).toBe("hidden");
    expect(loaded.stage.mode).toBe("docked");
    expect(loadRoomPanels("other-room", store).chat.mode).toBe("docked");
  });

  it("does not resurrect a popped window after reload", () => {
    const store = memoryStore();
    saveRoomPanels("r", builtinPreset("show"), store);
    const loaded = loadRoomPanels("r", store);
    for (const id of ROOM_PANEL_IDS) {
      expect(panelOf(loaded, id).mode).toBe("docked");
    }
  });
});

describe("preset application", () => {
  it("Focus leaves only the stage", () => {
    const next = applyPreset(defaultPanelMap(), builtinPreset("focus"));
    expect(modes(next)).toEqual({
      chat: "hidden",
      replies: "hidden",
      members: "hidden",
      transcript: "hidden",
      canvas: "hidden",
      tasks: "hidden",
      threads: "hidden",
      stage: "docked",
    });
  });

  it("Studio docks chat at 360px on the right and the transcript along the bottom", () => {
    const next = applyPreset(defaultPanelMap(), builtinPreset("studio"));
    expect(next.stage.mode).toBe("docked");
    expect(next.chat.mode).toBe("docked");
    expect(next.chat.dock).toBe("right");
    expect(next.chat.geometry.w).toBe(360);
    expect(next.transcript.mode).toBe("docked");
    expect(next.transcript.dock).toBe("bottom");
    expect(next.canvas.mode).toBe("hidden");
    expect(next.members.mode).toBe("hidden");
  });

  it("Text makes chat the docked surface and the stage a small floating window", () => {
    const next = applyPreset(defaultPanelMap(), builtinPreset("text"));
    expect(next.chat.mode).toBe("docked");
    expect(next.stage.mode).toBe("floating");
    expect(next.stage.geometry.w).toBe(320);
    expect(next.stage.geometry.h).toBe(180);
    expect(next.transcript.mode).toBe("hidden");
  });

  it("Show pops every panel into its own window", () => {
    const next = applyPreset(defaultPanelMap(), builtinPreset("show"));
    for (const id of ROOM_PANEL_IDS) {
      expect(panelOf(next, id).mode).toBe("popped");
    }
    expect(BUILTIN_PRESET_IDS).toEqual(["focus", "studio", "text", "show"]);
  });

  it("applying a preset does not alias the preset's geometry", () => {
    const preset = builtinPreset("studio");
    const applied = applyPreset(defaultPanelMap(), preset);
    applied.chat.geometry.w = 10;
    expect(preset.chat.geometry.w).toBe(360);
  });

  it("saves a named preset and applying it restores that map", () => {
    const custom = reducePanels(defaultPanelMap(), {
      type: "setMode",
      id: "canvas",
      mode: "floating",
    });
    const saved = upsertUserPreset([], "My desk", custom);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe("My desk");
    const applied = applyPreset(defaultPanelMap(), saved[0]!.panels);
    expect(applied.canvas.mode).toBe("floating");
    expect(applied.chat.mode).toBe("docked");
    expect(applied.chat.geometry.w).toBe(360);

    const replaced = upsertUserPreset(saved, "my desk", builtinPreset("focus"));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.panels.chat.mode).toBe("hidden");
    expect(saved[0]?.panels.canvas.mode).toBe("floating");
  });

  it("keeps popped inside a saved preset (apply reopens the windows)", () => {
    const parsed = parseUserPresets([
      { id: "p1", name: "Show night", panels: builtinPreset("show") },
    ]);
    expect(parsed[0]?.panels.tasks.mode).toBe("popped");
    expect(parsed[0]?.panels.chat.mode).toBe("popped");
    const applied = applyPreset(defaultPanelMap(), parsed[0]!.panels);
    expect(applied.members.mode).toBe("popped");
  });
});
