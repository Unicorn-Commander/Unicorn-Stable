import { Crown, Shield, Mic, X } from "lucide-react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import { api, type RoomMember } from "@/services/api";
import { Avatar } from "@/components/Avatar";

interface ParticipantStripProps {
  roomId: string;
}

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

export function ParticipantStrip({ roomId }: ParticipantStripProps) {
  const participants = useAppStore((s) => s.participants[roomId]) ?? EMPTY_MEMBERS;
  const rooms = useAppStore((s) => s.rooms);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const qc = useQueryClient();

  const room = rooms.find((r) => r.id === roomId);
  const lkName = (room as { display_name?: string } | undefined)?.display_name; // unused fallback

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
  void lkName;

  return (
    <aside
      className="flex h-full w-60 flex-col overflow-y-auto bg-slate-900/50 px-3 py-4"
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
              <li
                key={member.user_id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-slate-200"
              >
                <div className="relative shrink-0">
                  <Avatar name={member.display_name} src={member.avatar_url} size="sm" />
                  <OnlineIndicator online={true} />
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {member.display_name}
                </span>
                <RoleBadge role={member.role} />
              </li>
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
              <li
                key={member.user_id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-slate-500"
              >
                <div className="relative shrink-0 opacity-60">
                  <Avatar name={member.display_name} src={member.avatar_url} size="sm" />
                  <OnlineIndicator online={false} />
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {member.display_name}
                </span>
                <RoleBadge role={member.role} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
