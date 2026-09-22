import { useEffect, useRef, useState } from "react";
import {
  Crown,
  Shield,
  Mic,
  MicOff,
  MoreVertical,
  Star,
  UserMinus,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import { usePresenceStore } from "@/stores/presenceStore";
import {
  api,
  type RoomMember,
  type ApiError,
  type PeopleDirectoryEntry,
  type UserPreferences,
} from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { identityFor, resolveIdentity, rosterParticipantType } from "@/lib/identity";
import { agentPresence } from "@/lib/agentStatus";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useRoomBroadcasts } from "@/hooks/useRoomBroadcasts";
import { livekitIdentityForMember } from "@/lib/broadcast";
import { isGuestParticipant } from "@/lib/guest";
import { GuestBadge } from "@/components/ui/GuestBadge";

interface ParticipantStripProps {
  roomId: string;
}

type ModRole = "owner" | "admin" | "member" | "guest";

function OnlineIndicator({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
        online ? "bg-stable-mint animate-live" : "bg-slate-600",
      )}
      aria-label={online ? "Online" : "Offline"}
    />
  );
}

function RoleBadge({ role }: { role: RoomMember["role"] }) {
  if (role === "owner") {
    return (
      <span title="Owner">
        <Crown className="h-3 w-3 text-stable-gold" />
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span title="Admin">
        <Shield className="h-3 w-3 text-stable-purple-light" />
      </span>
    );
  }
  return null;
}

/**
 * Owner/admin moderation menu for a single human member. Visibility + the
 * available actions are decided by the caller's own role (myRole) vs. the
 * target's role, mirroring the backend rules so the UI never offers an action
 * that would 403:
 *   - owner: full control incl. granting/revoking roles
 *   - admin: may mute/remove members & guests, but not owners or other admins
 */
function MemberMenu({
  roomId,
  member,
  myRole,
}: {
  roomId: string;
  member: RoomMember;
  myRole: ModRole;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Hooks must run unconditionally — keep this above the visibility short-circuit.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const targetRole = (member.role as ModRole) ?? "member";
  const isOwner = myRole === "owner";
  // An admin can't act on an owner or another admin; an owner can act on anyone.
  const canAct =
    isOwner ||
    (myRole === "admin" && targetRole !== "owner" && targetRole !== "admin");
  const pid = member.participant_id || member.user_id || "";
  if (!canAct || !pid) return null;

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["room-members", roomId] });
      setOpen(false);
    } catch (e) {
      const err = e as ApiError;
      useAppStore.getState().pushToast({
        title: "Action failed",
        body: err?.detail || err?.message || undefined,
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  function toggleMute() {
    void run(() => api.setMemberMute(roomId, pid, !member.is_muted));
  }
  function remove() {
    setConfirmRemove(true);
  }
  function confirmRemoveMember() {
    setConfirmRemove(false);
    void run(() => api.removeMember(roomId, pid));
  }
  function changeRole(role: ModRole) {
    void run(() => api.setMemberRole(roomId, pid, role));
  }

  const roleChoices: ModRole[] = (
    ["owner", "admin", "member"] as ModRole[]
  ).filter((r) => r !== targetRole);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-slate-500 transition-opacity hover:bg-white/[0.08] hover:text-slate-100 focus-ring focus:opacity-100 md:p-1 md:opacity-0 md:group-hover:opacity-100"
        aria-label={`Manage ${member.display_name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Manage member"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="glass-heavy absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-xl p-1 text-xs shadow-pop animate-fade-in"
        >
          <button
            role="menuitem"
            onClick={toggleMute}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring disabled:opacity-50"
          >
            {member.is_muted ? (
              <>
                <Mic className="h-3.5 w-3.5 text-emerald-400" /> Unmute
              </>
            ) : (
              <>
                <MicOff className="h-3.5 w-3.5 text-amber-300" /> Mute
              </>
            )}
          </button>

          {isOwner && roleChoices.length > 0 && (
            <>
              <div className="my-1 border-t border-line" />
              <p className="px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Set role
              </p>
              {roleChoices.map((r) => (
                <button
                  key={r}
                  role="menuitem"
                  onClick={() => changeRole(r)}
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left capitalize text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring disabled:opacity-50"
                >
                  {r === "owner" ? (
                    <Crown className="h-3.5 w-3.5 text-stable-gold" />
                  ) : r === "admin" ? (
                    <Shield className="h-3.5 w-3.5 text-stable-purple-light" />
                  ) : (
                    <span className="h-3.5 w-3.5" />
                  )}
                  Make {r}
                </button>
              ))}
            </>
          )}

          <div className="my-1 border-t border-line" />
          <button
            role="menuitem"
            onClick={remove}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-rose-400 transition-colors hover:bg-rose-500/15 focus-ring disabled:opacity-50"
          >
            <UserMinus className="h-3.5 w-3.5" /> Remove from channel
          </button>
        </div>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove member?"
          message={
            <>
              Remove{" "}
              <span className="font-semibold text-slate-100">
                {member.display_name}
              </span>{" "}
              from this channel? They can be invited back anytime.
            </>
          }
          confirmLabel="Remove"
          icon={UserMinus}
          busy={false}
          onConfirm={confirmRemoveMember}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

/**
 * "● Broadcasting" — a live, no-login feed of this person exists right now.
 *
 * Duplicated intentionally onto the roster as well as the call tile: a
 * broadcast token can be minted (and shows here) before anyone joins a call,
 * and the roster is on screen far more of the time than the video stage.
 */
function BroadcastingBadge({ name }: { name: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-white"
      title={`${name} is being broadcast to an external feed right now`}
    >
      <span aria-hidden="true" className="text-[7px] leading-none">
        ●
      </span>
      Live
    </span>
  );
}

function HumanMemberRow({
  member,
  online,
  roomId,
  myRole,
  favorite,
  onToggleFavorite,
  broadcasting,
}: {
  member: RoomMember;
  online: boolean;
  roomId: string;
  myRole: ModRole | null;
  favorite: boolean;
  onToggleFavorite: (participantId: string) => void;
  broadcasting: boolean;
}) {
  const participantId =
    member.participant_id || member.user_id || member.id || "";
  return (
    <li
      className={clsx(
        "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]",
        online ? "text-slate-200" : "text-slate-500",
      )}
    >
      <div className={clsx("relative shrink-0", !online && "opacity-60")}>
        <Identity
          {...resolveIdentity({
            ...member,
            participant_type: rosterParticipantType(member),
          })}
          presence={null}
          size={28}
        />
        <OnlineIndicator online={online} />
      </div>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {member.display_name}
        {member.is_self && (
          <span className="ml-1 text-[10px] text-slate-500">(you)</span>
        )}
      </span>
      {/* From the SERVER's participant_type, never the display name (the guest
          chose it) and never the `guest-<hex>` username convention. A guest can
          read this room's whole history and may be on camera in it, so whoever
          is looking at the roster gets told, plainly, in the list itself. */}
      {isGuestParticipant(member.participant_type) && <GuestBadge />}
      {broadcasting && <BroadcastingBadge name={member.display_name} />}
      {member.is_muted && (
        <span title="Muted — can't post">
          <MicOff className="h-3 w-3 shrink-0 text-rose-400/70" />
        </span>
      )}
      <RoleBadge role={member.role} />
      {!member.is_self && participantId && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(participantId);
          }}
          className={clsx(
            "focus-ring inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-md transition-colors",
            favorite
              ? "text-stable-gold hover:bg-stable-gold/10"
              : "text-slate-600 hover:bg-white/[0.06] hover:text-slate-300",
          )}
          aria-label={
            favorite
              ? `Remove ${member.display_name} from favorites`
              : `Add ${member.display_name} to favorites`
          }
          aria-pressed={favorite}
          title={favorite ? "Remove favorite" : "Add to favorites"}
        >
          <Star className={clsx("h-3.5 w-3.5", favorite && "fill-current")} />
        </button>
      )}
      {myRole && !member.is_self && (
        <MemberMenu roomId={roomId} member={member} myRole={myRole} />
      )}
    </li>
  );
}

function DirectoryPersonRow({
  person,
  online,
  favorite,
  onToggleFavorite,
}: {
  person: PeopleDirectoryEntry;
  online: boolean;
  favorite: boolean;
  onToggleFavorite: (participantId: string) => void;
}) {
  return (
    <li className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-slate-300 transition-colors hover:bg-white/[0.04]">
      <div className={clsx("relative shrink-0", !online && "opacity-60")}>
        <Identity
          {...resolveIdentity({ ...person, participant_type: "human" })}
          presence={null}
          size={28}
        />
        <OnlineIndicator online={online} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{person.display_name}</p>
        <p className="truncate text-[10px] text-slate-500">
          {online ? "Available now" : `@${person.username}`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onToggleFavorite(person.id)}
        className={clsx(
          "focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md transition-colors",
          favorite
            ? "text-stable-gold hover:bg-stable-gold/10"
            : "text-slate-600 hover:bg-white/[0.06] hover:text-slate-300",
        )}
        aria-label={
          favorite
            ? `Remove ${person.display_name} from favorites`
            : `Add ${person.display_name} to favorites`
        }
        aria-pressed={favorite}
        title={favorite ? "Remove favorite" : "Add to favorites"}
      >
        <Star className={clsx("h-3.5 w-3.5", favorite && "fill-current")} />
      </button>
    </li>
  );
}

export function ParticipantStrip({ roomId }: ParticipantStripProps) {
  const participants =
    useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  const qc = useQueryClient();
  const [confirmRemoveAgent, setConfirmRemoveAgent] =
    useState<RoomMember | null>(null);
  // Occasional snapshot for correctness; live WS presence patches presenceStore
  // so the panel does not wait a full 30s for someone to go green/gray.
  const { data: directory = [] } = useQuery({
    queryKey: ["people-directory"],
    queryFn: () => api.getPeopleDirectory(),
    refetchInterval: 60_000,
  });
  // Seed the instance presence store whenever directory snapshot refreshes.
  useEffect(() => {
    if (directory.length === 0) return;
    usePresenceStore.getState().setFromDirectory(directory);
  }, [directory]);
  // Re-render when live presence patches land (sort / online sections).
  const presenceById = usePresenceStore((s) => s.byId);
  const { data: preferences } = useQuery({
    queryKey: ["my-preferences"],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });
  const favoriteIds = preferences?.favorite_people_ids ?? [];
  const favoriteSet = new Set(favoriteIds);

  // Consent surface: who currently has a live broadcast feed. The roster knows
  // members, /broadcast/active answers in LiveKit identities, so rebuild the
  // server's "<username>_<participant id>" to line the two up.
  const { isBroadcasting } = useRoomBroadcasts(roomId);
  const memberIsBroadcasting = (member: RoomMember) =>
    isBroadcasting(
      livekitIdentityForMember(
        member.username,
        member.participant_id || member.user_id,
      ),
    );

  // The caller's own membership row (server-flagged is_self) decides whether to
  // show moderation controls at all. Only owners/admins moderate.
  const me = participants.find((p) => p.is_self);
  const myRole: ModRole | null =
    me?.role === "owner" || me?.role === "admin" ? me.role : null;

  // Split members by participant_type. Agents come from the same /members
  // endpoint as humans now (they're auto-joined on /invite-brigade-agent).
  const humanParticipants = participants.filter(
    (p) => rosterParticipantType(p) !== "agent",
  );
  const agentMembers = participants.filter(
    (p) => rosterParticipantType(p) === "agent",
  );

  // `is_online` is the single presence reader: server-derived from Redis on
  // every /members poll, and patched in place by live WS presence deltas. It
  // used to be OR'd with a separate global online set, which could only ever
  // add, so a departed peer stayed green until the next members refetch.
  const onlineHumans = humanParticipants.filter((p) => p.is_online);
  const offlineHumans = humanParticipants.filter((p) => !p.is_online);

  const inThisRoom = new Set(
    participants
      .map((p) => p.participant_id || p.user_id || p.id)
      .filter(Boolean) as string[],
  );
  // Live store wins; directory poll is the cold-start / reconciling fallback.
  // Reading presenceById keeps this component subscribed to applyEvent patches.
  const isDirectoryPersonOnline = (person: PeopleDirectoryEntry) => {
    const live = presenceById[person.id];
    if (live) return live.isOnline;
    return person.is_online;
  };
  const favoritePeople = directory
    .filter((person) => favoriteSet.has(person.id))
    .sort((a, b) => {
      const onlineDelta =
        Number(isDirectoryPersonOnline(b)) - Number(isDirectoryPersonOnline(a));
      return onlineDelta || a.display_name.localeCompare(b.display_name);
    });
  const peopleOnline = directory
    .filter(
      (person) =>
        !favoriteSet.has(person.id) &&
        !inThisRoom.has(person.id) &&
        isDirectoryPersonOnline(person),
    )
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  async function toggleFavorite(participantId: string) {
    const previous = preferences ?? {
      default_agent_id: null,
      favorite_people_ids: [],
    };
    const nextIds = favoriteSet.has(participantId)
      ? favoriteIds.filter((id) => id !== participantId)
      : [...favoriteIds, participantId];
    const optimistic: UserPreferences = {
      ...previous,
      favorite_people_ids: nextIds,
    };
    qc.setQueryData(["my-preferences"], optimistic);
    try {
      const saved = await api.setFavoritePeople(nextIds);
      qc.setQueryData(["my-preferences"], saved);
    } catch (error) {
      qc.setQueryData(["my-preferences"], previous);
      useAppStore.getState().pushToast({
        title: "Couldn't update favorites",
        body: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  async function removeAgent(member: RoomMember) {
    // Username is "agent-<brigade_id>"; strip the prefix back out. Prefer an
    // explicit brigade id if the membership row ever carries one.
    const slug =
      (member as { brigade_agent_id?: string }).brigade_agent_id ||
      (member.username ?? "").replace(/^agent-/, "");
    if (!slug) {
      useAppStore.getState().pushToast({
        title: "Couldn't remove agent",
        body: "Missing agent id on this member row.",
      });
      return;
    }
    try {
      await api.removeBrigadeAgent(roomId, slug);
      await qc.invalidateQueries({ queryKey: ["room-members", roomId] });
      // Optimistic: drop from local roster so the strip updates even if the
      // members refetch races the delete.
      const roster = useAppStore.getState().participants[roomId] ?? [];
      useAppStore.getState().setParticipants(
        roomId,
        roster.filter(
          (p) =>
            (p.participant_id || p.user_id || p.id) !==
            (member.participant_id || member.user_id || member.id),
        ),
      );
      useAppStore.getState().pushToast({
        title: `Removed ${member.display_name}`,
        body: "Agent left this room.",
      });
    } catch (e) {
      console.error("remove agent failed", e);
      const apiErr = e as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't remove agent",
        body:
          (typeof apiErr?.detail === "string" && apiErr.detail) ||
          apiErr?.message ||
          (e instanceof Error ? e.message : "Request failed"),
      });
    }
  }

  // The residents actually here, clustered as overlapping avatars up top.
  // Agents used to be included unconditionally on the theory that they are
  // "always live once invited" — they are not: an agent Brigade has disabled,
  // or a bridge whose operator closed their session, is in the room's member
  // list and reachable by nobody. Only agents we positively observed as
  // connected or available are counted as here.
  const agentBadges = new Map(
    agentMembers.map((m) => [
      m.participant_id || m.user_id || m.username,
      agentPresence({
        isOnline: m.is_online,
        availability: m.availability,
        availabilityReason: m.availability_reason,
        name: m.display_name,
      }),
    ]),
  );
  const presentAgents = agentMembers.filter(
    (m) =>
      agentBadges.get(m.participant_id || m.user_id || m.username)?.kind !==
      "unknown",
  );
  const presentMembers = [...presentAgents, ...onlineHumans];

  return (
    <aside
      // w-full only: the RoomView column owns the width (user-resizable on
      // desktop) — a fixed md:w-60 here would pin the strip at 240px inside it.
      className="flex h-full w-full flex-col overflow-y-auto bg-slate-900/50 px-3 py-4"
      aria-label="Room participants"
    >
      {favoritePeople.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Favorites ({favoritePeople.length})
          </h3>
          <ul role="list" className="flex flex-col gap-1">
            {favoritePeople.map((person) => (
              <DirectoryPersonRow
                key={person.id}
                person={person}
                online={isDirectoryPersonOnline(person)}
                favorite
                onToggleFavorite={(id) => void toggleFavorite(id)}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          People online ({peopleOnline.length})
        </h3>
        {peopleOnline.length === 0 ? (
          <p className="px-2 text-xs italic text-slate-600">
            No coworkers online outside this room
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {peopleOnline.slice(0, 40).map((person) => (
              <DirectoryPersonRow
                key={person.id}
                person={person}
                online
                favorite={false}
                onToggleFavorite={(id) => void toggleFavorite(id)}
              />
            ))}
          </ul>
        )}
      </section>

      {presentMembers.length > 0 && (
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <div className="flex -space-x-1.5">
            {presentMembers.slice(0, 5).map((m) => (
              <Identity
                key={m.participant_id || m.user_id || m.id || m.username}
                {...resolveIdentity({
                  ...m,
                  participant_type: rosterParticipantType(m),
                })}
                presence={null}
                size={20}
                className="ring-2 ring-slate-900"
              />
            ))}
            {presentMembers.length > 5 && (
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[9px] font-semibold text-slate-300 ring-2 ring-slate-900 tabular-nums">
                +{presentMembers.length - 5}
              </span>
            )}
          </div>
          <span className="min-w-0 truncate text-[10px] font-medium text-slate-500 tabular-nums">
            {presentMembers.length} here now
          </span>
        </div>
      )}

      {agentMembers.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Agents ({agentMembers.length})
          </h3>
          <ul role="list" className="flex flex-col gap-1">
            {agentMembers.map((m) => {
              const ident = identityFor(
                m.participant_id || m.user_id || m.username,
                m.display_name,
              );
              const badge = agentBadges.get(
                m.participant_id || m.user_id || m.username,
              )!;
              return (
                <li
                  key={m.id || m.participant_id || m.username}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-slate-300 transition-colors hover:bg-white/[0.04]"
                >
                  <div className="relative shrink-0">
                    <Identity
                      {...resolveIdentity({
                        ...m,
                        participant_type: "agent",
                      })}
                      presence={null}
                      size={28}
                    />
                    {/* Was hardcoded mint+pulse for every agent — the same
                        "always online" claim this change removes. */}
                    <span
                      className={clsx(
                        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2",
                        badge.dotClass,
                      )}
                      aria-label={badge.label}
                      title={badge.label}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs font-semibold"
                      style={{ color: ident.text }}
                    >
                      {m.display_name}
                    </p>
                    <p className="truncate text-[10px] text-slate-500">
                      @{(m.username ?? "").replace(/^agent-/, "")}
                      {badge.kind !== "connected" && (
                        <>
                          {" · "}
                          <span
                            className={
                              badge.kind === "available"
                                ? "text-stable-cyan"
                                : "text-slate-600"
                            }
                            title={badge.label}
                          >
                            {badge.stateText}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {/* Always reachable on mobile + desktop. The old
                      `md:hidden md:group-hover:block` combo failed on desktop
                      (group-hover couldn't reliably unhide) so agents got
                      stuck in the room until you left and re-entered. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmRemoveAgent(m);
                    }}
                    className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md p-1.5 text-slate-500 transition-colors hover:bg-rose-500/20 hover:text-rose-400 focus-ring touch-manipulation opacity-100 md:opacity-70 md:group-hover:opacity-100"
                    aria-label={`Remove ${m.display_name}`}
                    title="Remove from channel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Online ({onlineHumans.length})
        </h3>
        {onlineHumans.length === 0 ? (
          <p className="px-2 text-xs italic text-slate-600">No one online</p>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {onlineHumans.map((member) => (
              <HumanMemberRow
                key={member.participant_id || member.user_id || member.id}
                member={member}
                online={true}
                roomId={roomId}
                myRole={myRole}
                favorite={favoriteSet.has(
                  member.participant_id || member.user_id || member.id || "",
                )}
                onToggleFavorite={(id) => void toggleFavorite(id)}
                broadcasting={memberIsBroadcasting(member)}
              />
            ))}
          </ul>
        )}
      </section>

      {offlineHumans.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Offline ({offlineHumans.length})
          </h3>
          <ul role="list" className="flex flex-col gap-1">
            {offlineHumans.map((member) => (
              <HumanMemberRow
                key={member.participant_id || member.user_id || member.id}
                member={member}
                online={false}
                roomId={roomId}
                myRole={myRole}
                favorite={favoriteSet.has(
                  member.participant_id || member.user_id || member.id || "",
                )}
                onToggleFavorite={(id) => void toggleFavorite(id)}
                broadcasting={memberIsBroadcasting(member)}
              />
            ))}
          </ul>
        </section>
      )}
      {confirmRemoveAgent && (
        <ConfirmDialog
          title="Remove agent?"
          message={
            <>
              Remove{" "}
              <span className="font-semibold text-slate-100">
                {confirmRemoveAgent.display_name}
              </span>{" "}
              from this channel? They can be invited back anytime.
            </>
          }
          confirmLabel="Remove"
          icon={UserMinus}
          busy={false}
          onConfirm={() => {
            const target = confirmRemoveAgent;
            setConfirmRemoveAgent(null);
            void removeAgent(target);
          }}
          onClose={() => setConfirmRemoveAgent(null)}
        />
      )}
    </aside>
  );
}
