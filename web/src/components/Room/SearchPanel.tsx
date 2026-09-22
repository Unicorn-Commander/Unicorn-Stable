import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import clsx from "clsx";
import { Search, SearchX, X } from "lucide-react";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { api, type Message } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { parseSearchQuery, removeOperatorToken } from "@/utils/searchOperators";

interface SearchPanelProps {
  roomId: string;
  onClose: () => void;
  onSelect: (message: Message) => void;
}

export function SearchPanel({ roomId, onClose, onSelect }: SearchPanelProps) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Operators (from:/has:/before:/after:) are parsed out of the raw input;
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
    queryKey: ["search", roomId, debounced, JSON.stringify(parsed.operators)],
    queryFn: () => api.searchMessages(roomId, debounced, parsed.operators),
    enabled: debounced.length > 0,
  });

  // ↑↓ move the selection, ↵ jumps to it — same contract as the
  // QuickSwitcher / global search.
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = results[sel];
      if (m) {
        onSelect(m);
        onClose();
      }
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-x-0 top-12 z-30 mx-auto max-w-2xl rounded-b-xl border border-t-0 border-line-strong bg-slate-900/90 shadow-pop backdrop-blur-xl"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search className="h-4 w-4 text-stable-cyan/80" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search messages in this room…"
          className="flex-1 bg-transparent text-base md:text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
        <button
          onClick={onClose}
          className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Close search"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {Object.keys(parsed.operators).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
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

      <div className="max-h-96 overflow-y-auto">
        {!debounced ? (
          <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-8 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-stable-cyan/10 text-stable-cyan shadow-[0_0_24px_rgba(34,211,238,0.15)]">
              <Search className="h-5 w-5" />
            </div>
            <p className="font-display text-sm font-semibold text-slate-200">
              Search this room
            </p>
            <p className="text-xs text-slate-500">
              Type at least one character.
            </p>
          </div>
        ) : isFetching ? (
          <p className="animate-pulse-soft px-3 py-6 text-center text-xs text-slate-500">
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
          <div className="flex animate-fade-in flex-col items-center gap-2 px-3 py-8 text-center">
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
                  onClick={() => {
                    onSelect(m);
                    onClose();
                  }}
                  className={clsx(
                    "focus-ring relative flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
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
                  <Identity {...resolveIdentity(m)} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="text-xs font-semibold"
                        style={{
                          color: identityFor(m.sender_id, m.sender_name).text,
                        }}
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
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
