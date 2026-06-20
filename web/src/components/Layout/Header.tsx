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
  Bookmark,
  Settings,
  LogOut,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { useStableRoom } from "@/hooks/useStableRoom";
import { logout } from "@/services/auth";
import { Avatar } from "@/components/Avatar";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";

// `hideOnMobile` lets AppShell collapse this top bar on phones when a room is
// active — there the RoomView sub-header (with a hamburger) is the single bar,
// so a second bar here would just waste vertical space. Desktop always shows it.
export function Header({ hideOnMobile = false }: { hideOnMobile?: boolean }) {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  // SavedPanel is now rendered once at the AppShell level (so the mobile drawer
  // account section can open it); here we only need the opener.
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const rooms = useAppStore((s) => s.rooms);
  const currentUser = useAppStore((s) => s.currentUser);
  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  // Shared call (VoiceProvider): connect/disconnect drive the one Room. Mic
  // publish + agent dispatch + audio playback all happen in the provider now.
  const {
    room,
    isConnected: lkConnected,
    isConnecting: lkConnecting,
    connect: lkConnect,
    disconnect: lkDisconnect,
  } = useStableRoom();

  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(false);
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
    const next = !micEnabled;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicEnabled(next);
  }

  async function handleToggleCam() {
    if (!room) return;
    const next = !camEnabled;
    await room.localParticipant.setCameraEnabled(next);
    setCamEnabled(next);
  }

  async function handleScreenShare() {
    if (!room) return;
    const isSharing = room.localParticipant.isScreenShareEnabled;
    await room.localParticipant.setScreenShareEnabled(!isSharing);
  }

  function handleCallToggle() {
    if (lkConnected || lkConnecting) {
      lkDisconnect();
    } else {
      void lkConnect();
    }
  }


  return (
    <header
      className={clsx(
        "flex h-14 shrink-0 items-center justify-between border-b border-slate-700/50 px-4",
        // On phones, collapse this bar when a room is active (the RoomView
        // sub-header is the single bar there). Always shown >= md.
        hideOnMobile && "max-md:hidden",
      )}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={toggleSidebar}
          className="rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 md:p-1.5"
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-5 w-5" />
          ) : (
            <PanelLeftOpen className="h-5 w-5" />
          )}
        </button>

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
                    "rounded-lg p-2.5 transition-colors md:p-2",
                    micEnabled
                      ? "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                      : "bg-red-500/20 text-red-400 hover:bg-red-500/30",
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
                    "rounded-lg p-2.5 transition-colors md:p-2",
                    camEnabled
                      ? "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                      : "text-slate-500 hover:bg-slate-800 hover:text-slate-300",
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
                  onClick={handleScreenShare}
                  className="rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 md:p-2"
                  aria-label="Share screen"
                >
                  <MonitorUp className="h-4 w-4" />
                </button>
              </span>
            )}

            <button
              onClick={handleCallToggle}
              className={clsx(
                "rounded-lg p-2.5 transition-colors md:p-2",
                lkConnected
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "text-green-400 hover:bg-green-500/20",
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
              <div className="mx-1 h-5 w-px bg-slate-700" />

              <button
                onClick={toggleParticipantPanel}
                className={clsx(
                  "rounded-lg p-2.5 transition-colors md:p-2",
                  participantPanelOpen
                    ? "bg-slate-800 text-slate-200"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                )}
                aria-label="Toggle participant panel"
              >
                <Users className="h-4 w-4" />
              </button>
            </span>
          </>
        )}

        {/* On phones these fold into the avatar menu (below) to save space. */}
        <span className="hidden md:contents">
          <button
            onClick={() => setSavedOpen(true)}
            className="rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 md:p-2"
            aria-label="Saved messages"
            title="Saved messages"
          >
            <Bookmark className="h-4 w-4" />
          </button>

          <button
            onClick={toggleSettings}
            className="rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 md:p-2"
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </span>

        {/* Account menu — desktop only; on phones account lives in the sidebar
            drawer's footer (see AppShell). */}
        <div className="relative hidden md:block" ref={menuRef}>
          <button
            ref={avatarBtnRef}
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="ml-1 transition-opacity hover:opacity-80"
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
              className="glass absolute right-0 top-full z-50 mt-2 w-56 rounded-xl p-2 shadow-xl animate-fade-in"
            >
              <div className="border-b border-slate-700/50 px-3 py-2">
                <p className="text-sm font-medium text-slate-100">
                  {currentUser?.displayName}
                </p>
                <p className="text-xs text-slate-400">
                  {currentUser?.email}
                </p>
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  logout();
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
