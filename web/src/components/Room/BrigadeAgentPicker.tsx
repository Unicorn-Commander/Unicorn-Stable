import { useEffect, useState } from "react";
import { Bot, ChevronDown, Lock, Search } from "lucide-react";
import clsx from "clsx";
import { api, type BrigadeAgent } from "../../services/api";
import { identityFor } from "@/lib/identity";
import {
  AGENT_LOCK_HINT,
  apiErrorText,
  isAgentEntitled,
} from "@/lib/agentEntitlement";
import { useVoice } from "../../contexts/VoiceProvider";
import { useCallUiStore } from "@/stores/callUiStore";
import { useAppStore } from "@/stores/appStore";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  /** The LiveKit room name the user is currently in. */
  roomName: string;
  /** Called when an agent is successfully invited. */
  onInvited?: (agentId: string) => void;
  /** Optional additional class names. */
  className?: string;
  /** Start with the agent list expanded (e.g. when hosted in a popover). */
  defaultOpen?: boolean;
}

/**
 * BrigadeAgentPicker — lists Brigade agents and lets the current user invite
 * one into the active LiveKit room.
 *
 * The invited agent joins the room as a LiveKit participant via the
 * Stable agent worker, using BrigadeBackedAgent under the hood. Once
 * dispatched, the agent shows up in the ParticipantStrip like any human.
 *
 * Rendering fix: the panel content used to render unconditionally with no
 * surface of its own, so it ghosted through translucent/faded drawer chrome
 * over the chat. The list is now a real disclosure — closed renders only the
 * trigger (a true conditional render, not an opacity fade), and the open
 * panel sits on an opaque glass surface.
 */
export function BrigadeAgentPicker({
  roomName,
  onInvited,
  className = "",
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<BrigadeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  // Only ask the server to dispatch a LiveKit voice worker when a call is
  // actually live IN THE ROOM WE'RE INVITING TO. The call now persists across
  // navigation, so a global "is any call live" flag would wrongly request a
  // voice dispatch into a room with no in-progress call (e.g. inviting from a
  // room you've navigated to while a call runs elsewhere). Outside such a call
  // the invite just re-binds the room's resident agent for the text path.
  const { isConnected } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const callActive = isConnected && activeCallRoomId === roomName;

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

  const qc = useQueryClient();

  const invite = async (agentId: string) => {
    setInviting(agentId);
    try {
      const result = await api.inviteBrigadeAgent(roomName, agentId, undefined, {
        dispatch: callActive,
      });
      // dispatched:false is still success when the server intentionally
      // skipped the voice worker (no call to join, or one already in-room).
      const skipped =
        result.reason === "dispatch_not_requested" ||
        (result.reason ?? "").startsWith("agent_already_in_room");
      if (result.dispatched || skipped) {
        setInvitedIds((prev) => new Set(prev).add(agentId));
        /* The server just persisted `metadata.brigade_agent_id` — and the
         * client's ROOM-LIST row is what a call tile resolves its persona
         * from (VoiceVideoBar → resolveCallTilePersona). Without this heal
         * the row stayed stale until the 60s list poll, which is how an
         * agent invited into a live group call rendered as the generic head
         * instead of its branded puppet. Optimistic store write first (the
         * call is live NOW), then the refetches for every other reader. */
        useAppStore.getState().updateRoom(roomName, {
          brigade_agent_id: agentId,
        });
        void qc.invalidateQueries({ queryKey: ["rooms"] });
        void qc.invalidateQueries({ queryKey: ["room", roomName] });
        onInvited?.(agentId);
      } else {
        const reason = result.reason || "dispatch_failed";
        setError(`Invite failed: ${reason}`);
      }
    } catch (e: unknown) {
      setError(apiErrorText(e, "Invite failed"));
    } finally {
      setInviting(null);
    }
  };

  const q = query.trim().toLowerCase();
  const visibleAgents = q
    ? agents.filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q),
      )
    : agents;

  return (
    <div className={`p-2 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="brigade-agent-picker-panel"
        className={clsx(
          "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition-colors focus-ring",
          open
            ? "border-stable-purple/40 bg-stable-purple/10 text-slate-100"
            : "border-line bg-white/[0.03] text-slate-300 hover:border-line-strong hover:bg-white/[0.05] hover:text-slate-100",
        )}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md gradient-bg text-white">
          <Bot className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate">Invite a Brigade agent</span>
        <ChevronDown
          className={clsx(
            "h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          id="brigade-agent-picker-panel"
          className="glass-heavy mt-2 overflow-hidden rounded-2xl shadow-pop animate-slide-up"
        >
          {loading ? (
            <p className="px-3 py-3 text-xs text-slate-500">Loading agents…</p>
          ) : error ? (
            <p className="px-3 py-3 text-xs text-rose-400">{error}</p>
          ) : agents.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500">
              No Brigade agents available. Configure <code>BRIGADE_API_KEY</code>{" "}
              on the Stable backend.
            </p>
          ) : (
            <>
              <div className="relative border-b border-line p-2">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search agents…"
                  aria-label="Search agents"
                  className="w-full rounded-lg border border-line bg-slate-950/60 py-1.5 pl-7 pr-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
                />
              </div>
              <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5">
                {visibleAgents.length === 0 ? (
                  <li className="px-2.5 py-3 text-center text-xs italic text-slate-500">
                    No agents match “{query}”
                  </li>
                ) : (
                  visibleAgents.map((a) => {
                    const isInvited = invitedIds.has(a.id);
                    const isInviting = inviting === a.id;
                    // Locked, not hidden: the roster stays a truthful
                    // directory; only the ACTION is gated (server enforces
                    // regardless — this just keeps the UI honest).
                    const locked = !isAgentEntitled(a);
                    const ident = identityFor(a.id, a.name);
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => invite(a.id)}
                          disabled={isInvited || isInviting || locked}
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                          title={locked ? AGENT_LOCK_HINT : a.description}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: ident.color }}
                            />
                            <span className="flex min-w-0 flex-col">
                              <span
                                className="truncate text-sm font-medium"
                                style={{ color: ident.text }}
                              >
                                {a.name || a.id}
                              </span>
                              {a.description ? (
                                <span className="truncate text-xs text-slate-500">
                                  {a.description}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span
                            className={clsx(
                              "shrink-0 text-xs",
                              locked
                                ? "flex items-center gap-1 text-slate-500"
                                : isInvited
                                  ? "font-medium text-stable-mint"
                                  : isInviting
                                    ? "text-slate-500 animate-pulse-soft"
                                    : "font-medium text-stable-purple-light",
                            )}
                          >
                            {locked ? (
                              <>
                                <Lock className="h-3 w-3" aria-hidden="true" />
                                {AGENT_LOCK_HINT}
                              </>
                            ) : isInvited ? (
                              "Invited"
                            ) : isInviting ? (
                              "Inviting…"
                            ) : (
                              "Invite"
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
