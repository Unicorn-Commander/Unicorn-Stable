import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark,
  Bot,
  Hash,
  Home,
  Keyboard,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Server,
  Settings,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { Identity } from "@/components/ui/Identity";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { isNavV1Enabled, type NavView, useNavStore } from "@/stores/navStore";
import { displayName, instanceHost } from "@/lib/instances";
import { useModalA11y } from "@/hooks/useModalA11y";

interface QuickSwitcherProps {
  onClose: () => void;
  onOpenGlobalSearch: () => void;
}

// No "user" kind in results: People drawer owns directory → ensure-DM (CreateDmModal owns the
// multi-step create→invite flow), so user rows would be dead entries here.
type Item =
  | { kind: "channel"; id: string; label: string; sub: string }
  | { kind: "server"; id: string; label: string; sub: string }
  | { kind: "dm"; id: string; label: string; sub: string }
  | { kind: "agent"; id: string; label: string; sub: string }
  | {
      kind: "action";
      id: string;
      label: string;
      sub: string;
      icon: LucideIcon;
      run: () => void;
    };

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

export function QuickSwitcher({ onClose, onOpenGlobalSearch }: QuickSwitcherProps) {
  const rooms = useAppStore((s) => s.rooms);
  // Servers live in the federation store. They are folded into THIS palette
  // rather than getting a chord of their own: one switcher that finds rooms,
  // agents, commands and servers beats two competing for Cmd/Ctrl+K.
  const instances = useFederationStore((s) => s.accessibleInstances);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);
  const metaByInstance = useFederationStore((s) => s.metaByInstance);
  const switchInstance = useFederationStore((s) => s.switchInstance);
  // Same rule the rail uses: servers are noise until you can reach more than one.
  const multiServer = instances.length > 1;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // Agent id whose DM is being created — guards double-Enter, drives the
  // row's spinner. null = idle.
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Esc-to-close, focus trap + restore. The hook's panel-scoped Esc stops
  // propagation, so when the switcher is stacked over SettingsModal one Esc
  // closes only this layer. It only intercepts Tab/Esc — ↑/↓/Enter below
  // keep working.
  const panelRef = useModalA11y(true, onClose);

  const { data: agents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
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
    // Everything from `meta` is untrusted peer output — already sanitised and
    // length-capped in @/lib/instances, and rendered here as a text node.
    const serverItems: Item[] = multiServer
      ? instances
          .filter((instance) => instance.id !== activeInstanceId)
          .map((instance) => {
            const meta = metaByInstance[instance.id];
            const host = instanceHost(instance);
            const description = meta?.description ?? "";
            return {
              kind: "server" as const,
              id: instance.id,
              label: displayName(instance, meta),
              // Host always rides along: the name is the falsifiable half.
              sub: description ? host + " — " + description : host,
            };
          })
      : [];
    const g = useAppStore.getState;
    const actionItems: Item[] = [
      { kind: "action", id: "new-channel", label: "Create a room", sub: "Channel, group, or direct message", icon: Plus, run: () => g().setCreateRoomModalOpen(true) },
      { kind: "action", id: "search-all", label: "Search all messages", sub: "Across every conversation", icon: Search, run: onOpenGlobalSearch },
      { kind: "action", id: "people", label: "People", sub: "Directory, DMs, favorites", icon: Users, run: () => g().setPeopleDrawerOpen(true) },
      { kind: "action", id: "saved", label: "Saved messages", sub: "Your bookmarks", icon: Bookmark, run: () => g().setSavedOpen(true) },
      { kind: "action", id: "settings", label: "Settings", sub: "Preferences & appearance", icon: Settings, run: () => g().toggleSettings() },
      { kind: "action", id: "shortcuts", label: "Keyboard shortcuts", sub: "Cheatsheet", icon: Keyboard, run: () => g().toggleCheatsheet() },
    ];
    // Jump to primary destinations when the view-based shell is on.
    if (isNavV1Enabled()) {
      const goView = (view: NavView) => {
        useNavStore.getState().setActiveView(view);
        if (view === "home") navigate("/");
      };
      actionItems.unshift(
        { kind: "action", id: "view-home", label: "Go to Home", sub: "Dashboard", icon: Home, run: () => goView("home") },
        { kind: "action", id: "view-chats", label: "Go to Chats", sub: "People and private groups", icon: MessageSquare, run: () => goView("chats") },
        { kind: "action", id: "view-channels", label: "Go to Channels", sub: "Joined channels", icon: Hash, run: () => goView("channels") },
        { kind: "action", id: "view-meetings", label: "Go to Meetings", sub: "Conference rooms", icon: Video, run: () => goView("meetings") },
        { kind: "action", id: "view-agents", label: "Go to Agents", sub: "Agent conversations", icon: Bot, run: () => goView("agents") },
      );
    }
    if (multiServer) {
      // The full directory (descriptions, add-a-server, admin identity) still
      // lives in ServerSwitcher; this row is the keyboard-only way to reach it.
      actionItems.push({
        kind: "action",
        id: "browse-servers",
        label: "Browse servers",
        sub: "Switch servers, see descriptions",
        icon: Server,
        run: () => useFederationStore.getState().setSwitcherOpen(true),
      });
    }
    const all = [
      ...actionItems,
      ...channelItems,
      ...dmItems,
      ...agentItems,
      ...serverItems,
    ];
    if (!q.trim()) return all.slice(0, 12);
    const scored = all
      .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.label), fuzzyScore(q, it.sub)) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.it);
    return scored.slice(0, 12);
  }, [
    rooms,
    agents,
    q,
    onOpenGlobalSearch,
    instances,
    activeInstanceId,
    metaByInstance,
    multiServer,
    navigate,
  ]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSel(0);
  }, [q]);

  async function activate(it: Item) {
    if (it.kind === "action") {
      onClose();
      it.run();
      return;
    }
    if (it.kind === "channel" || it.kind === "dm") {
      navigate(`/c/${it.id}`);
      onClose();
      return;
    }
    if (it.kind === "server") {
      // Close first: switchInstance tears down the per-server query caches.
      onClose();
      void switchInstance(it.id);
      return;
    }
    // Agent → same "new chat" path the sidebar uses: a fresh DM bound to the
    // persona, then jump into it.
    if (busyId) return;
    setBusyId(it.id);
    try {
      const room = await api.createAgentDm(it.id, `Chat with ${it.label}`);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      navigate(`/c/${room.id}`);
      onClose();
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't start the chat",
        body: (err as Error).message,
      });
      setBusyId(null);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    // Escape is handled by useModalA11y on the panel.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) void activate(it);
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
        aria-label="Quick switcher"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              multiServer
                ? "Search channels, agents, servers, commands…"
                : "Search channels, agents, commands…"
            }
            className="min-w-0 flex-1 bg-transparent text-base text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            esc
          </kbd>
        </div>

        <ul className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <li className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
              <Search className="mb-1 h-6 w-6 text-slate-600" />
              <p className="font-display text-sm font-semibold text-slate-300">
                No matches
              </p>
              <p className="text-xs text-slate-500">
                Try a channel or agent name.
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
                    onClick={() => void activate(it)}
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
                    {it.kind === "agent" && busyId === it.id ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
                    ) : (
                      <KindLabel kind={it.kind} />
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex shrink-0 items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-slate-500">
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
  const roster = useAppStore((s) =>
    item.kind === "agent" ? s.agents.find((agent) => agent.id === item.id) : undefined,
  );
  if (item.kind === "action") {
    const ActionIcon = item.icon;
    return <ActionIcon className="h-4 w-4 shrink-0 text-stable-purple-light/80" />;
  }
  if (item.kind === "server")
    return <Server className="h-4 w-4 shrink-0 text-stable-purple-light/80" />;
  if (item.kind === "channel")
    return <Hash className="h-4 w-4 shrink-0 text-stable-cyan/70" />;
  if (item.kind === "dm")
    return <MessageSquare className="h-4 w-4 shrink-0 text-slate-500" />;
  return (
    <Identity
      {...resolveIdentity(
        roster ?? {
          id: item.id,
          name: item.label,
          display_name: item.label,
          participant_type: "agent",
        },
      )}
      presence={null}
      size={20}
    />
  );
}

function KindLabel({ kind }: { kind: Item["kind"] }) {
  const label =
    kind === "channel"
      ? "Channel"
      : kind === "dm"
        ? "DM"
        : kind === "action"
          ? "Command"
          : kind === "server"
            ? "Server"
            : "Agent";
  return (
    <span className="shrink-0 rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
      {label}
    </span>
  );
}
