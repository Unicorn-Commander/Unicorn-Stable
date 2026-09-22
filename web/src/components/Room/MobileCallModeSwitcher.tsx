import clsx from "clsx";
import type { ReactNode } from "react";
import { Video, Columns2, MessageSquare } from "lucide-react";
import {
  useCallUiStore,
  type MobileCallMode,
} from "@/stores/callUiStore";
import { setMobileCallIntent } from "@/lib/callLayoutActions";

interface MobileCallModeSwitcherProps {
  className?: string;
  /** Compact strip without the "In call" label (e.g. overlaid on video). */
  overlay?: boolean;
  /** Phone top pills beside the mode switcher (the REC receipt). */
  extra?: ReactNode;
}

const MODES: {
  mode: MobileCallMode;
  label: string;
  hint: string;
  icon: typeof Video;
}[] = [
  {
    mode: "video",
    label: "Video",
    hint: "Full-screen video — new messages as a one-line pill",
    icon: Video,
  },
  {
    mode: "split",
    label: "Split",
    hint: "Stage on top, chat below",
    icon: Columns2,
  },
  {
    mode: "chat",
    label: "Chat",
    hint: "Full chat with picture-in-picture video",
    icon: MessageSquare,
  },
];

/**
 * Human-first mobile intent switcher: Video / Split / Chat.
 *
 * Distinct from the desktop ViewModeSwitcher (Gallery / Speaker / …). Touch
 * targets are ≥44px. Selecting a mode marks a user override so auto
 * presentation defaults do not steal the choice mid-call.
 */
export function MobileCallModeSwitcher({
  className,
  overlay = false,
  extra,
}: MobileCallModeSwitcherProps) {
  const mode = useCallUiStore((s) => s.mobileCallMode);

  function select(next: MobileCallMode) {
    // Intent stays in mobileCallMode. Writing the panel registry here hid
    // chat for the same browser the next time it was wide enough for desktop.
    setMobileCallIntent(next);
  }

  return (
    <div
      className={clsx(
        "flex w-full max-w-full shrink-0 flex-wrap items-center gap-2",
        overlay
          ? "justify-center px-2 py-1"
          : "min-h-12 justify-between border-b border-line bg-slate-950/85 px-3 py-1",
        className,
      )}
      role="group"
      aria-label="Mobile call layout"
    >
      {!overlay && (
        <span className="truncate text-[10px] font-medium text-slate-500">
          In call
        </span>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {extra}
      <div
        className={clsx(
          "flex items-center gap-0.5 rounded-xl border border-line p-0.5",
          overlay
            ? "bg-slate-950/75 backdrop-blur-md"
            : "bg-surface-2/80",
        )}
      >
        {MODES.map(({ mode: m, label, hint, icon: Icon }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => select(m)}
              className={clsx(
                // ≥44px touch target (height + horizontal padding)
                "focus-ring flex h-11 min-w-[2.75rem] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors",
                active
                  ? m === "chat"
                    ? "bg-stable-cyan/15 text-stable-cyan"
                    : "bg-stable-purple/25 text-stable-purple-light"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
              )}
              aria-pressed={active}
              aria-label={`${label} — ${hint}`}
              title={hint}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
