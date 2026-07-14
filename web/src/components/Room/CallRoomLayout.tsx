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
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const showVideo = useCallUiStore((s) => s.showVideo);
  const isDesktop = useIsDesktop();

  // Arrangement follows the chosen mode (see VIDEO_STAGE_MODES). Turning video
  // off globally (showVideo=false) collapses any stage back to the slim bar.
  const videoMain = voiceActive && showVideo && VIDEO_STAGE_MODES.has(viewMode);
  const callDock = voiceActive && viewMode === "sidebar";
  const slimBar = voiceActive && !videoMain && !callDock;

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

  // Video is the star: resizable [ video │ chat ]. Chat is collapsible so a
  // presenter can reclaim the full stage, then re-open chat with one click.
  if (videoMain) {
    return (
      <SplitPane
        storageKey="call-chat"
        orientation={isDesktop ? "horizontal" : "vertical"}
        defaultSize={isDesktop ? 380 : 260}
        min={isDesktop ? 280 : 180}
        max={isDesktop ? 680 : 520}
        collapsible
        secondaryLabel="chat"
        primary={callSurface}
        secondary={chatColumn}
      />
    );
  }

  // Co-working: chat is the star, the call docks as a narrow secondary column
  // (in-flow + resizable — never the old fixed overlay that clipped chat).
  if (callDock) {
    return (
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
    );
  }

  // Compact / audio / video-off, or no call: a slim call bar above full chat.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {slimBar && <div className="shrink-0">{callSurface}</div>}
      {chatColumn}
    </div>
  );
}
