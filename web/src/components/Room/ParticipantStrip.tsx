import { Bot, Crown, Shield, Mic } from "lucide-react";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";
import type { RoomMember } from "@/services/api";

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
  const agents = useAppStore((s) => s.agents);
  const rooms = useAppStore((s) => s.rooms);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const setStageAgentId = useAppStore((s) => s.setStageAgentId);
  const stageAgentId = useAppStore((s) => s.ui.stageAgentId);

  const room = rooms.find((r) => r.id === roomId);
  const roomAgents = room?.agents ?? [];
  const roomAgentDetails = roomAgents
    .map((ra) => agents.find((a) => a.id === ra.id) ?? ra)
    .filter(Boolean);

  const humanParticipants = participants.filter(Boolean);
  const onlineHumans = humanParticipants.filter(
    (p) => p.is_online || onlineUsers.includes(p.user_id),
  );
  const offlineHumans = humanParticipants.filter(
    (p) => !p.is_online && !onlineUsers.includes(p.user_id),
  );

  return (
    <aside
      className="flex h-full w-60 flex-col overflow-y-auto bg-slate-900/50 px-3 py-4"
      aria-label="Room participants"
    >
      {roomAgentDetails.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Agents ({roomAgentDetails.length})
          </h3>
          <ul role="list" className="flex flex-col gap-1">
            {roomAgentDetails.map((agent) => {
              const isStage = stageAgentId === agent.id;
              return (
                <li key={agent.id}>
                  <button
                    onClick={() =>
                      setStageAgentId(isStage ? null : agent.id)
                    }
                    className={clsx(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                      isStage
                        ? "bg-stable-cyan/10 text-stable-cyan"
                        : "text-slate-300 hover:bg-slate-800/60",
                    )}
                    aria-label={`${agent.display_name} - ${agent.status}`}
                  >
                    <div className="relative shrink-0">
                      {agent.avatar_url ? (
                        <img
                          src={agent.avatar_url}
                          alt={agent.display_name}
                          className="h-7 w-7 rounded-full object-cover ring-1 ring-stable-cyan/30"
                        />
                      ) : (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-stable-cyan/20">
                          <Bot className="h-3.5 w-3.5 text-stable-cyan" />
                        </div>
                      )}
                      <span
                        className={clsx(
                          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
                          agent.status === "active" && "bg-green-500",
                          agent.status === "working" &&
                            "bg-yellow-500 animate-pulse-soft",
                          agent.status === "idle" && "bg-slate-500",
                          agent.status === "offline" && "bg-slate-700",
                        )}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {agent.display_name}
                      </p>
                      <p className="truncate text-[10px] text-slate-500">
                        {agent.status === "working"
                          ? "Working..."
                          : agent.status}
                      </p>
                    </div>

                    {isStage && (
                      <Mic className="h-3 w-3 shrink-0 text-stable-cyan" />
                    )}
                  </button>
                </li>
              );
            })}
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
                  {member.avatar_url ? (
                    <img
                      src={member.avatar_url}
                      alt={member.display_name}
                      className="h-7 w-7 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-stable-purple/20 text-xs font-semibold text-stable-purple-light">
                      {member.display_name.charAt(0).toUpperCase()}
                    </div>
                  )}
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
                <div className="relative shrink-0">
                  {member.avatar_url ? (
                    <img
                      src={member.avatar_url}
                      alt={member.display_name}
                      className="h-7 w-7 rounded-full object-cover opacity-50"
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-600">
                      {member.display_name.charAt(0).toUpperCase()}
                    </div>
                  )}
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
