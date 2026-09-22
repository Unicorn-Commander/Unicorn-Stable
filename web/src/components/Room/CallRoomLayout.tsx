import { useIsLandscape } from "@/hooks/useIsLandscape";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore, type MobileCallMode } from "@/stores/callUiStore";
import { useIsDesktop } from "@/hooks/usePanelResize";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion, AnimatePresence } from "framer-motion";
import { ChatPanel } from "./ChatPanel";
import { StageView } from "./StageView";
import { VoiceVideoBar } from "./VoiceVideoBar";
import { SplitPane } from "./SplitPane";
import { MobileCallModeSwitcher } from "./MobileCallModeSwitcher";
import type { CallViewMode } from "@/lib/roomDataProtocol";
import { MessageSquare } from "lucide-react";
import clsx from "clsx";
import { PanelHost } from "@/components/Layout/PanelHost";
import {
  installCallLayoutMirrors,
  presentChat,
  toggleCallChat,
} from "@/lib/callLayoutActions";
import { decideIncomingPill } from "@/lib/incomingPill";
import { useRoomPanelHotkeys } from "./useRoomPanelHotkeys";
import { CHAT_DOCK_WIDTH } from "@/stores/panelRegistry";
import { usePanelChromeStore } from "@/stores/panelChromeStore";

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
 * Desktop: a resizable {@link SplitPane} keeps chat (360px default) beside the
 * stage. Hidden chat drops the side column so the stage is the full width.
 * The split stays in this window — a popped chat is the panel body portaled
 * by {@link PanelHost}, never the split.
 *
 * Mobile (<768px):
 *   • Video — stage full size. Chat is not a sheet. A new message is a
 *     one-line pill; tap opens Split.
 *   • Split — chat is in normal flow below the stage (beside it in landscape).
 *   • Chat — full chat, stage as a corner picture.
 */
export function CallRoomLayout({ roomId, onInviteAgent }: CallRoomLayoutProps) {
  const stageAgentId = useAppStore((s) => s.ui.stageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const showVideo = useCallUiStore((s) => s.showVideo);
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const toggleVideo = useCallUiStore((s) => s.toggleVideo);
  const mobileCallMode = useCallUiStore((s) => s.mobileCallMode);
  const mobileCallModeUserOverride = useCallUiStore(
    (s) => s.mobileCallModeUserOverride,
  );
  const setMobileCallMode = useCallUiStore((s) => s.setMobileCallMode);
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();
  const panels = useRoomPanels(roomId);
  const layoutEpoch = usePanelChromeStore((s) => s.layoutEpoch[roomId] ?? 0);
  const [chatDock, setChatDock] = useState<HTMLElement | null>(null);

  useRoomPanelHotkeys(roomId);
  useEffect(() => {
    installCallLayoutMirrors();
  }, []);

  const callIsHere = voiceActive && roomId === activeCallRoomId;

  const anyVideoLive = useCallUiStore((s) => s.anyVideoLive);
  const audioIntentHold = useCallUiStore((s) => s.audioIntentHold);
  const applyAudioIntentHold = useCallUiStore((s) => s.applyAudioIntentHold);
  const liftAudioIntentHold = useCallUiStore((s) => s.liftAudioIntentHold);

  useEffect(() => {
    if (!callIsHere || anyVideoLive) return;
    applyAudioIntentHold(roomId, VIDEO_STAGE_MODES.has(viewMode));
  }, [callIsHere, anyVideoLive, roomId, viewMode, applyAudioIntentHold]);

  useEffect(() => {
    if (!callIsHere || !anyVideoLive) return;
    if (audioIntentHold?.roomId === roomId) {
      liftAudioIntentHold(roomId);
    }
  }, [callIsHere, anyVideoLive, audioIntentHold, roomId, liftAudioIntentHold]);

  useEffect(() => {
    if (!callIsHere || isDesktop) return;
    const needsStage =
      mobileCallMode === "video" ||
      (mobileCallMode === "split" && anyVideoLive);
    if (needsStage) {
      if (!showVideo) toggleVideo(true);
      if (!VIDEO_STAGE_MODES.has(viewMode)) {
        setViewMode(roomId, "grid");
      }
    }
  }, [
    callIsHere,
    isDesktop,
    mobileCallMode,
    anyVideoLive,
    showVideo,
    viewMode,
    roomId,
    toggleVideo,
    setViewMode,
  ]);

  useEffect(() => {
    if (!callIsHere || isDesktop || mobileCallModeUserOverride) return;
    if (anyVideoLive && mobileCallMode !== "video") {
      setMobileCallMode("video");
    }
  }, [
    callIsHere,
    isDesktop,
    mobileCallModeUserOverride,
    anyVideoLive,
    mobileCallMode,
    setMobileCallMode,
  ]);

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

  // A room that remembered "chat hidden" opens the phone on the full stage.
  useEffect(() => {
    if (!callIsHere || isDesktop) return;
    if (panels.chat.mode !== "hidden") return;
    if (mobileCallMode === "video" || mobileCallMode === "chat") return;
    setMobileCallMode("video");
  }, [callIsHere, isDesktop, panels.chat.mode, mobileCallMode, setMobileCallMode]);

  const chatColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AnimatePresence>
        {stageAgentId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
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

  const callSurface = (
    <ErrorBoundary label="the call">
      <VoiceVideoBar roomId={roomId} />
    </ErrorBoundary>
  );

  const textLayout = callIsHere && panels.stage.mode === "floating";
  const chatPresent = presentChat({
    callIsHere,
    isDesktop,
    mobileCallMode,
    chatMode: panels.chat.mode,
    textLayout,
  });

  const chatHost = (
    <PanelHost
      roomId={roomId}
      panelId="chat"
      title="Chat"
      dockElement={chatPresent === "docked" ? chatDock : null}
      present={chatPresent}
    >
      {chatColumn}
    </PanelHost>
  );

  if (callIsHere && !isDesktop) {
    const phoneMode: MobileCallMode =
      mobileCallMode === "video" || panels.chat.mode === "hidden"
        ? "video"
        : mobileCallMode;
    return (
      <>
        <MobileCallLayout
          roomId={roomId}
          mode={phoneMode}
          isLandscape={isLandscape}
          callSurface={callSurface}
          onChatDock={setChatDock}
          onOpenChat={() => toggleCallChat(roomId)}
          onReturnToVideo={() => {
            setMobileCallMode("video", { user: true });
          }}
        />
        {chatHost}
      </>
    );
  }

  const videoMain = callIsHere && showVideo && VIDEO_STAGE_MODES.has(viewMode);
  const callDock = callIsHere && viewMode === "sidebar" && !textLayout;
  const slimBar = callIsHere && !videoMain && !callDock && !textLayout;
  const stageFrame = callIsHere && (videoMain || textLayout) && !callDock;

  if (stageFrame) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SplitPane
          storageKey={`call-chat:${roomId}`}
          legacyStorageKey="call-chat"
          orientation="horizontal"
          defaultSize={CHAT_DOCK_WIDTH}
          min={280}
          max={680}
          collapsible
          collapsed={chatPresent !== "docked" || textLayout}
          fullBleedWhenCollapsed
          secondaryLabel="chat"
          className="relative"
          preferredSize={panels.chat.geometry.w}
          preferredEpoch={layoutEpoch}
          onSizeCommit={(w) => {
            const g = usePanelChromeStore.getState().getPanel(roomId, "chat").geometry;
            if (g.w === w) return;
            usePanelChromeStore.getState().setPanelGeometry(roomId, "chat", {
              ...g,
              w,
            });
          }}
          primary={
            <div className="relative flex min-h-0 min-w-0 flex-1">
              {textLayout && chatPresent === "docked" && (
                <div
                  ref={setChatDock}
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                />
              )}
              <div
                data-stage-root=""
                className={clsx(
                  "min-h-0 min-w-0 overflow-hidden",
                  textLayout
                    ? "absolute bottom-16 right-3 z-20 h-44 w-72 rounded-xl border border-line bg-slate-950 shadow-pop"
                    : "flex flex-1 flex-col",
                )}
              >
                {callSurface}
              </div>
            </div>
          }
          secondary={
            <div
              ref={textLayout ? undefined : setChatDock}
              data-chat-dock="true"
              className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
            />
          }
        />
        {chatHost}
      </div>
    );
  }

  if (callDock && chatPresent === "docked") {
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
          primary={
            <div ref={setChatDock} className="flex min-h-0 min-w-0 flex-1 flex-col" />
          }
          secondary={callSurface}
        />
        {chatHost}
      </div>
    );
  }

  if (callIsHere && viewMode === "sidebar" && chatPresent !== "docked") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">{callSurface}</div>
        {chatHost}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {slimBar && (isDesktop || showVideo) && (
        <div className="shrink-0">{callSurface}</div>
      )}
      {chatPresent === "docked" && (
        <div ref={setChatDock} className="flex min-h-0 min-w-0 flex-1 flex-col" />
      )}
      {chatHost}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Mobile layouts — Video / Split / Chat
 * ------------------------------------------------------------------ */

interface MobileCallLayoutProps {
  roomId: string;
  mode: MobileCallMode;
  isLandscape: boolean;
  callSurface: ReactNode;
  onChatDock: (el: HTMLElement | null) => void;
  onOpenChat: () => void;
  onReturnToVideo: () => void;
}

function MobileCallLayout({
  roomId,
  mode,
  isLandscape,
  callSurface,
  onChatDock,
  onOpenChat,
  onReturnToVideo,
}: MobileCallLayoutProps) {
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
        {mode === "video" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-[max(0.25rem,env(safe-area-inset-top))]">
            <div className="pointer-events-auto">
              <MobileCallModeSwitcher overlay />
            </div>
          </div>
        )}

        <div
          data-stage-root=""
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
          title={mode === "chat" ? "Tap to return to Video · drag to move" : undefined}
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

        {/*
          Phone Split: the chat slot is a flex sibling of the stage, under it
          in portrait and beside it in landscape. It is not position:absolute
          and there is no scrim, so it cannot cover the stage.
          Phone Video: this slot is not rendered. Chat stays off the stage.
        */}
        {mode !== "video" && (
          <div
            ref={onChatDock}
            className={clsx(
              "flex min-h-0 min-w-0 flex-col",
              mode === "split" &&
                (isLandscape
                  ? "w-1/2 flex-1 border-l border-line"
                  : "min-h-0 flex-1 border-t border-line"),
              mode === "chat" && "min-h-0 flex-1",
            )}
          />
        )}

        {mode === "video" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-20 flex justify-center px-3">
            <IncomingMessagePill roomId={roomId} onOpen={onOpenChat} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One line, tappable. Tap leaves Video for Split (chat below the stage).
 * Nothing here opens a sheet over the picture.
 */
function IncomingMessagePill({
  roomId,
  onOpen,
}: {
  roomId: string;
  onOpen: () => void;
}) {
  const messages = useAppStore((s) => s.messages[roomId]?.items);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const [preview, setPreview] = useState<{ id: string; line: string } | null>(
    null,
  );
  // The dismiss timer lives in a ref. Cleaning it up from the messages
  // effect would cancel it whenever the array identity changes and the
  // early return below would not arm a new one — the pill would stick.
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const items = messages ?? [];
    const last = items[items.length - 1];
    const decision = decideIncomingPill(
      roomId,
      last
        ? {
            id: last.id,
            senderId: last.sender_id ?? null,
            senderName: last.sender_name,
            text: last.content || "",
          }
        : null,
      currentUserId ?? null,
    );
    if (decision.action !== "show" || !decision.line || !last) return;
    setPreview({ id: last.id, line: decision.line });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setPreview(null);
    }, 6000);
  }, [messages, currentUserId, roomId]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!preview) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="focus-ring pointer-events-auto flex h-11 max-w-full items-center gap-2 rounded-full border border-line bg-slate-950/90 px-3 text-left text-xs font-medium text-slate-100 shadow-pop backdrop-blur-md"
      aria-label={`New message. ${preview.line}. Open chat below the stage.`}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-stable-cyan" />
      <span className="truncate">{preview.line}</span>
    </button>
  );
}
