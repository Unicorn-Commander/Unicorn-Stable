import {
  PanelLeftClose,
  PanelLeftOpen,
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Users,
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
import { useDirectCall } from "@/hooks/useDirectCall";
import { useStableRoom } from "@/hooks/useStableRoom";
import { logout } from "@/services/auth";
import { Avatar } from "@/components/Avatar";
import { Tooltip } from "@/components/ui";
import { identityFor } from "@/lib/identity";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { api } from "@/services/api";
import { useFederationStore } from "@/stores/federationStore";
import {
  runScreenShareAction,
  windowShareGuidance,
  monitorShareHint,
} from "@/lib/screenShare";

// `hideOnMobile` lets AppShell collapse this top bar on phones when a room is
// active — there the RoomView sub-header (with a hamburger) is the single bar,
// so a second bar here would just waste vertical space. Desktop always shows it.
export function Header({
  hideOnMobile = false,
  onOpenActivity,
}: {
  hideOnMobile?: boolean;
  onOpenActivity: () => void;
}) {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const peopleDrawerOpen = useAppStore((s) => s.ui.peopleDrawerOpen);
  const togglePeopleDrawer = useAppStore((s) => s.togglePeopleDrawer);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCheatsheet = useAppStore((s) => s.toggleCheatsheet);
  // SavedPanel is now rendered once at the AppShell level (so the mobile drawer
  // account section can open it); here we only need the opener.
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  // Stable ref so PeopleDrawer restores focus here on close (useModalA11y).
  const peopleBtnRef = useRef<HTMLButtonElement>(null);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const rooms = useAppStore((s) => s.rooms);
  const currentUser = useAppStore((s) => s.currentUser);
  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  const { startCall } = useDirectCall();
  // Identity hue for the signed-in resident — rings the avatar + menu header.
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);
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

  // Shared call (VoiceProvider): connect/disconnect drive the one Room. Mic
  // publish + agent dispatch + audio playback all happen in the provider now.
  const {
    room,
    localParticipant,
    isConnected: lkConnected,
    isConnecting: lkConnecting,
    disconnect: lkDisconnect,
    // Read purely to re-render on mic/camera/track changes. LiveKit mutates
    // the SAME LocalParticipant object in place, so the object identity never
    // changes and a version bump is the only signal a toggle happened.
    version: _lkVersion,
  } = useStableRoom();

  // DERIVE from LiveKit; never mirror it in local state.
  //
  // These used to be `useState(true)` / `useState(false)` that only updated
  // when THIS header's own buttons were clicked. Two independent bugs fell out:
  //   1. Toggling the camera from the in-call bar (VoiceVideoBar) or the call
  //      dock changed the real track but never told the header, so the header
  //      icon kept showing the old state until you clicked the header itself.
  //   2. The seed values were fiction -- mic defaulted to "on" and camera to
  //      "off" regardless of the actual published tracks, so the header could
  //      be wrong before anyone touched anything.
  // CallDock and VoiceVideoBar already derive; the header was the odd one out.
  const micEnabled = localParticipant?.isMicrophoneEnabled ?? false;
  const camEnabled = localParticipant?.isCameraEnabled ?? false;
  const screenShareEnabled = localParticipant?.isScreenShareEnabled ?? false;
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

  async function handleToggleMic() {
    if (!room) return;
    // No local echo: the RoomEvent.TrackMuted/TrackUnmuted listener in
    // VoiceProvider bumps `version`, which re-renders every consumer with the
    // real state. Echoing here is what let the header drift out of sync.
    await room.localParticipant.setMicrophoneEnabled(!micEnabled);
  }

  async function handleToggleCam() {
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!camEnabled);
  }

  async function handleScreenShare() {
    if (!room) return;
    // Shared helper: prefer full-display surface, clean stop/start, window tip.
    const result = await runScreenShareAction(room.localParticipant, "toggle");
    if (!result.ok) {
      if (result.action === "cancelled") return;
      useAppStore.getState().pushToast({
        title: "Couldn't share your screen",
        body: result.error || "Your browser blocked screen sharing.",
      });
      return;
    }
    if (result.action === "started" || result.action === "replaced") {
      if (result.surface === "window" || result.surface === "browser") {
        useAppStore.getState().pushToast({
          title: "Window share active",
          body: windowShareGuidance(),
        });
      } else if (result.surface === "unknown") {
        // Browser didn't report displaySurface — still surface the tip once.
        useAppStore.getState().pushToast({
          title: "Screen share started",
          body: monitorShareHint(),
        });
      }
    }
  }

  function handleCallToggle() {
    if (lkConnected || lkConnecting) {
      lkDisconnect();
    } else if (activeRoomId) {
      // DMs ring the person; channels fall through to a plain join inside
      // startCall. Both used to be `lkConnect()`, which is why a DM call had
      // no way to tell anybody it was happening.
      void startCall(activeRoomId);
    }
  }


  return (
    <header
      className={clsx(
        // relative z-30 lifts the header's (blur-induced) stacking context
        // above the z-auto content column below it, so the account dropdown
        // (which was pinned inside this context) paints OVER the message area
        // and rails instead of behind them.
        "relative z-30 flex h-14 shrink-0 items-center justify-between border-b border-line bg-stable-glass px-4 backdrop-blur-lg",
        // On phones, collapse this bar when a room is active (the RoomView
        // sub-header is the single bar there). Always shown >= md.
        hideOnMobile && "max-md:hidden",
      )}
    >
      <div className="flex items-center gap-3">
        <Tooltip content={sidebarOpen ? "Close sidebar" : "Open sidebar"} placement="bottom">
          <button
            onClick={toggleSidebar}
            className="focus-ring rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1.5"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-5 w-5" />
            ) : (
              <PanelLeftOpen className="h-5 w-5" />
            )}
          </button>
        </Tooltip>

        {activeRoom && (
          // The room identity also lives in the RoomView sub-header (with topic
          // + actions). On phones that one is enough — hide this duplicate so the
          // top bar stays uncluttered. Desktop shows both.
          <div className="hidden flex-col md:flex">
            <h2 className="text-sm font-semibold text-slate-100">
              {activeRoom.type === "channel" ? "#" : ""} {activeRoom.name}
            </h2>
            {activeRoom.description && (
              <p className="max-w-xs truncate text-xs text-slate-400">
                {activeRoom.description}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
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
            data-people-trigger
          >
            <UserRound className="h-4 w-4" />
          </button>
        </Tooltip>

        {activeRoomId && (
          <>
            {(lkConnected || lkConnecting) && (
              // In-call mic/cam/screen controls are duplicated by the
              // VoiceVideoBar (which is always visible during a call). Hide them
              // here on phones; keep the call start/end toggle below.
              <span className="hidden md:contents">
                <button
                  onClick={handleToggleMic}
                  className={clsx(
                    "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
                    micEnabled
                      ? "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                      : "bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
                  )}
                  aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
                >
                  {micEnabled ? (
                    <Mic className="h-4 w-4" />
                  ) : (
                    <MicOff className="h-4 w-4" />
                  )}
                </button>

                <button
                  onClick={handleToggleCam}
                  className={clsx(
                    "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
                    camEnabled
                      ? "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                      : "text-slate-500 hover:bg-white/[0.06] hover:text-slate-300",
                  )}
                  aria-label={camEnabled ? "Turn off camera" : "Turn on camera"}
                >
                  {camEnabled ? (
                    <Video className="h-4 w-4" />
                  ) : (
                    <VideoOff className="h-4 w-4" />
                  )}
                </button>

                <button
                  onClick={() => void handleScreenShare()}
                  className={clsx(
                    "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
                    screenShareEnabled
                      ? "bg-stable-cyan/15 text-stable-cyan hover:bg-stable-cyan/25"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
                  )}
                  aria-label={
                    screenShareEnabled ? "Stop sharing screen" : "Share screen"
                  }
                  aria-pressed={screenShareEnabled}
                  title={
                    screenShareEnabled
                      ? "Stop sharing your screen"
                      : "Share your screen — pick Entire Screen for a full display (not just a window)"
                  }
                >
                  <MonitorUp className="h-4 w-4" />
                </button>
              </span>
            )}

            <button
              onClick={handleCallToggle}
              className={clsx(
                "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
                lkConnected
                  ? "bg-rose-500/15 text-rose-400 hover:bg-rose-500/25"
                  : "text-emerald-400 hover:bg-emerald-500/15",
                lkConnecting && "animate-pulse-soft",
              )}
              aria-label={lkConnected ? "End call" : "Start call"}
            >
              {lkConnected ? (
                <PhoneOff className="h-4 w-4" />
              ) : (
                <Phone className="h-4 w-4" />
              )}
            </button>

            {/* Participants toggle is duplicated in the RoomView sub-header;
                hide this one (and its divider) on phones. */}
            <span className="hidden md:contents">
              <div className="mx-1 h-5 w-px bg-line-strong" />

              <Tooltip
                content={participantPanelOpen ? "Hide participants" : "Show participants"}
                placement="bottom"
              >
                <button
                  onClick={toggleParticipantPanel}
                  className={clsx(
                    "focus-ring rounded-lg p-2.5 transition-colors md:p-2",
                    participantPanelOpen
                      ? "bg-white/[0.08] text-slate-100"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
                  )}
                  aria-label="Toggle participant panel"
                >
                  <Users className="h-4 w-4" />
                </button>
              </Tooltip>
            </span>
          </>
        )}

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
            >
              <Settings className="h-4 w-4" />
            </button>
          </Tooltip>
        </span>

        {/* Account menu — desktop only; on phones account lives in the sidebar
            drawer's footer (see AppShell). */}
        <div className="relative hidden md:block" ref={menuRef}>
          <button
            ref={avatarBtnRef}
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="focus-ring ml-1.5 flex rounded-full transition-opacity hover:opacity-85"
            style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
            aria-label="User menu"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <Avatar
              name={currentUser?.displayName ?? "U"}
              src={currentUser?.avatarUrl}
              size="sm"
            />
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
                  <Avatar
                    name={currentUser?.displayName ?? "U"}
                    src={currentUser?.avatarUrl}
                    size="sm"
                  />
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
