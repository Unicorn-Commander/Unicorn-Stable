import {
  Bot,
  Hash,
  Home,
  MessageSquare,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import {
  type NavView,
  useNavStore,
} from "@/stores/navStore";

const DESTINATIONS: {
  id: NavView;
  label: string;
  short: string;
  Icon: LucideIcon;
}[] = [
  { id: "home", label: "Home", short: "Home", Icon: Home },
  { id: "chats", label: "Chats", short: "Chats", Icon: MessageSquare },
  { id: "channels", label: "Channels", short: "Channels", Icon: Hash },
  { id: "meetings", label: "Meetings", short: "Meet", Icon: Video },
  { id: "agents", label: "Agents", short: "Agents", Icon: Bot },
];

/**
 * Primary destination switcher for the view-based sidebar (Slice 2).
 *
 * Lives above RoomList so both desktop and the mobile drawer get the same
 * control. Home clears the active room; other views filter the list and
 * optionally restore the last room for that view×server when nothing is open.
 */
export function ViewSwitcher() {
  const navigate = useNavigate();
  const activeView = useNavStore((s) => s.activeView);
  const setActiveView = useNavStore((s) => s.setActiveView);
  const lastRoomFor = useNavStore((s) => s.lastRoomFor);
  const serverId = useFederationStore((s) => s.activeInstanceId);
  const rooms = useAppStore((s) => s.rooms);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const clearUnread = useAppStore((s) => s.clearUnread);

  function selectView(view: NavView) {
    setActiveView(view);

    if (view === "home") {
      navigate("/");
      return;
    }

    // Already looking at a room: only change the filtered list — do not yank
    // the user out of their conversation. Restore last-room only when the
    // main pane is on Home (no active room).
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
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => selectView(id)}
                className={clsx(
                  "focus-ring flex w-full flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium transition-colors",
                  isActive
                    ? "bg-white/[0.08] text-slate-50"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
                title={label}
              >
                <Icon
                  className={clsx(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-stable-purple-light" : "opacity-80",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{short}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
