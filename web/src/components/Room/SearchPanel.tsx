import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Search, SearchX, X } from "lucide-react";
import { identityFor } from "@/lib/identity";
import { api, type Message } from "@/services/api";
import { Avatar } from "@/components/Avatar";

interface SearchPanelProps {
  roomId: string;
  onClose: () => void;
  onSelect: (message: Message) => void;
}

export function SearchPanel({ roomId, onClose, onSelect }: SearchPanelProps) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data: results = [], isFetching, isError, refetch } = useQuery({
    queryKey: ["search", roomId, debounced],
    queryFn: () => api.searchMessages(roomId, debounced),
    enabled: debounced.length > 0,
  });

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
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search messages in this room…"
          className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
        <button
          onClick={onClose}
          className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Close search"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

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
            {results.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => {
                    onSelect(m);
                    onClose();
                  }}
                  className="focus-ring flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <Avatar
                    name={m.sender_name}
                    src={m.sender_avatar}
                    size="sm"
                    isAgent={m.sender_type === "agent"}
                  />
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
