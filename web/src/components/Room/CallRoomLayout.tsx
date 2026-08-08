import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useIsDesktop } from "@/hooks/usePanelResize";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion, AnimatePresence } from "framer-motion";
import { ChatPanel } from "./ChatPanel";
import { StageView } from "./StageView";
import { VoiceVideoBar } from "./VoiceVideoBar";
import { SplitPane } from "./SplitPane";
import { MobileCallModeSwitcher } from "./MobileCallModeSwitcher";
import type { CallViewMode } from "@/lib/roomDataProtocol";
import { ChevronUp, MessageSquare, X } from "lucide-react";
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

const LANDSCAPE_QUERY = "(orientation: landscape)";

function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(LANDSCAPE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(LANDSCAPE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setLandscape(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return landscape;
}

/**
 * CallRoomLayout — decides how the CALL surface and the CHAT coexist.
 *
 * Desktop: a resizable {@link SplitPane} keeps chat and video beside each other
 * keyed off the agent-drivable {@link CallViewMode} (grid/focus/spotlight/
 * screen / sidebar / compact).
 *
 * Mobile: human-first intent modes from {@link MobileCallModeSwitcher}:
 *   • Video — edge-to-edge stage; chat as a half/full bottom sheet
 *   • Split — video + chat stacked (portrait) or side-by-side (landscape)
 *   • Chat  — full chat with a corner PiP of the live call surface
 *
 * The SAME <VoiceVideoBar> instance is kept mounted across mobile mode switches
 * (CSS layout only) so LiveKit tracks never detach on intent change.
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
  const mobileCallMode = useCallUiStore((s) => s.mobileCallMode);
  const mobileCallModeUserOverride = useCallUiStore(
    (s) => s.mobileCallModeUserOverride,
  );
  const mobileChatSheet = useCallUiStore((s) => s.mobileChatSheet);
  const setMobileCallMode = useCallUiStore((s) => s.setMobileCallMode);
  const setMobileChatSheet = useCallUiStore((s) => s.setMobileChatSheet);
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();

  // The call PERSISTS across navigation, so "is there a call to show HERE?" is
  // not the global voiceActive flag — it's whether THIS room owns the live
  // call. In every other room the call surface stays hidden and the app-level
  // floating CallDock represents the call instead.
  const callIsHere = voiceActive && roomId === activeCallRoomId;

  // Mobile Video/Split need a real video stage (not audio-compact chips).
  useEffect(() => {
    if (!callIsHere || isDesktop) return;
    if (mobileCallMode === "video" || mobileCallMode === "split") {
      if (!showVideo) toggleVideo(true);
      if (!VIDEO_STAGE_MODES.has(viewMode)) {
        setViewMode(roomId, "grid");
      }
      // Presentation bias: screen-share view mode already set by VoiceVideoBar;
      // keep chat collapsed in pure Video so the share fills the stage.
      if (mobileCallMode === "video" && viewMode === "screen") {
        setChatCollapsed(true);
      }
    }
  }, [
    callIsHere,
    isDesktop,
    mobileCallMode,
    showVideo,
    viewMode,
    roomId,
    toggleVideo,
    setViewMode,
    setChatCollapsed,
  ]);

  // Default to Video when joining with a stage-worthy mode (camera/share path
  // already lifts viewMode). Only auto-apply until the user overrides.
  useEffect(() => {
    if (!callIsHere || isDesktop || mobileCallModeUserOverride) return;
    if (VIDEO_STAGE_MODES.has(viewMode) || showVideo) {
      if (mobileCallMode !== "video") {
        setMobileCallMode("video");
      }
    }
  }, [
    callIsHere,
    isDesktop,
    mobileCallModeUserOverride,
    viewMode,
    showVideo,
    mobileCallMode,
    setMobileCallMode,
  ]);

  // Screen-share presentation bias: prefer Video intent (edge-to-edge stage)
  // when the wire mode is Presentation and the user hasn't locked a mode.
  useEffect(() => {
    if (!callIsHere || isDesktop || mobileCallModeUserOverride) return;
    if (viewMode === "screen" && mobileCallMode !== "video") {
      setMobileCallMode("video");
    }
  }, [
    callIsHere,
    isDesktop,
    mobileCallModeUserOverride,
    viewMode,
    mobileCallMode,
    setMobileCallMode,
  ]);

  const chatColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Agent avatar stage (co-working spotlight) — unchanged behavior. */}
      <AnimatePresence>
        {stageAgentId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            // Clamp against --app-height (visual viewport), not vh: when the
            // mobile keyboard opens, vh keeps phantom height and the stage
            // shoves the composer off screen; --app-height tracks it.
            animate={{ height: "min(300px, calc(var(--app-height, 100dvh) * 0.4))", opacity: 1 }}
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

  // Single call surface instance — layout parents reflow via CSS so LiveKit
  // never remounts on mobile Video ⇄ Split ⇄ Chat.
  const callSurface = (
    <ErrorBoundary label="the call">
      <VoiceVideoBar roomId={roomId} />
    </ErrorBoundary>
  );

  // ── Mobile intent layouts ────────────────────────────────────────────────
  if (callIsHere && !isDesktop) {
    return (
      <MobileCallLayout
        roomId={roomId}
        mode={mobileCallMode}
        sheet={mobileChatSheet}
        isLandscape={isLandscape}
        callSurface={callSurface}
        chatColumn={chatColumn}
        onOpenSheet={(snap) => setMobileChatSheet(snap)}
        onCloseSheet={() => setMobileChatSheet(null)}
        onReturnToVideo={() => setMobileCallMode("video", { user: true })}
      />
    );
  }

  // Arrangement follows the chosen mode (see VIDEO_STAGE_MODES). Turning video
  // off (showVideo=false) collapses any stage back to the slim bar — that's the
  // user's "hide the video section → chat gets the whole screen" toggle.
  const videoMain = callIsHere && showVideo && VIDEO_STAGE_MODES.has(viewMode);
  const callDock = callIsHere && viewMode === "sidebar";
  const slimBar = callIsHere && !videoMain && !callDock;

  // Video is the star: resizable [ video │ chat ]. Chat is collapsible so a
  // presenter can reclaim the full stage, then re-open chat with one click. The
  // collapse is CONTROLLED off the shared `chatCollapsed` flag so the in-call
  // "hide chat" button (VoiceVideoBar controls) and the divider chevron stay in
  // lockstep — the chat pane stays mounted behind display:none either way.
  if (videoMain) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
      {slimBar && (isDesktop || showVideo) && (
        <div className="shrink-0">{callSurface}</div>
      )}
      {chatColumn}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Mobile layouts — Video / Split / Chat
 * ------------------------------------------------------------------ */

interface MobileCallLayoutProps {
  roomId: string;
  mode: "video" | "split" | "chat";
  sheet: "half" | "full" | null;
  isLandscape: boolean;
  callSurface: ReactNode;
  chatColumn: ReactNode;
  onOpenSheet: (snap: "half" | "full") => void;
  onCloseSheet: () => void;
  onReturnToVideo: () => void;
}

function MobileCallLayout({
  roomId,
  mode,
  sheet,
  isLandscape,
  callSurface,
  chatColumn,
  onOpenSheet,
  onCloseSheet,
  onReturnToVideo,
}: MobileCallLayoutProps) {
  // Single persistent call surface + chat column — CSS only reflows them so
  // LiveKit tracks and chat scroll/draft never remount on intent change.
  const [pipPos, setPipPos] = useState({ x: 12, y: 12 });
  const pipDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const onPipPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== "chat") return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, textarea, [role='button']")) return;
    pipDrag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pipPos.x,
      origY: pipPos.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPipPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = pipDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = d.startX - e.clientX;
    const dy = d.startY - e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    setPipPos({
      x: Math.max(8, d.origX + dx),
      y: Math.max(8, d.origY + dy),
    });
  };
  const onPipPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = pipDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const wasTap = !d.moved;
    pipDrag.current = null;
    if (wasTap) onReturnToVideo();
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {mode !== "video" && <MobileCallModeSwitcher />}

      <div
        className={clsx(
          "relative flex min-h-0 flex-1",
          mode === "video" && "flex-col bg-black",
          mode === "split" && (isLandscape ? "flex-row" : "flex-col"),
          mode === "chat" && "flex-col",
        )}
      >
        {/* Overlay mode switcher (Video only) */}
        {mode === "video" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-[max(0.25rem,env(safe-area-inset-top))]">
            <div className="pointer-events-auto">
              <MobileCallModeSwitcher overlay />
            </div>
          </div>
        )}

        {/* Persistent call surface — full / split pane / PiP via CSS */}
        <div
          className={clsx(
            "min-h-0 min-w-0",
            mode === "video" && "flex flex-1 flex-col",
            mode === "split" &&
              (isLandscape
                ? "flex w-1/2 flex-1 flex-col"
                : "flex h-[48%] shrink-0 flex-col"),
            mode === "chat" &&
              "absolute z-30 h-40 w-[7.5rem] overflow-hidden rounded-xl border border-line bg-slate-950 shadow-pop ring-1 ring-white/10",
          )}
          style={
            mode === "chat"
              ? { right: pipPos.x, bottom: pipPos.y }
              : undefined
          }
          onPointerDown={mode === "chat" ? onPipPointerDown : undefined}
          onPointerMove={mode === "chat" ? onPipPointerMove : undefined}
          onPointerUp={mode === "chat" ? onPipPointerUp : undefined}
          onPointerCancel={
            mode === "chat"
              ? () => {
                  pipDrag.current = null;
                }
              : undefined
          }
          role={mode === "chat" ? "button" : undefined}
          tabIndex={mode === "chat" ? 0 : undefined}
          aria-label={mode === "chat" ? "Return to full video" : undefined}
          title={
            mode === "chat" ? "Tap to return to Video · drag to move" : undefined
          }
          onKeyDown={
            mode === "chat"
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onReturnToVideo();
                  }
                }
              : undefined
          }
        >
          <div
            className={clsx(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              mode === "chat" && "pointer-events-none origin-top-left scale-[0.92]",
            )}
          >
            {callSurface}
          </div>
          {mode === "chat" && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] font-medium text-white">
              Tap for Video
            </span>
          )}
        </div>

        {/* Persistent chat — same fiber parent always; CSS places it as split
            pane, full column, bottom sheet, or display:none. */}
        {mode === "video" && sheet !== null && (
          <button
            type="button"
            aria-label="Dismiss chat"
            className="absolute inset-0 z-30 bg-slate-950/50"
            onClick={onCloseSheet}
          />
        )}

        <div
          className={clsx(
            "flex min-h-0 min-w-0 flex-col",
            mode === "split" &&
              (isLandscape
                ? "w-1/2 flex-1 border-l border-line"
                : "min-h-0 flex-1 border-t border-line"),
            mode === "chat" && "min-h-0 flex-1",
            mode === "video" && sheet === null && "hidden",
            mode === "video" &&
              sheet === "half" &&
              "absolute inset-x-0 bottom-0 z-40 h-[50dvh] max-h-full overflow-hidden rounded-t-2xl border-t border-line bg-surface-0 shadow-pop",
            mode === "video" &&
              sheet === "full" &&
              "absolute inset-x-0 bottom-0 z-40 h-[92dvh] max-h-full overflow-hidden rounded-t-2xl border-t border-line bg-surface-0 shadow-pop",
          )}
          role={mode === "video" && sheet ? "dialog" : undefined}
          aria-modal={mode === "video" && sheet ? true : undefined}
          aria-label={mode === "video" && sheet ? "Chat" : undefined}
        >
          {mode === "video" && sheet !== null && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="block h-1 w-10 rounded-full bg-slate-600/80"
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold text-slate-200">
                  Chat
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    onOpenSheet(sheet === "half" ? "full" : "half")
                  }
                  className="focus-ring flex h-11 min-w-11 items-center justify-center rounded-lg px-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06]"
                >
                  {sheet === "half" ? "Full" : "Half"}
                </button>
                <button
                  type="button"
                  onClick={onCloseSheet}
                  className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
                  aria-label="Close chat"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{chatColumn}</div>
        </div>

        {mode === "video" && (
          <>
            <IncomingMessagePreview roomId={roomId} active={sheet === null} />
            {sheet === null && (
              <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
                <button
                  type="button"
                  onClick={() => onOpenSheet("half")}
                  className="focus-ring flex h-11 min-w-[11rem] items-center justify-center gap-2 rounded-full border border-line bg-slate-950/80 px-4 text-sm font-medium text-slate-100 shadow-pop backdrop-blur-md"
                  aria-label="Open chat"
                >
                  <MessageSquare className="h-4 w-4 text-stable-cyan" />
                  Chat
                  <ChevronUp className="h-4 w-4 text-slate-400" />
                </button>
                <SheetDragHandle
                  onOpenHalf={() => onOpenSheet("half")}
                  onOpenFull={() => onOpenSheet("full")}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Thin swipe-up zone under the Chat button — opens half or full by distance. */
function SheetDragHandle({
  onOpenHalf,
  onOpenFull,
}: {
  onOpenHalf: () => void;
  onOpenFull: () => void;
}) {
  const startY = useRef<number | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startY.current == null) return;
    const dy = startY.current - e.clientY;
    startY.current = null;
    if (dy > 120) onOpenFull();
    else if (dy > 36) onOpenHalf();
  };

  return (
    <div
      className="mt-1 flex h-8 w-full touch-none items-start justify-center"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        startY.current = null;
      }}
      aria-hidden="true"
    >
      <span className="h-1 w-10 rounded-full bg-slate-600/60" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Transient message previews while chat is hidden (Video mode)
 * ------------------------------------------------------------------ */

function IncomingMessagePreview({
  roomId,
  active,
}: {
  roomId: string;
  active: boolean;
}) {
  const messages = useAppStore((s) => s.messages[roomId]?.items);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const setMobileChatSheet = useCallUiStore((s) => s.setMobileChatSheet);
  const [preview, setPreview] = useState<{
    id: string;
    name: string;
    text: string;
  } | null>(null);
  const lastSeenId = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      setPreview(null);
      return;
    }
    const items = messages ?? [];
    if (items.length === 0) return;
    const last = items[items.length - 1]!;
    if (lastSeenId.current === null) {
      lastSeenId.current = last.id;
      return;
    }
    if (last.id === lastSeenId.current) return;
    lastSeenId.current = last.id;
    // Don't preview our own sends.
    if (currentUserId && last.sender_id === currentUserId) return;
    const name = last.sender_name || "Someone";
    const text = (last.content || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    setPreview({
      id: last.id,
      name,
      text: text.length > 90 ? `${text.slice(0, 87)}…` : text,
    });
    const t = window.setTimeout(() => setPreview(null), 4200);
    return () => window.clearTimeout(t);
  }, [messages, active, currentUserId]);

  if (!preview) return null;

  return (
    <button
      type="button"
      onClick={() => setMobileChatSheet("half")}
      className="focus-ring absolute inset-x-3 top-14 z-20 rounded-xl border border-line bg-slate-950/85 px-3 py-2 text-left shadow-pop backdrop-blur-md"
    >
      <p className="truncate text-xs font-semibold text-slate-100">
        {preview.name}
      </p>
      <p className="line-clamp-2 text-xs text-slate-300">{preview.text}</p>
    </button>
  );
}

