import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  IDLE_RECORDING,
  formatRecPill,
  starterDisplayName,
  type NameSource,
} from "@/lib/recording";
import { useRecordingStore } from "@/stores/recordingStore";

/**
 * The red receipt. Same string on every screen: `● REC 12:04 · started by Aaron`.
 * Renders nothing while the room is not recording — absence is the off state.
 */
export function RecPill({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      data-testid="rec-pill"
      role="status"
      aria-live="polite"
      title={label}
      className={clsx(
        "inline-flex max-w-[16rem] shrink-0 items-center truncate rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-semibold leading-none text-white shadow-pop",
        className,
      )}
    >
      {label}
    </span>
  );
}

function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Live pill for one room. Pass the roster you already have — this file does
 * not read the member app store, so the guest shell can use it.
 */
export function RecPillLive({
  roomId,
  members,
  className,
}: {
  roomId: string;
  members?: readonly NameSource[] | null;
  className?: string;
}) {
  const state = useRecordingStore((s) => s.byRoom[roomId] ?? IDLE_RECORDING);
  const now = useTickingNow(state.active);
  if (!state.active) return null;
  return (
    <RecPill
      label={formatRecPill(state, starterDisplayName(state, members), now)}
      className={className}
    />
  );
}
