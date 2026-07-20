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
  Keyboard,
  LogOut,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { useStableRoom } from "@/hooks/useStableRoom";
import { logout } from "@/services/auth";
import { Avatar } from "@/components/Avatar";
import { Tooltip } from "@/components/ui";
import { identityFor } from "@/lib/identity";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";

/** Read `.name` off an unknown thrown value without relying on `instanceof`.
 * getDisplayMedia rejects with a DOMException, and `DOMException instanceof
 * Error` is unreliable across engines (the spec doesn't make it inherit Error),
 * so we duck-type instead — this also survives any wrapper that preserves the
 * error name. */
function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) {
    return String((err as { name: unknown }).name);
  }
  return "";
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

/**
 * getDisplayMedia rejections that mean "the user chose not to share" (dismissed
 * the picker) or "there was nothing to share" — NOT a failure worth surfacing or
 * retrying. Re-prompting after a deliberate cancel would be hostile, so we treat
 * these as a silent no-op. Everything else is a real error we can try to recover
 * from (see handleScreenShare's video-only fallback).
 */
function isUserDismissedShare(err: unknown): boolean {
  const name = errorName(err);
  return (
    name === "NotAllowedError" ||
    name === "AbortError" ||
    name === "NotFoundError"
  );
}

// `hideOnMobile` lets AppShell collapse this top bar on phones when a room is
// active — there the RoomView sub-header (with a hamburger) is the single bar,
// so a second bar here would just waste vertical space. Desktop always shows it.
export function Header({ hideOnMobile = false }: { hideOnMobile?: boolean }) {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCheatsheet = useAppStore((s) => s.toggleCheatsheet);
  // SavedPanel is now rendered once at the AppShell level (so the mobile drawer
  // account section can open it); here we only need the opener.
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const rooms = useAppStore((s) => s.rooms);
  const currentUser = useAppStore((s) => s.currentUser);
  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  // Identity hue for the signed-in resident — rings the avatar + menu header.
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);

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
    const lp = room.localParticipant;

    // Toggle OFF — no capture options; wrap so a stray rejection can't bubble up
    // as an unhandled promise rejection.
    if (lp.isScreenShareEnabled) {
      try {
        await lp.setScreenShareEnabled(false);
      } catch (err) {
        console.error("failed to stop screen share", err);
      }
      return;
    }

    // Toggle ON — request tab/system AUDIO alongside the display video so remote
    // participants can HEAR the shared tab/app.
    //   audio: true              → getDisplayMedia({ audio: … }) captures the tab/system audio track
    //   systemAudio: "include"   → offer whole-system audio as a source (Chromium)
    //   selfBrowserSurface:"exclude" → don't offer the Stable tab itself (sharing it back into the
    //                                   call would loop the call's own audio → echo)
    //
    // Browser support for screenshare audio is limited (Chrome/Edge tab, or
    // Chromium system audio; Safari/Firefox capture none; picking a *window*
    // yields none). In every "no audio available" case getDisplayMedia simply
    // returns a video-only stream and LiveKit publishes just the screen video —
    // the share still works. We only need to defend against (a) the user
    // dismissing the picker and (b) the rare browser that REJECTS the audio
    // constraints outright, which we recover from by retrying video-only.
    try {
      await lp.setScreenShareEnabled(true, {
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      });
    } catch (err) {
      if (isUserDismissedShare(err)) return; // user closed the picker — no-op
      console.warn(
        "screen share with audio failed; retrying without audio",
        err,
      );
      try {
        await lp.setScreenShareEnabled(true);
      } catch (err2) {
        if (isUserDismissedShare(err2)) return;
        console.error("screen share failed", err2);
        useAppStore.getState().pushToast({
          title: "Couldn't share your screen",
          body:
            errorMessage(err2) || "Your browser blocked screen sharing.",
        });
      }
    }
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
                  onClick={handleScreenShare}
                  className="focus-ring rounded-lg p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-2"
                  aria-label="Share screen"
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
