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
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { useStableRoom } from "@/hooks/useStableRoom";
import { api } from "@/services/api";
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
  const setVoiceActive = useAppStore((s) => s.setVoiceActive);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  const {
    room,
    isConnected: lkConnected,
    isConnecting: lkConnecting,
    connect: lkConnect,
    disconnect: lkDisconnect,
  } = useStableRoom(voiceActive ? activeRoomId : null);

  // Room detail carries the resident Brigade agent id (metadata.brigade_agent_id).
  // Same query key/shape as RoomView so react-query dedupes the fetch.
  const { data: roomDetail } = useQuery({
    queryKey: ["room", activeRoomId],
    queryFn: () => api.getRoom(activeRoomId as string),
    enabled: !!activeRoomId,
    staleTime: 30_000,
  });
  const brigadeAgentId = roomDetail?.brigade_agent_id ?? null;

  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Guards so a single call-start enables the mic + dispatches the agent
  // exactly once per connection (toggling the button must not re-fire).
  const micEnabledOnConnect = useRef(false);
  const agentDispatched = useRef(false);
  // The user pressed "call" and wants this surface to connect. We can't call
  // lkConnect() synchronously from the click: the hook is armed off
  // `voiceActive` (null roomId until it flips true), so a cold-start click
  // captures a no-op connect. Instead we set the intent + arm voiceActive,
  // then connect from an effect once the hook re-arms with the real roomId.
  const wantCall = useRef(false);

  // When the call connects, publish the human's mic on the SAME room instance
  // that lkConnect() connected (this hook's `room`), and dispatch the room's
  // resident Brigade agent into the voice session — once per connection.
  useEffect(() => {
    if (!lkConnected || !room) {
      // Reset guards when the call ends so the next call re-arms them.
      if (!lkConnected) {
        micEnabledOnConnect.current = false;
        agentDispatched.current = false;
      }
      return;
    }

    if (!micEnabledOnConnect.current) {
      micEnabledOnConnect.current = true;
      void room.localParticipant
        .setMicrophoneEnabled(true)
        .then(() => setMicEnabled(true))
        .catch((err) => {
          console.error("failed to enable microphone on call start", err);
        });
    }

    if (!agentDispatched.current && activeRoomId && brigadeAgentId) {
      agentDispatched.current = true;
      // A failed agent dispatch must never break the human's call.
      void api
        .inviteBrigadeAgent(activeRoomId, brigadeAgentId)
        .catch((err) => {
          console.error("failed to dispatch agent into voice call", err);
        });
    }
  }, [lkConnected, room, activeRoomId, brigadeAgentId]);

  // Drive the actual connect once the hook has re-armed with a real roomId
  // (voiceActive flipped true). Only this surface, having captured the user's
  // intent in wantCall, initiates the connection.
  useEffect(() => {
    if (
      wantCall.current &&
      voiceActive &&
      activeRoomId &&
      !lkConnected &&
      !lkConnecting
    ) {
      void lkConnect();
    }
  }, [voiceActive, activeRoomId, lkConnected, lkConnecting, lkConnect]);

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
      wantCall.current = false;
      lkDisconnect();
    } else {
      // Capture intent + arm the hook. The connect-arming effect calls
      // lkConnect() once the hook re-renders with the real roomId. The
      // mic-publish + agent-dispatch effect fires when the call connects.
      wantCall.current = true;
      setVoiceActive(true);
    }
  }


  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-700/50 px-4">
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
              </>
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
          </>
        )}

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
