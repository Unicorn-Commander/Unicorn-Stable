import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Hash, MessageSquare, Search, User } from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { identityFor } from "@/lib/identity";
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
      sub: `@${u.username}${u.signed_in ? "" : " · not yet on Stable"}`,
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="glass-heavy w-full max-w-xl overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-label="Quick switcher"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to channel, agent, or person…"
            className="min-w-0 flex-1 bg-transparent text-base text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            esc
          </kbd>
        </div>

        <ul className="max-h-96 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <li className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
              <Search className="mb-1 h-6 w-6 text-slate-600" />
              <p className="font-display text-sm font-semibold text-slate-300">
                No matches
              </p>
              <p className="text-xs text-slate-500">
                Try a channel, agent, or teammate name.
              </p>
            </li>
          ) : (
            items.map((it, i) => {
              const ident =
                it.kind === "agent" ? identityFor(it.id, it.label) : null;
              return (
                <li key={`${it.kind}:${it.id}`}>
                  <button
                    onMouseEnter={() => setSel(i)}
                    onClick={() => activate(it)}
                    className={clsx(
                      "focus-ring relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                      i === sel
                        ? "bg-white/[0.06] text-slate-50"
                        : "text-slate-300 hover:bg-white/[0.04]",
                    )}
                  >
                    {i === sel && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
                        style={ident ? { background: ident.color } : undefined}
                      />
                    )}
                    <Icon item={it} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.label}</p>
                      <p className="truncate text-xs text-slate-500">{it.sub}</p>
                    </div>
                    <KindLabel kind={it.kind} />
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-slate-500">
          <span>
            <kbd className="mr-1 rounded border border-line bg-white/[0.04] px-1 py-0.5 text-[10px] font-medium text-slate-400">
              ↑↓
            </kbd>
            move
          </span>
          <span>
            <kbd className="mr-1 rounded border border-line bg-white/[0.04] px-1 py-0.5 text-[10px] font-medium text-slate-400">
              ↵
            </kbd>
            jump
          </span>
          <span className="ml-auto">
            <kbd className="mr-1 rounded border border-line bg-white/[0.04] px-1 py-0.5 text-[10px] font-medium text-slate-400">
              ⌘K
            </kbd>
            anywhere
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Icon({ item }: { item: Item }) {
  if (item.kind === "channel")
    return <Hash className="h-4 w-4 shrink-0 text-stable-cyan/70" />;
  if (item.kind === "dm")
    return <MessageSquare className="h-4 w-4 shrink-0 text-slate-500" />;
  if (item.kind === "agent") {
    // Agents carry their identity hue — a 6px dot, same as sidebar agent DMs.
    const ident = identityFor(item.id, item.label);
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: ident.color, boxShadow: `0 0 0 3px ${ident.faint}` }}
        />
      </span>
    );
  }
  return <User className="h-4 w-4 shrink-0 text-slate-500" />;
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
    <span className="shrink-0 rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
      {label}
    </span>
  );
}
