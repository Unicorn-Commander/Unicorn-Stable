import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import type { BuiltinPresetId, RoomPanelId } from "@/stores/panelRegistry";
import {
  applyCallPreset,
  popPanel,
  toggleCallChat,
} from "@/lib/callLayoutActions";

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

const POP_BY_KEY: Record<string, RoomPanelId> = {
  c: "chat",
  t: "transcript",
  m: "members",
  a: "canvas",
  k: "tasks",
};

/** `e.key`, including the shifted US digit, so Alt+Shift+1 matches on QWERTY. */
const PRESET_BY_KEY: Record<string, BuiltinPresetId> = {
  "1": "focus",
  "!": "focus",
  "2": "studio",
  "@": "studio",
  "3": "text",
  "#": "text",
  "4": "show",
  $: "show",
};

export type CallLayoutShortcut =
  | { type: "chat" }
  | { type: "preset"; id: BuiltinPresetId }
  | { type: "pop"; id: RoomPanelId };

/**
 * Character from `e.key`, not `e.code`. `code` is the physical key, so C and
 * the digit row miss on Dvorak and AZERTY. Presets are Alt+Shift+1…4 because
 * Alt+1…4 switches Firefox tabs.
 */
export function matchCallLayoutShortcut(e: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
}): CallLayoutShortcut | null {
  if (e.metaKey || e.ctrlKey || e.repeat) return null;
  if (e.altKey && e.shiftKey) {
    const preset = PRESET_BY_KEY[e.key];
    if (preset) return { type: "preset", id: preset };
    const letter = e.key.length === 1 ? e.key.toLowerCase() : "";
    const pop = POP_BY_KEY[letter];
    if (pop) return { type: "pop", id: pop };
    return null;
  }
  if (e.altKey || e.shiftKey) return null;
  if (e.key === "c" || e.key === "C") return { type: "chat" };
  return null;
}

/**
 * Call-layout keys. Ignored while typing and when this room is not in a call.
 * `c` toggles chat. Alt+Shift+1…4 apply presets. Alt+Shift+letter pops a panel.
 */
export function useRoomPanelHotkeys(roomId: string): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const ui = useCallUiStore.getState();
      const callHere =
        ui.activeCallRoomId === roomId && useAppStore.getState().voiceActive;
      if (!callHere) return;
      const shortcut = matchCallLayoutShortcut(e);
      if (!shortcut) return;
      e.preventDefault();
      if (shortcut.type === "chat") toggleCallChat(roomId);
      else if (shortcut.type === "preset") applyCallPreset(roomId, shortcut.id);
      else popPanel(roomId, shortcut.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roomId]);
}
