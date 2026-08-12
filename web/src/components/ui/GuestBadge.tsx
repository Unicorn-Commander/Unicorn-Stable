/**
 * The Guest badge — ONE component, used on every surface where a participant is
 * rendered: the room roster, the message list, the call tiles, and the guest's
 * own shell.
 *
 * It lives in `ui/` rather than in `components/Guest/` precisely because the
 * member-facing surfaces need it: "who in this room is an outsider" must not be
 * something the guest page knows and the host's roster doesn't. It is a plain
 * label, not a hover affordance — on a touch screen anything that only appears
 * on :hover is functionally missing, and this is a fact about who can hear you.
 *
 * The caller decides WHETHER to render it, always from a server field —
 * `participant_type` on a member row, `sender_type` on a message, or the roster
 * join in `isGuestCallIdentity` for a LiveKit tile. Never from a display name
 * (the guest chose it) and never from the `guest-<hex>` username convention.
 */
import clsx from "clsx";
import { GUEST_BADGE_LABEL } from "@/lib/guest";

export function GuestBadge({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded-md border border-stable-gold/30 bg-stable-gold/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stable-gold",
        className,
      )}
      title="Joined with a guest link — not a member of this workspace"
    >
      {GUEST_BADGE_LABEL}
    </span>
  );
}

export default GuestBadge;
