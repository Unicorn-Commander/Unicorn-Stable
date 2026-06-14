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
import { SavedPanel } from "./SavedPanel";

export function Header() {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const [savedOpen, setSavedOpen] = useState(false);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const rooms = useAppStore((s) => s.rooms);
  const currentUser = useAppStore((s) => s.currentUser);
  const voiceActive = useAppStore((s) => s.voiceActive);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  const {
    room,
    isConnected: lkConnected,
    isConnecting: lkConnecting,
    connect: lkConnect,
    disconnect: lkDisconnect,
  } = useStableRoom(voiceActive ? activeRoomId : null);

  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
      lkConnect();
    }
  }


  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-700/50 px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={toggleSidebar}
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-5 w-5" />
          ) : (
            <PanelLeftOpen className="h-5 w-5" />
          )}
        </button>

        {activeRoom && (
          <div className="flex flex-col">
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
              <>
                <button
                  onClick={handleToggleMic}
                  className={clsx(
                    "rounded-lg p-2 transition-colors",
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
                    "rounded-lg p-2 transition-colors",
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
                  className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  aria-label="Share screen"
                >
                  <MonitorUp className="h-4 w-4" />
                </button>
              </>
            )}

            <button
              onClick={handleCallToggle}
              className={clsx(
                "rounded-lg p-2 transition-colors",
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

            <div className="mx-1 h-5 w-px bg-slate-700" />

            <button
              onClick={toggleParticipantPanel}
              className={clsx(
                "rounded-lg p-2 transition-colors",
                participantPanelOpen
                  ? "bg-slate-800 text-slate-200"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
              aria-label="Toggle participant panel"
            >
              <Users className="h-4 w-4" />
            </button>
          </>
        )}

        <button
          onClick={() => setSavedOpen(true)}
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          aria-label="Saved messages"
          title="Saved messages"
        >
          <Bookmark className="h-4 w-4" />
        </button>

        <button
          onClick={toggleSettings}
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>

        {savedOpen && <SavedPanel onClose={() => setSavedOpen(false)} />}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="ml-1 transition-opacity hover:opacity-80"
            aria-label="User menu"
            aria-expanded={userMenuOpen}
          >
            <Avatar
              name={currentUser?.displayName ?? "U"}
              src={currentUser?.avatarUrl}
              size="sm"
            />
          </button>

          {userMenuOpen && (
            <div className="glass absolute right-0 top-full z-50 mt-2 w-56 rounded-xl p-2 shadow-xl animate-fade-in">
              <div className="border-b border-slate-700/50 px-3 py-2">
                <p className="text-sm font-medium text-slate-100">
                  {currentUser?.displayName}
                </p>
                <p className="text-xs text-slate-400">
                  {currentUser?.email}
                </p>
              </div>
              <button
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
