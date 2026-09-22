import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import type { BuiltinPresetId, RoomPanelId } from "@/stores/panelRegistry";
import { applyCallPreset, popPanel, toggleCallChat } from "@/lib/callLayoutActions";

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

const POP_KEYS: Record<string, RoomPanelId> = {
  KeyC: "chat",
  KeyT: "transcript",
  KeyM: "members",
  KeyA: "canvas",
  KeyK: "tasks",
};

const PRESET_KEYS: Record<string, BuiltinPresetId> = {
  Digit1: "focus",
  Digit2: "studio",
  Digit3: "text",
  Digit4: "show",
};

/**
 * Call-layout keys. Ignored while typing and when this room is not in a call.
 * `c` toggles chat. Alt+1…4 apply presets. Alt+Shift pops a panel out.
 */
export function useRoomPanelHotkeys(roomId: string): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      const ui = useCallUiStore.getState();
      const callHere =
        ui.activeCallRoomId === roomId && useAppStore.getState().voiceActive;
      if (!callHere) return;

      if (e.altKey && e.shiftKey) {
        const id = POP_KEYS[e.code];
        if (!id) return;
        e.preventDefault();
        popPanel(roomId, id);
        return;
      }
      if (e.altKey && !e.shiftKey) {
        const preset = PRESET_KEYS[e.code];
        if (!preset) return;
        e.preventDefault();
        applyCallPreset(roomId, preset);
        return;
      }
      if (!e.altKey && !e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        toggleCallChat(roomId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roomId]);
}
