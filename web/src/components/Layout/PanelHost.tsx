/**
 * One host for a room panel: docked, floating, or popped.
 *
 * Popped uses the existing `panelPopout` portal (one JS context, one LiveKit
 * room). The panel body is the child — never a SplitPane — so a popped window
 * does not drag against the opener document. Zustand state is the same module
 * the docked panel reads; the portal does not boot a second app.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Columns2, ExternalLink, X } from "lucide-react";
import { FloatingWindow } from "@/components/ui/FloatingWindow";
import { PanelPopoutPortal, usePanelPopout } from "@/components/ui/panelPopout";
import { useAppStore } from "@/stores/appStore";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import {
  defaultRecord,
  type PanelMode,
  type RoomPanelId,
} from "@/stores/panelRegistry";
import { registerPanelOpener } from "./panelOpeners";

const SLOT_CLASS = "flex h-full min-h-0 min-w-0 flex-1 flex-col";

/**
 * One element for the life of the host. The body is portaled into it, and
 * the element is moved between the dock, a hidden park, a float, and a
 * pop-out. React reuses the portal only while this container stays the same
 * object — swapping a `<div>` for `createPortal`, or pointing the portal at
 * a new dock node, remounts chat and drops the draft, scroll, and unread.
 */
function useStablePanelSlot(): HTMLDivElement | null {
  const slot = useRef<HTMLDivElement | null>(null);
  if (slot.current === null && typeof document !== "undefined") {
    const el = document.createElement("div");
    el.className = SLOT_CLASS;
    slot.current = el;
  }
  useEffect(() => {
    const el = slot.current;
    return () => el?.remove();
  }, []);
  return slot.current;
}

interface PanelHostProps {
  roomId: string;
  panelId: RoomPanelId;
  title: string;
  children: ReactNode;
  /** DOM slot for docked mode. The slot stays in the main window. */
  dockElement?: HTMLElement | null;
  /**
   * Render as this mode without writing the registry. Used so chat still
   * fills the room when no call is up, even if the call layout hid it.
   */
  present?: PanelMode;
}

export function PanelHost({
  roomId,
  panelId,
  title,
  children,
  dockElement = null,
  present,
}: PanelHostProps) {
  const record = usePanelChromeStore((s) => s.rooms[roomId]?.[panelId]);
  const setMode = usePanelChromeStore((s) => s.setPanelMode);
  const setGeom = usePanelChromeStore((s) => s.setPanelGeometry);
  const pushToast = useAppStore((s) => s.pushToast);
  const stored = record ?? defaultRecord(panelId);
  const mode = present ?? stored.mode;

  const pop = usePanelPopout({
    title: `${title} · Stable`,
    geometryKey: `room-panel:${roomId}:${panelId}`,
    width: stored.geometry.w,
    height: stored.geometry.h,
    onBlocked: () =>
      pushToast({
        title: "Pop-out blocked",
        body: "Allow pop-ups for Stable, or dock the panel instead.",
        kind: "error",
      }),
  });

  const open = pop.open;
  const close = pop.close;
  const isOpenRef = useRef(false);
  isOpenRef.current = pop.isOpen;
  useEffect(() => {
    return registerPanelOpener(roomId, panelId, {
      open,
      close,
      isOpen: () => isOpenRef.current,
    });
  }, [roomId, panelId, open, close]);

  // A popped mode whose window is gone (room switch closes it on unmount,
  // or the open never landed) would render nothing for the rest of the
  // session. Dock it. No was-open latch: the first mount is the stale case.
  useEffect(() => {
    if (pop.isOpen) return;
    const live = usePanelChromeStore.getState().getPanel(roomId, panelId).mode;
    if (live !== "popped") return;
    setMode(roomId, panelId, "docked");
  }, [pop.isOpen, roomId, panelId, setMode]);

  const slot = useStablePanelSlot();
  const parkRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const shelled = mode === "floating" || (mode === "popped" && pop.isOpen);
  useLayoutEffect(() => {
    if (!slot) return;
    const parent =
      mode === "docked" && dockElement
        ? dockElement
        : shelled
          ? shellRef.current
          : parkRef.current;
    if (!parent) return;
    if (slot.parentElement !== parent) parent.appendChild(slot);
    const hidden = parent === parkRef.current;
    slot.hidden = hidden;
    slot.className = SLOT_CLASS;
    if (hidden) slot.setAttribute("aria-hidden", "true");
    else slot.removeAttribute("aria-hidden");
  }, [slot, mode, dockElement, shelled, pop.isOpen, pop.handle]);

  const body = slot ? createPortal(children, slot) : null;

  if (mode === "popped" && pop.isOpen && pop.handle) {
    return (
      <>
        {body}
        <PanelPopoutPortal handle={pop.handle}>
          <div className="flex h-full min-h-0 flex-col bg-surface-0">
            <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
              <span className="truncate text-sm font-semibold text-slate-100">
                {title}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setMode(roomId, panelId, "docked");
                  }}
                  className="focus-ring inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  Dock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setMode(roomId, panelId, "hidden");
                  }}
                  className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
                  aria-label={`Close ${title}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </span>
            </header>
            <div
              ref={shellRef}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            />
          </div>
        </PanelPopoutPortal>
      </>
    );
  }

  if (mode === "floating") {
    return (
      <>
        {body}
        <FloatingWindow
          titleId={`panel-${panelId}-title`}
          geometry={stored.geometry}
          onGeometryChange={(g) => setGeom(roomId, panelId, g)}
          minW={280}
          minH={180}
          header={
            <header className="flex h-11 items-center justify-between gap-2 border-b border-line px-3">
              <span
                id={`panel-${panelId}-title`}
                className="truncate text-sm font-semibold text-slate-100"
              >
                {title}
              </span>
              <span className="flex items-center gap-1" data-no-drag>
                <button
                  type="button"
                  onClick={() => setMode(roomId, panelId, "docked")}
                  className="focus-ring inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-300 hover:bg-white/[0.06]"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  Dock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode(roomId, panelId, "popped");
                    if (!open()) setMode(roomId, panelId, "floating");
                  }}
                  className="focus-ring inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-300 hover:bg-white/[0.06]"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Pop out
                </button>
                <button
                  type="button"
                  onClick={() => setMode(roomId, panelId, "hidden")}
                  className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/[0.06]"
                  aria-label={`Close ${title}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </span>
            </header>
          }
        >
          <div
            ref={shellRef}
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
          />
        </FloatingWindow>
      </>
    );
  }

  // Hidden, docked, or popped before the window exists. The slot stays
  // mounted (display:none until it is moved into the dock) so a hide or a
  // late dock ref does not remount the body.
  return (
    <>
      {body}
      <div ref={parkRef} hidden className="hidden" aria-hidden />
    </>
  );
}
