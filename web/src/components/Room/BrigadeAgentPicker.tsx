import { useEffect, useState } from "react";
import { api, type BrigadeAgent } from "../../services/api";

interface Props {
  /** The LiveKit room name the user is currently in. */
  roomName: string;
  /** Called when an agent is successfully invited. */
  onInvited?: (agentId: string) => void;
  /** Optional additional class names. */
  className?: string;
}

/**
 * BrigadeAgentPicker — MVP picker that lists Brigade agents and lets
 * the current user invite one into the active LiveKit room.
 *
 * The invited agent joins the room as a LiveKit participant via the
 * Stable agent worker, using BrigadeBackedAgent under the hood. Once
 * dispatched, the agent shows up in the ParticipantStrip like any human.
 */
export function BrigadeAgentPicker({ roomName, onInvited, className = "" }: Props) {
  const [agents, setAgents] = useState<BrigadeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getBrigadeAgents();
        if (!cancelled) {
          setAgents(list);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "Failed to load agents";
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const invite = async (agentId: string) => {
    setInviting(agentId);
    try {
      const result = await api.inviteBrigadeAgent(roomName, agentId);
      if (result.dispatched) {
        setInvitedIds((prev) => new Set(prev).add(agentId));
        onInvited?.(agentId);
      } else {
        const reason = result.reason || "dispatch_failed";
        setError(`Invite failed: ${reason}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invite failed";
      setError(msg);
    } finally {
      setInviting(null);
    }
  };

  if (loading) {
    return (
      <div className={`text-sm text-slate-500 ${className}`}>Loading agents…</div>
    );
  }
  if (error) {
    return (
      <div className={`text-sm text-red-500 ${className}`}>
        {error}
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <div className={`text-sm text-slate-500 ${className}`}>
        No Brigade agents available. Configure <code>BRIGADE_API_KEY</code> on
        the Command Center backend.
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 p-3 ${className}`}>
      <h3 className="text-sm font-semibold text-slate-200">
        Invite a Brigade agent
      </h3>
      <ul className="flex flex-col gap-1 max-h-80 overflow-auto">
        {agents.map((a) => {
          const isInvited = invitedIds.has(a.id);
          const isInviting = inviting === a.id;
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => invite(a.id)}
                disabled={isInvited || isInviting}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-700/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between gap-3"
                title={a.description}
              >
                <span className="flex flex-col min-w-0">
                  <span className="text-sm text-slate-100 truncate">
                    {a.name || a.id}
                  </span>
                  {a.description ? (
                    <span className="text-xs text-slate-400 truncate">
                      {a.description}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs shrink-0">
                  {isInvited
                    ? "Invited"
                    : isInviting
                      ? "Inviting…"
                      : "Invite"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
