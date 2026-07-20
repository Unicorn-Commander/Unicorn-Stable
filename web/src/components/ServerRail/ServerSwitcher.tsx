import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Search, X, Plus, Pencil } from "lucide-react";
import clsx from "clsx";
import { useFederationStore } from "@/stores/federationStore";
import { displayName, instanceHost } from "@/lib/instances";
import { isServerAdmin } from "./admin";
import { ServerLogo } from "./ServerLogo";

/**
 * Server search + directory.
 *
 * This is where DESCRIPTIONS actually live. The rail's hover card is a
 * convenience for mouse users; a phone has no hover, so the full description
 * has to be reachable by tap — hence a palette opened from an always-visible
 * Search button (and ⌘K on desktop).
 *
 * Everything rendered from `meta` is untrusted peer output, already sanitised
 * and length-capped in @/lib/instances and rendered as text nodes. The host is
 * always shown next to the name because the name is the falsifiable half.
 */
export function ServerSwitcher() {
  const instances = useFederationStore((state) => state.accessibleInstances);
  const activeId = useFederationStore((state) => state.activeInstanceId);
  const metaByInstance = useFederationStore((state) => state.metaByInstance);
  const unreadByInstance = useFederationStore((state) => state.unreadByInstance);
  const switchInstance = useFederationStore((state) => state.switchInstance);
  const setSwitcherOpen = useFederationStore((state) => state.setSwitcherOpen);
  const setAddServerOpen = useFederationStore((state) => state.setAddServerOpen);
  const setIdentityOpen = useFederationStore((state) => state.setIdentityOpen);

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = instances.map((instance) => {
      const meta = metaByInstance[instance.id];
      return {
        instance,
        name: displayName(instance, meta),
        host: instanceHost(instance),
        description: meta?.description ?? "",
        unread: unreadByInstance[instance.id] ?? 0,
      };
    });
    if (!needle) return rows;
    return rows.filter((row) =>
      `${row.name} ${row.host} ${row.description}`.toLowerCase().includes(needle),
    );
  }, [instances, metaByInstance, unreadByInstance, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  function choose(id: string) {
    setSwitcherOpen(false);
    if (id !== activeId) void switchInstance(id);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      setSwitcherOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = results[cursor];
      if (row) choose(row.instance.id);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[10vh] backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) setSwitcherOpen(false);
      }}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Search servers"
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="glass-heavy flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search servers…"
            aria-label="Search servers by name, address or description"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={() => setSwitcherOpen(false)}
            aria-label="Close"
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              No server matches “{query.trim()}”.
            </p>
          )}
          {results.map((row, index) => {
            const active = row.instance.id === activeId;
            return (
              <button
                key={row.instance.id}
                type="button"
                onClick={() => choose(row.instance.id)}
                onMouseEnter={() => setCursor(index)}
                aria-current={active ? "true" : undefined}
                className={clsx(
                  "focus-ring flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                  index === cursor ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
                )}
              >
                <ServerLogo instance={row.instance} size="md" active={active} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-100">{row.name}</span>
                    {active && (
                      <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                        current
                      </span>
                    )}
                    {row.unread > 0 && !active && (
                      <span className="shrink-0 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {row.unread > 99 ? "99+" : row.unread}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">{row.host}</span>
                  {/* No `block` alongside line-clamp: the clamp relies on
                      display:-webkit-box and `block` can win on cascade order. */}
                  {row.description && (
                    <span className="mt-1 line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-slate-400">
                      {row.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={() => {
              setSwitcherOpen(false);
              setAddServerOpen(true);
            }}
            className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a server
          </button>
          {/* Display-gating only. The server re-checks the caller's role on every
              write, so a user who forges this button gets a 403. */}
          {isServerAdmin() && (
            <button
              type="button"
              onClick={() => {
                setSwitcherOpen(false);
                setIdentityOpen(true);
              }}
              className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit this server
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
