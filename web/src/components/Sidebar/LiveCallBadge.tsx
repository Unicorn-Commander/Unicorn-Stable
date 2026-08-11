import type { LiveCallEntry } from "@/lib/callAwareness";

/**
 * Compact "a call is live in this room" chip for sidebar rows — the same mint
 * live language as the Home dashboard dots and the Meetings rejoin card: a
 * pulsing dot plus how many people are on the line. Purely presentational; the
 * data comes from the shared useLiveCalls source of truth so every row agrees
 * with the banner, the dock and Home.
 *
 * Renders nothing when the room has no live call, so rows can include it
 * unconditionally.
 */
export function LiveCallBadge({ call }: { call: LiveCallEntry | undefined }) {
  if (!call || call.participant_count < 1) return null;
  const count = call.participant_count;
  const label = `Live call · ${count} ${count === 1 ? "person" : "people"} in call`;
  return (
    <span
      className="ml-1 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-stable-mint/30 bg-stable-mint/10 px-1.5 text-[10px] font-semibold tabular-nums text-stable-mint"
      role="img"
      aria-label={label}
      title={label}
    >
      <span
        aria-hidden="true"
        className="animate-live h-1.5 w-1.5 rounded-full bg-stable-mint"
      />
      {count}
    </span>
  );
}
