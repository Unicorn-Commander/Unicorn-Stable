import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Bot, Hash, MessageSquare, Search, User } from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

interface QuickSwitcherProps {
  onClose: () => void;
}

type Item =
  | { kind: "channel"; id: string; label: string; sub: string }
  | { kind: "dm"; id: string; label: string; sub: string }
  | { kind: "agent"; id: string; label: string; sub: string }
  | { kind: "user"; id: string; label: string; sub: string };

function fuzzyScore(needle: string, hay: string): number {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (h.startsWith(n)) return 1000 + (1000 - h.length);
  if (h.includes(n)) return 500 - h.indexOf(n);
  // subsequence match
  let i = 0;
  let s = 0;
  for (const c of h) {
    if (c === n[i]) {
      i++;
      s += 5;
      if (i === n.length) break;
    }
  }
  return i === n.length ? s : 0;
}

export function QuickSwitcher({ onClose }: QuickSwitcherProps) {
  const rooms = useAppStore((s) => s.rooms);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: agents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-search", q],
    queryFn: () => api.searchUsers(q),
    enabled: q.length >= 2,
  });

  const items = useMemo<Item[]>(() => {
    const channelItems: Item[] = rooms
      .filter((r) => r.type === "channel")
      .map((r) => ({
        kind: "channel" as const,
        id: r.id,
        label: r.name,
        sub: r.description || "channel",
      }));
    const dmItems: Item[] = rooms
      .filter((r) => r.type === "dm" || r.type === "group_dm")
      .map((r) => ({
        kind: "dm" as const,
        id: r.id,
        label: r.name,
        sub: "direct message",
      }));
    const agentItems: Item[] = agents.map((a) => ({
      kind: "agent" as const,
      id: a.id,
      label: a.name,
      sub: a.description?.slice(0, 60) ?? "agent",
    }));
    const userItems: Item[] = users.slice(0, 5).map((u) => ({
      kind: "user" as const,
      id: u.id || u.keycloak_sub,
      label: u.display_name || u.username,
      sub: `@${u.username}${u.signed_in ? "" : " · not yet on Command Center"}`,
    }));
    const all = [...channelItems, ...dmItems, ...agentItems, ...userItems];
    if (!q.trim()) return all.slice(0, 12);
    const scored = all
      .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.label), fuzzyScore(q, it.sub)) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.it);
    return scored.slice(0, 12);
  }, [rooms, agents, users, q]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSel(0);
  }, [q]);

  function activate(it: Item) {
    if (it.kind === "channel" || it.kind === "dm") {
      navigate(`/c/${it.id}`);
    } else if (it.kind === "agent" || it.kind === "user") {
      // Future: open compose-DM-with flow. For now just close.
    }
    onClose();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) activate(it);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-label="Quick switcher"
      >
        <div className="flex items-center gap-2 border-b border-slate-700/50 px-3 py-2.5">
          <Search className="h-4 w-4 text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to channel, agent, or person…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
          />
          <kbd className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">
            esc
          </kbd>
        </div>

        <ul className="max-h-96 overflow-y-auto py-1">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-500">
              No matches.
            </li>
          ) : (
            items.map((it, i) => (
              <li key={`${it.kind}:${it.id}`}>
                <button
                  onMouseEnter={() => setSel(i)}
                  onClick={() => activate(it)}
                  className={clsx(
                    "flex w-full items-center gap-3 px-3 py-2 text-left",
                    i === sel
                      ? "bg-stable-purple/15 text-slate-100"
                      : "text-slate-300 hover:bg-slate-800/40",
                  )}
                >
                  <Icon kind={it.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.label}</p>
                    <p className="truncate text-xs text-slate-500">{it.sub}</p>
                  </div>
                  <KindLabel kind={it.kind} />
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="flex items-center gap-3 border-t border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
          <span>
            <kbd className="mr-1 rounded border border-slate-700 px-1">↑↓</kbd>
            move
          </span>
          <span>
            <kbd className="mr-1 rounded border border-slate-700 px-1">↵</kbd>
            jump
          </span>
          <span className="ml-auto">
            <kbd className="mr-1 rounded border border-slate-700 px-1">⌘K</kbd>
            anywhere
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Icon({ kind }: { kind: Item["kind"] }) {
  const cls = "h-4 w-4 shrink-0 text-slate-500";
  if (kind === "channel") return <Hash className={cls} />;
  if (kind === "dm") return <MessageSquare className={cls} />;
  if (kind === "agent") return <Bot className={cls} />;
  return <User className={cls} />;
}

function KindLabel({ kind }: { kind: Item["kind"] }) {
  const label =
    kind === "channel"
      ? "Channel"
      : kind === "dm"
        ? "DM"
        : kind === "agent"
          ? "Agent"
          : "User";
  return (
    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
      {label}
    </span>
  );
}
