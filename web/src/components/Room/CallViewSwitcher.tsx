import clsx from "clsx";
import {
  Rows3,
  LayoutGrid,
  Maximize,
  PanelRight,
  Video,
  VideoOff,
  Captions,
} from "lucide-react";
import { useCallUiStore } from "@/stores/callUiStore";
import type { CallViewMode } from "@/lib/roomDataProtocol";

interface CallViewSwitcherProps {
  roomId: string;
  /** Hide the video + transcript toggles (e.g. when shown in a tight bar). */
  compact?: boolean;
  className?: string;
}

const MODES: { mode: CallViewMode; label: string; icon: typeof Rows3 }[] = [
  { mode: "compact", label: "Compact bar", icon: Rows3 },
  { mode: "focus", label: "Focus speaker", icon: Maximize },
  { mode: "grid", label: "Grid", icon: LayoutGrid },
  { mode: "sidebar", label: "Side dock", icon: PanelRight },
];

/**
 * Small, unobtrusive control cluster for the call UI: pick a view mode and
 * toggle video / transcript. Mirrors the imperative {@link uiCommandBus}
 * actions an agent can also invoke, so human + agent share one surface.
 */
export function CallViewSwitcher({
  roomId,
  compact = false,
  className,
}: CallViewSwitcherProps) {
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const showVideo = useCallUiStore((s) => s.showVideo);
  const toggleVideo = useCallUiStore((s) => s.toggleVideo);
  const showTranscript = useCallUiStore((s) => s.showTranscript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);

  return (
    <div
      className={clsx("flex items-center gap-1", className)}
      role="group"
      aria-label="Call view controls"
    >
      <div className="flex items-center gap-0.5 rounded-lg bg-slate-800/60 p-0.5">
        {MODES.map(({ mode, label, icon: Icon }) => {
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              onClick={() => setViewMode(roomId, mode)}
              className={clsx(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                active
                  ? "bg-stable-purple/30 text-stable-purple-light"
                  : "text-slate-400 hover:bg-slate-700/60 hover:text-slate-200",
              )}
              aria-label={label}
              aria-pressed={active}
              title={label}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>

      {!compact && (
        <>
          <button
            onClick={() => toggleVideo()}
            className={clsx(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showVideo
                ? "text-slate-200 hover:bg-slate-700/60"
                : "text-slate-500 hover:bg-slate-700/60 hover:text-slate-300",
            )}
            aria-label={showVideo ? "Hide video" : "Show video"}
            aria-pressed={showVideo}
            title={showVideo ? "Hide everyone's video" : "Show video"}
          >
            {showVideo ? (
              <Video className="h-3.5 w-3.5" />
            ) : (
              <VideoOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => toggleTranscript()}
            className={clsx(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showTranscript
                ? "bg-stable-cyan/20 text-stable-cyan"
                : "text-slate-400 hover:bg-slate-700/60 hover:text-slate-200",
            )}
            aria-label={showTranscript ? "Hide transcript" : "Show transcript"}
            aria-pressed={showTranscript}
            title={showTranscript ? "Hide live transcript" : "Show live transcript"}
          >
            <Captions className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
