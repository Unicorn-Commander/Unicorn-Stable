import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bookmark, Settings, LogOut, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { logout } from "@/services/auth";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { useChannelCategories } from "@/stores/categoryStore";
import { useFederationStore } from "@/stores/federationStore";
import { Avatar } from "@/components/Avatar";
import { identityFor } from "@/lib/identity";
import { StableMark } from "@/components/StableMark";
import { useGlobalNotifications } from "@/hooks/useGlobalNotifications";
import { useAppHeight } from "@/hooks/useAppHeight";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { Header } from "./Header";
import { ToastStack } from "./ToastStack";
import { CheatsheetModal } from "./CheatsheetModal";
import { SettingsModal } from "./SettingsModal";
import { SavedPanel } from "./SavedPanel";
import { QuickSwitcher } from "./QuickSwitcher";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { ServerRail } from "./ServerRail";
import { AddServerModal } from "./AddServerModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RoomList } from "@/components/Sidebar/RoomList";
import { CreateRoomModal } from "@/components/Sidebar/CreateRoomModal";
import { RoomView } from "@/components/Room/RoomView";
import { IncomingCallBanner } from "@/components/Call/IncomingCallBanner";
import { HomeDashboard } from "@/components/Home/HomeDashboard";
import { AgentsPage } from "@/components/Agents/AgentsPage";
import { BridgePage } from "@/components/Bridge/BridgePage";

/**
 * The sidebar's visual room order, flattened for Alt+↑/↓ navigation. Mirrors
 * RoomList exactly: categorized channels (categories A→Z, list order within;
 * collapsed categories skipped — their rows aren't visible), then ungrouped
 * channels, then Direct messages where an agent's threads collapse to ONE
 * entry (its newest thread — the collapsed group row's click target).
 *
 * Each entry is the set of room ids it represents; entry[0] is the navigation
 * target. Multi-id entries let a non-newest agent thread still resolve to its
 * group's position instead of falling off the list.
 */
function sidebarRoomOrder(): string[][] {
  const { rooms } = useAppStore.getState();
  const { categories, collapsed } = useChannelCategories.getState();
  const entries: string[][] = [];

  const grouped = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const r of rooms) {
    if (r.type !== "channel") continue;
    const cat = categories[r.id];
    if (!cat) {
      ungrouped.push(r.id);
    } else if (!collapsed[cat]) {
      const arr = grouped.get(cat);
      if (arr) arr.push(r.id);
      else grouped.set(cat, [r.id]);
    }
  }
  for (const [, ids] of [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    for (const id of ids) entries.push([id]);
  }
  for (const id of ungrouped) entries.push([id]);

  const byAgent = new Map<string, string[]>();
  for (const r of rooms) {
    if (r.type !== "dm" && r.type !== "group_dm") continue;
    const agentId = r.brigade_agent_id;
    if (agentId) {
      const threads = byAgent.get(agentId);
      if (threads) {
        threads.push(r.id);
      } else {
        const fresh = [r.id];
        byAgent.set(agentId, fresh);
        entries.push(fresh);
      }
    } else {
      entries.push([r.id]);
    }
  }
  return entries;
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export function AppShell() {
  useGlobalNotifications();
  // Keep the app pinned to the visible viewport (collapsing toolbar + keyboard).
  useAppHeight();
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  // Desktop drag-to-resize for the room-list sidebar. On phones the sidebar is
  // an off-canvas overlay drawer at a fixed 280px — no handle, no stored width.
  const isDesktop = useIsDesktop();
  const sidebarResize = usePanelResize("sidebar", {
    defaultWidth: 280,
    min: 220,
    max: 480,
    edge: "right",
  });
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const isAgentsView = location.pathname === "/agents";
  const isBridgeView = location.pathname === "/bridge";
  const navigate = useNavigate();
  const setRooms = useAppStore((s) => s.setRooms);
  const setAgents = useAppStore((s) => s.setAgents);
  const createRoomModalOpen = useAppStore((s) => s.ui.createRoomModalOpen);
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const savedOpen = useAppStore((s) => s.ui.savedOpen);
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const currentUser = useAppStore((s) => s.currentUser);
  // Identity hue for the signed-in resident (rings the drawer-footer avatar).
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  // Federated multi-server: the active instance id keys the per-server
  // react-query caches; a switch clears the cache and returns to the home view.
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);
  const switching = useFederationStore((s) => s.switching);
  const addServerOpen = useFederationStore((s) => s.addServerOpen);
  const queryClient = useQueryClient();
  const previousInstanceId = useRef(activeInstanceId);

  useEffect(() => {
    if (!activeInstanceId) return;
    if (previousInstanceId.current === null) {
      previousInstanceId.current = activeInstanceId;
      return;
    }
    if (previousInstanceId.current === activeInstanceId) return;
    previousInstanceId.current = activeInstanceId;
    // Rooms/agents (and everything derived from them) belonged to the old
    // server — drop the whole react-query cache and land on the home view.
    queryClient.removeQueries();
    void queryClient.invalidateQueries();
    navigate("/", { replace: true });
  }, [activeInstanceId, navigate, queryClient]);

  // Poll the OTHER reachable servers for unread so the rail can badge them.
  // Cheap + fail-safe (inactive instances only, every 60s); no-op single-server.
  useEffect(() => {
    const fed = useFederationStore.getState();
    if (fed.accessibleInstances.length <= 1) return;
    void fed.refreshInstanceUnread();
    const timer = setInterval(
      () => void useFederationStore.getState().refreshInstanceUnread(),
      60_000,
    );
    return () => clearInterval(timer);
  }, [activeInstanceId]);

  // Tab title: "(unread) #room — Stable" so background tabs can notify AND the
  // tab strip identifies which conversation this window is sitting in.
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const storeRooms = useAppStore((s) => s.rooms);
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    const active = storeRooms.find((r) => r.id === activeRoomId);
    const prefix = total > 0 ? `(${total > 99 ? "99+" : total}) ` : "";
    const roomLabel = active
      ? `${active.type === "channel" ? "#" : ""}${active.name} — `
      : "";
    document.title = `${prefix}${roomLabel}Stable`;
    return () => {
      document.title = "Stable";
    };
  }, [unreadCounts, storeRooms, activeRoomId]);

  // Favicon unread badge: draw the site icon onto a 64px canvas with a red
  // count pill and swap the <link rel="icon"> href to the data URL; restore
  // the original href when unread returns to 0. The badge label ("1".."99",
  // capped) is the redraw key — same label means no redraw, so a stream of
  // messages into an already-badged bucket can't thrash the icon.
  const faviconLinkRef = useRef<HTMLLinkElement | null>(null);
  const faviconOriginalRef = useRef<string | null>(null);
  const faviconLabelRef = useRef<string>("");
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    const label = total <= 0 ? "" : total > 99 ? "99" : String(total);
    if (label === faviconLabelRef.current) return;
    faviconLabelRef.current = label;

    const link =
      faviconLinkRef.current ??
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    faviconLinkRef.current = link;
    // Cache the pristine href once (link.href resolves to an absolute URL,
    // which is exactly what Image.src and the restore path both want).
    if (faviconOriginalRef.current === null) {
      faviconOriginalRef.current = link.href;
    }
    const originalHref = faviconOriginalRef.current;

    if (!label) {
      link.href = originalHref;
      return;
    }

    // Stale-draw guard: the icon loads async, so by the time it arrives a
    // newer effect run may have moved the label on (or cleared it). Compare
    // against the ref instead of a cleanup flag — a cleanup flag would also
    // cancel the draw on StrictMode's mount->cleanup->remount cycle, where the
    // rerun early-returns on the unchanged label and the badge never renders.
    const drawBadge = (img: HTMLImageElement | null) => {
      if (faviconLabelRef.current !== label) return;
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // Base icon; on load failure we fall through to a badge-only canvas
        // so the unread signal still shows.
        if (img) ctx.drawImage(img, 0, 0, size, size);
        // Pill in the top-right quadrant — red (#ef4444) beats Aurora purple
        // for 16px legibility. Wider pill for 2-digit counts. Manual arc path
        // (not roundRect) for older canvas implementations.
        const h = 34;
        const r = h / 2;
        const w = label.length > 1 ? 46 : h;
        const x = size - w;
        const y = 0;
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(x + r, y + h);
        ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font =
          "bold 26px system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + w / 2, y + h / 2 + 1);
        // Only swap after toDataURL succeeds (it throws on a tainted canvas),
        // so a failure leaves the real favicon untouched.
        link.href = canvas.toDataURL("image/png");
      } catch {
        // Cosmetic — never let the favicon break anything.
      }
    };

    // The favicon is same-origin (SVG or PNG both drawImage fine), but it
    // loads async — badge once it arrives; badge-only if it never does.
    const img = new Image();
    img.onload = () => drawBadge(img);
    img.onerror = () => drawBadge(null);
    img.src = originalHref;
  }, [unreadCounts]);

  // Restore the pristine favicon if the shell ever unmounts mid-badge.
  // Clearing the label ref first also voids any still-inflight badge draw.
  useEffect(() => {
    return () => {
      faviconLabelRef.current = "";
      if (faviconLinkRef.current && faviconOriginalRef.current) {
        faviconLinkRef.current.href = faviconOriginalRef.current;
      }
    };
  }, []);

  // Global shortcuts, one listener: Cmd/Ctrl+/ cheatsheet, Cmd/Ctrl+K quick
  // switcher, Alt+↑/↓ previous/next room in the sidebar's visual order.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        useAppStore.getState().toggleCheatsheet();
        return;
      }
      // Bare "?" (Shift+/) opens the same cheatsheet — the near-universal
      // "help" shortcut. Skipped while typing so it never eats a literal "?".
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        useAppStore.getState().toggleCheatsheet();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setGlobalSearchOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen(true);
        return;
      }
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        // Not while typing — Alt+arrows are word/line motions in editors.
        if (isEditableTarget(e.target)) return;
        const entries = sidebarRoomOrder();
        if (entries.length === 0) return;
        e.preventDefault();
        const current = useAppStore.getState().activeRoomId;
        const idx = entries.findIndex((ids) =>
          ids.includes(current ?? ""),
        );
        const delta = e.key === "ArrowUp" ? -1 : 1;
        // No active room: enter the list from the end you're moving toward.
        const next =
          idx === -1
            ? delta === 1
              ? 0
              : entries.length - 1
            : Math.min(Math.max(idx + delta, 0), entries.length - 1);
        const target = entries[next]?.[0];
        if (target && target !== current) {
          useAppStore.getState().clearUnread(target);
          navigate(`/c/${target}`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const { data: rooms } = useQuery({
    queryKey: ["rooms", activeInstanceId],
    queryFn: () => api.getRooms(),
    refetchInterval: 60_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents", activeInstanceId],
    queryFn: () => api.getAgents(),
    staleTime: 120_000,
  });

  useEffect(() => {
    if (rooms) {
      setRooms(rooms);
    }
  }, [rooms, setRooms]);

  // ---------------------------------------------------------------------------
  // ROUTING: the URL is the SINGLE, ONE-DIRECTIONAL source of truth for the
  // active room. The flow is always URL -> store, never store -> URL:
  //
  //   user action (sidebar click, quick-switcher, create/leave, deep-link)
  //     -> navigate("/c/<id>")        (handlers navigate; they never setActiveRoomId)
  //     -> routeRoomId changes
  //     -> the single effect below sets activeRoomId
  //     -> RoomView mounts off activeRoomId
  //
  // There is intentionally NO store -> URL effect. A prior attempt (reverted,
  // commit 6c36874) had TWO effects syncing both ways plus a branch that nulled
  // activeRoomId when the route param had not caught up; they raced every render
  // and settled with activeRoomId=null, leaving the main pane on the welcome
  // empty-state even though the URL + sidebar updated. DO NOT re-add a
  // store->URL effect or call setActiveRoomId from a click handler: navigate()
  // is the only entry point and this single idempotent effect is the only writer.

  // Legacy permalink shim: /?room=X(&message=Y) -> /c/X(?message=Y). This is a
  // URL -> URL redirect (not store -> URL), so it cannot join a sync loop;
  // previously-shared ?room= links still resolve.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const legacyRoom = search.get("room");
    if (!legacyRoom) return;
    const msg = search.get("message");
    navigate(
      `/c/${legacyRoom}${msg ? `?message=${encodeURIComponent(msg)}` : ""}`,
      { replace: true },
    );
  }, [navigate]);

  // URL -> store: the ONLY writer of activeRoomId from routing. Depends on
  // routeRoomId alone and is idempotent, so it converges in a single pass for
  // every entry path (sidebar click, deep-link, refresh on /c/:id, browser
  // back/forward) and is safe under React StrictMode double-invocation.
  // The "/" route (no param) clears the active room.
  useEffect(() => {
    setActiveRoomId(routeRoomId ?? null);
  }, [routeRoomId, setActiveRoomId]);

  useEffect(() => {
    if (agents) {
      setAgents(agents);
    }
  }, [agents, setAgents]);

  // Auto-close sidebar on small screens when a room is opened
  useEffect(() => {
    if (typeof window === "undefined") return;
    // <768px = phone (the off-canvas drawer). 768px itself is desktop (Tailwind
    // `md`), so use 767 — at exactly 768 the sidebar is in-flow and must NOT be
    // auto-collapsed.
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = (small: boolean) => {
      const ui = useAppStore.getState().ui;
      if (small && activeRoomId && ui.sidebarOpen) {
        useAppStore.setState({
          ui: { ...ui, sidebarOpen: false },
        });
      }
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [activeRoomId]);

  return (
    // Transparent root: the page tone comes from body (surface-0) + the aurora
    // field behind it, so glass/translucent surfaces actually pick it up.
    <div
      className="relative flex w-screen overflow-hidden"
      style={{
        // Fill the visible viewport exactly (see useAppHeight). Reserve the
        // notch/status-bar inset up top so content clears it in standalone PWA
        // mode. No left/right inset here on purpose: the drawers + backdrop are
        // `fixed` (viewport-anchored), so insetting only the root would leave a
        // seam in landscape — edge-to-edge is correct for those overlays.
        height: "var(--app-height, 100dvh)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      {/* Discord-style server rail — 72px, far left, desktop only. Renders null
          unless the user can reach more than one federated instance. */}
      <ServerRail />
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            // Desktop width is user-resizable (persisted); the phone drawer
            // stays at the fixed 280 the overlay was designed around.
            animate={{ width: isDesktop ? sidebarResize.width : 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            // While the handle is being dragged the width must track the
            // pointer 1:1 — a tween here would rubber-band behind the cursor.
            // Open/close keeps the original ease.
            transition={
              sidebarResize.isDragging
                ? { duration: 0 }
                : { duration: 0.2, ease: "easeInOut" }
            }
            // md:relative (not md:static): the resize handle is absolutely
            // positioned against this aside, which must stay a containing block.
            className="section-nav absolute inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-line-strong bg-surface-0/85 backdrop-blur-xl md:relative md:z-auto"
            aria-label="Room list sidebar"
          >
            {/* Mobile server switcher — horizontal strip atop the drawer. */}
            <ServerRail mobile />
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
              <h1 className="flex min-w-0 items-center">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="focus-ring flex items-center gap-2.5 rounded-lg py-1 pr-1 transition-opacity hover:opacity-80"
                  title="Home — Unicorn Stable"
                  aria-label="Go to home"
                >
                  <StableMark className="h-7 w-7 shrink-0" />
                  <span className="gradient-text font-display text-lg font-bold tracking-tight">
                    Stable
                  </span>
                </button>
              </h1>
              {/* The hamburger is hidden behind the open drawer on phones, so
                  give the drawer its own close affordance. Desktop closes via
                  the header toggle. */}
              <button
                onClick={toggleSidebar}
                className="focus-ring -mr-1 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:hidden"
                aria-label="Close sidebar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <RoomList />
            {/* Mobile-only account footer. On phones the top Header (with the
                avatar menu) is hidden while a room is open, so account actions
                live at the foot of the drawer. Desktop keeps the Header menu. */}
            <div className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
              <div className="mb-1 flex items-center gap-2.5 px-2.5 py-2">
                <span
                  className="inline-flex shrink-0 rounded-full"
                  style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
                >
                  <Avatar
                    name={currentUser?.displayName ?? "U"}
                    src={currentUser?.avatarUrl}
                    size="sm"
                  />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {currentUser?.displayName}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {currentUser?.email}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setSavedOpen(true);
                  toggleSidebar();
                }}
                className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
              >
                <Bookmark className="h-4 w-4 text-slate-400" />
                Saved messages
              </button>
              <button
                onClick={() => {
                  toggleSettings();
                  toggleSidebar();
                }}
                className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
              >
                <Settings className="h-4 w-4 text-slate-400" />
                Settings
              </button>
              <button
                onClick={() => logout()}
                className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-500/10"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
            {/* Desktop-only drag handle (double-click resets, arrows nudge).
                The phone drawer keeps its fixed width. */}
            <div
              {...sidebarResize.dragHandleProps}
              aria-label="Resize sidebar"
              title="Drag to resize · double-click to reset"
              className={clsx(
                PANEL_RESIZE_HANDLE_CLASS,
                "right-0 hidden md:block",
              )}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm md:hidden"
          aria-hidden="true"
          onClick={toggleSidebar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <Header hideOnMobile={!!activeRoomId} />
        <div className="flex min-h-0 flex-1">
          {activeRoomId ? (
            <ErrorBoundary key={activeRoomId}>
              <RoomView roomId={activeRoomId} />
            </ErrorBoundary>
          ) : isAgentsView ? (
            <ErrorBoundary>
              <AgentsPage />
            </ErrorBoundary>
          ) : isBridgeView ? (
            <ErrorBoundary>
              <BridgePage />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary>
              <HomeDashboard />
            </ErrorBoundary>
          )}
        </div>
      </main>

      <AnimatePresence>
        {createRoomModalOpen && <CreateRoomModal />}
      </AnimatePresence>

      <CheatsheetModal />

      <AnimatePresence>
        {settingsOpen && <SettingsModal onClose={toggleSettings} />}
      </AnimatePresence>

      <AnimatePresence>
        {savedOpen && <SavedPanel onClose={() => setSavedOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {switcherOpen && (
          <QuickSwitcher
            onClose={() => setSwitcherOpen(false)}
            onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {globalSearchOpen && (
          <GlobalSearchModal onClose={() => setGlobalSearchOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {addServerOpen && <AddServerModal />}
      </AnimatePresence>

      {switching && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40">
          <div className="rounded-xl bg-slate-800 px-4 py-3 text-sm text-slate-200 shadow-xl">
            Switching Stable instance…
          </div>
        </div>
      )}

      <ConnectionBanner />
      <IncomingCallBanner />
      <ToastStack />
    </div>
  );
}

/**
 * Slim top-of-app banner for websocket health. websocket.ts already reconnects
 * with backoff and emits "connected"/"disconnected" — this only renders that
 * state. Debounced: a drop that recovers within 2s (backoff attempt #1) never
 * shows, so brief blips don't flash the UI. After a real outage reconnects, a
 * green "Reconnected" confirmation lingers ~2s then dismisses itself.
 */
function ConnectionBanner() {
  const [phase, setPhase] = useState<"hidden" | "lost" | "restored">("hidden");

  useEffect(() => {
    let lostTimer: number | null = null;
    let restoredTimer: number | null = null;

    const offDown = ws.on("disconnected", () => {
      if (restoredTimer !== null) {
        window.clearTimeout(restoredTimer);
        restoredTimer = null;
      }
      setPhase((p) => (p === "restored" ? "lost" : p));
      if (lostTimer !== null) return;
      lostTimer = window.setTimeout(() => {
        lostTimer = null;
        setPhase("lost");
      }, 2000);
    });

    const offUp = ws.on("connected", () => {
      if (lostTimer !== null) {
        // Recovered inside the debounce window — the banner never showed.
        window.clearTimeout(lostTimer);
        lostTimer = null;
        return;
      }
      setPhase((p) => {
        if (p !== "lost") return p;
        if (restoredTimer !== null) window.clearTimeout(restoredTimer);
        restoredTimer = window.setTimeout(() => {
          restoredTimer = null;
          setPhase((q) => (q === "restored" ? "hidden" : q));
        }, 2000);
        return "restored";
      });
    });

    return () => {
      offDown();
      offUp();
      if (lostTimer !== null) window.clearTimeout(lostTimer);
      if (restoredTimer !== null) window.clearTimeout(restoredTimer);
    };
  }, []);

  return (
    <AnimatePresence>
      {phase !== "hidden" && (
        <motion.div
          key={phase}
          initial={{ y: -32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -32, opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 top-0 z-[60]"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div
            className={clsx(
              "flex items-center justify-center gap-2 border-b px-4 py-1.5 text-xs font-medium backdrop-blur-md",
              phase === "lost"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                : "border-stable-mint/30 bg-stable-mint/10 text-stable-mint",
            )}
          >
            {phase === "lost" ? (
              <>
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                Connection lost — reconnecting…
              </>
            ) : (
              <>
                <Wifi className="h-3.5 w-3.5 shrink-0" />
                Reconnected
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
