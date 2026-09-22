/**
 * Call-layout actions shared by the call bar and the keyboard shortcuts.
 *
 * Preset application is a panel-map write plus the call-ui flags the existing
 * stage already reads (show transcript, chat collapsed, mobile intent). Pop-out
 * opens run synchronously so the browser still counts them as the user's gesture.
 */
import { pipManager } from "@/components/Room/popout/pipManager";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore, type MobileCallMode } from "@/stores/callUiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  readLiveRoom,
  usePanelChromeStore,
} from "@/stores/panelChromeStore";
import {
  ROOM_PANEL_IDS,
  builtinPreset,
  clonePanelMap,
  panelOf,
  type BuiltinPresetId,
  type PanelMap,
  type RoomPanelId,
} from "@/stores/panelRegistry";
import {
  closePanelWindow,
  openPanelWindow,
} from "@/components/Layout/panelOpeners";

let mirrorsInstalled = false;
let applyingPreset = false;

const POP_ORDER: readonly RoomPanelId[] = [
  "stage",
  "chat",
  "transcript",
  "canvas",
  "members",
  "tasks",
  "replies",
  "threads",
];

export function isDesktopViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 768px)").matches
  );
}

/** Mirror the captions toggle into the registry, except while a preset is landing. */
export function installCallLayoutMirrors(): void {
  if (mirrorsInstalled) return;
  mirrorsInstalled = true;
  useCallUiStore.subscribe((state, prev) => {
    if (applyingPreset) return;
    if (state.showTranscript === prev.showTranscript) return;
    const roomId = state.activeCallRoomId;
    if (!roomId) return;
    const chrome = usePanelChromeStore.getState();
    const cur = chrome.getPanel(roomId, "transcript").mode;
    if (!state.showTranscript) {
      if (cur === "popped" || cur === "floating") {
        closePanelWindow(roomId, "transcript");
      }
      if (cur !== "hidden") chrome.setPanelMode(roomId, "transcript", "hidden");
      return;
    }
    if (cur === "popped" || cur === "floating") return;
    if (cur !== "docked") chrome.setPanelMode(roomId, "transcript", "docked");
  });
}

function currentView(roomId: string): string {
  return useCallUiStore.getState().viewModes[roomId] ?? "compact";
}

function liftStage(roomId: string): void {
  const ui = useCallUiStore.getState();
  ui.toggleVideo(true);
  const view = currentView(roomId);
  if (view === "compact" || view === "sidebar") ui.setViewMode(roomId, "grid");
}

export function requestStagePip(): boolean {
  if (typeof document === "undefined") return false;
  if (!pipManager.isSupported()) return false;
  const scoped = document.querySelector("[data-stage-root] video");
  const fallback = document.querySelector(
    '[aria-label="Voice and video call"] video',
  );
  const video = scoped ?? fallback;
  if (!(video instanceof HTMLVideoElement)) return false;
  void pipManager.requestPip(video, "call-stage").catch(() => {});
  return true;
}

export function chatIsVisible(opts: {
  mode: PanelMap["chat"]["mode"];
  desktop: boolean;
  mobileCallMode: MobileCallMode;
}): boolean {
  if (!opts.desktop) {
    return opts.mobileCallMode !== "video" && opts.mode !== "hidden";
  }
  return opts.mode !== "hidden";
}

export function toggleCallChat(roomId: string): void {
  const chrome = usePanelChromeStore.getState();
  const ui = useCallUiStore.getState();
  const mode = chrome.getPanel(roomId, "chat").mode;
  const desktop = isDesktopViewport();
  if (!desktop) {
    const hidden = ui.mobileCallMode === "video" || mode === "hidden";
    if (hidden) {
      if (mode === "popped") closePanelWindow(roomId, "chat");
      chrome.setPanelMode(roomId, "chat", "docked");
      ui.setMobileCallMode("split", { user: true });
      ui.setMobileChatSheet(null);
      ui.setChatCollapsed(false);
    } else {
      if (mode === "popped") closePanelWindow(roomId, "chat");
      chrome.setPanelMode(roomId, "chat", "hidden");
      ui.setMobileCallMode("video", { user: true });
      ui.setMobileChatSheet(null);
      ui.setChatCollapsed(true);
    }
    return;
  }
  if (mode === "hidden") {
    chrome.setPanelMode(roomId, "chat", "docked");
    ui.setChatCollapsed(false);
    return;
  }
  if (mode === "popped") closePanelWindow(roomId, "chat");
  chrome.setPanelMode(roomId, "chat", "hidden");
  ui.setChatCollapsed(true);
}

export function popPanel(roomId: string, id: RoomPanelId): boolean {
  const chrome = usePanelChromeStore.getState();
  const cur = chrome.getPanel(roomId, id).mode;
  if (cur === "popped") {
    closePanelWindow(roomId, id);
    chrome.setPanelMode(roomId, id, "docked");
    if (id === "chat") useCallUiStore.getState().setChatCollapsed(false);
    return true;
  }
  chrome.setPanelMode(roomId, id, "popped");
  const ok = openPanelWindow(roomId, id);
  if (!ok) {
    chrome.setPanelMode(roomId, id, cur);
    return false;
  }
  if (id === "canvas") useCanvasStore.getState().setPanelOpen(true);
  if (id === "members") useAppStore.getState().setParticipantPanelOpen(true);
  if (id === "chat") useCallUiStore.getState().setChatCollapsed(true);
  return true;
}

export function floatPanel(roomId: string, id: RoomPanelId): void {
  const chrome = usePanelChromeStore.getState();
  const cur = chrome.getPanel(roomId, id).mode;
  if (cur === "popped") closePanelWindow(roomId, id);
  chrome.setPanelMode(roomId, id, cur === "floating" ? "docked" : "floating");
}

function syncCompanionSurfaces(roomId: string, panels: PanelMap): void {
  const ui = useCallUiStore.getState();
  const desktop = isDesktopViewport();
  ui.setChatCollapsed(panels.chat.mode !== "docked" && panels.chat.mode !== "floating");
  ui.toggleTranscript(panels.transcript.mode !== "hidden");
  if (panels.stage.mode === "floating") {
    liftStage(roomId);
    if (!desktop) ui.setMobileCallMode("chat", { user: true });
  } else if (panels.chat.mode === "hidden") {
    liftStage(roomId);
    if (!desktop) ui.setMobileCallMode("video", { user: true });
  } else if (panels.chat.mode === "docked" && panels.stage.mode === "docked") {
    liftStage(roomId);
    if (!desktop) ui.setMobileCallMode("split", { user: true });
  }
  if (panels.members.mode === "hidden") {
    useAppStore.getState().setParticipantPanelOpen(false);
  } else {
    useAppStore.getState().setParticipantPanelOpen(true);
  }
  if (panels.canvas.mode === "hidden") {
    useCanvasStore.getState().setPanelOpen(false);
  } else {
    useCanvasStore.getState().setPanelOpen(true);
  }
}

function openPopped(roomId: string, panels: PanelMap): void {
  const chrome = usePanelChromeStore.getState();
  for (const id of POP_ORDER) {
    if (panelOf(panels, id).mode !== "popped") continue;
    if (!openPanelWindow(roomId, id)) {
      chrome.setPanelMode(roomId, id, "docked");
    }
  }
}

export function applyCallPreset(
  roomId: string,
  source: BuiltinPresetId | PanelMap,
): void {
  const panels =
    typeof source === "string" ? builtinPreset(source) : clonePanelMap(source);
  applyingPreset = true;
  try {
    usePanelChromeStore.getState().replaceRoomPanels(roomId, panels, true);
    syncCompanionSurfaces(roomId, panels);
    openPopped(roomId, panels);
    if (panelOf(panels, "stage").mode === "floating") requestStagePip();
  } finally {
    applyingPreset = false;
  }
}

export function saveCurrentLayout(roomId: string, name: string): void {
  const panels = usePanelChromeStore.getState().rooms[roomId] ?? readLiveRoom(roomId);
  usePanelChromeStore.getState().saveUserPreset(name, panels);
}

export function presetModesMatch(a: PanelMap, b: PanelMap): boolean {
  return ROOM_PANEL_IDS.every(
    (id) => panelOf(a, id).mode === panelOf(b, id).mode,
  );
}
