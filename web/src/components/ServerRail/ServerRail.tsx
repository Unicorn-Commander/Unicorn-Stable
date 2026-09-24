import {
  Bot,
  Hash,
  Home,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import {
  isDirectoryPath,
  isNavV1Enabled,
  isNavV2Enabled,
  shellDestinationForPath,
  useNavStore,
  type NavView,
} from "@/stores/navStore";
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
const V1_DESTINATIONS: { id: NavView; label: string; Icon: LucideIcon; testId: string }[] = [
  { id: "home", label: "Home", Icon: Home, testId: "nav-home" },
  { id: "direct", label: "Direct", Icon: MessageSquare, testId: "nav-direct" },
  { id: "channels", label: "Channels", Icon: Hash, testId: "nav-channels" },
  { id: "meetings", label: "Meetings", Icon: Video, testId: "nav-meetings" },
  { id: "agents", label: "Agents", Icon: Bot, testId: "nav-agents" },
];

/** Home, the one list, and the crew directory. Filters are not on this rail. */
const V2_DESTINATIONS: { id: string; label: string; Icon: LucideIcon; testId: string }[] = [
  { id: "home", label: "Home", Icon: Home, testId: "nav-home" },
  { id: "conversations", label: "Conversations", Icon: MessagesSquare, testId: "nav-conversations" },
  { id: "directory", label: "Directory", Icon: Users, testId: "nav-directory" },
];

/**
 * Primary rail. Nav v2: Home, Conversations, Directory. Nav v1 (the fallback):
 * Home, Direct, Channels, Meetings, Agents. Badges count rooms that need you
 * (unread DMs and @-mentions), not every unread channel message.
 * Federated servers stay one tap away when there is more than one.
 */
function closePhoneSidebar() {
  if (
    window.matchMedia("(max-width: 767px)").matches &&
    useAppStore.getState().ui.sidebarOpen
  ) {
    useAppStore.getState().toggleSidebar();
  }
}

function DestinationRail({ mobile = false }: { mobile?: boolean }) {
  const navigate = useNavigate();
  const path = useLocation().pathname;
  const navV2 = isNavV2Enabled();
  const activeView = useNavStore((s) => s.activeView);
  const setActiveView = useNavStore((s) => s.setActiveView);
  const v2Destination = useNavStore((s) => s.v2Destination);
  const setV2Destination = useNavStore((s) => s.setV2Destination);
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
  const destinations = navV2 ? V2_DESTINATIONS : V1_DESTINATIONS;

  const badges = useMemo(() => {
    const muted = (roomId: string) => getNotifyLevel(roomId) === "muted";
    const out: Record<string, number> = {};
    if (navV2) {
      const list = rooms.filter((room) => !room.parent_room_id);
      const n = countNeedsYou(list, unreadCounts, mentionUnreads, muted);
      if (n > 0) out.conversations = n;
      const home = n + pendingInvites.length;
      if (home > 0) out.home = home;
      return out;
    }
    for (const id of ["direct", "channels", "meetings", "agents"] as const) {
      const list = roomsForView(rooms, id).filter((room) => !room.parent_room_id);
      const n = countNeedsYou(list, unreadCounts, mentionUnreads, muted);
      if (n > 0) out[id] = n;
    }
    const home = (out.direct ?? 0) + (out.channels ?? 0) + (out.meetings ?? 0) + (out.agents ?? 0) + pendingInvites.length;
    if (home > 0) out.home = home;
    return out;
  }, [navV2, rooms, unreadCounts, mentionUnreads, pendingInvites.length]);

  const you = resolveIdentity({
    id: currentUser?.id,
    display_name: currentUser?.displayName || "You",
    username: currentUser?.username,
    avatar_url: currentUser?.avatarUrl,
    participant_type: "human",
    is_self: !!currentUser,
  });

  const destination = shellDestinationForPath(path, v2Destination);

  function select(id: string) {
    if (navV2) {
      if (id === "home") {
        setV2Destination("home");
        navigate("/");
        closePhoneSidebar();
        return;
      }
      if (id === "directory") {
        setV2Destination("directory");
        navigate("/agents");
        closePhoneSidebar();
        return;
      }
      setV2Destination("conversations");
      if (isDirectoryPath(path)) navigate("/");
      return;
    }
    const view = id as NavView;
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
      {destinations.map(({ id, label, Icon, testId }) => {
        const badge = badges[id] ?? 0;
        const active = navV2 ? destination === id : activeView === id;
        return (
          <Tooltip key={id} content={badge > 0 ? `${label} · ${badge} need you` : label}>
            <button
              type="button"
              onClick={() => select(id)}
              aria-current={active ? "page" : undefined}
              aria-label={badge > 0 ? `${label}, ${badge} need you` : label}
              data-testid={testId}
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
  // v2 is the one-list shell. An explicit stable_nav_v1=0 opts out of v2
  // too (isNavV2Enabled is false) and lands on the classic rail. v2 off with
  // v1 still on is the five-view rail.
  if (isNavV2Enabled() || isNavV1Enabled()) return <DestinationRail mobile={mobile} />;
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
