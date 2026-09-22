import {
  Bot,
  Hash,
  Home,
  MessageSquare,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import {
  type NavView,
  useNavStore,
} from "@/stores/navStore";
import { roomsForView } from "@/components/Sidebar/sidebarModel";
import { countNeedsYou } from "@/lib/conversation";
import { getNotifyLevel } from "@/utils/mute";

const DESTINATIONS: {
  id: NavView;
  label: string;
  short: string;
  Icon: LucideIcon;
}[] = [
  { id: "home", label: "Home", short: "Home", Icon: Home },
  { id: "direct", label: "Direct", short: "Direct", Icon: MessageSquare },
  { id: "channels", label: "Channels", short: "Channels", Icon: Hash },
  { id: "meetings", label: "Meetings", short: "Meet", Icon: Video },
  { id: "agents", label: "Agents", short: "Agents", Icon: Bot },
];

/**
 * Primary destination switcher for the view-based sidebar (Slice 2).
 * Shows per-view unread badges so noise is scannable without opening each list.
 */
export function ViewSwitcher() {
  const navigate = useNavigate();
  const activeView = useNavStore((s) => s.activeView);
  const setActiveView = useNavStore((s) => s.setActiveView);
  const lastRoomFor = useNavStore((s) => s.lastRoomFor);
  const serverId = useFederationStore((s) => s.activeInstanceId);
  const rooms = useAppStore((s) => s.rooms);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const clearUnread = useAppStore((s) => s.clearUnread);

  const badges = useMemo(() => {
    const out: Partial<Record<NavView, number>> = {};
    for (const id of ["direct", "channels", "meetings", "agents"] as NavView[]) {
      const list = roomsForView(rooms, id).filter((room) => !room.parent_room_id);
      const n = countNeedsYou(
        list,
        unreadCounts,
        mentionUnreads,
        (roomId) => getNotifyLevel(roomId) === "muted",
      );
      if (n > 0) out[id] = n;
    }
    return out;
  }, [rooms, unreadCounts, mentionUnreads]);

  function selectView(view: NavView) {
    setActiveView(view);

    if (view === "home") {
      navigate("/");
      return;
    }

    if (activeRoomId) return;

    const lastId = lastRoomFor(serverId, view);
    if (lastId && rooms.some((r) => r.id === lastId)) {
      clearUnread(lastId);
      navigate(`/c/${lastId}`);
    }
  }

  return (
    <nav
      className="shrink-0 border-b border-line px-2 py-2"
      aria-label="Primary destinations"
    >
      <ul className="grid grid-cols-5 gap-0.5" role="list">
        {DESTINATIONS.map(({ id, label, short, Icon }) => {
          const isActive = activeView === id;
          const badge = badges[id] ?? 0;
          const badgeLabel =
            badge > 0
              ? `${label}, ${badge > 99 ? "99+" : badge} need you`
              : label;
          const testIds: Record<NavView, string> = {
            home: "nav-home",
            direct: "nav-direct",
            channels: "nav-channels",
            meetings: "nav-meetings",
            agents: "nav-agents",
          };
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => selectView(id)}
                className={clsx(
                  "focus-ring relative flex w-full flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium transition-colors",
                  isActive
                    ? "bg-white/[0.08] text-slate-50"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
                aria-label={badgeLabel}
                aria-current={isActive ? "page" : undefined}
                title={badgeLabel}
                data-testid={testIds[id]}
              >
                <span className="relative">
                  <Icon
                    className={clsx(
                      "h-4 w-4 shrink-0",
                      isActive ? "text-stable-purple-light" : "opacity-80",
                    )}
                    aria-hidden="true"
                  />
                  {badge > 0 && (
                    <span
                      className="absolute -right-2.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-stable-purple px-0.5 text-[9px] font-semibold leading-none text-white tabular-nums"
                      aria-hidden="true"
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </span>
                <span className="truncate">{short}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
