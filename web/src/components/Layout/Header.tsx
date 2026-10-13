import {
  PanelLeftClose,
  PanelLeftOpen,
  UserRound,
  Activity,
  Bookmark,
  Settings,
  Keyboard,
  LogOut,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { logout } from "@/services/auth";
import { Identity, PhotoNudge, useSelfFace, useShowPhotoNudge } from "@/components/ui/Identity";
import { Tooltip } from "@/components/ui";
import { identityFor } from "@/lib/identity";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { api } from "@/services/api";
import { useFederationStore } from "@/stores/federationStore";
import { PresenterBadge } from "./PresenterBadge";

// Home, Agents, and Bridge use this bar. A room does not: RoomView's 44px
// header is the only bar there, at every width. `hideOnMobile` remains so a
// caller can still collapse this bar without unmounting it.
export function Header({
  hideOnMobile = false,
  onOpenActivity,
}: {
  hideOnMobile?: boolean;
  onOpenActivity: () => void;
}) {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const peopleDrawerOpen = useAppStore((s) => s.ui.peopleDrawerOpen);
  const togglePeopleDrawer = useAppStore((s) => s.togglePeopleDrawer);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const openSettings = useAppStore((s) => s.openSettings);
  const toggleCheatsheet = useAppStore((s) => s.toggleCheatsheet);
  // SavedPanel is now rendered once at the AppShell level (so the mobile drawer
  // account section can open it); here we only need the opener.
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  // Stable ref so PeopleDrawer restores focus here on close (useModalA11y).
  const peopleBtnRef = useRef<HTMLButtonElement>(null);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const currentUser = useAppStore((s) => s.currentUser);
  // Identity hue for the signed-in resident — rings the avatar + menu header.
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);
  const selfFace = useSelfFace();
  const showPhotoNudge = useShowPhotoNudge();
  const activeInstanceId = useFederationStore((state) => state.activeInstanceId);
  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending", activeInstanceId],
    queryFn: () => api.getPendingApprovals(),
    refetchInterval: 15_000,
  });
  const pendingApprovalCount = pendingApprovals?.items.length ?? 0;
  const pendingApprovalLabel = pendingApprovals?.has_more
    ? `${pendingApprovalCount}+`
    : String(pendingApprovalCount);

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keyboard model for the account menu (focus-in, arrows, Esc-to-close).
  useMenuKeyboard(userMenuOpen, userMenuRef, avatarBtnRef, () =>
    setUserMenuOpen(false),
  );

  // RoomView is the only bar while a room is open. Leaving this mounted stacked
  // a second row (room title, Phone, Video) on top of that header.
  if (activeRoomId) return null;

  return (
    <header
      data-testid="app-header"
      className={clsx(
        // relative z-30 lifts the header's (blur-induced) stacking context
        // above the z-auto content column below it, so the account dropdown
        // (which was pinned inside this context) paints OVER the message area
        // and rails instead of behind them.
        "relative z-30 flex h-14 shrink-0 items-center justify-between border-b border-line bg-stable-glass px-4 backdrop-blur-lg",
        hideOnMobile && "max-md:hidden",
      )}
    >
      <div className="flex items-center gap-3">
        <Tooltip content={sidebarOpen ? "Close sidebar" : "Open sidebar"} placement="bottom">
          <button
            onClick={toggleSidebar}
            className="focus-ring max-md:min-h-11 max-md:min-w-11 rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1.5"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-5 w-5" />
            ) : (
              <PanelLeftOpen className="h-5 w-5" />
            )}
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center gap-1">
        <PresenterBadge className="mr-1 inline-flex" />
        {/* Global People directory — always available (not the room participant panel). */}
        <Tooltip content="People" placement="bottom">
          <button
            ref={peopleBtnRef}
            type="button"
            onClick={togglePeopleDrawer}
            className={clsx(
              "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
              peopleDrawerOpen
                ? "bg-white/[0.08] text-slate-100"
                : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
            )}
            aria-label="People"
            aria-haspopup="dialog"
            aria-expanded={peopleDrawerOpen}
            data-testid="open-people"
            data-people-trigger
          >
            <UserRound className="h-4 w-4" />
          </button>
        </Tooltip>

        {/* On phones these fold into the avatar menu (below) to save space. */}
        <span className="hidden md:contents">
          <Tooltip content="Activity Center" placement="bottom">
            <button
              onClick={onOpenActivity}
              className="focus-ring relative rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-2"
              aria-label={`Activity Center${pendingApprovalCount ? `, ${pendingApprovalLabel} pending approvals` : ""}`}
            >
              <Activity className="h-4 w-4" />
              {pendingApprovalCount > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white"
                  aria-hidden="true"
                >
                  {pendingApprovalLabel}
                </span>
              )}
            </button>
          </Tooltip>

          <Tooltip content="Saved messages" placement="bottom">
            <button
              onClick={() => setSavedOpen(true)}
              className="focus-ring rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-2"
              aria-label="Saved messages"
            >
              <Bookmark className="h-4 w-4" />
            </button>
          </Tooltip>

          <Tooltip content="Settings" placement="bottom">
            <button
              onClick={toggleSettings}
              className="focus-ring rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-2"
              aria-label="Settings"
              data-testid="open-settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          </Tooltip>
        </span>

        {/* Account menu — desktop only; on phones account lives in the sidebar
            drawer's footer (see AppShell). */}
        <div className="relative hidden items-center gap-2 md:flex" ref={menuRef}>
          {showPhotoNudge && (
            <PhotoNudge onAdd={() => openSettings("appearance")} />
          )}
          <button
            ref={avatarBtnRef}
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="focus-ring ml-1.5 flex rounded-full transition-opacity hover:opacity-85"
            style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
            aria-label="User menu"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <Identity {...selfFace} presence={null} size={24} />
          </button>

          {userMenuOpen && (
            <div
              ref={userMenuRef}
              role="menu"
              className="glass-heavy absolute right-0 top-full z-50 mt-2.5 w-60 rounded-2xl p-1.5 shadow-pop animate-fade-in"
            >
              <div className="mb-1 flex items-center gap-2.5 border-b border-line px-3 py-2.5">
                <span
                  className="inline-flex shrink-0 rounded-full"
                  style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
                >
                  <Identity {...selfFace} presence={null} size={24} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {currentUser?.displayName}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {currentUser?.email}
                  </p>
                </div>
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  toggleCheatsheet();
                }}
                className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.04] hover:text-slate-100"
              >
                <Keyboard className="h-4 w-4 text-slate-400" />
                Keyboard shortcuts
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  logout();
                }}
                className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-500/10"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
