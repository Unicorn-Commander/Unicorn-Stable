import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { X, Search, Check, MessageSquarePlus, Users, Bot, Star } from "lucide-react";
import clsx from "clsx";
import { api, type Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  TIER_META,
  tierOf,
  statusDot,
  prettyDomain,
  toolCostInfo,
} from "./agentClass";
import { PaidToolsBadge } from "./AgentBadges";

function label(a: Agent): string {
  return a.display_name || a.name;
}

/**
 * Popup to start a chat with a single agent OR several at once. Opens focused on
 * the clicked agent (pre-selected); you can add more from the searchable list.
 * One agent → a DM; several → a group room with all of them invited.
 */
export function AgentChatModal({
  focusAgent,
  agents,
  onClose,
}: {
  focusAgent: Agent;
  agents: Agent[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([focusAgent.id]),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const tierMeta = TIER_META[tierOf(focusAgent)];
  const affilMeta = AFFIL_META[affiliationOf(focusAgent)];
  const paidNames = useMemo(
    () => new Set(toolCostInfo(focusAgent).paidTools.map((t) => t.name)),
    [focusAgent],
  );

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? agents.filter(
          (a) =>
            label(a).toLowerCase().includes(q) ||
            (a.domain || "").toLowerCase().includes(q) ||
            (a.title || "").toLowerCase().includes(q),
        )
      : agents;
    // Selected first, then alphabetical.
    return [...base].sort(
      (a, b) =>
        Number(selected.has(b.id)) - Number(selected.has(a.id)) ||
        label(a).localeCompare(label(b)),
    );
  }, [agents, query, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function start() {
    const ids = [...selected];
    if (busy || ids.length === 0) return;
    setBusy(true);
    try {
      const picked = agents.filter((a) => ids.includes(a.id));
      let roomId: string;
      if (picked.length === 1) {
        const room = await api.createAgentDm(
          picked[0]!.id,
          `Chat with ${label(picked[0]!)}`,
        );
        roomId = room.id;
      } else {
        const names = picked.slice(0, 3).map(label).join(", ");
        const room = await api.createRoom({
          name:
            "Group: " + names + (picked.length > 3 ? ` +${picked.length - 3}` : ""),
          description: "",
          type: "group_dm",
          member_ids: [],
          agent_ids: [],
        });
        for (const a of picked) {
          try {
            await api.inviteBrigadeAgent(room.id, a.id);
          } catch (err) {
            console.warn("agent-invite failed for", a.id, err);
          }
        }
        roomId = room.id;
      }
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      onClose();
      navigate(`/c/${roomId}`);
    } catch (err) {
      console.error("start agent chat failed", err);
      alert("Couldn't start the chat — " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const count = selected.size;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Start a chat with agents"
    >
      <motion.div
        initial={{ scale: 0.96, y: 8, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 8, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className={clsx(
          "flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-l-4 border-slate-700/60 bg-slate-900 shadow-2xl",
          affilMeta.border,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Focused agent header */}
        <div className="relative shrink-0 overflow-hidden border-b border-slate-700/50 p-5">
          <div
            className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-stable-purple/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative flex items-start gap-3">
            <span className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-2xl text-stable-purple-light">
              {focusAgent.avatar_url ? (
                <img
                  src={focusAgent.avatar_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : focusAgent.emoji ? (
                <span aria-hidden="true">{focusAgent.emoji}</span>
              ) : (
                <Bot className="h-6 w-6" />
              )}
              <span
                className={clsx(
                  "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-slate-900",
                  statusDot(focusAgent.status),
                )}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-bold text-slate-50">
                  {label(focusAgent)}
                </h2>
                <span
                  className={clsx(
                    "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1",
                    tierMeta.chip,
                  )}
                >
                  {tierMeta.label}
                </span>
                <PaidToolsBadge agent={focusAgent} />
              </div>
              <p className="truncate text-sm text-stable-purple-light">
                {focusAgent.title || prettyDomain(focusAgent.domain)}
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                <span className={clsx("inline-flex items-center gap-1", affilMeta.text)}>
                  {affilMeta.label}
                </span>
                {focusAgent.rank && (
                  <span className="inline-flex items-center gap-0.5 text-slate-400">
                    <Star className="h-3 w-3" />
                    {focusAgent.rank}
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={onClose}
              className="-mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {focusAgent.tools && focusAgent.tools.length > 0 && (
            <div className="relative mt-3 flex flex-wrap gap-1.5">
              {focusAgent.tools.slice(0, 8).map((t) => (
                <span
                  key={t}
                  title={paidNames.has(t) ? `${t} · costs money` : t}
                  className={clsx(
                    "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                    paidNames.has(t)
                      ? "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/25"
                      : "bg-slate-700/40 text-slate-400",
                  )}
                >
                  {paidNames.has(t) ? `$ ${t}` : t}
                </span>
              ))}
              {focusAgent.tools.length > 8 && (
                <span className="rounded-md bg-slate-700/30 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                  +{focusAgent.tools.length - 8}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Add-more selector */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <Users className="h-3.5 w-3.5" />
              Add agents to this chat
            </span>
            <span className="text-[11px] text-slate-500">{count} selected</span>
          </div>
          <div className="relative mx-4 mt-2">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg bg-slate-800/80 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder-slate-500 outline-none ring-1 ring-slate-700/50 focus:ring-stable-purple/50"
              aria-label="Search agents to add"
            />
          </div>
          <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {list.map((a) => {
              const on = selected.has(a.id);
              return (
                <li key={a.id}>
                  <button
                    onClick={() => toggle(a.id)}
                    className={clsx(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                      on ? "bg-stable-purple/15" : "hover:bg-slate-800/60",
                    )}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-stable-purple-light">
                      {a.emoji ? (
                        <span aria-hidden="true">{a.emoji}</span>
                      ) : (
                        <Bot className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-200">
                        {label(a)}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {a.title || prettyDomain(a.domain)}
                      </span>
                    </span>
                    <span
                      className={clsx(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        on
                          ? "border-stable-purple bg-stable-purple text-white"
                          : "border-slate-600",
                      )}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-700/50 p-3">
          {count > 1 && (
            <p className="mb-2 px-1 text-[11px] text-slate-500">
              Group chat — @mention an agent (or @all) to address them.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              onClick={start}
              disabled={busy || count === 0}
              className="gradient-bg flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MessageSquarePlus className="h-4 w-4" />
              {busy
                ? "Starting…"
                : count > 1
                  ? `Start group chat (${count})`
                  : "Start chat"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
