import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark } from "lucide-react";
import clsx from "clsx";
import { api, type Message } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { useModalA11y } from "@/hooks/useModalA11y";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import { FloatingWindow } from "@/components/ui/FloatingWindow";
import { PanelModeToolbar } from "@/components/ui/PanelModeToolbar";
import {
  PanelPopoutPortal,
  usePanelPopout,
} from "@/components/ui/panelPopout";
import { useAppStore } from "@/stores/appStore";
import { usePresentedRooms } from "@/hooks/usePresentedRooms";
import { PresenterHiddenLine } from "@/components/Layout/PresenterHiddenLine";

interface SavedPanelProps {
  onClose: () => void;
}

export function SavedPanel({ onClose }: SavedPanelProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pushToast = useAppStore((s) => s.pushToast);
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const isDesktop = useIsDesktop();
  const presentation = usePanelChromeStore((s) => s.presentation.saved);
  const setPresentation = usePanelChromeStore((s) => s.setPresentation);
  const floatGeom = usePanelChromeStore((s) => s.floatGeom.saved);
  const setFloatGeom = usePanelChromeStore((s) => s.setFloatGeom);
  const mode = isDesktop ? presentation : "overlay";

  const dockResize = usePanelResize("saved", {
    defaultWidth: 360,
    min: 280,
    max: 560,
    edge: "left",
  });

  const popout = usePanelPopout({
    title: "Stable — Saved",
    geometryKey: "panel:saved",
    width: 480,
    height: 640,
    onBlocked: () =>
      pushToast({
        title: "Pop-out blocked",
        body: "Allow pop-ups, or use Float / Dock instead.",
      }),
  });

  const trapFocus = mode === "overlay" && !popout.isOpen;
  const panelRef = useModalA11y(trapFocus, onClose);

  const { data: saved = [] } = useQuery({
    queryKey: ["saved"],
    queryFn: () => api.getSaved(),
  });
  const visibleSaved = presenterEnabled
    ? saved.filter(
        (message) =>
          rule.isRoomAllowed(message.room_id) &&
          rule.isIdentityAllowed(message.sender_id, message.sender_name),
      )
    : saved;

  const headerBar = (
    <div className="flex items-center justify-between border-b border-line px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-stable-purple/15">
          <Bookmark className="h-4 w-4 text-stable-purple-light" />
        </span>
        <h2
          id="saved-panel-title"
          className="font-display text-base font-semibold text-slate-100"
        >
          Saved
        </h2>
        {visibleSaved.length > 0 && (
          <span className="text-xs text-slate-500 tabular-nums">
            ({visibleSaved.length})
          </span>
        )}
      </div>
      <PanelModeToolbar
        presentation={presentation}
        onPresentation={(m) => {
          if (popout.isOpen) popout.close();
          setPresentation("saved", m);
        }}
        onPopout={() => {
          if (popout.isOpen) {
            popout.handle?.focus();
            return;
          }
          popout.open();
        }}
        popoutActive={popout.isOpen}
        onClose={() => {
          if (popout.isOpen) popout.close();
          onClose();
        }}
      />
    </div>
  );

  const listBody = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {visibleSaved.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-14 text-center">
          <div className="relative mb-4">
            <div
              className="absolute -inset-3 rounded-full bg-stable-purple/20 blur-xl"
              aria-hidden="true"
            />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2">
              <Bookmark className="h-6 w-6 text-stable-purple-light" />
            </div>
          </div>
          <h3 className="font-display text-sm font-semibold text-slate-200">
            Nothing saved yet
          </h3>
          <p className="mt-1 max-w-xs text-xs text-slate-500">
            Hover any message and click the bookmark icon to keep it here.
          </p>
        </div>
      ) : (
        <>
        <PresenterHiddenLine count={presenterEnabled ? saved.length - visibleSaved.length : 0} />
        <ul className="divide-y divide-line">
          {visibleSaved.map((m: Message) => {
            const ident = identityFor(m.sender_id, m.sender_name);
            const showContent = !presenterEnabled || rule.isOpenRoom(m.room_id);
            return (
              <li key={m.id} className="p-3.5 transition-colors hover:bg-white/[0.02]">
                <div className="flex items-start gap-2.5">
                  <Identity {...resolveIdentity(m)} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="truncate text-xs font-semibold"
                        style={{ color: ident.text }}
                      >
                        {m.sender_name}
                      </span>
                      <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">
                        {new Date(m.created_at).toLocaleString()}
                      </span>
                    </div>
                    {showContent ? (
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                        {m.content}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-slate-500">Saved message</p>
                    )}
                    <div className="mt-1.5 flex gap-3 text-[10px]">
                      <button
                        type="button"
                        onClick={() => {
                          // Land on the saved message itself (?message deep-link
                          // scroll + ring), not the bottom of the channel.
                          navigate(`/c/${m.room_id}?message=${m.id}`);
                          if (mode === "overlay" || !isDesktop) onClose();
                        }}
                        className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-stable-purple-light"
                      >
                        Jump to message
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.toggleSave(m.id);
                          await qc.invalidateQueries({ queryKey: ["saved"] });
                        }}
                        className="focus-ring rounded font-medium text-slate-500 transition-colors hover:text-rose-300"
                      >
                        Unsave
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );

  const popoutPortal = (
    <PanelPopoutPortal handle={popout.handle}>
      <div className="flex h-full min-h-0 flex-col">
        {headerBar}
        {listBody}
      </div>
    </PanelPopoutPortal>
  );

  if (popout.isOpen) return popoutPortal;

  if (mode === "dock" && isDesktop) {
    return (
      <>
        {popoutPortal}
        <div
          ref={panelRef}
          className="relative hidden h-full shrink-0 flex-col border-l border-line-strong bg-surface-0/85 backdrop-blur-xl md:flex"
          style={{ width: dockResize.width }}
          role="complementary"
          aria-label="Saved messages"
        >
          <div
            {...dockResize.dragHandleProps}
            aria-label="Resize Saved panel"
            title="Drag to resize · double-click to reset"
            className={clsx(PANEL_RESIZE_HANDLE_CLASS, "left-0")}
          />
          {headerBar}
          {listBody}
        </div>
      </>
    );
  }

  if (mode === "float" && isDesktop) {
    return (
      <>
        {popoutPortal}
        <FloatingWindow
          titleId="saved-panel-title"
          geometry={floatGeom}
          onGeometryChange={(g) => setFloatGeom("saved", g)}
          minW={320}
          minH={280}
          header={headerBar}
        >
          {listBody}
        </FloatingWindow>
      </>
    );
  }

  return (
    <>
      {popoutPortal}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[8dvh] backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="saved-panel-title"
          initial={{ scale: 0.96, y: -8 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.96, y: -8 }}
          className="glass-heavy flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl shadow-pop"
          onClick={(e) => e.stopPropagation()}
        >
          {headerBar}
          {listBody}
        </motion.div>
      </motion.div>
    </>
  );
}
