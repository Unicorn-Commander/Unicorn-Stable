/**
 * Call-layout actions shared by the call bar and the keyboard shortcuts.
 *
 * Preset application writes the panel map, then the call-ui flags the stage
 * already reads (transcript, mobile intent). A pop-out open runs synchronously
 * inside the user's gesture. Show opens one window per gesture; the rest are
 * hidden, not docked, until the next gesture.
 */
import { pipManager } from "@/components/Room/popout/pipManager";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore, type MobileCallMode } from "@/stores/callUiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { readLiveRoom, usePanelChromeStore } from "@/stores/panelChromeStore";
import {
  ROOM_PANEL_IDS,
  POP_GESTURE_ORDER,
  builtinPreset,
  clonePanelMap,
  hideFailedPop,
  panelOf,
  planPopGesture,
  type BuiltinPresetId,
  type PanelMap,
  type PanelMode,
  type RoomPanelId,
} from "@/stores/panelRegistry";
import {
  closePanelWindow,
  isPanelWindowOpen,
  openPanelWindow,
} from "@/components/Layout/panelOpeners";

let mirrorsInstalled = false;
let applyingPreset = false;

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

function stageVideo(): HTMLVideoElement | null {
  if (typeof document === "undefined") return null;
  const scoped = document.querySelector("[data-stage-root] video");
  const fallback = document.querySelector(
    '[aria-label="Voice and video call"] video',
  );
  const video = scoped ?? fallback;
  return video instanceof HTMLVideoElement ? video : null;
}

/**
 * Text layout mounts the stage `<video>` when React commits the preset, so a
 * query during the click itself finds nothing and Picture-in-Picture no-ops.
 * Run after paint. The gesture's transient activation is still valid then.
 */
export function requestStagePip(): boolean {
  if (typeof window === "undefined") return false;
  if (!pipManager.isSupported()) return false;
  const tryOnce = (): boolean => {
    const video = stageVideo();
    if (!video) return false;
    void pipManager.requestPip(video, "call-stage").catch(() => {});
    return true;
  };
  requestAnimationFrame(() => {
    if (tryOnce()) return;
    requestAnimationFrame(() => {
      tryOnce();
    });
  });
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

/**
 * How chat is presented. Phone Video hides the column without writing the
 * desktop registry. A popped or floating chat stays that mode on the phone
 * once the user is not in Video.
 */
export function presentChat(opts: {
  callIsHere: boolean;
  isDesktop: boolean;
  mobileCallMode: MobileCallMode;
  chatMode: PanelMode;
  textLayout: boolean;
}): PanelMode {
  if (!opts.callIsHere) return "docked";
  if (!opts.isDesktop) {
    if (opts.mobileCallMode === "video" || opts.chatMode === "hidden") {
      return "hidden";
    }
    if (opts.chatMode === "popped" || opts.chatMode === "floating") {
      return opts.chatMode;
    }
    return "docked";
  }
  if (
    opts.textLayout &&
    opts.chatMode !== "popped" &&
    opts.chatMode !== "floating" &&
    opts.chatMode !== "hidden"
  ) {
    return "docked";
  }
  return opts.chatMode;
}

/**
 * Phone Video / Split / Chat. Lives in `mobileCallMode` only — it must not
 * write the per-room panel registry, or a phone Video tap hides chat on the
 * same browser once the viewport is desktop width.
 */
export function setMobileCallIntent(next: MobileCallMode): void {
  const ui = useCallUiStore.getState();
  if (next === "video" || next === "split") ui.toggleVideo(true);
  ui.setMobileCallMode(next, { user: true });
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
    } else {
      if (mode === "popped") closePanelWindow(roomId, "chat");
      chrome.setPanelMode(roomId, "chat", "hidden");
      ui.setMobileCallMode("video", { user: true });
    }
    return;
  }
  if (mode === "hidden") {
    chrome.setPanelMode(roomId, "chat", "docked");
    return;
  }
  if (mode === "popped") closePanelWindow(roomId, "chat");
  chrome.setPanelMode(roomId, "chat", "hidden");
}

export function popPanel(roomId: string, id: RoomPanelId): boolean {
  const chrome = usePanelChromeStore.getState();
  const cur = chrome.getPanel(roomId, id).mode;
  if (cur === "popped") {
    closePanelWindow(roomId, id);
    chrome.setPanelMode(roomId, id, "docked");
    return true;
  }
  chrome.setPanelMode(roomId, id, "popped");
  const opened = openPanelWindow(roomId, id);
  if (opened !== "opened") {
    chrome.setPanelMode(roomId, id, cur);
    return false;
  }
  if (id === "canvas") useCanvasStore.getState().setPanelOpen(true);
  if (id === "members") useAppStore.getState().setParticipantPanelOpen(true);
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

export interface OpenPoppedResult {
  panels: PanelMap;
  /** Panels left hidden because this click already spent its one window. */
  deferred: RoomPanelId[];
  /** The panel whose window opened, if any. */
  opened: RoomPanelId | null;
}

function windowsAlreadyOpen(
  roomId: string,
  panels: PanelMap,
): Set<RoomPanelId> {
  const open = new Set<RoomPanelId>();
  for (const id of POP_GESTURE_ORDER) {
    if (panelOf(panels, id).mode !== "popped") continue;
    if (isPanelWindowOpen(roomId, id)) open.add(id);
  }
  return open;
}

/**
 * Open at most one new window for panels whose mode is `popped`.
 * Does not write the store — {@link applyCallPreset} stores the returned map.
 * A blocked or missing opener becomes `hidden`, never `docked`.
 */
export function openPopped(roomId: string, panels: PanelMap): OpenPoppedResult {
  const plan = planPopGesture(panels, windowsAlreadyOpen(roomId, panels));
  let next = plan.panels;
  let opened: RoomPanelId | null = null;
  if (plan.toOpen) {
    const result = openPanelWindow(roomId, plan.toOpen);
    if (result === "opened") {
      opened = plan.toOpen;
    } else {
      next = hideFailedPop(next, plan.toOpen);
      if (result === "unmounted") {
        useAppStore.getState().pushToast({
          title: "Pop-out unavailable",
          body: "That panel isn't on screen yet, so no window opened. It stayed hidden.",
          kind: "error",
        });
      }
    }
  }
  if (opened && plan.deferred.length > 0) {
    useAppStore.getState().pushToast({
      title: "One window per click",
      body: "Browsers allow one new window at a time. Apply Show again to pop the next panel.",
    });
  }
  return { panels: next, deferred: plan.deferred, opened };
}

export function applyCallPreset(
  roomId: string,
  source: BuiltinPresetId | PanelMap,
): void {
  const panels =
    typeof source === "string" ? builtinPreset(source) : clonePanelMap(source);
  applyingPreset = true;
  try {
    const landed = openPopped(roomId, panels);
    usePanelChromeStore
      .getState()
      .replaceRoomPanels(roomId, landed.panels, true);
    syncCompanionSurfaces(roomId, landed.panels);
    if (panelOf(landed.panels, "stage").mode === "floating") requestStagePip();
  } finally {
    applyingPreset = false;
  }
}

export function saveCurrentLayout(roomId: string, name: string): void {
  const panels =
    usePanelChromeStore.getState().rooms[roomId] ?? readLiveRoom(roomId);
  usePanelChromeStore.getState().saveUserPreset(name, panels);
}

export function presetModesMatch(a: PanelMap, b: PanelMap): boolean {
  return ROOM_PANEL_IDS.every(
    (id) => panelOf(a, id).mode === panelOf(b, id).mode,
  );
}
