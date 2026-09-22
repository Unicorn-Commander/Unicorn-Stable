import {
  Bot,
  Hash,
  Home,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useFederationStore } from "@/stores/federationStore";
import { displayName, instanceHost } from "@/lib/instances";
import { ServerLogo } from "./ServerLogo";
import { ServerSwitcher } from "./ServerSwitcher";
import { ServerIdentityModal } from "./ServerIdentityModal";
import { Tooltip } from "@/components/ui/Tooltip";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { countNeedsYou } from "@/lib/conversation";
import { getNotifyLevel } from "@/utils/mute";
import { roomsForView } from "@/components/Sidebar/sidebarModel";
import { isNavV1Enabled, useNavStore, type NavView } from "@/stores/navStore";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";

/**
 * The server rail: which Stables you can reach, which one you're in, and what
 * is waiting on the others.
 *
 * Four things beyond the original icon strip:
 *   * per-server LOGO, set at runtime by that server's own admin
 *   * a HIDE toggle that persists, leaving a reveal affordance that is a real
 *     button (touch devices must never be stranded behind hover)
 *   * SEARCH, via a switcher palette (also the only place descriptions are
 *     reachable without a mouse — see ServerSwitcher)
 *   * DESCRIPTIONS, on hover/focus here and in full in the switcher
 *
 * Unchanged and load-bearing: the rail renders nothing at all when the user can
 * reach one server or fewer, which is the shipped behaviour when instances.json
 * is not mounted.
 */
const DESTINATIONS: { id: NavView; label: string; Icon: LucideIcon }[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "direct", label: "Direct", Icon: MessageSquare },
  { id: "channels", label: "Channels", Icon: Hash },
  { id: "meetings", label: "Meetings", Icon: Video },
  { id: "agents", label: "Agents", Icon: Bot },
];

/**
 * Primary rail when the conversation shell is on: Home, Direct, Channels,
 * Meetings, Agents, Search, and You. Badges count rooms that need you
 * (unread DMs and @-mentions), not every unread channel message.
 * Federated servers stay one tap away when there is more than one.
 */
function DestinationRail({ mobile = false }: { mobile?: boolean }) {
  const navigate = useNavigate();
  const activeView = useNavStore((s) => s.activeView);
  const setActiveView = useNavStore((s) => s.setActiveView);
  const rooms = useAppStore((s) => s.rooms);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const currentUser = useAppStore((s) => s.currentUser);
  const openSettings = useAppStore((s) => s.openSettings);
  const pendingInvites = useConversationUi((s) => s.pendingInvites);
  const instances = useFederationStore((s) => s.accessibleInstances);
  const setSwitcherOpen = useFederationStore((s) => s.setSwitcherOpen);
  const switcherOpen = useFederationStore((s) => s.switcherOpen);
  const serverId = useFederationStore((s) => s.activeInstanceId);
  const lastRoomFor = useNavStore((s) => s.lastRoomFor);
  const multi = instances.length > 1;

  const badges = useMemo(() => {
    const out: Partial<Record<NavView, number>> = {};
    for (const id of ["direct", "channels", "meetings", "agents"] as const) {
      const list = roomsForView(rooms, id).filter((room) => !room.parent_room_id);
      const n = countNeedsYou(list, unreadCounts, mentionUnreads, (roomId) => getNotifyLevel(roomId) === "muted");
      if (n > 0) out[id] = n;
    }
    const home = (out.direct ?? 0) + (out.channels ?? 0) + (out.meetings ?? 0) + (out.agents ?? 0) + pendingInvites.length;
    if (home > 0) out.home = home;
    return out;
  }, [rooms, unreadCounts, mentionUnreads, pendingInvites.length]);

  const you = resolveIdentity({
    id: currentUser?.id,
    display_name: currentUser?.displayName || "You",
    username: currentUser?.username,
    avatar_url: currentUser?.avatarUrl,
    participant_type: "human",
    is_self: !!currentUser,
  });

  function select(view: NavView) {
    setActiveView(view);
    if (view === "home") {
      navigate("/");
      return;
    }
    if (useAppStore.getState().activeRoomId) return;
    const last = lastRoomFor(serverId, view);
    const known = useAppStore.getState().rooms;
    if (last && known.some((room) => room.id === last)) {
      useAppStore.getState().clearUnread(last);
      navigate(`/c/${last}`);
    }
  }

  return (
    <>
    <nav
      className={clsx(
        mobile
          ? "flex h-16 w-full items-center gap-1 overflow-x-auto border-b border-slate-700/50 px-2 md:hidden"
          : "hidden h-full w-[72px] shrink-0 flex-col items-center gap-1 border-r border-slate-700/50 bg-slate-950/60 py-3 md:flex",
      )}
      aria-label="Primary"
    >
      {DESTINATIONS.map(({ id, label, Icon }) => {
        const badge = badges[id] ?? 0;
        const active = activeView === id;
        const testIds: Record<NavView, string> = {
          home: "nav-home",
          direct: "nav-direct",
          channels: "nav-channels",
          meetings: "nav-meetings",
          agents: "nav-agents",
        };
        return (
          <Tooltip key={id} content={badge > 0 ? `${label} · ${badge} need you` : label}>
            <button
              type="button"
              onClick={() => select(id)}
              aria-current={active ? "page" : undefined}
              aria-label={badge > 0 ? `${label}, ${badge} need you` : label}
              data-testid={testIds[id]}
              className={clsx(
                "focus-ring relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-colors",
                active ? "bg-white/[0.1] text-slate-50" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
              )}
            >
              <Icon className="h-5 w-5" />
              {badge > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
      <Tooltip content="Search">
        <button
          type="button"
          aria-label="Search"
          onClick={() => useConversationUi.getState().requestQuickSwitcher()}
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
        >
          <Search className="h-5 w-5" />
        </button>
      </Tooltip>
      {multi && (
        <Tooltip content="Servers">
          <button
            type="button"
            aria-label="Switch server"
            onClick={() => setSwitcherOpen(true)}
            className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
          >
            <Plus className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
      <Tooltip content={you.name || "You"}>
        <button
          type="button"
          aria-label="You"
          onClick={() => openSettings("account")}
          className={clsx("focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl", !mobile && "mt-auto")}
        >
          <Identity {...you} presence={null} size={32} />
        </button>
      </Tooltip>
    </nav>
    {!mobile && (
      <>
        {switcherOpen && <ServerSwitcher />}
        <ServerIdentityModal />
      </>
    )}
    </>
  );
}

export function ServerRail({ mobile = false }: { mobile?: boolean }) {
  if (isNavV1Enabled()) return <DestinationRail mobile={mobile} />;
  return <FederationRail mobile={mobile} />;
}

function FederationRail({ mobile = false }: { mobile?: boolean }) {
  const instances = useFederationStore((state) => state.accessibleInstances);
  const activeId = useFederationStore((state) => state.activeInstanceId);
  const switching = useFederationStore((state) => state.switching);
  const switchInstance = useFederationStore((state) => state.switchInstance);
  const setAddServerOpen = useFederationStore((state) => state.setAddServerOpen);
  const unreadByInstance = useFederationStore((state) => state.unreadByInstance);
  const metaByInstance = useFederationStore((state) => state.metaByInstance);
  const railHidden = useFederationStore((state) => state.railHidden);
  const setRailHidden = useFederationStore((state) => state.setRailHidden);
  const switcherOpen = useFederationStore((state) => state.switcherOpen);
  const setSwitcherOpen = useFederationStore((state) => state.setSwitcherOpen);

  const multi = instances.length > 1;

  // No keyboard chord is registered here on purpose. Cmd/Ctrl+K already belongs
  // to the room quick-switcher (AppShell), and a second document-level listener
  // on the same chord would open two palettes at once. Servers are reachable
  // from that one switcher instead — it lists them and carries a
  // "Browse servers" row that opens this directory. See QuickSwitcher.tsx.

  // The rail only earns its space when the user can reach more than one server.
  if (!multi) return null;

  // AppShell mounts this component TWICE (a desktop column and a mobile strip);
  // only one of them may own the overlays or every dialog renders in duplicate.
  // The desktop instance is mounted at every breakpoint (CSS hides it), and the
  // overlays are siblings of — not inside — the hidden container, so they still
  // render correctly on a phone.
  const overlays = mobile ? null : (
    <>
      {switcherOpen && <ServerSwitcher />}
      <ServerIdentityModal />
    </>
  );

  const hiddenUnread = instances
    .filter((instance) => instance.id !== activeId)
    .reduce((sum, instance) => sum + (unreadByInstance[instance.id] ?? 0), 0);

  // --- collapsed -----------------------------------------------------------
  // Hiding must not hide the *way back*. The reveal is a real, always-rendered
  // button (no hover-to-discover), it keeps a 44px touch target, and it carries
  // the aggregate unread so collapsing the rail never costs you the signal.
  if (railHidden) {
    return (
      <>
        <div
          className={clsx(
            mobile
              ? "flex w-full items-center gap-2 border-b border-slate-700/50 px-3 py-1.5 md:hidden"
              : "hidden h-full w-8 shrink-0 flex-col items-center justify-start border-r border-slate-700/50 bg-slate-950/60 py-3 md:flex",
          )}
          aria-label="Stable servers (hidden)"
        >
          <Tooltip content="Show servers">
            <button
              type="button"
              onClick={() => setRailHidden(false)}
              aria-label={`Show servers${hiddenUnread > 0 ? ` — ${hiddenUnread} unread elsewhere` : ""}`}
              aria-expanded={false}
              className="focus-ring relative flex h-11 w-full min-w-[44px] items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            >
              <PanelLeftOpen className="h-4 w-4" />
              {hiddenUnread > 0 && (
                <span
                  className="absolute right-0.5 top-1.5 h-2 w-2 rounded-full bg-rose-500"
                  aria-hidden="true"
                />
              )}
            </button>
          </Tooltip>
          {mobile && (
            <span className="text-xs text-slate-500">
              {displayName(
                instances.find((instance) => instance.id === activeId) ?? instances[0]!,
                metaByInstance[activeId ?? ""],
              )}
            </span>
          )}
        </div>
        {overlays}
      </>
    );
  }

  // --- expanded ------------------------------------------------------------
  return (
    <>
      <div
        className={clsx(
          mobile
            ? "flex h-16 w-full items-center gap-2 overflow-x-auto border-b border-slate-700/50 px-3 md:hidden"
            : "hidden h-full w-[72px] shrink-0 flex-col items-center gap-3 border-r border-slate-700/50 bg-slate-950/60 py-3 md:flex",
        )}
        aria-label="Stable servers"
      >
        {instances.map((instance) => {
          const active = instance.id === activeId;
          const meta = metaByInstance[instance.id];
          const name = displayName(instance, meta);
          const host = instanceHost(instance);
          const unread = unreadByInstance[instance.id] ?? 0;
          return (
            <div key={instance.id} className="group relative shrink-0">
              <button
                type="button"
                aria-label={`Switch to ${name} (${host})${unread > 0 ? ` — ${unread} unread` : ""}`}
                aria-current={active ? "true" : undefined}
                disabled={switching}
                onClick={() => void switchInstance(instance.id)}
                className="focus-ring relative flex items-center justify-center rounded-2xl transition-all hover:rounded-xl disabled:opacity-60"
              >
                <ServerLogo instance={instance} size={mobile ? "md" : "lg"} active={active} />
                {active && !mobile && (
                  <span className="absolute -left-3 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-white" />
                )}
                {!active && unread > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-slate-950 bg-rose-500 px-1 text-[10px] font-bold leading-none text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>

              {/* Hover/focus card. Progressive enhancement only: every word in
                  here is also reachable by tapping Search, because a touch
                  device has no hover and must not lose the description. */}
              {!mobile && (
                <div
                  role="presentation"
                  className="pointer-events-none absolute left-full top-0 z-50 ml-2 hidden w-60 rounded-xl border border-line bg-slate-900/95 p-3 opacity-0 shadow-pop backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:block"
                >
                  <p className="truncate text-sm font-semibold text-slate-100">{name}</p>
                  {/* The host is the only unfalsifiable identifier a federated
                      server has — a name can claim anything, so always show it. */}
                  <p className="truncate text-[11px] text-slate-500">{host}</p>
                  {meta?.description && (
                    <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-slate-400">
                      {meta.description}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <Tooltip content="Search servers">
          <button
            type="button"
            aria-label="Search servers"
            onClick={() => setSwitcherOpen(true)}
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-line text-slate-400 transition-colors hover:rounded-xl hover:border-stable-purple hover:text-white"
          >
            <Search className="h-4 w-4" />
          </button>
        </Tooltip>

        <Tooltip content="Add a server">
          <button
            type="button"
            aria-label="Add a server"
            onClick={() => setAddServerOpen(true)}
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-dashed border-slate-600 text-slate-400 transition-colors hover:rounded-xl hover:border-stable-purple hover:text-white"
          >
            <Plus className="h-5 w-5" />
          </button>
        </Tooltip>

        {switching && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-slate-400" />}

        <Tooltip content="Hide the server rail">
          <button
            type="button"
            onClick={() => setRailHidden(true)}
            aria-label="Hide the server rail"
            aria-expanded
            className={clsx(
              "focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200",
              !mobile && "mt-auto",
            )}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {overlays}
    </>
  );
}
