import {
  AppWindow,
  Columns2,
  ExternalLink,
  Maximize2,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { PanelPresentation } from "@/stores/panelChromeStore";
import { isPopoutSupported } from "@/components/Room/popout/callPopout";
import { useIsDesktop } from "@/hooks/usePanelResize";

interface PanelModeToolbarProps {
  presentation: PanelPresentation;
  onPresentation: (mode: PanelPresentation) => void;
  onPopout?: () => void;
  popoutActive?: boolean;
  onClose: () => void;
  /** Compact icon-only (docked sidebar header). */
  compact?: boolean;
}

/**
 * Dock / Float / Pop out / Close controls shared by resizable panels.
 */
export function PanelModeToolbar({
  presentation,
  onPresentation,
  onPopout,
  popoutActive,
  onClose,
  compact = false,
}: PanelModeToolbarProps) {
  const isDesktop = useIsDesktop();
  const canPopout = isDesktop && isPopoutSupported() && !!onPopout;

  const btn =
    "focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 data-[active=true]:bg-stable-purple/20 data-[active=true]:text-stable-purple-light";

  return (
    <div
      className={clsx("flex shrink-0 items-center gap-0.5", compact && "gap-0")}
      data-no-drag
      role="toolbar"
      aria-label="Panel layout"
    >
      {isDesktop && (
        <>
          <button
            type="button"
            className={btn}
            data-active={presentation === "dock" && !popoutActive}
            onClick={() => onPresentation("dock")}
            aria-label="Dock as sidebar"
            title="Dock as sidebar"
            aria-pressed={presentation === "dock" && !popoutActive}
          >
            <Columns2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={btn}
            data-active={presentation === "float" && !popoutActive}
            onClick={() => onPresentation("float")}
            aria-label="Float as window"
            title="Float as window"
            aria-pressed={presentation === "float" && !popoutActive}
          >
            <AppWindow className="h-4 w-4" />
          </button>
          {canPopout && (
            <button
              type="button"
              className={btn}
              data-active={!!popoutActive}
              onClick={onPopout}
              aria-label={popoutActive ? "Focus pop-out window" : "Pop out to new window"}
              title={popoutActive ? "Focus pop-out window" : "Pop out to new window"}
              aria-pressed={!!popoutActive}
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          {presentation !== "overlay" && (
            <button
              type="button"
              className={btn}
              onClick={() => onPresentation("overlay")}
              aria-label="Modal overlay"
              title="Modal overlay"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
        </>
      )}
      <button
        type="button"
        className={btn}
        onClick={onClose}
        aria-label="Close"
        title="Close"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
