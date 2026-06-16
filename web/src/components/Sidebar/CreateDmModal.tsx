import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X, Check, Bot, User as UserIcon } from "lucide-react";
import { api, type Room, type BrigadeAgent } from "@/services/api";
import { Avatar } from "@/components/Avatar";

interface CreateDmModalProps {
  onClose: () => void;
}

interface PickedUser {
  kind: "user";
  id: string | null;
  keycloak_sub: string;
  display_name: string;
  username: string;
}

interface PickedAgent {
  kind: "agent";
  id: string;
  name: string;
  description: string;
}

type Picked = PickedUser | PickedAgent;
type Tab = "people" | "agents";

function pickedKey(p: Picked): string {
  if (p.kind === "agent") return `agent:${p.id}`;
  return `user:${p.id || p.keycloak_sub}`;
}

export function CreateDmModal({ onClose }: CreateDmModalProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("people");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tab]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const filteredAgents: BrigadeAgent[] = (() => {
    if (!debounced) return agents;
    const q = debounced.toLowerCase();
    return agents.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.description || "").toLowerCase().includes(q),
    );
  })();

  function togglePickUser(u: Omit<PickedUser, "kind">) {
    const candidate: PickedUser = { kind: "user", ...u };
    const key = pickedKey(candidate);
    setPicked((prev) =>
      prev.find((x) => pickedKey(x) === key)
        ? prev.filter((x) => pickedKey(x) !== key)
        : [...prev, candidate],
    );
  }
  function togglePickAgent(a: BrigadeAgent) {
    const candidate: PickedAgent = {
      kind: "agent",
      id: a.id,
      name: a.name,
      description: a.description,
    };
    const key = pickedKey(candidate);
    setPicked((prev) =>
      prev.find((x) => pickedKey(x) === key)
        ? prev.filter((x) => pickedKey(x) !== key)
        : [...prev, candidate],
    );
  }

  const pickedUsers = picked.filter(
    (p): p is PickedUser => p.kind === "user",
  );
  const pickedAgents = picked.filter(
    (p): p is PickedAgent => p.kind === "agent",
  );

  async function start() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    try {
      const memberCount = pickedUsers.length + pickedAgents.length;
      const isGroup = memberCount >= 2;
      const labelParts: string[] = [];
      if (pickedUsers.length > 0) {
        labelParts.push(
          ...pickedUsers
            .slice(0, 3)
            .map((p) => p.display_name || p.username),
        );
      }
      if (pickedAgents.length > 0 && labelParts.length < 3) {
        labelParts.push(
          ...pickedAgents
            .slice(0, 3 - labelParts.length)
            .map((p) => p.name),
        );
      }
      const display = isGroup
        ? "Group: " + labelParts.join(", ")
        : pickedUsers.length === 1
          ? `DM with ${pickedUsers[0]!.display_name || pickedUsers[0]!.username}`
          : `Chat with ${pickedAgents[0]!.name}`;

      const room: Room = await api.createRoom({
        name: display,
        description: "",
        type: isGroup ? "group_dm" : "dm",
        member_ids: [],
        agent_ids: [],
      });

      for (const u of pickedUsers) {
        try {
          await api.inviteUserToRoom(
            room.id,
            u.id ? { participant_id: u.id } : { keycloak_sub: u.keycloak_sub },
          );
        } catch (err) {
          console.warn("dm-invite failed for", u.username, err);
        }
      }

      for (const a of pickedAgents) {
        try {
          await api.inviteBrigadeAgent(room.id, a.id);
        } catch (err) {
          console.warn("agent-invite failed for", a.id, err);
        }
      }

      await qc.invalidateQueries({ queryKey: ["rooms"] });
      onClose();
      navigate(`/c/${room.id}`);
    } catch (err) {
      console.error("dm create failed", err);
      alert("Couldn't start DM — " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const startLabel = (() => {
    if (busy) return "Starting…";
    if (picked.length === 0) return "Pick someone";
    if (picked.length === 1) {
      const only = picked[0]!;
      return only.kind === "agent"
        ? `Chat with ${only.name}`
        : `Start DM with ${only.display_name || only.username}`;
    }
    return `Start group with ${picked.length}`;
  })();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="w-full max-w-md rounded-xl border border-slate-700/50 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Start a chat
            </h2>
            <p className="text-xs text-slate-400">
              Pick people, agents, or both — everyone lands in one room.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex gap-1 rounded-md bg-slate-950/60 p-1">
          <button
            onClick={() => setTab("people")}
            className={
              tab === "people"
                ? "flex flex-1 items-center justify-center gap-1.5 rounded bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-100"
                : "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            }
          >
            <UserIcon className="h-3.5 w-3.5" /> People
          </button>
          <button
            onClick={() => setTab("agents")}
            className={
              tab === "agents"
                ? "flex flex-1 items-center justify-center gap-1.5 rounded bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-100"
                : "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            }
          >
            <Bot className="h-3.5 w-3.5" /> Agents
          </button>
        </div>

        {picked.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <span
                key={pickedKey(p)}
                className={
                  p.kind === "agent"
                    ? "flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-200"
                    : "flex items-center gap-1 rounded-full border border-stable-purple/40 bg-stable-purple/10 px-2 py-0.5 text-xs text-stable-purple-light"
                }
              >
                {p.kind === "agent" ? (
                  <Bot className="h-3 w-3" />
                ) : (
                  <UserIcon className="h-3 w-3" />
                )}
                {p.kind === "agent"
                  ? p.name
                  : p.display_name || p.username}
                <button
                  onClick={() =>
                    setPicked((prev) =>
                      prev.filter((x) => pickedKey(x) !== pickedKey(p)),
                    )
                  }
                  aria-label="Remove"
                  className="text-slate-400 hover:text-slate-200"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
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
            className="w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-stable-purple focus:outline-none"
          />
        </div>

        <div className="mb-4 max-h-64 overflow-y-auto">
          {tab === "people" ? (
            users.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-slate-500">
                {debounced ? "No matches." : "Start typing to search."}
              </p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {users.map((u) => {
                  const candidate: Omit<PickedUser, "kind"> = {
                    id: u.id,
                    keycloak_sub: u.keycloak_sub,
                    display_name: u.display_name,
                    username: u.username,
                  };
                  const key = pickedKey({ kind: "user", ...candidate });
                  const selected = picked.find((p) => pickedKey(p) === key);
                  return (
                    <li
                      key={key}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar
                          name={u.display_name || u.username}
                          src={u.avatar_url}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm text-slate-200">
                            {u.display_name || u.username}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            @{u.username}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => togglePickUser(candidate)}
                        className={
                          selected
                            ? "flex shrink-0 items-center gap-1 rounded-md bg-stable-purple/30 px-2.5 py-1 text-xs text-stable-purple-light"
                            : "flex shrink-0 items-center gap-1 rounded-md bg-stable-purple/20 px-2.5 py-1 text-xs text-stable-purple hover:bg-stable-purple/30"
                        }
                      >
                        {selected ? (
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
              {agents.length === 0
                ? "No agents available."
                : "No matches."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {filteredAgents.map((a) => {
                const key = pickedKey({
                  kind: "agent",
                  id: a.id,
                  name: a.name,
                  description: a.description,
                });
                const selected = picked.find((p) => pickedKey(p) === key);
                return (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-cyan-500/20 text-cyan-300">
                        <Bot className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">
                          {a.name}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {a.description || `@${a.id}`}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => togglePickAgent(a)}
                      className={
                        selected
                          ? "flex shrink-0 items-center gap-1 rounded-md bg-cyan-500/30 px-2.5 py-1 text-xs text-cyan-200"
                          : "flex shrink-0 items-center gap-1 rounded-md bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-300 hover:bg-cyan-500/30"
                      }
                    >
                      {selected ? (
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
          className="w-full rounded-md bg-stable-purple py-2 text-sm font-medium text-white hover:bg-stable-purple-light disabled:opacity-50"
        >
          {startLabel}
        </button>
      </motion.div>
    </motion.div>
  );
}
