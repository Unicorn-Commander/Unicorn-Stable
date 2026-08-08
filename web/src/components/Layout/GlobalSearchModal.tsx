import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import clsx from "clsx";
import { Hash, Loader2, Search, SearchX, X } from "lucide-react";
import { api, type Message } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { identityFor } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { Avatar } from "@/components/Avatar";
import { parseSearchQuery, removeOperatorToken } from "@/utils/searchOperators";

interface GlobalSearchModalProps {
  onClose: () => void;
}

/**
 * Workspace-wide message search — spans every room the caller belongs to
 * (backend `GET /api/v1/search/messages`, membership-scoped server-side).
 * Unlike the per-room `SearchPanel` dropdown, this is a centered modal
 * (mirrors QuickSwitcher) and labels each result with its room, since results
 * cross rooms. Selecting a result jumps to that room and opens the thread.
 */
export function GlobalSearchModal({ onClose }: GlobalSearchModalProps) {
  const rooms = useAppStore((s) => s.rooms);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useModalA11y(true, onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Operators (from:/in:/has:/before:/after:) are parsed out of the raw input;
  // the free-text remainder is what gets debounced into the query string.
  const parsed = useMemo(() => parseSearchQuery(q), [q]);

  const removeOperator = (key: string) => {
    const op = parsed.operators[key as keyof typeof parsed.operators];
    if (!op) return;
    setQ(removeOperatorToken(q, key, op));
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(parsed.query.trim()), 250);
    return () => clearTimeout(t);
  }, [parsed]);

  // New result set → keyboard selection restarts at the top.
  useEffect(() => {
    setSel(0);
  }, [debounced]);

  const { data: results = [], isFetching, isError, refetch } = useQuery({
    queryKey: ["global-search", debounced, JSON.stringify(parsed.operators)],
    queryFn: () => api.searchAllMessages(debounced, parsed.operators),
    enabled: debounced.length > 0,
  });

  // room_id -> friendly label, from the already-loaded room list. Every result
  // is scoped to the caller's rooms, so its room is always present here.
  const roomLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rooms) {
      map.set(r.id, r.type === "channel" ? `#${r.name}` : r.display_name || r.name);
    }
    return map;
  }, [rooms]);

  function openResult(m: Message) {
    if (m.thread_id) {
      // A thread reply lives only in its thread panel — open that.
      navigate(`/c/${m.room_id}`);
      setThreadMessageId(m.thread_id);
    } else {
      // Land ON the message: ChatPanel's ?message deep-link scrolls to it and
      // flashes a ring (same path ActivityCenter uses). Opening a one-message
      // "thread" here was disorienting — you searched for a message, not a
      // thread view of it.
      navigate(`/c/${m.room_id}?message=${m.id}`);
    }
    onClose();
  }

  // ↑↓ move the selection, ↵ opens it — same contract as the QuickSwitcher
  // (the search modal is its sibling surface).
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = results[sel];
      if (m) openResult(m);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12dvh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        initial={{ scale: 0.96, y: -8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: -8 }}
        className="glass-heavy flex max-h-[85dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
        aria-label="Search all messages"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-stable-cyan/80" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages across all channels…"
            className="min-w-0 flex-1 bg-transparent text-base text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          {isFetching && debounced ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />
          ) : (
            <kbd className="shrink-0 rounded border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
              esc
            </kbd>
          )}
        </div>

        {Object.keys(parsed.operators).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-1.5">
            {Object.entries(parsed.operators).map(([key, value]) => (
              <button
                key={key}
                onClick={() => removeOperator(key)}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-line-strong hover:text-slate-100"
              >
                <span className="text-slate-500">{key}:</span>
                <span>{value}</span>
                <X className="h-2.5 w-2.5 text-slate-500" />
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!debounced ? (
            <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-10 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-cyan/10 text-stable-cyan shadow-[0_0_24px_rgba(34,211,238,0.15)]">
                <Search className="h-5 w-5" />
              </div>
              <p className="font-display text-sm font-semibold text-slate-200">
                Search every conversation
              </p>
              <p className="text-xs text-slate-500">
                Finds messages across all channels and DMs you're in.
              </p>
            </div>
          ) : isFetching ? (
            <p className="animate-pulse-soft px-3 py-8 text-center text-xs text-slate-500">
              Searching…
            </p>
          ) : isError ? (
            <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-8 text-center">
              <p className="font-display text-sm font-semibold text-slate-200">
                Search failed
              </p>
              <button
                onClick={() => refetch()}
                className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-line-strong hover:text-slate-100"
              >
                Try again
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-10 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-cyan/10 text-stable-cyan/80">
                <SearchX className="h-5 w-5" />
              </div>
              <p className="font-display text-sm font-semibold text-slate-200">
                No matches
              </p>
              <p className="text-xs text-slate-500">Try a different word.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {results.map((m, i) => (
                <li key={m.id}>
                  <button
                    onMouseEnter={() => setSel(i)}
                    onClick={() => openResult(m)}
                    className={clsx(
                      "focus-ring relative flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
                      i === sel
                        ? "bg-white/[0.06] text-slate-50"
                        : "text-slate-300 hover:bg-white/[0.04]",
                    )}
                  >
                    {i === sel && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
                      />
                    )}
                    <Avatar
                      name={m.sender_name}
                      src={m.sender_avatar}
                      size="sm"
                      isAgent={m.sender_type === "agent"}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className="truncate text-xs font-semibold"
                          style={{ color: identityFor(m.sender_id, m.sender_name).text }}
                        >
                          {m.sender_name}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                          {new Date(m.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-slate-400">
                        {highlight(m.content, debounced)}
                      </p>
                      <span className="mt-1 inline-flex max-w-full items-center gap-1 truncate rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-slate-400">
                        <Hash className="h-2.5 w-2.5 shrink-0 opacity-70" />
                        <span className="truncate">
                          {roomLabel.get(m.room_id)?.replace(/^#/, "") ?? "a conversation"}
                        </span>
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lc = text.toLowerCase();
  const lq = q.toLowerCase();
  const i = lc.indexOf(lq);
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-stable-purple/40 px-0.5 text-slate-100">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}
