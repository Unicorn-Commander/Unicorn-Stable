import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Lock, Search, User as UserIcon, Users, X } from "lucide-react";
import { api, type BrigadeAgent } from "@/services/api";
import { useModalA11y } from "@/hooks/useModalA11y";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { Identity } from "@/components/ui/Identity";
import { useAppStore } from "@/stores/appStore";
import {
  composeStartGroupPayload,
  groupLabelFromPicks,
  pickKey,
  togglePick,
  type StartGroupPick,
} from "./startGroupModel";

interface StartGroupModalProps {
  /** The 1:1 DM being converted (never mutated — a NEW group room is created). */
  roomId: string;
  /** The other side of the DM — person or agent — named in the affordance. */
  peerLabel: string;
  /** Brigade id of the DM's resident agent, if this is an agent DM. */
  residentAgentId?: string | null;
  /**
   * Pre-picked selections. Used when the flow was entered by choosing a
   * specific agent elsewhere (e.g. the Brigade picker inside a human 1:1 DM
   * routes here with that agent already selected), so the intent survives
   * the hand-off.
   */
  initialPicks?: StartGroupPick[];
  onClose: () => void;
}

type Tab = "people" | "agents";

/**
 * StartGroupModal — the explicit DM → group conversion.
 *
 * The UX wave removed Invite from 1:1 DM headers because it silently
 * converted a private DM in place. This is the replacement: it says up front
 * that a NEW group is being created with the peer + the selections, and that
 * the 1:1 stays private. Picker idioms (tabs, chips, search) mirror
 * CreateDmModal so the two group-creation paths feel like one feature.
 */
export function StartGroupModal({
  roomId,
  peerLabel,
  residentAgentId,
  initialPicks,
  onClose,
}: StartGroupModalProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("people");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<StartGroupPick[]>(
    () => initialPicks ?? [],
  );
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useModalA11y(true, onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tab]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: users = [] } = useQuery({
    queryKey: ["dm-search", debounced],
    queryFn: () => api.searchUsers(debounced),
    enabled: tab === "people",
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    enabled: tab === "agents",
    staleTime: 60_000,
  });

  // The DM's own members are seeded server-side; rows matching them render
  // as "already in" instead of being pickable (InviteMembersModal idiom).
  const { data: currentMembers = [] } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
  });
  const existingIds = new Set(
    currentMembers
      .map((m) => m.participant_id || m.user_id || "")
      .filter(Boolean),
  );

  const filteredAgents: BrigadeAgent[] = (() => {
    if (!debounced) return agents;
    const needle = debounced.toLowerCase();
    return agents.filter(
      (a) =>
        a.id.toLowerCase().includes(needle) ||
        a.name.toLowerCase().includes(needle) ||
        (a.description || "").toLowerCase().includes(needle),
    );
  })();

  async function start() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    try {
      const payload = composeStartGroupPayload(picked, {
        existingParticipantIds: existingIds,
      });
      const room = await api.startGroupFromDm(roomId, {
        ...payload,
        display_name: groupLabelFromPicks(peerLabel, picked),
      });
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      onClose();
      navigate(`/c/${room.id}`);
    } catch (err) {
      console.error("start group failed", err);
      const apiErr = err as { detail?: unknown; message?: string };
      useAppStore.getState().pushToast({
        title: "Couldn't start the group",
        body:
          (typeof apiErr.detail === "string" && apiErr.detail) ||
          apiErr.message ||
          "Try again in a moment.",
        kind: "error",
      });
      setBusy(false);
    }
  }

  const startLabel = busy
    ? "Starting group…"
    : picked.length === 0
      ? "Pick who to add"
      : `Start group with ${peerLabel} + ${picked.length}`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Start a group with ${peerLabel}`}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy w-full max-w-md overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-slate-50">
              <Users className="h-4 w-4 shrink-0 text-stable-purple-light" />
              <span className="truncate">Start a group with {peerLabel}</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Creates a <span className="font-medium text-slate-300">new</span>{" "}
              group room with {peerLabel} and whoever you add. This 1:1 chat
              stays private — none of its history is shared.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="focus-ring -mr-1 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {/* Seed chips: the DM's two sides, locked — they define the group. */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full border border-line bg-white/[0.04] px-2 py-0.5 text-xs font-medium text-slate-300">
              <Lock className="h-3 w-3 text-slate-500" />
              You
            </span>
            <span className="flex min-w-0 items-center gap-1 rounded-full border border-line bg-white/[0.04] px-2 py-0.5 text-xs font-medium text-slate-300">
              <Lock className="h-3 w-3 shrink-0 text-slate-500" />
              <span className="truncate">{peerLabel}</span>
            </span>
            {picked.map((p) => {
              const ident =
                p.kind === "agent" ? identityFor(p.id, p.name) : null;
              return (
                <span
                  key={pickKey(p)}
                  className={
                    ident
                      ? "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                      : "flex items-center gap-1 rounded-full border border-stable-purple/40 bg-stable-purple/10 px-2 py-0.5 text-xs font-medium text-stable-purple-light"
                  }
                  style={
                    ident
                      ? {
                          background: ident.soft,
                          borderColor: ident.border,
                          color: ident.text,
                        }
                      : undefined
                  }
                >
                  {p.kind === "agent" ? (
                    <Bot className="h-3 w-3" />
                  ) : (
                    <UserIcon className="h-3 w-3" />
                  )}
                  {p.kind === "agent" ? p.name : p.display_name || p.username}
                  <button
                    onClick={() => setPicked((prev) => togglePick(prev, p))}
                    aria-label={`Remove ${
                      p.kind === "agent" ? p.name : p.display_name || p.username
                    }`}
                    className="focus-ring rounded-full opacity-60 transition-opacity hover:opacity-100"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>

          <div className="mb-3 flex gap-1 rounded-lg border border-line bg-slate-950/50 p-1">
            <button
              onClick={() => setTab("people")}
              className={
                tab === "people"
                  ? "focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white/[0.08] px-2 py-1.5 text-xs font-medium text-slate-50 shadow-sm"
                  : "focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
              }
            >
              <UserIcon className="h-3.5 w-3.5 text-stable-cyan" /> People
            </button>
            <button
              onClick={() => setTab("agents")}
              className={
                tab === "agents"
                  ? "focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white/[0.08] px-2 py-1.5 text-xs font-medium text-slate-50 shadow-sm"
                  : "focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
              }
            >
              <Bot className="h-3.5 w-3.5 text-stable-purple-light" /> Agents
            </button>
          </div>

          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              ref={inputRef}
              type="text"
              placeholder={
                tab === "people"
                  ? "Search by name or username…"
                  : "Search agents…"
              }
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full rounded-xl border border-line bg-slate-950/60 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          </div>

          <div className="mb-4 max-h-64 overflow-y-auto">
            {tab === "people" ? (
              users.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-slate-500">
                  {debounced ? "No matches." : "Start typing to search."}
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {users.map((u) => {
                    const candidate: StartGroupPick = {
                      kind: "user",
                      id: u.id,
                      keycloak_sub: u.keycloak_sub,
                      display_name: u.display_name,
                      username: u.username,
                    };
                    const key = pickKey(candidate);
                    const alreadyIn = u.id ? existingIds.has(u.id) : false;
                    const selected = picked.some((p) => pickKey(p) === key);
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between gap-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Identity
                            {...resolveIdentity({
                              id: u.id,
                              username: u.username,
                              display_name: u.display_name || u.username,
                              avatar_url: u.avatar_url,
                              participant_type: "human",
                            })}
                            size={28}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-200">
                              {u.display_name || u.username}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              @{u.username}
                              {!u.signed_in && (
                                <span className="ml-2 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
                                  hasn't signed in yet
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            setPicked((prev) => togglePick(prev, candidate))
                          }
                          disabled={alreadyIn}
                          className={
                            alreadyIn
                              ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-500"
                              : selected
                                ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-stable-purple/40 bg-stable-purple/20 px-2.5 py-1 text-xs font-medium text-stable-purple-light transition-colors"
                                : "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:bg-white/[0.06] hover:text-slate-100"
                          }
                        >
                          {alreadyIn ? (
                            "In this chat"
                          ) : selected ? (
                            <>
                              <Check className="h-3 w-3" /> Picked
                            </>
                          ) : (
                            "Pick"
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : filteredAgents.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-slate-500">
                {agents.length === 0 ? "No agents available." : "No matches."}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {filteredAgents.map((a) => {
                  const candidate: StartGroupPick = {
                    kind: "agent",
                    id: a.id,
                    name: a.name,
                  };
                  const key = pickKey(candidate);
                  const alreadyIn = a.id === residentAgentId;
                  const selected = picked.some((p) => pickKey(p) === key);
                  const ident = identityFor(a.id, a.name);
                  return (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Identity
                          {...resolveIdentity({
                            id: a.id,
                            name: a.name,
                            display_name: a.name,
                            participant_type: "agent",
                          })}
                          size={28}
                        />
                        <div className="min-w-0">
                          <p
                            className="truncate text-sm font-medium"
                            style={{ color: ident.text }}
                          >
                            {a.name}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {a.description || `@${a.id}`}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          setPicked((prev) => togglePick(prev, candidate))
                        }
                        disabled={alreadyIn}
                        className={
                          alreadyIn
                            ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-500"
                            : selected
                              ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
                              : "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:bg-white/[0.06] hover:text-slate-100"
                        }
                        style={
                          alreadyIn
                            ? undefined
                            : selected
                              ? {
                                  background: ident.soft,
                                  borderColor: ident.border,
                                  color: ident.text,
                                }
                              : undefined
                        }
                      >
                        {alreadyIn ? (
                          "In this chat"
                        ) : selected ? (
                          <>
                            <Check className="h-3 w-3" /> Picked
                          </>
                        ) : (
                          "Pick"
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <button
            onClick={start}
            disabled={busy || picked.length === 0}
            className="focus-ring gradient-bg shadow-glow-iris w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
