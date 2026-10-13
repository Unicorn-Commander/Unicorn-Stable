import { Home, MessagesSquare, Phone, UserRound, Users, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import {
  isDirectoryPath,
  isNavV2Enabled,
  PHONE_TABS,
  phoneTabForDestination,
  shellDestinationForPath,
  useNavStore,
  type PhoneTab,
} from "@/stores/navStore";
import { shellBadges } from "@/lib/shellBadges";
import { useConversationUi } from "@/stores/conversationUiStore";
import { getNotifyLevel } from "@/utils/mute";
import { useSoftKeyboard } from "@/hooks/useSoftKeyboard";
import { usePresentedRooms } from "@/hooks/usePresentedRooms";

const ICON: Record<PhoneTab, LucideIcon> = {
  home: Home,
  chats: MessagesSquare,
  crew: Users,
  calls: Phone,
  me: UserRound,
};

/**
 * Phone bottom tabs (Nav v3 §2.6): Home · Chats · Crew · Calls · Me.
 *
 * On a phone the lists live in the drawer, so Chats, Crew and Calls set the
 * drawer's destination and open it; Home closes it and goes to the
 * dashboard; Me opens the Me sheet (profile, People, Activity, Saved,
 * Settings, Sign out). Agents is no longer a tab — the directory
 * is "All agents" under Crew and still answers at /agents. The bar leaves
 * the screen while a room is open — a conversation takes the whole phone —
 * and returns with the drawer, so the lists can be switched from a room.
 */
export function PhoneTabBar() {
  const navigate = useNavigate();
  const path = useLocation().pathname;
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen);
  const meSheetOpen = useConversationUi((s) => s.meSheetOpen);
  const openMeSheet = useConversationUi((s) => s.openMeSheet);
  const pendingInvites = useConversationUi((s) => s.pendingInvites.length);
  const { rooms } = usePresentedRooms();
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const stored = useNavStore((s) => s.v2Destination);
  const setV2Destination = useNavStore((s) => s.setV2Destination);
  const keyboardUp = useSoftKeyboard();

  // Threads count (a seat answers in a thread); Home carries only the invites.
  const badges = useMemo(
    () =>
      shellBadges({
        rooms,
        unreadCounts,
        mentionUnreads,
        isMuted: (roomId) => getNotifyLevel(roomId) === "muted",
        pendingInvites,
      }),
    [rooms, unreadCounts, mentionUnreads, pendingInvites],
  );

  // Inside a room the conversation has the whole phone; the tabs come back
  // with the drawer, which is where the lists are. While the keyboard is
  // up the bar leaves too, and whatever is being typed sits on the keyboard.
  if (!isNavV2Enabled() || (activeRoomId && !sidebarOpen) || keyboardUp) return null;

  const destination = shellDestinationForPath(path, stored);
  const activeTab: PhoneTab =
    settingsOpen || meSheetOpen ? "me" : phoneTabForDestination(destination);

  function select(tab: PhoneTab) {
    const state = useAppStore.getState();
    const drawerOpen = state.ui.sidebarOpen;
    if (tab === "me") {
      openMeSheet();
      return;
    }
    const spec = PHONE_TABS.find((item) => item.id === tab);
    if (!spec?.destination) return;
    setV2Destination(spec.destination);
    if (tab === "home") {
      if (drawerOpen) state.toggleSidebar();
      navigate("/");
      return;
    }
    if (isDirectoryPath(path)) navigate("/");
    if (!drawerOpen) state.toggleSidebar();
  }

  return (
    <nav
      aria-label="Primary"
      data-testid="phone-tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-0/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      <ul className="grid h-14 grid-cols-5" role="list">
        {PHONE_TABS.map(({ id, label, testId }) => {
          const Icon = ICON[id];
          const active = activeTab === id;
          const badge = id === "chats" ? badges.conversations : id === "home" ? badges.home : 0;
          const name = badge > 0 ? `${label}, ${badge > 99 ? "99+" : badge} need you` : label;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => select(id)}
                aria-label={name}
                aria-current={active ? "page" : undefined}
                data-testid={testId}
                className={clsx(
                  "focus-ring relative flex h-full w-full flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                  active ? "text-slate-50" : "text-slate-400 hover:text-slate-200",
                )}
              >
                <span className="relative">
                  <Icon
                    className={clsx("h-5 w-5", active ? "text-stable-purple-light" : "opacity-80")}
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
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
