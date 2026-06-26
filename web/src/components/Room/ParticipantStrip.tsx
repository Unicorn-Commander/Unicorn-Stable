import { useEffect, useRef, useState } from "react";
import {
  Crown,
  Shield,
  Mic,
  MicOff,
  MoreVertical,
  UserMinus,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import { api, type RoomMember, type ApiError } from "@/services/api";
import { Avatar } from "@/components/Avatar";

interface ParticipantStripProps {
  roomId: string;
}

type ModRole = "owner" | "admin" | "member" | "guest";

function OnlineIndicator({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
        online ? "bg-green-500" : "bg-slate-600",
      )}
      aria-label={online ? "Online" : "Offline"}
    />
  );
}

function RoleBadge({ role }: { role: RoomMember["role"] }) {
  if (role === "owner") {
    return (
      <span title="Owner">
        <Crown className="h-3 w-3 text-yellow-500" />
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
  const ref = useRef<HTMLDivElement>(null);

  // Hooks must run unconditionally — keep this above the visibility short-circuit.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
    isOwner || (myRole === "admin" && targetRole !== "owner" && targetRole !== "admin");
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
      alert(err?.detail || err?.message || "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleMute() {
    void run(() => api.setMemberMute(roomId, pid, !member.is_muted));
  }
  function remove() {
    if (!confirm(`Remove ${member.display_name} from this channel?`)) return;
    void run(() => api.removeMember(roomId, pid));
  }
  function changeRole(role: ModRole) {
    void run(() => api.setMemberRole(roomId, pid, role));
  }

  const roleChoices: ModRole[] = (["owner", "admin", "member"] as ModRole[]).filter(
    (r) => r !== targetRole,
  );

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1 text-slate-500 opacity-0 transition-opacity hover:bg-slate-700/60 hover:text-slate-200 focus:opacity-100 group-hover:opacity-100"
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
          className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/95 p-1 text-xs shadow-xl backdrop-blur"
        >
          <button
            role="menuitem"
            onClick={toggleMute}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {member.is_muted ? (
              <>
                <Mic className="h-3.5 w-3.5 text-green-400" /> Unmute
              </>
            ) : (
              <>
                <MicOff className="h-3.5 w-3.5 text-amber-400" /> Mute
              </>
            )}
          </button>

          {isOwner && roleChoices.length > 0 && (
            <>
              <div className="my-1 border-t border-slate-700/50" />
              <p className="px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                Set role
              </p>
              {roleChoices.map((r) => (
                <button
                  key={r}
                  role="menuitem"
                  onClick={() => changeRole(r)}
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left capitalize text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  {r === "owner" ? (
                    <Crown className="h-3.5 w-3.5 text-yellow-500" />
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

          <div className="my-1 border-t border-slate-700/50" />
          <button
            role="menuitem"
            onClick={remove}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-red-400 hover:bg-red-500/15 disabled:opacity-50"
          >
            <UserMinus className="h-3.5 w-3.5" /> Remove from channel
          </button>
        </div>
      )}
    </div>
  );
}

function HumanMemberRow({
  member,
  online,
  roomId,
  myRole,
}: {
  member: RoomMember;
  online: boolean;
  roomId: string;
  myRole: ModRole | null;
}) {
  return (
    <li
      className={clsx(
        "group flex items-center gap-2.5 rounded-lg px-2 py-1.5",
        online ? "text-slate-200" : "text-slate-500",
      )}
    >
      <div className={clsx("relative shrink-0", !online && "opacity-60")}>
        <Avatar name={member.display_name} src={member.avatar_url} size="sm" />
        <OnlineIndicator online={online} />
      </div>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {member.display_name}
        {member.is_self && (
          <span className="ml-1 text-[10px] text-slate-500">(you)</span>
        )}
      </span>
      {member.is_muted && (
        <span title="Muted — can't post">
          <MicOff className="h-3 w-3 shrink-0 text-amber-400" />
        </span>
      )}
      <RoleBadge role={member.role} />
      {myRole && !member.is_self && (
        <MemberMenu roomId={roomId} member={member} myRole={myRole} />
      )}
    </li>
  );
}

export function ParticipantStrip({ roomId }: ParticipantStripProps) {
  const participants = useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const qc = useQueryClient();

  // The caller's own membership row (server-flagged is_self) decides whether to
  // show moderation controls at all. Only owners/admins moderate.
  const me = participants.find((p) => p.is_self);
  const myRole: ModRole | null =
    me?.role === "owner" || me?.role === "admin" ? me.role : null;

  // Split members by participant_type. Agents come from the same /members
  // endpoint as humans now (they're auto-joined on /invite-brigade-agent).
  const humanParticipants = participants.filter(
    (p) => (p.participant_type ?? "human") !== "agent",
  );
  const agentMembers = participants.filter(
    (p) => p.participant_type === "agent",
  );

  const onlineHumans = humanParticipants.filter(
    (p) => p.is_online || onlineUsers.includes(p.user_id || p.participant_id || ""),
  );
  const offlineHumans = humanParticipants.filter(
    (p) => !p.is_online && !onlineUsers.includes(p.user_id || p.participant_id || ""),
  );

  async function removeAgent(member: RoomMember) {
    // Username is "agent-<brigade_id>"; strip the prefix back out.
    const slug = (member.username ?? "").replace(/^agent-/, "");
    if (!slug) return;
    if (!confirm(`Remove ${member.display_name} from this channel?`)) return;
    try {
      await api.removeBrigadeAgent(roomId, slug);
      await qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    } catch (e) {
      console.error("remove agent failed", e);
      alert("Couldn't remove agent: " + (e as Error).message);
    }
  }

  return (
    <aside
      className="flex h-full w-full md:w-60 flex-col overflow-y-auto bg-slate-900/50 px-3 py-4"
      aria-label="Room participants"
    >
      {agentMembers.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Agents ({agentMembers.length})
          </h3>
          <ul role="list" className="flex flex-col gap-1">
            {agentMembers.map((m) => (
              <li
                key={m.id || m.participant_id || m.username}
                className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-slate-300 hover:bg-slate-800/60"
              >
                <div className="relative shrink-0">
                  <Avatar
                    name={m.display_name}
                    src={m.avatar_url}
                    size="sm"
                    isAgent
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900 bg-green-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {m.display_name}
                  </p>
                  <p className="truncate text-[10px] text-slate-500">
                    @{(m.username ?? "").replace(/^agent-/, "")}
                  </p>
                </div>
                <button
                  onClick={() => removeAgent(m)}
                  className="hidden shrink-0 rounded p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-400 group-hover:block"
                  aria-label={`Remove ${m.display_name}`}
                  title="Remove from channel"
                >
                  <X className="h-3 w-3" />
                </button>
                {/* Mic icon retained as visual marker for future stage feature */}
                <Mic className="hidden h-3 w-3 shrink-0 text-stable-cyan" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Online ({onlineHumans.length})
        </h3>
        {onlineHumans.length === 0 ? (
          <p className="px-2 text-xs text-slate-600">No one online</p>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {onlineHumans.map((member) => (
              <HumanMemberRow
                key={member.participant_id || member.user_id || member.id}
                member={member}
                online={true}
                roomId={roomId}
                myRole={myRole}
              />
            ))}
          </ul>
        )}
      </section>

      {offlineHumans.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
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
              />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
