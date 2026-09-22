/**
 * The small primitives the guest surfaces share: a name disc, the Guest badge,
 * and a participant row.
 *
 * WHY NOT `components/ui/Avatar`: it resolves through `lib/avatar.ts`, which
 * imports `services/auth` and the federation store — i.e. the Keycloak client
 * and the instance list. A guest has neither. `Identity` resolves through
 * `lib/identity.ts`, which does not import either of those. NameDisc stays for
 * surfaces that only have a name (a video tile, a message before the roster
 * arrives).
 */
import clsx from "clsx";
import { identityFor, resolveIdentity, rosterParticipantType } from "@/lib/identity";
import { Identity } from "@/components/ui/Identity";
import { isGuestParticipant } from "@/lib/guest";
import { GuestBadge } from "@/components/ui/GuestBadge";
import type { GuestRoomMember } from "@/services/guestApi";

export { GuestBadge };

export function NameDisc({
  name,
  id,
  size = 28,
  className,
}: {
  name: string;
  id?: string | null;
  size?: number;
  className?: string;
}) {
  const ident = identityFor(id, name);
  const initials = (name || "?")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: ident.gradient,
        color: "#0b1020",
        fontSize: Math.max(9, Math.round(size * 0.38)),
      }}
    >
      {initials || "?"}
    </span>
  );
}

/** One row of the guest room's roster. Badged from `participant_type`. */
export function GuestParticipantRow({ member }: { member: GuestRoomMember }) {
  const id = member.participant_id || member.user_id || member.username;
  const guest = isGuestParticipant(member.participant_type);
  const agent = member.participant_type === "agent";
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
      <div className="relative">
        <Identity
          {...resolveIdentity({
            ...member,
            id,
            participant_type: rosterParticipantType(member),
          })}
          presence={null}
          size={28}
        />
        <span
          className={clsx(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
            member.is_online ? "bg-stable-mint" : "bg-slate-600",
          )}
          aria-label={member.is_online ? "Online" : "Offline"}
        />
      </div>
      <span
        className={clsx(
          "min-w-0 flex-1 truncate text-xs font-medium",
          member.is_online ? "text-slate-200" : "text-slate-500",
        )}
      >
        {member.display_name}
        {member.is_self && (
          <span className="ml-1 text-[10px] text-slate-500">(you)</span>
        )}
      </span>
      {guest && <GuestBadge />}
      {agent && (
        <span className="shrink-0 rounded-md bg-stable-purple/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stable-purple-light">
          AI
        </span>
      )}
    </li>
  );
}

/** Full-screen card used by every terminal/blocking guest state. */
export function GuestCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-slate-900 p-4">
      <div className="glass flex w-full max-w-md flex-col gap-4 rounded-2xl p-8">
        <h1 className="text-xl font-semibold text-slate-50">{title}</h1>
        {children}
      </div>
    </div>
  );
}
