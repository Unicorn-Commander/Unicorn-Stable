import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  broadcastLowerThirdOptIn,
  LOWER_THIRD_HOLD_MS,
  type LowerThirdLayout,
} from "@/lib/tileChrome";

/**
 * Broadcast-style name strip: who is speaking, and their role or title when
 * we have one. No buttons — a captured feed must not grow chrome.
 */
export function LowerThird({
  name,
  subtitle,
  className,
}: {
  name: string;
  subtitle?: string | null;
  /** Replaces the default `bottom-3` when the stage has a dock over that edge. */
  className?: string;
}) {
  const sub = subtitle?.trim() || "";
  return (
    <div
      data-testid="lower-third"
      role="status"
      aria-live="polite"
      aria-label={sub ? `${name}, ${sub}` : name}
      className={clsx(
        "pointer-events-none absolute left-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))]",
        className ?? "bottom-3",
      )}
    >
      <div className="border-l-[3px] border-stable-cyan bg-slate-950/80 px-3 py-1.5 shadow-pop backdrop-blur-sm">
        <p className="truncate font-display text-sm font-semibold leading-tight text-white md:text-base">
          {name}
        </p>
        {sub ? (
          <p className="truncate text-[11px] leading-tight text-slate-300 md:text-xs">
            {sub}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * True while `speakerId` is set, then false after `holdMs` of that same id.
 * A different id starts the hold over. Null hides immediately.
 */
export function useLowerThirdHold(
  speakerId: string | null,
  holdMs: number,
): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!speakerId) {
      setShown(false);
      return;
    }
    setShown(true);
    const timer = window.setTimeout(() => setShown(false), holdMs);
    return () => window.clearTimeout(timer);
  }, [speakerId, holdMs]);
  return shown;
}

/**
 * Mounts the strip on a stage only. Compact and filmstrip render nothing,
 * and neither does an opted-out call. The same speaker hides after the hold.
 */
export function StageLowerThird({
  optedIn,
  layout,
  speakerId,
  name,
  subtitle,
  holdMs = LOWER_THIRD_HOLD_MS,
  className,
}: {
  optedIn: boolean;
  layout: LowerThirdLayout;
  speakerId: string | null;
  name: string;
  subtitle?: string | null;
  holdMs?: number;
  className?: string;
}) {
  const active = optedIn && layout === "stage" && speakerId ? speakerId : null;
  const shown = useLowerThirdHold(active, holdMs);
  if (!shown || !name.trim()) return null;
  return (
    <LowerThird name={name.trim()} subtitle={subtitle} className={className} />
  );
}

/**
 * What the broadcast page mounts. Default off: no URL flag and no room
 * opt-in means this returns null, so the captured frame stays a bare camera.
 */
export function BroadcastLowerThird({
  search,
  roomOptIn,
  speakerId,
  name,
  subtitle,
}: {
  search: string;
  roomOptIn: boolean;
  speakerId: string | null;
  name: string;
  subtitle?: string | null;
}) {
  const on = broadcastLowerThirdOptIn({ search, roomOptIn });
  return (
    <StageLowerThird
      optedIn={on}
      layout="stage"
      speakerId={speakerId}
      name={name}
      subtitle={subtitle}
    />
  );
}
