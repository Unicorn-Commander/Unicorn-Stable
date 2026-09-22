/**
 * One host for a room panel: docked, floating, or popped.
 *
 * Popped uses the existing `panelPopout` portal (one JS context, one LiveKit
 * room). The panel body is the child — never a SplitPane — so a popped window
 * does not drag against the opener document. Zustand state is the same module
 * the docked panel reads; the portal does not boot a second app.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Columns2, ExternalLink, X } from "lucide-react";
import { FloatingWindow } from "@/components/ui/FloatingWindow";
import {
  PanelPopoutPortal,
  usePanelPopout,
} from "@/components/ui/panelPopout";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import {
  defaultRecord,
  type PanelMode,
  type RoomPanelId,
} from "@/stores/panelRegistry";
import { registerPanelOpener } from "./panelOpeners";

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
  const stored = record ?? defaultRecord(panelId);
  const mode = present ?? stored.mode;

  const pop = usePanelPopout({
    title: `${title} · Stable`,
    geometryKey: `room-panel:${roomId}:${panelId}`,
    width: stored.geometry.w,
    height: stored.geometry.h,
  });

  const open = pop.open;
  const close = pop.close;
  useEffect(() => {
    return registerPanelOpener(roomId, panelId, { open, close });
  }, [roomId, panelId, open, close]);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (pop.isOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const live = usePanelChromeStore.getState().getPanel(roomId, panelId).mode;
    if (live === "popped") setMode(roomId, panelId, "docked");
  }, [pop.isOpen, roomId, panelId, setMode]);

  const frame = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">{children}</div>
  );

  if (mode === "popped") {
    if (!pop.isOpen || !pop.handle) return null;
    return (
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
          {frame}
        </div>
      </PanelPopoutPortal>
    );
  }

  if (mode === "floating") {
    return (
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
        {frame}
      </FloatingWindow>
    );
  }

  if (mode === "hidden") {
    // Kept mounted (display:none) so chat scroll and drafts survive a hide.
    // Not positioned, so it cannot cover the stage.
    return (
      <div className="hidden" hidden aria-hidden>
        {frame}
      </div>
    );
  }

  if (dockElement) return createPortal(frame, dockElement);
  return null;
}
