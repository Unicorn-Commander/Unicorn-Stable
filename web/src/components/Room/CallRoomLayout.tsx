import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useIsDesktop } from "@/hooks/usePanelResize";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion, AnimatePresence } from "framer-motion";
import { ChatPanel } from "./ChatPanel";
import { StageView } from "./StageView";
import { VoiceVideoBar } from "./VoiceVideoBar";
import { SplitPane } from "./SplitPane";
import type { CallViewMode } from "@/lib/roomDataProtocol";
import { MessageSquare, Smartphone } from "lucide-react";
import clsx from "clsx";

interface CallRoomLayoutProps {
  roomId: string;
  /** Opens the room's invite flow — forwarded to the chat empty-state chip. */
  onInviteAgent: () => void;
}

/**
 * Modes that want the big, resizable [ video stage │ chat ] arrangement — the
 * "video is the star" layout. All four map onto a stage of tiles (people show as
 * avatar tiles until a camera/screen is live), so we key the arrangement on the
 * CHOSEN mode rather than on whether a camera happens to be publishing. That's
 * what lets a user pick Gallery/Speaker/Spotlight/Presentation and immediately
 * get the stage, instead of it collapsing to the audio bar while everyone's
 * camera is still off.
 */
const VIDEO_STAGE_MODES: ReadonlySet<CallViewMode> = new Set<CallViewMode>([
  "grid",
  "focus",
  "spotlight",
  "screen",
]);

/**
 * CallRoomLayout — decides how the CALL surface and the CHAT coexist.
 *
 * A single resizable {@link SplitPane} keeps chat and video BESIDE each other
 * (or stacked on mobile) so you can always read + send while in a call. Three
 * arrangements, chosen off the same per-room view mode agents already drive:
 *
 *   • video stage (grid / focus / spotlight / screen) → video is the star: a
 *     resizable split of [ video stage │ chat dock ] (chat collapsible).
 *   • sidebar (co-working) → chat is the star: [ chat │ narrow call dock ].
 *   • compact / audio / video-off → a slim call bar docked above full chat.
 *
 * The SAME <SplitPane> instance flips orientation across the md breakpoint
 * (side-by-side ⇄ stacked), so VoiceVideoBar is never remounted by a resize —
 * which matters because its LiveKit <video> tracks would otherwise detach.
 * VoiceVideoBar is rendered at most ONCE in every branch (no double-attach).
 */
export function CallRoomLayout({ roomId, onInviteAgent }: CallRoomLayoutProps) {
  const stageAgentId = useAppStore((s) => s.ui.stageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const showVideo = useCallUiStore((s) => s.showVideo);
  const chatCollapsed = useCallUiStore((s) => s.chatCollapsed);
  const setChatCollapsed = useCallUiStore((s) => s.setChatCollapsed);
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const toggleVideo = useCallUiStore((s) => s.toggleVideo);
  const isDesktop = useIsDesktop();

  // The call PERSISTS across navigation, so "is there a call to show HERE?" is
  // not the global voiceActive flag — it's whether THIS room owns the live
  // call. In every other room the call surface stays hidden and the app-level
  // floating CallDock represents the call instead.
  const callIsHere = voiceActive && roomId === activeCallRoomId;

  // Arrangement follows the chosen mode (see VIDEO_STAGE_MODES). Turning video
  // off (showVideo=false) collapses any stage back to the slim bar — that's the
  // user's "hide the video section → chat gets the whole screen" toggle.
  const videoMain = callIsHere && showVideo && VIDEO_STAGE_MODES.has(viewMode);
  const callDock = callIsHere && viewMode === "sidebar";
  const slimBar = callIsHere && !videoMain && !callDock;

  const chatColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Agent avatar stage (co-working spotlight) — unchanged behavior. */}
      <AnimatePresence>
        {stageAgentId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 300, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="shrink-0 overflow-hidden border-b border-line"
          >
            <StageView agentId={stageAgentId} roomId={roomId} />
          </motion.div>
        )}
      </AnimatePresence>

      <ErrorBoundary label="the chat area">
        <ChatPanel roomId={roomId} onInviteAgent={onInviteAgent} />
      </ErrorBoundary>
    </div>
  );

  const callSurface = (
    <ErrorBoundary label="the call">
      <VoiceVideoBar roomId={roomId} />
    </ErrorBoundary>
  );

  /**
   * Phones get two named layouts instead of having to decode the desktop's
   * icon-only view controls:
   *   Portrait → video above chat (the SplitPane's vertical orientation)
   *   Chat     → the call continues, but chat owns the usable viewport
   */
  const mobileLayoutBar = callIsHere ? (
    <div
      className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line bg-slate-950/85 px-3 md:hidden"
      role="group"
      aria-label="Mobile call layout"
    >
      <span className="truncate text-[10px] font-medium text-slate-500">
        In call
      </span>
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2/80 p-0.5">
        <button
          type="button"
          onClick={() => {
            toggleVideo(true);
            setChatCollapsed(false);
            setViewMode(roomId, "grid");
          }}
          className={clsx(
            "focus-ring flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
            showVideo
              ? "bg-stable-purple/25 text-stable-purple-light"
              : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
          )}
          aria-pressed={showVideo}
          title="Portrait call — video above chat"
        >
          <Smartphone className="h-3.5 w-3.5" />
          Portrait
        </button>
        <button
          type="button"
          onClick={() => toggleVideo(false)}
          className={clsx(
            "focus-ring flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
            !showVideo
              ? "bg-stable-cyan/15 text-stable-cyan"
              : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
          )}
          aria-pressed={!showVideo}
          title="Chat focus — call continues while chat fills the screen"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </button>
      </div>
    </div>
  ) : null;

  // Video is the star: resizable [ video │ chat ]. Chat is collapsible so a
  // presenter can reclaim the full stage, then re-open chat with one click. The
  // collapse is CONTROLLED off the shared `chatCollapsed` flag so the in-call
  // "hide chat" button (VoiceVideoBar controls) and the divider chevron stay in
  // lockstep — the chat pane stays mounted behind display:none either way.
  if (videoMain) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mobileLayoutBar}
        <SplitPane
          storageKey="call-chat"
          orientation={isDesktop ? "horizontal" : "vertical"}
          defaultSize={isDesktop ? 380 : 260}
          min={isDesktop ? 280 : 180}
          max={isDesktop ? 680 : 520}
          collapsible
          collapsed={chatCollapsed}
          onCollapsedChange={setChatCollapsed}
          secondaryLabel="chat"
          primary={callSurface}
          secondary={chatColumn}
        />
      </div>
    );
  }

  // Co-working: chat is the star, the call docks as a narrow secondary column
  // (in-flow + resizable — never the old fixed overlay that clipped chat).
  if (callDock) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mobileLayoutBar}
        <SplitPane
          storageKey="call-dock"
          orientation={isDesktop ? "horizontal" : "vertical"}
          defaultSize={isDesktop ? 300 : 220}
          min={isDesktop ? 220 : 160}
          max={isDesktop ? 460 : 420}
          collapsible
          secondaryLabel="call"
          primary={chatColumn}
          secondary={callSurface}
        />
      </div>
    );
  }

  // Compact / audio / video-off, or no call: a slim call bar above full chat.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {mobileLayoutBar}
      {slimBar && (isDesktop || showVideo) && (
        <div className="shrink-0">{callSurface}</div>
      )}
      {chatColumn}
    </div>
  );
}
