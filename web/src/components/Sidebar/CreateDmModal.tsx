import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X, Check, Bot, User as UserIcon } from "lucide-react";
import { api, type Room, type BrigadeAgent } from "@/services/api";
import { identityFor } from "@/lib/identity";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy w-full max-w-md overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-50">
              Start a chat
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Pick people, agents, or both — everyone lands in one room.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="focus-ring -mr-1 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
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

        {picked.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {picked.map((p) => {
              // Agent chips carry the resident's identity hue; human chips
              // stay in the brand iris family.
              const ident =
                p.kind === "agent" ? identityFor(p.id, p.name) : null;
              return (
                <span
                  key={pickedKey(p)}
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
                    className="focus-ring rounded-full opacity-60 transition-opacity hover:opacity-100"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

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
                          <p className="truncate text-sm font-medium text-slate-200">
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
                            ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-stable-purple/40 bg-stable-purple/20 px-2.5 py-1 text-xs font-medium text-stable-purple-light transition-colors"
                            : "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:bg-white/[0.06] hover:text-slate-100"
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
            <ul className="divide-y divide-line">
              {filteredAgents.map((a) => {
                const key = pickedKey({
                  kind: "agent",
                  id: a.id,
                  name: a.name,
                  description: a.description,
                });
                const selected = picked.find((p) => pickedKey(p) === key);
                const ident = identityFor(a.id, a.name);
                return (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                        style={{
                          background: ident.soft,
                          borderColor: ident.border,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: ident.color }}
                        />
                      </div>
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
                      onClick={() => togglePickAgent(a)}
                      className={
                        selected
                          ? "focus-ring flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
                          : "focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:bg-white/[0.06] hover:text-slate-100"
                      }
                      style={
                        selected
                          ? {
                              background: ident.soft,
                              borderColor: ident.border,
                              color: ident.text,
                            }
                          : undefined
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
          className="focus-ring gradient-bg shadow-glow-iris w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {startLabel}
        </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
