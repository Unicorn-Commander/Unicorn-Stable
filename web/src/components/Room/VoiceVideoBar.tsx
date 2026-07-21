import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { RoomEvent } from "livekit-client";
import type {
  LocalTrack,
  RemoteTrack,
  RemoteAudioTrack,
  Participant,
} from "livekit-client";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Volume2,
  VolumeX,
  Bot,
  MonitorUp,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Maximize,
  Minimize,
  PictureInPicture2,
  ExternalLink,
  GripVertical,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { identityFor } from "@/lib/identity";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useIsDesktop } from "@/hooks/usePanelResize";
import {
  useCallUiStore,
  uiCommandBus,
  DEFAULT_CALL_VIEW_MODE,
} from "@/stores/callUiStore";
import type { CallViewMode } from "@/lib/roomDataProtocol";
import { api, type BrigadeAgent } from "@/services/api";
import { ViewModeSwitcher } from "./ViewModeSwitcher";
import { TranscriptPanel } from "./TranscriptPanel";
import { VoiceAgentStatus } from "./VoiceAgentStatus";
import { VideoGrid } from "./VideoGrid";
import { SplitPane } from "./SplitPane";
// ─────────────────────────────────────────────────────────────────────────────
// Pop-out / Picture-in-Picture module (audit §4a) — web/src/components/Room/popout/.
// Integrated and typechecked against the module's REAL exports (CONTRACT.md), no
// longer assumed: `usePipTile`, `useMergedVideoRef`, `useCallPopout`,
// `isPopoutSupported` all resolve from the popout barrel.
//
// We use `useMergedVideoRef` (memoized) rather than a raw `mergeVideoRefs`: a
// fresh merged ref each render would detach+reattach the LiveKit track every
// render (flicker + black frame + adaptive-stream churn — CONTRACT §3.1), and we
// gate the detached window on `isPopoutSupported()` in addition to desktop
// (CONTRACT §3.5).
//
// `usePipTile().enter/toggle` and `useCallPopout().open` MUST be called
// synchronously from a user gesture (no `await` before them) — that is why
// pop-out/PiP stay human-only controls and are intentionally NOT on the agent
// `ui_command` wire (see roomDataProtocol.ts / audit §4c, §5).
// ─────────────────────────────────────────────────────────────────────────────
import {
  usePipTile,
  useMergedVideoRef,
  useCallPopout,
  isPopoutSupported,
} from "@/components/Room/popout";

interface VoiceVideoBarProps {
  roomId: string;
}

/** Resolved per-participant view model shared across the render modes. */
interface CallParticipant {
  /** LiveKit identity ("agent-majik", a user id, or "local" for self). */
  id: string;
  sid: string;
  name: string;
  isAgent: boolean;
  isLocal: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  /** Camera track if publishing one, else null. */
  videoTrack: LocalTrack | RemoteTrack | null;
}

/** Resolved screen-share tile model: video + its sibling screen audio (if any). */
interface ScreenShareVM {
  sid: string;
  label: string;
  videoTrack: LocalTrack | RemoteTrack;
  /**
   * The sibling `screen_share_audio` track, when a remote sharer captured audio
   * (local share isn't looped back to self → null). Owned by the tile via
   * claim/release against VoiceProvider (SCREENAUDIO-NOTE / audit §4b).
   */
  audioTrack: RemoteAudioTrack | null;
}

/**
 * A ref callback that attaches a LiveKit track to a media element and detaches
 * on cleanup. Element-agnostic (`HTMLMediaElement`) so the same discipline
 * drives both tile `<video>` and screen-audio `<audio>` (audit §4b).
 */
type AttachRef = (el: HTMLMediaElement | null) => (() => void) | void;
const NOOP_REF: AttachRef = () => undefined;

/**
 * Returns a STABLE callback-ref per track that attaches it to the tile's media
 * element and detaches on cleanup. Stability matters: a fresh ref function each
 * render would make React detach+reattach the track every render (flicker), so
 * we cache one callback per track object. Tracks are stable across renders until
 * the publication set changes (see VoiceProvider.version).
 *
 * `track.attach(el)` accepts a media element from ANY document, so the SAME
 * cached callback correctly re-attaches when a tile subtree is portaled into a
 * pop-out window (audit §4a: exactly-one-place-at-a-time keeps attach/detach
 * balanced).
 */
function useAttachTrack(): (track: LocalTrack | RemoteTrack | null) => AttachRef {
  const cache = useRef(new Map<LocalTrack | RemoteTrack, AttachRef>());
  return useCallback((track) => {
    if (!track) return NOOP_REF;
    const existing = cache.current.get(track);
    if (existing) return existing;
    const ref: AttachRef = (el) => {
      if (el) {
        track.attach(el);
        return () => {
          track.detach(el);
        };
      }
    };
    cache.current.set(track, ref);
    return ref;
  }, []);
}

/* ------------------------------------------------------------------ *
 * Fullscreen — per-tile, cross-vendor (standard + webkit for Safari).
 * ------------------------------------------------------------------ */

type FullscreenDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

interface FullscreenController {
  ref: (el: HTMLDivElement | null) => void;
  isFullscreen: boolean;
  supported: boolean;
  toggle: () => void;
}

function useFullscreen(): FullscreenController {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supported =
    typeof document !== "undefined" &&
    (document.fullscreenEnabled ||
      !!(document as FullscreenDoc).webkitFullscreenEnabled);

  useEffect(() => {
    const onChange = () => {
      const doc = document as FullscreenDoc;
      const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setIsFullscreen(!!elRef.current && fsEl === elRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange as EventListener);
    };
  }, []);

  const toggle = useCallback(() => {
    const el = elRef.current as FullscreenEl | null;
    if (!el) return;
    const doc = document as FullscreenDoc;
    const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    void (async () => {
      try {
        if (fsEl === el) {
          await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
        } else {
          await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
        }
      } catch (e) {
        console.error("fullscreen toggle failed", e);
      }
    })();
  }, []);

  const ref = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);

  return { ref, isFullscreen, supported, toggle };
}

/* ------------------------------------------------------------------ *
 * Tile hover-control button (pin / fullscreen / PiP / hide / mute).
 * ------------------------------------------------------------------ */

interface TileControlButtonProps {
  icon: LucideIcon;
  label: string;
  /**
   * Longer hover tooltip when the terse `label` (which stays the accessible
   * name) needs disambiguating — e.g. Picture-in-Picture vs. the call bar's
   * "Pop out to window", two similar-looking controls that do different things.
   */
  title?: string;
  onClick: (e: ReactMouseEvent) => void;
  active?: boolean;
}

function TileControlButton({
  icon: Icon,
  label,
  title,
  onClick,
  active,
}: TileControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      className={clsx(
        "glass focus-ring flex h-6 w-6 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-white",
        active && "text-stable-purple-light ring-1 ring-stable-purple/60",
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * ParticipantTile — one camera/avatar tile with the full interaction set.
 * ------------------------------------------------------------------ */

interface ParticipantTileProps {
  p: CallParticipant;
  /** Attach ref for the camera track (present only when a video should show). */
  videoRef?: AttachRef;
  /** Event-driven speaking state (active-speaker OR isSpeaking). */
  speaking: boolean;
  size?: "normal" | "large";
  /** Fill the container (big-stage tiles) rather than a fixed 16:9 box. */
  fill?: boolean;
  hidden?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onToggleHide?: () => void;
  onClick?: () => void;
  /** Show the drag-reorder grip affordance (grid tiles). */
  showGrip?: boolean;
}

function ParticipantTile({
  p,
  videoRef,
  speaking,
  size = "normal",
  fill = false,
  hidden,
  isPinned,
  onTogglePin,
  onToggleHide,
  onClick,
  showGrip,
}: ParticipantTileProps) {
  const pip = usePipTile();
  const fs = useFullscreen();
  const initial = p.name.charAt(0).toUpperCase();
  const showVideoEl = !!videoRef && !hidden;
  const ident = identityFor(p.id.replace(/^agent-/, ""), p.name);
  // Compose the LiveKit attach ref with the PiP ref on ONE <video> (audit §4a).
  // useMergedVideoRef memoizes internally (CONTRACT §3.1) so the track isn't
  // detached+reattached every render; safe to call unconditionally with an
  // undefined attach ref (the <video> only renders when showVideoEl anyway).
  const composedVideoRef = useMergedVideoRef(videoRef, pip.videoRef);

  // Pinned wins (purple) over the identity-hued speaking glow.
  const ringStyle: CSSProperties | undefined = isPinned
    ? {
        boxShadow:
          "0 0 0 2px var(--color-stable-purple), 0 0 18px -2px var(--color-stable-purple)",
      }
    : speaking
      ? { boxShadow: `0 0 0 2px ${ident.ring}, 0 0 16px -4px ${ident.ring}` }
      : undefined;

  return (
    <div
      ref={fs.ref}
      onClick={onClick}
      className={clsx(
        "group relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface-1/80 transition-all",
        fs.isFullscreen ? "h-full" : fill ? "h-full" : "aspect-video",
        onClick && "cursor-pointer",
      )}
      style={ringStyle}
    >
      {showVideoEl ? (
        <video
          ref={composedVideoRef}
          autoPlay
          playsInline
          muted
          className={clsx(
            "h-full w-full",
            fs.isFullscreen ? "object-contain" : "object-cover",
          )}
        />
      ) : (
        <div
          className={clsx(
            "flex items-center justify-center rounded-full font-semibold text-white/95",
            size === "large"
              ? "h-24 w-24 text-3xl"
              : "h-14 w-14 text-lg sm:h-16 sm:w-16",
            speaking && !p.isMuted && "animate-pulse-soft",
          )}
          style={{
            background: ident.gradient,
            boxShadow: speaking ? `0 0 0 2px ${ident.ring}` : undefined,
          }}
        >
          {p.isAgent ? (
            <Bot className={size === "large" ? "h-12 w-12" : "h-7 w-7"} />
          ) : (
            initial
          )}
        </div>
      )}

      {/* Name plate. */}
      <span className="glass absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-md px-2 py-0.5 text-xs font-medium text-slate-100">
        {p.name}
      </span>

      {/* Persistent pin marker, OR a drag grip on hover (grid tiles). */}
      {isPinned ? (
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-stable-purple/30 px-1.5 py-0.5 text-[10px] font-semibold text-stable-purple-light ring-1 ring-stable-purple/50">
          <Pin className="h-2.5 w-2.5" />
          Pinned
        </span>
      ) : showGrip ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/40 p-0.5 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100"
          title="Drag to reorder"
        >
          <GripVertical className="h-3 w-3" />
        </span>
      ) : null}

      {/* Status (bottom-right): muted OR speaking. */}
      {p.isMuted && (
        <div className="absolute bottom-1.5 right-1.5 rounded-full bg-rose-500/80 p-1">
          <MicOff className="h-3 w-3 text-white" />
        </div>
      )}
      {speaking && !p.isMuted && (
        <div className="absolute bottom-1.5 right-1.5 rounded-full bg-stable-mint/90 p-1">
          <Volume2 className="h-3 w-3 text-slate-950" />
        </div>
      )}

      {/* Hover control cluster (top-right): pin · fullscreen · PiP · hide. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
        {onTogglePin && (
          <TileControlButton
            icon={isPinned ? PinOff : Pin}
            label={isPinned ? `Unpin ${p.name}` : `Pin ${p.name} to the big tile`}
            active={isPinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
          />
        )}
        {fs.supported && (
          <TileControlButton
            icon={fs.isFullscreen ? Minimize : Maximize}
            label={fs.isFullscreen ? "Exit full screen" : "Full screen"}
            active={fs.isFullscreen}
            onClick={(e) => {
              e.stopPropagation();
              fs.toggle();
            }}
          />
        )}
        {pip.supported && p.videoTrack && (
          <TileControlButton
            icon={PictureInPicture2}
            label="Picture in picture"
            title="Picture in picture — float just this video in a small always-on-top thumbnail (use the call bar’s “Pop out to window” for a full second window)"
            active={pip.isActive}
            onClick={(e) => {
              e.stopPropagation();
              void pip.toggle();
            }}
          />
        )}
        {onToggleHide && p.videoTrack && (
          <TileControlButton
            icon={hidden ? Eye : EyeOff}
            label={hidden ? `Show ${p.name} video` : `Hide ${p.name} video`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHide();
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ScreenShareTile — screen video + (NEW) its own audio + per-share mute.
 * ------------------------------------------------------------------ */

interface ScreenShareTileProps {
  label: string;
  videoRef: AttachRef;
  /**
   * The sibling `screen_share_audio` track (audit §4b). The tile mounts its OWN
   * un-muted <audio> for it and CLAIMS ownership from VoiceProvider's global
   * sink (claim → the provider detaches its sink element so audio plays here
   * once, not twice; release on unmount → the provider re-attaches the sink so
   * audio-only / compact listeners keep hearing it). This is the claim-handoff
   * VoiceProvider exposes (SCREENAUDIO-NOTE), which is strictly better than the
   * audit's naive "always tile-owned" sketch (that regressed compact/audio-only
   * to silence). Because the <audio> lives in the tile subtree, it follows the
   * tile into a pop-out portal for free.
   */
  audioTrack?: RemoteAudioTrack | null;
  /** User's per-share mute of the screen audio (element property, not attach). */
  muted?: boolean;
  onToggleMuted?: () => void;
  fill?: boolean;
  onClick?: () => void;
}

function ScreenShareTile({
  label,
  videoRef,
  audioTrack,
  muted,
  onToggleMuted,
  fill = false,
  onClick,
}: ScreenShareTileProps) {
  const { claimScreenAudio, releaseScreenAudio } = useStableRoom();
  const pip = usePipTile();
  const fs = useFullscreen();
  const composedVideoRef = useMergedVideoRef(videoRef, pip.videoRef);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const hasAudio = !!audioTrack;

  // Own the screen audio while mounted: attach to our <audio> + claim it from
  // the global sink; detach + release on unmount / track change. Effect-keyed on
  // the track so a stage switch (focus→grid→sidebar) or a move into the pop-out
  // hands ownership tile→tile with no gap and no doubling (the provider defers
  // the sink re-attach one microtask so the new claim cancels it).
  useEffect(() => {
    const el = audioElRef.current;
    if (!el || !audioTrack) return;
    audioTrack.attach(el);
    claimScreenAudio(audioTrack);
    return () => {
      audioTrack.detach(el);
      releaseScreenAudio(audioTrack);
    };
  }, [audioTrack, claimScreenAudio, releaseScreenAudio]);

  // Per-share mute is a media-element property — never gate the attach on it.
  useEffect(() => {
    if (audioElRef.current) audioElRef.current.muted = !!muted;
  }, [muted]);

  return (
    <div
      ref={fs.ref}
      onClick={onClick}
      className={clsx(
        "group relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-stable-cyan/30 bg-slate-950/80 ring-1 ring-stable-cyan/20",
        fs.isFullscreen ? "h-full" : fill ? "h-full" : "aspect-video",
        onClick && "cursor-pointer",
      )}
    >
      <video
        ref={composedVideoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full bg-black object-contain"
      />

      {/* Screen audio: un-muted media element (the video above stays muted).
          Autoplay is covered by the existing "Tap to hear" banner — the Room
          registers this element via track.attach(). */}
      {hasAudio && (
        <audio ref={audioElRef} autoPlay playsInline className="hidden" />
      )}

      <div className="glass absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-stable-cyan">
        <MonitorUp className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>

      {/* Hover controls: mute (if audio) · fullscreen · PiP. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
        {hasAudio && onToggleMuted && (
          <TileControlButton
            icon={muted ? VolumeX : Volume2}
            label={muted ? "Unmute screen audio" : "Mute screen audio"}
            active={muted}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMuted();
            }}
          />
        )}
        {fs.supported && (
          <TileControlButton
            icon={fs.isFullscreen ? Minimize : Maximize}
            label={fs.isFullscreen ? "Exit full screen" : "Full screen"}
            active={fs.isFullscreen}
            onClick={(e) => {
              e.stopPropagation();
              fs.toggle();
            }}
          />
        )}
        {pip.supported && (
          <TileControlButton
            icon={PictureInPicture2}
            label="Picture in picture"
            title="Picture in picture — float just this video in a small always-on-top thumbnail (use the call bar’s “Pop out to window” for a full second window)"
            active={pip.isActive}
            onClick={(e) => {
              e.stopPropagation();
              void pip.toggle();
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * AudioChip — compact avatar chip with a speaking ring (no video).
 * ------------------------------------------------------------------ */

interface AudioChipProps {
  id: string;
  name: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
}

function AudioChip({ id, name, isAgent, isSpeaking, isMuted }: AudioChipProps) {
  const initial = name.charAt(0).toUpperCase();
  const ident = identityFor(id.replace(/^agent-/, ""), name);
  return (
    <div
      className={clsx(
        "relative flex shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 transition-all",
        !isSpeaking && "border-transparent bg-surface-2/70",
      )}
      style={
        isSpeaking ? { background: ident.faint, borderColor: ident.ring } : undefined
      }
    >
      <div
        className={clsx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white/95",
          isSpeaking && !isMuted && "animate-pulse-soft",
        )}
        style={{ background: ident.gradient }}
      >
        {isAgent ? <Bot className="h-4 w-4" /> : initial}
      </div>
      <span className="max-w-[10ch] truncate text-xs font-medium text-slate-200">
        {name}
      </span>
      {isMuted && <MicOff className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
    </div>
  );
}

/** Placeholder shown in the main window while the stage is popped out. */
function PoppedOutPlaceholder({ onBringBack }: { onBringBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line bg-surface-1/60 p-6 text-center">
      <ExternalLink className="h-6 w-6 text-stable-purple-light" />
      <p className="text-sm font-medium text-slate-200">
        The video is playing in a pop-out window.
      </p>
      <button
        type="button"
        onClick={onBringBack}
        className="focus-ring rounded-lg bg-stable-purple/20 px-3 py-1.5 text-xs font-semibold text-stable-purple-light transition-colors hover:bg-stable-purple/30"
      >
        Bring it back
      </button>
    </div>
  );
}

/* ================================================================== *
 * VoiceVideoBar — the call stage.
 * ================================================================== */

export function VoiceVideoBar({ roomId }: VoiceVideoBarProps) {
  const {
    room,
    localParticipant,
    remoteParticipants,
    isConnected,
    isConnecting,
    audioBlocked,
    version,
    startAudio,
    disconnect,
  } = useStableRoom(roomId);

  // Call-UI state.
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const showVideo = useCallUiStore((s) => s.showVideo);
  const toggleVideo = useCallUiStore((s) => s.toggleVideo);
  const showTranscript = useCallUiStore((s) => s.showTranscript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);
  const chatCollapsed = useCallUiStore((s) => s.chatCollapsed);
  const setChatCollapsed = useCallUiStore((s) => s.setChatCollapsed);
  const hiddenTileIds = useCallUiStore((s) => s.hiddenTileIds);
  const setTileHidden = useCallUiStore((s) => s.setTileHidden);
  const focusedParticipantId = useCallUiStore((s) => s.focusedParticipantId);
  const pinnedId = useCallUiStore((s) => s.pinnedParticipantId[roomId] ?? null);
  const setPopoutOpen = useCallUiStore((s) => s.setPopoutOpen);
  const videoPrompted = useCallUiStore((s) => s.videoPrompted);
  const setVideoPrompted = useCallUiStore((s) => s.setVideoPrompted);

  // Real Brigade roster — label/detect agent participants by "agent-<id>".
  const { data: brigadeAgents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
  });

  const matchAgent = useCallback(
    (identity: string): BrigadeAgent | undefined => {
      const slug = identity.replace(/^agent-/, "");
      return brigadeAgents.find(
        (a) => a.id === slug || slug.includes(a.id) || identity.includes(a.id),
      );
    },
    [brigadeAgents],
  );

  const attachTrack = useAttachTrack();

  const getCameraTrack = useCallback(
    (
      pubs: {
        kind: string;
        track?: LocalTrack | RemoteTrack | undefined;
        source: string;
      }[],
    ): LocalTrack | RemoteTrack | null => {
      const pub = pubs.find(
        (t) => t.kind === "video" && t.track && t.source === "camera",
      );
      return pub?.track ?? null;
    },
    [],
  );

  // Unified participant list (self first), resolved each `version` bump.
  const participants = useMemo<CallParticipant[]>(() => {
    const out: CallParticipant[] = [];
    if (localParticipant) {
      out.push({
        id: "local",
        sid: localParticipant.sid,
        name: "You",
        isAgent: false,
        isLocal: true,
        isSpeaking: localParticipant.isSpeaking,
        isMuted: !localParticipant.isMicrophoneEnabled,
        videoTrack: getCameraTrack(
          Array.from(localParticipant.trackPublications.values()),
        ),
      });
    }
    for (const p of remoteParticipants) {
      const agent = matchAgent(p.identity);
      out.push({
        id: p.identity,
        sid: p.sid,
        name: agent?.name || p.name || p.identity,
        isAgent: !!agent,
        isLocal: false,
        isSpeaking: p.isSpeaking,
        isMuted: !p.isMicrophoneEnabled,
        videoTrack: getCameraTrack(Array.from(p.trackPublications.values())),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, remoteParticipants, version, matchAgent, getCameraTrack]);

  // Event-driven active-speaker signal. LiveKit's `isSpeaking` flips WITHOUT a
  // `version` bump (VoiceProvider doesn't sync on speaking), so subscribe to the
  // SFU-ranked ActiveSpeakersChanged directly for a reliable, ordered signal.
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<string[]>([]);
  useEffect(() => {
    if (!room) {
      setActiveSpeakerIds([]);
      return;
    }
    const onSpeakers = (speakers: Participant[]) => {
      setActiveSpeakerIds(speakers.map((s) => (s.isLocal ? "local" : s.identity)));
    };
    onSpeakers(room.activeSpeakers ?? []);
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room]);

  // Who to glow, event-driven (active-speaker set ∪ per-participant isSpeaking).
  const speakingIds = useMemo(() => {
    const set = new Set<string>(activeSpeakerIds);
    for (const p of participants) if (p.isSpeaking) set.add(p.id);
    return set;
  }, [activeSpeakerIds, participants]);

  // Debounced spotlight promotion: only promote a NEW top speaker after they've
  // held the floor ~2s (a cough/"mm-hmm" must not yank the big tile); silence
  // keeps the current one. A pin or manual focus (below) wins immediately.
  const liveSpeakerId =
    activeSpeakerIds[0] ?? participants.find((p) => p.isSpeaking)?.id ?? null;
  const [stableSpeakerId, setStableSpeakerId] = useState<string | null>(null);
  useEffect(() => {
    if (liveSpeakerId === null || liveSpeakerId === stableSpeakerId) return;
    const t = setTimeout(() => setStableSpeakerId(liveSpeakerId), 2000);
    return () => clearTimeout(t);
  }, [liveSpeakerId, stableSpeakerId]);

  // Screen-shares (local + remote): video + sibling screen audio (audit §4b).
  const screenShares = useMemo<ScreenShareVM[]>(() => {
    const out: ScreenShareVM[] = [];
    if (localParticipant) {
      const pubs = Array.from(localParticipant.trackPublications.values());
      const v = pubs.find(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      // Local screen audio isn't looped back to self → audioTrack is null.
      if (v?.track)
        out.push({ sid: "local-screen", label: "You — screen", videoTrack: v.track, audioTrack: null });
    }
    for (const p of remoteParticipants) {
      const pubs = Array.from(p.trackPublications.values());
      const v = pubs.find(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      if (v?.track) {
        const agent = matchAgent(p.identity);
        const a = pubs.find(
          (t) =>
            t.kind === "audio" && t.track && t.source === "screen_share_audio",
        );
        out.push({
          sid: p.sid,
          label: `${agent?.name || p.name || p.identity} — screen`,
          videoTrack: v.track,
          // Remote screen_share_audio is a RemoteAudioTrack; source-string
          // narrowing isn't reflected in the publication type, so cast.
          audioTrack: (a?.track as RemoteAudioTrack | undefined) ?? null,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, remoteParticipants, version, matchAgent]);

  const hasAnyVideo = useMemo(
    () => participants.some((p) => p.videoTrack) || screenShares.length > 0,
    [participants, screenShares],
  );

  // Session-local tile order for drag-to-reorder (Gallery). Reconciled against
  // the live roster: departed ids drop, new ids append.
  const [order, setOrder] = useState<string[]>([]);
  const idsKey = participants.map((p) => p.id).join("|");
  useEffect(() => {
    const ids = participants.map((p) => p.id);
    setOrder((prev) => {
      const known = new Set(prev);
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !known.has(id));
      const next = [...kept, ...added];
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) {
        return prev;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const orderedParticipants = useMemo(() => {
    const byId = new Map(participants.map((p) => [p.id, p] as const));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((p): p is CallParticipant => !!p);
    // Any not-yet-ordered (first render before the effect) go to the end.
    if (ordered.length !== participants.length) {
      const seen = new Set(order);
      for (const p of participants) if (!seen.has(p.id)) ordered.push(p);
    }
    return ordered;
  }, [order, participants]);

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      setOrder((prev) => {
        const base = prev.length ? [...prev] : participants.map((p) => p.id);
        const fi = base.indexOf(fromId);
        const ti = base.indexOf(toId);
        if (fi < 0 || ti < 0) return prev;
        base.splice(fi, 1);
        base.splice(ti, 0, fromId);
        return base;
      });
    },
    [participants],
  );

  // Per-share screen-audio mute (session-local, keyed by screen sid).
  const [mutedScreens, setMutedScreens] = useState<Set<string>>(new Set());
  const toggleScreenMuted = useCallback((sid: string) => {
    setMutedScreens((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }, []);

  // Presentation mode: which screen share fills the stage (others → filmstrip).
  const [stageScreenSid, setStageScreenSid] = useState<string | null>(null);

  // Whole-stage pop-out (human-only; window.open needs a user gesture + desktop).
  // Gate on BOTH desktop and the module's feature-detect (CONTRACT §3.5).
  const isDesktop = useIsDesktop();
  const popoutSupported = isDesktop && isPopoutSupported();

  // Popping out from the audio-compact default has to lift the view into the
  // video stage (that's what the pop-out shows). `setViewMode` PERSISTS to
  // localStorage, so without this the single act of popping out would silently
  // and permanently rewrite the user's saved view mode for the room. Remember
  // what we changed and put it back when the window closes — by our button OR
  // by the user closing the OS window, which is why the restore lives in the
  // `onClose` callback rather than in `bringBackPopout`.
  const popoutPriorViewRef = useRef<{
    mode: CallViewMode;
    showVideo: boolean;
  } | null>(null);

  const restorePrePopoutView = useCallback(() => {
    const prior = popoutPriorViewRef.current;
    popoutPriorViewRef.current = null;
    if (!prior) return;
    const s = useCallUiStore.getState();
    // Only undo what is still OURS. If the user picked a different view while
    // popped out, that's a deliberate choice and it wins.
    if ((s.viewModes[roomId] ?? DEFAULT_CALL_VIEW_MODE) === "grid") {
      s.setViewMode(roomId, prior.mode);
    }
    if (s.showVideo && !prior.showVideo) s.toggleVideo(false);
  }, [roomId]);

  const popout = useCallPopout({
    onClose: () => {
      setPopoutOpen(roomId, false);
      restorePrePopoutView();
    },
  });

  // Audio-first / video-off shows chips; the video modes show tiles.
  const showChips = viewMode === "compact" || !showVideo;
  // The user's "video section" is hidden whenever no video stage is on screen —
  // whether because video is toggled off (showVideo) OR the audio-compact mode
  // is selected. This is exactly `showChips`; naming it makes the hide/show
  // control below read clearly. It drives the SAME `showVideo` flag the
  // ViewModeSwitcher's (removed) toggle used, so the two can't disagree.
  const videoHidden = showChips;

  // A popped-out stage makes no sense once we're back in chips; auto-close it.
  // NOTE: `openPopout` lifts out of chips in the SAME click (batched with the
  // open), so opening from the default compact view does not trip this.
  useEffect(() => {
    if (popout.isOpen && showChips) {
      popout.close();
      setPopoutOpen(roomId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChips, popout.isOpen]);

  // Optional-video nudge: someone turned a camera on while in audio compact.
  useEffect(() => {
    if (hasAnyVideo && viewMode === "compact" && !videoPrompted) {
      setVideoPrompted(true);
    } else if (!hasAnyVideo && videoPrompted) {
      setVideoPrompted(false);
    }
  }, [hasAnyVideo, viewMode, videoPrompted, setVideoPrompted]);

  if (!isConnected && !isConnecting) {
    return null;
  }

  if (!room) {
    return (
      <div className="flex items-center justify-between border-b border-line bg-surface-1/70 px-4 py-2 backdrop-blur-md">
        <span className="animate-shimmer text-sm font-medium">
          Connecting to the call…
        </span>
        <button
          onClick={disconnect}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
          aria-label="Cancel call"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>
    );
  }

  const isMicOn = localParticipant?.isMicrophoneEnabled ?? false;
  const isCamOn = localParticipant?.isCameraEnabled ?? false;
  const poppedOut = popout.isOpen;

  async function toggleMic() {
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!isMicOn);
  }
  async function toggleCam() {
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!isCamOn);
  }
  function openPopout() {
    // The pop-out shows the VIDEO STAGE, which the audio-compact default view
    // doesn't render — so lift out of chips as part of the same click instead
    // of hiding the control (which is why users concluded it didn't exist).
    // The lift is batched with this click, so by the time the auto-close effect
    // runs `showChips` is already false and it does not immediately re-close.
    // Synchronous in the click handler — no await before .open() (audit §5).
    // `open()` returns false when the popup was blocked; `popout.error` then
    // drives the visible banner, so we must NOT claim the stage is detached
    // (and must not disturb the user's view mode for a window that never
    // opened).
    if (!popout.open()) return;
    if (showChips) {
      // Record the pre-pop-out view BEFORE mutating it so closing the window
      // restores it (setViewMode persists — see `popoutPriorViewRef`).
      popoutPriorViewRef.current = { mode: viewMode, showVideo };
      toggleVideo(true);
      if (viewMode === "compact") setViewMode(roomId, "grid");
    }
    setPopoutOpen(roomId, true);
  }
  function bringBackPopout() {
    // `close()` runs the handle's teardown synchronously, which fires the
    // `onClose` above → `restorePrePopoutView()`. No second restore here.
    popout.close();
    setPopoutOpen(roomId, false);
  }

  // Big-tile resolution: durable PIN > agent FOCUS > debounced active speaker >
  // first remote > self (audit §4c).
  const focused =
    participants.find((p) => p.id === pinnedId) ??
    participants.find((p) => p.id === focusedParticipantId) ??
    (stableSpeakerId
      ? participants.find((p) => p.id === stableSpeakerId)
      : undefined) ??
    participants.find((p) => !p.isLocal) ??
    participants[0];

  const stageScreen =
    screenShares.find((s) => s.sid === stageScreenSid) ?? screenShares[0] ?? null;

  // ---- Tile builders --------------------------------------------------------

  function renderTile(
    p: CallParticipant,
    opts?: { size?: "normal" | "large"; onClick?: () => void; grip?: boolean; fill?: boolean },
  ) {
    const hidden = hiddenTileIds.has(p.id);
    const trackVisible = !showChips && !hidden && !!p.videoTrack;
    const isPinned = pinnedId === p.id;
    return (
      <ParticipantTile
        key={p.id}
        p={p}
        size={opts?.size ?? "normal"}
        fill={opts?.fill}
        hidden={hidden}
        speaking={speakingIds.has(p.id)}
        isPinned={isPinned}
        onClick={opts?.onClick}
        showGrip={!!opts?.grip}
        videoRef={trackVisible ? attachTrack(p.videoTrack) : undefined}
        onTogglePin={() =>
          uiCommandBus.pinParticipant(roomId, isPinned ? null : p.id)
        }
        onToggleHide={
          p.videoTrack ? () => setTileHidden(p.id, !hidden) : undefined
        }
      />
    );
  }

  function renderScreen(s: ScreenShareVM, opts?: { fill?: boolean; onClick?: () => void }) {
    return (
      <ScreenShareTile
        key={s.sid}
        label={s.label}
        fill={opts?.fill}
        onClick={opts?.onClick}
        videoRef={attachTrack(s.videoTrack)}
        audioTrack={s.audioTrack}
        muted={mutedScreens.has(s.sid)}
        onToggleMuted={s.audioTrack ? () => toggleScreenMuted(s.sid) : undefined}
      />
    );
  }

  // ---- The stage surface (the pop-out-able tiles), per mode -----------------

  let stageSurface: ReactNode = null;
  if (!showChips) {
    if (viewMode === "grid") {
      // Gallery: equal, paginated, drag-to-reorder tiles.
      stageSurface = (
        <VideoGrid
          onReorder={reorder}
          items={[
            ...orderedParticipants.map((p) => ({
              key: p.id,
              draggable: true,
              node: renderTile(p, { grip: true }),
            })),
            ...screenShares.map((s) => ({
              key: `screen:${s.sid}`,
              node: renderScreen(s),
            })),
          ]}
        />
      );
    } else if (viewMode === "focus" || viewMode === "spotlight") {
      // Speaker / Spotlight: one big tile + a filmstrip of the rest.
      stageSurface = (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1">
            {focused && renderTile(focused, { size: "large", fill: true })}
          </div>
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
            {screenShares.map((s) => (
              <div key={s.sid} className="w-40 shrink-0">
                {renderScreen(s, {
                  onClick: () => {
                    setStageScreenSid(s.sid);
                    setViewMode(roomId, "screen");
                  },
                })}
              </div>
            ))}
            {orderedParticipants
              .filter((p) => p.id !== focused?.id)
              .map((p) => (
                <div key={p.id} className="w-32 shrink-0">
                  {renderTile(p, {
                    onClick: () => uiCommandBus.pinParticipant(roomId, p.id),
                  })}
                </div>
              ))}
          </div>
        </div>
      );
    } else if (viewMode === "sidebar") {
      // Co-working dock: a single vertical column of tiles.
      stageSurface = (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {screenShares.map((s) => renderScreen(s))}
          {orderedParticipants.map((p) => renderTile(p))}
        </div>
      );
    } else if (viewMode === "screen") {
      // Presentation: a screen share fills the stage + a people filmstrip.
      stageSurface = stageScreen ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1">{renderScreen(stageScreen, { fill: true })}</div>
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
            {screenShares
              .filter((s) => s.sid !== stageScreen.sid)
              .map((s) => (
                <div key={s.sid} className="w-40 shrink-0">
                  {renderScreen(s, { onClick: () => setStageScreenSid(s.sid) })}
                </div>
              ))}
            {orderedParticipants.map((p) => (
              <div key={p.id} className="w-32 shrink-0">
                {renderTile(p)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        // No screen yet — keep the stage useful (hint + a gallery fallback).
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="glass flex shrink-0 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-300">
            <MonitorUp className="h-3.5 w-3.5 text-stable-cyan" />
            No one is sharing a screen yet — start one from the controls.
          </div>
          <VideoGrid
            items={orderedParticipants.map((p) => ({ key: p.id, node: renderTile(p) }))}
          />
        </div>
      );
    }
  }

  const chipsRow = (
    <div className="flex flex-1 items-center gap-2 overflow-x-auto py-1">
      {participants.map((p) => (
        <AudioChip
          key={p.id}
          id={p.id}
          name={p.name}
          isAgent={p.isAgent}
          isSpeaking={speakingIds.has(p.id)}
          isMuted={p.isMuted}
        />
      ))}
    </div>
  );

  const controls = (
    <div className="glass flex shrink-0 items-center justify-center gap-1.5 rounded-2xl p-1.5">
      <button
        onClick={toggleMic}
        className={clsx(
          "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
          isMicOn
            ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
            : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
        )}
        aria-label={isMicOn ? "Mute" : "Unmute"}
      >
        {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button
        onClick={toggleCam}
        className={clsx(
          "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
          isCamOn
            ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
            : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
        )}
        aria-label={isCamOn ? "Turn off camera" : "Turn on camera"}
      >
        {isCamOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>

      {/* Hide / show the VIDEO section — the single, canonical control for it
          (the ViewModeSwitcher's old duplicate video toggle was removed so the
          two can't disagree). Hidden ⇒ audio-only: a slim bar keeps THESE
          controls and the chat fills the screen. It drives `showVideo`; "show"
          also lifts audio-compact into Gallery so a stage actually appears.
          This is the discoverable half of "use the whole screen for just the
          one I'm using." */}
      <button
        onClick={() => {
          if (videoHidden) {
            toggleVideo(true);
            if (viewMode === "compact") setViewMode(roomId, "grid");
          } else {
            toggleVideo(false);
          }
        }}
        className={clsx(
          "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-transparent transition-colors active:scale-[0.98]",
          !videoHidden
            ? "text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
            : "bg-stable-purple/20 text-stable-purple-light hover:bg-stable-purple/30",
        )}
        aria-label={videoHidden ? "Show video" : "Hide video"}
        aria-pressed={videoHidden}
        title={
          videoHidden
            ? "Show the video"
            : "Hide the video — audio only, chat fills the screen"
        }
      >
        {videoHidden ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>

      {/* Hide / show the CHAT section. Hidden ⇒ the video fills the screen. Only
          in the video-stage arrangement, where chat is the collapsible side
          pane (mirrors the divider's collapse chevron via `chatCollapsed`). */}
      {!showChips && viewMode !== "sidebar" && (
        <button
          onClick={() => setChatCollapsed()}
          className={clsx(
            "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-transparent transition-colors active:scale-[0.98]",
            !chatCollapsed
              ? "text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
              : "bg-stable-purple/20 text-stable-purple-light hover:bg-stable-purple/30",
          )}
          aria-label={chatCollapsed ? "Show chat" : "Hide chat"}
          aria-pressed={chatCollapsed}
          title={
            chatCollapsed
              ? "Show the chat"
              : "Hide the chat — video fills the screen"
          }
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}

      {/* Pop the video stage out into a REAL separate OS window you can drag to
          another monitor (desktop only — `popoutSupported` already folds in
          `useIsDesktop()`, so this never renders on touch).

          Deliberately NOT gated on `!showChips` any more: the default view IS
          audio-compact, so that gate hid the feature entirely and users
          concluded it didn't exist. `openPopout` lifts the view out of chips
          itself.

          Distinct from the per-tile `PictureInPicture2` control, which floats
          ONE video into the small always-on-top OS PiP thumbnail. Labels and
          tooltips on both spell the difference out. */}
      {popoutSupported && (
        <button
          onClick={poppedOut ? bringBackPopout : openPopout}
          className={clsx(
            "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-transparent transition-colors active:scale-[0.98]",
            poppedOut
              ? "bg-stable-purple/20 text-stable-purple-light hover:bg-stable-purple/30"
              : "text-slate-200 hover:bg-white/[0.06] hover:text-slate-100",
          )}
          aria-label={
            poppedOut
              ? "Bring the call back into this window"
              : "Pop out to window"
          }
          aria-pressed={poppedOut}
          title={
            poppedOut
              ? "Bring the video back into this window"
              : "Pop out to window — opens the video in a separate window you can move to another monitor"
          }
        >
          <ExternalLink className="h-5 w-5" />
        </button>
      )}

      <button
        onClick={disconnect}
        className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
        aria-label="End call"
      >
        <PhoneOff className="h-5 w-5" />
      </button>
    </div>
  );

  // Slim single-row layout: audio compact with no transcript. An open transcript
  // needs vertical room, so fall back to the column layout even in compact.
  const slim = viewMode === "compact" && !showTranscript;

  return (
    <div className="flex h-full flex-col">
      {audioBlocked && (
        <button
          onClick={() => void startAudio()}
          className="focus-ring flex w-full shrink-0 items-center justify-center gap-2 border-b border-amber-400/20 bg-amber-400/15 px-4 py-2 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-400/25"
        >
          <Volume2 className="h-4 w-4" />
          Tap to hear the call
        </button>
      )}

      {/* Pop-out blocked. `window.open` returning null is the browser's ONLY
          signal and it is otherwise invisible — without this banner the button
          appears to do nothing at all. Actionable: says what to change, and
          retries in a fresh user gesture. */}
      {popout.error && (
        <div
          role="alert"
          className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-400/20 bg-amber-400/15 px-4 py-2 text-sm text-amber-200"
        >
          <span className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 shrink-0" />
            {popout.error === "blocked"
              ? "Your browser blocked the pop-out window. Allow pop-ups for this site, then try again."
              : "This browser can’t open a separate call window."}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {popout.error === "blocked" && (
              <button
                type="button"
                onClick={openPopout}
                className="focus-ring rounded-md bg-amber-400/20 px-2 py-0.5 text-xs font-semibold transition-colors hover:bg-amber-400/30"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={popout.clearError}
              className="focus-ring rounded-md px-1.5 py-0.5 text-xs text-amber-200/70 transition-colors hover:text-amber-100"
              aria-label="Dismiss the pop-out warning"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {/* Agent working-state orb (listening / thinking / speaking). */}
      <VoiceAgentStatus />

      {/* Non-forcing prompt: someone turned a camera on while in audio compact. */}
      {videoPrompted && slim && hasAnyVideo && (
        <div className="flex w-full shrink-0 items-center justify-between gap-2 border-b border-stable-cyan/20 bg-stable-cyan/15 px-4 py-1.5 text-xs text-stable-cyan">
          <span className="flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5" />
            Someone turned their camera on.
          </span>
          <span className="flex items-center gap-1">
            <button
              onClick={() => setViewMode(roomId, "grid")}
              className="focus-ring rounded-md bg-stable-cyan/20 px-2 py-0.5 font-semibold transition-colors hover:bg-stable-cyan/30"
            >
              Show video
            </button>
            <button
              onClick={() => setVideoPrompted(false)}
              className="focus-ring rounded-md px-1.5 py-0.5 text-slate-400 transition-colors hover:text-slate-200"
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {/* Pop-out host: portals the LIVE stage tiles into the detached window when
          open (renders null in the main tree otherwise). Mounted once so tiles
          move main↔popout with balanced attach/detach (audit §4a). The Host
          clones stylesheets + mirrors the theme; we give it a styled flex root so
          the stage fills the window (CONTRACT §2.2). NOTE: no SplitPane inside the
          Host — CONTRACT §3.4 (its drag writes the MAIN document.body). */}
      <popout.Host>
        {poppedOut ? (
          <div className="flex h-full w-full flex-col bg-surface-0 p-3">
            {stageSurface}
          </div>
        ) : null}
      </popout.Host>

      <div
        className={clsx(
          "flex min-h-0 flex-1 border-b border-line bg-surface-1/70 backdrop-blur-md",
          slim ? "flex-row items-center gap-3 px-4 py-2" : "flex-col gap-2 p-3",
        )}
        role="region"
        aria-label="Voice and video call"
      >
        {slim ? (
          chipsRow
        ) : showChips ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex min-h-0 flex-1">{chipsRow}</div>
            {showTranscript && (
              <div className="h-40 shrink-0 overflow-hidden rounded-xl border border-line">
                <TranscriptPanel />
              </div>
            )}
          </div>
        ) : (
          // Video stage with a resizable, persisted transcript dock. The stage
          // (SplitPane primary) stays mounted whether the transcript is shown or
          // collapsed, so toggling captions never detaches the video tracks.
          <SplitPane
            storageKey="call-transcript"
            orientation="vertical"
            defaultSize={168}
            min={96}
            max={360}
            collapsible
            collapsed={!showTranscript}
            onCollapsedChange={(c) => toggleTranscript(!c)}
            secondaryLabel="transcript"
            primary={
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {poppedOut ? (
                  <PoppedOutPlaceholder onBringBack={bringBackPopout} />
                ) : (
                  stageSurface
                )}
              </div>
            }
            secondary={
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <TranscriptPanel />
              </div>
            }
          />
        )}

        <div
          className={clsx(
            "flex shrink-0 items-center gap-2",
            slim ? "" : "justify-between pt-1",
          )}
        >
          <ViewModeSwitcher
            roomId={roomId}
            compact={slim}
            activeParticipantId={focused?.id ?? null}
            screenShareActive={screenShares.length > 0}
          />
          {controls}
        </div>
      </div>
    </div>
  );
}
