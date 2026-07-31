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
  MonitorUp,
  MonitorOff,
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
  RefreshCw,
  Plus,
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
import { useAppStore } from "@/stores/appStore";
import {
  runScreenShareAction,
  windowShareGuidance,
  monitorShareHint,
  localScreenShareCount,
} from "@/lib/screenShare";
import { ViewModeSwitcher } from "./ViewModeSwitcher";
import { TranscriptPanel } from "./TranscriptPanel";
import { VoiceAgentStatus } from "./VoiceAgentStatus";
import { VideoGrid } from "./VideoGrid";
import { SplitPane } from "./SplitPane";
import { Avatar } from "@/components/ui/Avatar";
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
//
// MULTI-WINDOW (`useFeedPopouts`): the whole-stage `useCallPopout` above holds a
// SINGLE handle, so it can only ever detach one window. `useFeedPopouts` keeps a
// REGISTRY keyed by feed — participant identity PLUS track source, because one
// participant can publish both a camera and a screen share and Aaron wants those
// on separate monitors. Each key portals exactly one tile into its own window.
import {
  usePipTile,
  useMergedVideoRef,
  useCallPopout,
  useFeedPopouts,
  isPopoutSupported,
} from "@/components/Room/popout";

/* ------------------------------------------------------------------ *
 * Feed keys — the identity of ONE poppable video feed.
 *
 * Source-qualified on purpose: `cam:local` and `screen:local-screen` are two
 * different feeds from the same person, independently poppable. The key is also
 * the geometry namespace (see callPopout.ts), so it must be STABLE across
 * reloads for a given feed or the remembered monitor placement is lost.
 *
 * Camera keys use the participant identity (stable across reconnects), not the
 * LiveKit `sid` (which is regenerated per session).
 * ------------------------------------------------------------------ */
const camFeedKey = (participantId: string): string => `cam:${participantId}`;
const screenFeedKey = (screenSid: string): string => `screen:${screenSid}`;

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
  /**
   * Identity-derived, STABLE across reloads and reconnects -- unlike `sid`,
   * which is a LiveKit participant sid regenerated every session. Only used
   * to build the pop-out feed key, which doubles as the localStorage key for
   * remembered monitor placement: keying that on `sid` meant placement was
   * silently never restored and the store grew unbounded.
   * Multi-share extras append the track publication sid so each feed is unique.
   */
  feedId: string;
  label: string;
  videoTrack: LocalTrack | RemoteTrack;
  /**
   * The sibling `screen_share_audio` track, when a remote sharer captured audio
   * (local share isn't looped back to self → null). Owned by the tile via
   * claim/release against VoiceProvider (SCREENAUDIO-NOTE / audit §4b).
   */
  audioTrack: RemoteAudioTrack | null;
  /** True when this is a local (self) share. */
  isLocal?: boolean;
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

/**
 * Per-tile fullscreen.
 *
 * DOCUMENT-AWARE (multi-window): a tile that has been popped out lives in the
 * CHILD window's document, so `document.fullscreenElement` and
 * `document.exitFullscreen()` on the global (opener) document address the wrong
 * window entirely — the button would report the wrong state and could never
 * exit. Everything here resolves the document from the NODE (`el.ownerDocument`)
 * and re-binds its listeners when the node moves between documents. This is the
 * same wrong-document bug class that makes SplitPane unsafe to portal.
 */
function useFullscreen(): FullscreenController {
  const elRef = useRef<HTMLDivElement | null>(null);
  // The document our node currently lives in; flips when the tile is portalled
  // into (or back out of) a pop-out window, which re-runs the listener effect.
  const [ownerDoc, setOwnerDoc] = useState<Document | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supported =
    typeof document !== "undefined" &&
    (document.fullscreenEnabled ||
      !!(document as FullscreenDoc).webkitFullscreenEnabled);

  useEffect(() => {
    const doc = ownerDoc ?? (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    const onChange = () => {
      const d = doc as FullscreenDoc;
      const fsEl = doc.fullscreenElement ?? d.webkitFullscreenElement ?? null;
      setIsFullscreen(!!elRef.current && fsEl === elRef.current);
    };
    // Reconcile immediately: moving documents can only ever drop fullscreen, and
    // a stale `true` would leave the tile stuck rendering its exit affordance.
    onChange();
    doc.addEventListener("fullscreenchange", onChange);
    doc.addEventListener("webkitfullscreenchange", onChange as EventListener);
    return () => {
      doc.removeEventListener("fullscreenchange", onChange);
      doc.removeEventListener("webkitfullscreenchange", onChange as EventListener);
    };
  }, [ownerDoc]);

  const toggle = useCallback(() => {
    const el = elRef.current as FullscreenEl | null;
    if (!el) return;
    // Resolve from the node, NOT the global — this is the whole point.
    const doc = (el.ownerDocument ?? document) as FullscreenDoc;
    const fsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    void (async () => {
      try {
        if (fsEl === el) {
          await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
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
    setOwnerDoc(el?.ownerDocument ?? null);
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
  /**
   * Pop THIS feed into its own window. Supplied only when the feed is poppable
   * (desktop + a real video track); calling it must open the window
   * synchronously, straight out of the click.
   */
  onPopOut?: () => void;
  /** This tile is currently being rendered INSIDE its pop-out window. */
  inPopout?: boolean;
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
  onPopOut,
  inPopout,
}: ParticipantTileProps) {
  const pip = usePipTile();
  const fs = useFullscreen();
  const showVideoEl = !!videoRef && !hidden;
  const ident = identityFor(p.id.replace(/^agent-/, ""), p.name);
  const agent = useAppStore((s) =>
    p.isAgent
      ? s.agents.find(
          (candidate) => candidate.id === p.id.replace(/^agent-/, ""),
        )
      : undefined,
  );
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
        <Avatar
          avatarUrl={agent?.avatar_url}
          emoji={agent?.emoji}
          id={p.id.replace(/^agent-/, "")}
          name={p.name}
          size={size === "large" ? 96 : 64}
          ring={speaking}
          className={clsx(
            speaking && !p.isMuted && "animate-pulse-soft",
          )}
          alt=""
        />
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

      {/* Control cluster (top-right): pin · fullscreen · PiP · hide.
          Always visible inside a pop-out so a frozen frame can't hide the only
          way to PiP/fullscreen; hover-reveal on the main stage. */}
      <div
        className={clsx(
          "absolute right-1.5 top-1.5 flex items-center gap-1",
          inPopout
            ? "opacity-100"
            : "transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100",
        )}
      >
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
        {/* Pop THIS feed into its own window. Deliberately adjacent to — and
            unambiguously distinct from — the Picture-in-Picture control above:
            two similar-looking controls confused Aaron once, so the accessible
            names are the plain-English "Pop out … to its own window" vs
            "Picture in picture", and both tooltips spell out the difference. */}
        {onPopOut && p.videoTrack && (
          <TileControlButton
            icon={ExternalLink}
            label={`Pop out ${p.name}’s camera to its own window`}
            title={`Pop out to window — opens ${p.name}’s camera in a separate window you can drag to another monitor (different from “Picture in picture”, which floats a small always-on-top thumbnail)`}
            onClick={(e) => {
              e.stopPropagation();
              onPopOut();
            }}
          />
        )}
        {pip.supported && p.videoTrack && (
          <TileControlButton
            icon={PictureInPicture2}
            label="Picture in picture"
            title="Picture in picture — float just this video in a small always-on-top thumbnail (use “Pop out to window” for a full second window)"
            active={pip.isActive}
            onClick={(e) => {
              e.stopPropagation();
              void pip.toggle();
            }}
          />
        )}
        {/* Hiding a feed that lives in its own window would blank that window
            with no visible cause, so the control is dropped there. */}
        {!inPopout && onToggleHide && p.videoTrack && (
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

/**
 * ScreenAudioSink — owns ONE screen share's `screen_share_audio` track.
 *
 * WHY THIS IS ITS OWN COMPONENT, MOUNTED IN THE MAIN TREE:
 *
 *  1. AUDIO STAYS IN THE MAIN DOCUMENT. This used to live inside ScreenShareTile,
 *     so the <audio> followed the tile into a pop-out portal. With per-feed
 *     windows that would scatter call audio across up to four child windows,
 *     each of which can raise its OWN autoplay prompt — and the "Tap to hear the
 *     call" banner only exists in the main tab, so the user would have no way to
 *     unblock it. Mounted here it never moves, matching the rule the tile
 *     <video> elements already follow (they are `muted`; the VoiceProvider sink
 *     is untouched).
 *  2. PAGINATION CAN'T MUTE IT. VideoGrid unmounts off-page tiles, which
 *     previously tore down the screen audio with them — paging away from a
 *     screen share silently killed its sound. This sink is a sibling of the
 *     stage, so paging and view-mode switches never unmount it.
 *
 * The VoiceProvider claim-handoff (SCREENAUDIO-NOTE) is unchanged: claim → the
 * provider detaches its global sink element so the audio plays here once, not
 * twice; release on unmount → the provider re-attaches it so audio-only and
 * compact listeners keep hearing it.
 */
function ScreenAudioSink({
  audioTrack,
  muted,
}: {
  audioTrack: RemoteAudioTrack;
  muted: boolean;
}) {
  const { claimScreenAudio, releaseScreenAudio } = useStableRoom();
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    audioTrack.attach(el);
    claimScreenAudio(audioTrack);
    return () => {
      audioTrack.detach(el);
      releaseScreenAudio(audioTrack);
    };
  }, [audioTrack, claimScreenAudio, releaseScreenAudio]);

  // Per-share mute is a media-element property — never gate the attach on it.
  useEffect(() => {
    if (audioElRef.current) audioElRef.current.muted = muted;
  }, [muted]);

  return <audio ref={audioElRef} autoPlay playsInline className="hidden" />;
}

interface ScreenShareTileProps {
  label: string;
  videoRef: AttachRef;
  /**
   * Whether this share HAS sibling screen audio — drives the mute button only.
   * The actual <audio> element lives in {@link ScreenAudioSink} in the main
   * document and is never portalled; see that component for why.
   */
  hasAudio?: boolean;
  /** User's per-share mute of the screen audio. */
  muted?: boolean;
  onToggleMuted?: () => void;
  fill?: boolean;
  onClick?: () => void;
  /** Pop THIS share into its own window (synchronously, from the click). */
  onPopOut?: () => void;
  /** Tile is rendered inside a pop-out — keep controls always visible. */
  inPopout?: boolean;
}

function ScreenShareTile({
  label,
  videoRef,
  hasAudio = false,
  muted,
  onToggleMuted,
  fill = false,
  onClick,
  onPopOut,
  inPopout,
}: ScreenShareTileProps) {
  const pip = usePipTile();
  const fs = useFullscreen();
  const composedVideoRef = useMergedVideoRef(videoRef, pip.videoRef);

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

      {/* NOTE: no <audio> here. Screen audio is owned by <ScreenAudioSink> in
          the MAIN document so it never rides a portal into a child window (see
          that component). The video above stays `muted`, as it always has. */}

      <div className="glass absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-stable-cyan">
        <MonitorUp className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>

      {/* Controls: always visible in a pop-out (frozen frame / no reliable hover);
          hover-reveal on the main stage. */}
      <div
        className={clsx(
          "absolute right-1.5 top-1.5 flex items-center gap-1",
          inPopout
            ? "opacity-100"
            : "transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100",
        )}
      >
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
        {/* A screen share is a DISTINCT track source from the same participant's
            camera, so it pops out into its OWN window independently — which is
            exactly the "my camera here, my screenshare there" layout. */}
        {onPopOut && (
          <TileControlButton
            icon={ExternalLink}
            label={`Pop out ${label} to its own window`}
            title={`Pop out to window — opens ${label} in a separate window you can drag to another monitor (different from “Picture in picture”, which floats a small always-on-top thumbnail)`}
            onClick={(e) => {
              e.stopPropagation();
              onPopOut();
            }}
          />
        )}
        {pip.supported && (
          <TileControlButton
            icon={PictureInPicture2}
            label="Picture in picture"
            title="Picture in picture — float just this video in a small always-on-top thumbnail (use “Pop out to window” for a full second window)"
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
  const ident = identityFor(id.replace(/^agent-/, ""), name);
  const agent = useAppStore((s) =>
    isAgent
      ? s.agents.find(
          (candidate) => candidate.id === id.replace(/^agent-/, ""),
        )
      : undefined,
  );
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
      <Avatar
        avatarUrl={agent?.avatar_url}
        emoji={agent?.emoji}
        id={id.replace(/^agent-/, "")}
        name={name}
        size={32}
        ring={isSpeaking}
        className={clsx(isSpeaking && !isMuted && "animate-pulse-soft")}
        alt=""
      />
      <span className="max-w-[10ch] truncate text-xs font-medium text-slate-200">
        {name}
      </span>
      {isMuted && <MicOff className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
    </div>
  );
}

/**
 * FeedPoppedOutPlaceholder — occupies ONE feed's slot in the main grid while
 * that feed is showing in its own window.
 *
 * This is the visible half of the load-bearing invariant: the real tile is
 * rendered in exactly one place, and when that place is the pop-out, the grid
 * gets this instead. Keeping a same-shaped tile in the layout means the grid
 * doesn't reflow every other tile the moment you detach one, and the user has
 * an obvious way back that doesn't require finding the OS window first.
 */
function FeedPoppedOutPlaceholder({
  label,
  fill,
  onBringBack,
  onFocusWindow,
}: {
  label: string;
  fill?: boolean;
  onBringBack: () => void;
  onFocusWindow: () => void;
}) {
  return (
    <div
      className={clsx(
        "flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stable-purple/40 bg-surface-1/60 p-3 text-center",
        fill ? "h-full" : "aspect-video",
      )}
    >
      <ExternalLink className="h-5 w-5 shrink-0 text-stable-purple-light" />
      <p className="max-w-full truncate text-xs font-medium text-slate-200">
        {label} is in its own window
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1">
        <button
          type="button"
          onClick={onFocusWindow}
          className="focus-ring rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
        >
          Find window
        </button>
        <button
          type="button"
          onClick={onBringBack}
          className="focus-ring rounded-lg bg-stable-purple/20 px-2 py-1 text-[11px] font-semibold text-stable-purple-light transition-colors hover:bg-stable-purple/30"
        >
          Bring it back
        </button>
      </div>
    </div>
  );
}

/** Placeholder shown in the main window while the WHOLE stage is popped out. */
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
  const mobileCallMode = useCallUiStore((s) => s.mobileCallMode);
  const mobileCallModeUserOverride = useCallUiStore(
    (s) => s.mobileCallModeUserOverride,
  );
  const setMobileCallMode = useCallUiStore((s) => s.setMobileCallMode);
  const setMobileChatSheet = useCallUiStore((s) => s.setMobileChatSheet);
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
  // Collects ALL local screen-share publications so a second share (multi-monitor)
  // shows as its own tile, not just the primary setScreenShareEnabled track.
  const screenShares = useMemo<ScreenShareVM[]>(() => {
    const out: ScreenShareVM[] = [];
    if (localParticipant) {
      const pubs = Array.from(localParticipant.trackPublications.values());
      const localVideos = pubs.filter(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      localVideos.forEach((v, i) => {
        if (!v.track) return;
        const trackSid = v.trackSid || v.track.sid || String(i);
        const multi = localVideos.length > 1;
        out.push({
          sid: multi ? `local-screen:${trackSid}` : "local-screen",
          feedId: multi ? `local-screen:${trackSid}` : "local-screen",
          label: multi ? `You — screen ${i + 1}` : "You — screen",
          videoTrack: v.track,
          // Local screen audio isn't looped back to self.
          audioTrack: null,
          isLocal: true,
        });
      });
    }
    for (const p of remoteParticipants) {
      const pubs = Array.from(p.trackPublications.values());
      const videos = pubs.filter(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      const audios = pubs.filter(
        (t) =>
          t.kind === "audio" && t.track && t.source === "screen_share_audio",
      );
      videos.forEach((v, i) => {
        if (!v.track) return;
        const agent = matchAgent(p.identity);
        const name = agent?.name || p.name || p.identity;
        const multi = videos.length > 1;
        const trackSid = v.trackSid || v.track.sid || String(i);
        // Pair the i-th screen audio when present (best-effort; LiveKit usually
        // publishes one audio per share session).
        const a = audios[i] ?? audios[0];
        out.push({
          sid: multi ? `${p.sid}:${trackSid}` : p.sid,
          feedId: multi ? `${p.identity}:${trackSid}` : p.identity,
          label: multi ? `${name} — screen ${i + 1}` : `${name} — screen`,
          videoTrack: v.track,
          audioTrack: (a?.track as RemoteAudioTrack | undefined) ?? null,
          isLocal: false,
        });
      });
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
  // Mobile Video intent: fade non-essential chrome after inactivity. Safe
  // controls (mic / cam / leave) stay reachable. Reduced-motion keeps chrome up.
  const mobileVideoChrome = !isDesktop && mobileCallMode === "video";
  const mobilePipSurface = !isDesktop && mobileCallMode === "chat";
  const prefersReducedMotion = usePrefersReducedMotion();
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    if (!mobileVideoChrome || prefersReducedMotion) return;
    chromeTimerRef.current = setTimeout(() => setChromeVisible(false), 3200);
  }, [mobileVideoChrome, prefersReducedMotion]);

  useEffect(() => {
    if (!mobileVideoChrome || prefersReducedMotion) {
      setChromeVisible(true);
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
      return;
    }
    bumpChrome();
    return () => {
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    };
  }, [mobileVideoChrome, prefersReducedMotion, bumpChrome]);

  const popoutSupported = isDesktop && isPopoutSupported();
  // Per-tile pop-out controls carry the SAME gate (DESKTOP_QUERY min-width
  // 768px + feature detect), so they never render on touch. The tile control
  // cluster they live in is `md:opacity-0 md:group-hover:opacity-100` — i.e.
  // hover-reveal ONLY at ≥md, permanently visible below it — so the controls
  // that do show on touch are not hover-gated. It also carries
  // `focus-within:opacity-100`, so the cluster is keyboard-reachable.
  const feedPopoutSupported = popoutSupported;

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

  // Per-feed windows: N open at once, one per camera / screen share.
  const feedPopouts = useFeedPopouts();
  const { openKeys: poppedFeedKeys, isOpen: isFeedPoppedOut } = feedPopouts;
  const feedPopoutClose = feedPopouts.close;
  const feedPopoutCloseAll = feedPopouts.closeAll;

  // Every feed that currently EXISTS and is therefore poppable.
  const liveFeedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const p of participants) {
      if (p.videoTrack) keys.add(camFeedKey(p.id));
    }
    for (const s of screenShares) keys.add(screenFeedKey(s.feedId));
    return keys;
  }, [participants, screenShares]);

  // A window whose feed went away (participant left, camera off, share stopped)
  // has nothing left to render. Close it rather than leaving an empty window
  // stranded on a monitor with no way to tell what it was.
  useEffect(() => {
    for (const key of poppedFeedKeys) {
      if (!liveFeedKeys.has(key)) feedPopoutClose(key);
    }
  }, [poppedFeedKeys, liveFeedKeys, feedPopoutClose]);

  // The call ended → close every feed window. The hook's own unmount cleanup
  // does NOT cover this: when the call drops, this component early-returns null
  // but stays MOUNTED, so without this the windows would linger showing frozen
  // video from a call that is over.
  useEffect(() => {
    if (!isConnected && !isConnecting) feedPopoutCloseAll();
  }, [isConnected, isConnecting, feedPopoutCloseAll]);

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

  // Presentation bias: when a screen share *appears*, prefer Presentation
  // stage + mobile Video intent (once). User can still switch Gallery/Split
  // afterward without being yanked back every render.
  const prevShareCountRef = useRef(0);
  useEffect(() => {
    const prev = prevShareCountRef.current;
    prevShareCountRef.current = screenShares.length;
    if (screenShares.length === 0 || screenShares.length <= prev) return;
    setViewMode(roomId, "screen");
    toggleVideo(true);
    if (!isDesktop && !mobileCallModeUserOverride) {
      setMobileCallMode("video");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShares.length, isDesktop, mobileCallModeUserOverride, roomId]);

  // Screen-share menu (stop / replace / add) — hooks must stay above early returns.
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!shareMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        shareMenuRef.current &&
        !shareMenuRef.current.contains(e.target as Node)
      ) {
        setShareMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [shareMenuOpen]);

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

  const isScreenSharing =
    !!localParticipant && localScreenShareCount(localParticipant) > 0;

  async function handleShareAction(mode: "toggle" | "replace" | "add") {
    if (!room) return;
    setShareMenuOpen(false);
    // Lift into Presentation when starting a share so the stage is useful.
    if (mode !== "toggle" || !isScreenSharing) {
      setViewMode(roomId, "screen");
      toggleVideo(true);
      // Mobile: prefer edge-to-edge Video intent for presentation (unless the
      // user already locked Split/Chat).
      if (!isDesktop && !mobileCallModeUserOverride) {
        setMobileCallMode("video");
      }
    }
    const result = await runScreenShareAction(room.localParticipant, mode);
    if (!result.ok) {
      if (result.action === "cancelled") return;
      useAppStore.getState().pushToast({
        title: "Couldn't share your screen",
        body: result.error || "Your browser blocked screen sharing.",
      });
      // Multi-share failed — offer replace as the next click path.
      if (mode === "add") {
        useAppStore.getState().pushToast({
          title: "One share at a time here",
          body: "Use Replace share to switch to another display or window without freezing the call.",
        });
      }
      return;
    }
    if (
      result.action === "started" ||
      result.action === "replaced" ||
      result.action === "added"
    ) {
      if (result.surface === "window" || result.surface === "browser") {
        useAppStore.getState().pushToast({
          title: "Window share active",
          body: windowShareGuidance(),
        });
      } else if (result.surface === "unknown" && result.action === "started") {
        useAppStore.getState().pushToast({
          title: "Screen share started",
          body: monitorShareHint(),
        });
      }
      if (viewMode !== "screen" && viewMode !== "grid" && viewMode !== "spotlight") {
        setViewMode(roomId, "screen");
      }
    }
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

  /**
   * Build the REAL camera tile. Callers must guarantee it ends up in exactly one
   * place — either the main stage (`renderTile`, which substitutes a placeholder
   * when the feed is detached) or that feed's pop-out Host, never both.
   *
   * `inPopout` matters for more than styling: inside a window the tile ignores
   * `showChips` (a detached feed keeps playing even when the main tab is in
   * audio-compact — that is the point of putting it on another monitor) and it
   * renders `fill`, so the feed uses the whole window.
   */
  function buildTile(
    p: CallParticipant,
    opts?: {
      size?: "normal" | "large";
      onClick?: () => void;
      grip?: boolean;
      fill?: boolean;
      inPopout?: boolean;
    },
  ) {
    const inPopout = !!opts?.inPopout;
    const hidden = !inPopout && hiddenTileIds.has(p.id);
    // In a pop-out the feed is visible on its own merits; in the main stage it
    // still obeys the chips / hidden rules.
    const trackVisible = inPopout
      ? !!p.videoTrack
      : !showChips && !hidden && !!p.videoTrack;
    const isPinned = pinnedId === p.id;
    const feedKey = camFeedKey(p.id);
    return (
      <ParticipantTile
        key={p.id}
        p={p}
        size={opts?.size ?? "normal"}
        fill={opts?.fill}
        hidden={hidden}
        inPopout={inPopout}
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
        // Synchronous open, straight out of the click — one window per gesture,
        // which is what keeps a popup blocker from eating the 2nd..Nth.
        onPopOut={
          feedPopoutSupported && !inPopout
            ? () =>
                feedPopouts.open(feedKey, {
                  title: `${p.name} — camera · Stable`,
                  label: `${p.name}’s camera`,
                })
            : undefined
        }
      />
    );
  }

  /** Main-stage camera tile: the real tile, or a placeholder when detached. */
  function renderTile(
    p: CallParticipant,
    opts?: { size?: "normal" | "large"; onClick?: () => void; grip?: boolean; fill?: boolean },
  ) {
    const feedKey = camFeedKey(p.id);
    if (isFeedPoppedOut(feedKey)) {
      // EXACTLY ONE PLACE: the real tile is mounted in this feed's pop-out Host
      // (rendered near the component root, outside the stage), so it must NOT be
      // rendered here as well.
      return (
        <FeedPoppedOutPlaceholder
          key={p.id}
          label={p.name}
          fill={opts?.fill}
          onBringBack={() => feedPopoutClose(feedKey)}
          onFocusWindow={() =>
            feedPopouts.open(feedKey, { label: `${p.name}’s camera` })
          }
        />
      );
    }
    return buildTile(p, opts);
  }

  /** Build the REAL screen-share tile. Same exactly-one-place contract. */
  function buildScreen(
    s: ScreenShareVM,
    opts?: { fill?: boolean; onClick?: () => void; inPopout?: boolean },
  ) {
    const inPopout = !!opts?.inPopout;
    const feedKey = screenFeedKey(s.feedId);
    return (
      <ScreenShareTile
        key={s.sid}
        label={s.label}
        fill={opts?.fill}
        onClick={opts?.onClick}
        videoRef={attachTrack(s.videoTrack)}
        // Audio is NOT owned by the tile any more — <ScreenAudioSink> in the
        // main document owns it, so it can't ride a portal into a child window.
        hasAudio={!!s.audioTrack}
        muted={mutedScreens.has(s.sid)}
        inPopout={inPopout}
        onToggleMuted={s.audioTrack ? () => toggleScreenMuted(s.sid) : undefined}
        onPopOut={
          feedPopoutSupported && !inPopout
            ? () =>
                feedPopouts.open(feedKey, {
                  title: `${s.label} · Stable`,
                  label: s.label,
                  // Screen shares are wide and detail-dense — give them a bigger
                  // default window than a camera tile.
                  width: 1280,
                  height: 760,
                })
            : undefined
        }
      />
    );
  }

  /** Main-stage screen tile: the real tile, or a placeholder when detached. */
  function renderScreen(s: ScreenShareVM, opts?: { fill?: boolean; onClick?: () => void }) {
    const feedKey = screenFeedKey(s.feedId);
    if (isFeedPoppedOut(feedKey)) {
      return (
        <FeedPoppedOutPlaceholder
          key={s.sid}
          label={s.label}
          fill={opts?.fill}
          onBringBack={() => feedPopoutClose(feedKey)}
          onFocusWindow={() => feedPopouts.open(feedKey, { label: s.label })}
        />
      );
    }
    return buildScreen(s, opts);
  }

  /**
   * Resolve a feed key back to its live tile for rendering inside that key's
   * window. Returns null when the feed no longer exists — the effect above then
   * closes the window on the next commit.
   */
  function renderPoppedFeed(feedKey: string): ReactNode {
    if (feedKey.startsWith("cam:")) {
      const id = feedKey.slice("cam:".length);
      const p = participants.find((x) => x.id === id);
      return p ? buildTile(p, { fill: true, inPopout: true, size: "large" }) : null;
    }
    if (feedKey.startsWith("screen:")) {
      const sid = feedKey.slice("screen:".length);
      const s = screenShares.find((x) => x.sid === sid);
      return s ? buildScreen(s, { fill: true, inPopout: true }) : null;
    }
    return null;
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

  // Safe chrome: mic / cam / leave always visible in mobile Video (even when
  // the extended control cluster fades). Extended chrome includes share, hide
  // video/chat, pop-out, and the view-mode switcher.
  const safeControls = (
    <div className="glass flex shrink-0 items-center justify-center gap-1.5 rounded-2xl p-1.5">
      <button
        onClick={() => {
          bumpChrome();
          void toggleMic();
        }}
        className={clsx(
          "focus-ring flex h-11 w-11 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
          isMicOn
            ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
            : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
        )}
        aria-label={isMicOn ? "Mute" : "Unmute"}
      >
        {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button
        onClick={() => {
          bumpChrome();
          void toggleCam();
        }}
        className={clsx(
          "focus-ring flex h-11 w-11 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
          isCamOn
            ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
            : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
        )}
        aria-label={isCamOn ? "Turn off camera" : "Turn on camera"}
      >
        {isCamOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>
      <button
        onClick={disconnect}
        className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
        aria-label="End call"
      >
        <PhoneOff className="h-5 w-5" />
      </button>
    </div>
  );

  const controls = (
    <div className="glass flex shrink-0 items-center justify-center gap-1.5 rounded-2xl p-1.5">
      {/* Mic/cam/leave live in safeControls when mobile Video chrome-fades. */}
      {!mobileVideoChrome && (
        <>
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
        </>
      )}

      {/* Screen share — in-call control (Header also has one). When already
          sharing, a small menu offers Stop / Replace / Share another display
          so multi-monitor desks aren't forced into a frozen single share. */}
      <div className="relative" ref={shareMenuRef}>
        <button
          type="button"
          onClick={() => {
            if (isScreenSharing) {
              setShareMenuOpen((o) => !o);
            } else {
              void handleShareAction("toggle");
            }
          }}
          className={clsx(
            "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
            isScreenSharing
              ? "border-stable-cyan/40 bg-stable-cyan/15 text-stable-cyan hover:bg-stable-cyan/25"
              : "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100",
          )}
          aria-label={
            isScreenSharing ? "Screen share options" : "Share screen"
          }
          aria-pressed={isScreenSharing}
          aria-haspopup={isScreenSharing ? "menu" : undefined}
          aria-expanded={isScreenSharing ? shareMenuOpen : undefined}
          title={
            isScreenSharing
              ? "Screen share options — stop, replace, or share another display"
              : "Share your screen — pick Entire Screen for a full display"
          }
        >
          {isScreenSharing ? (
            <MonitorOff className="h-5 w-5" />
          ) : (
            <MonitorUp className="h-5 w-5" />
          )}
        </button>
        {shareMenuOpen && isScreenSharing && (
          <div
            role="menu"
            className="glass-heavy absolute bottom-full left-1/2 z-40 mb-2 w-56 -translate-x-1/2 rounded-xl p-1.5 shadow-pop"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleShareAction("toggle")}
              className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/15"
            >
              <MonitorOff className="h-3.5 w-3.5 shrink-0" />
              Stop sharing
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleShareAction("replace")}
              className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.06]"
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              Replace share
              <span className="ml-auto text-[10px] font-normal text-slate-400">
                full screen / window
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleShareAction("add")}
              className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.06]"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              Share another display
            </button>
            <p className="px-2.5 pb-1.5 pt-1 text-[10px] leading-snug text-slate-400">
              Prefer Entire Screen in the picker for a full-display capture.
            </p>
          </div>
        )}
      </div>

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
          pane (mirrors the divider's collapse chevron via `chatCollapsed`).
          On mobile Video intent, open the chat bottom sheet instead. */}
      {!showChips && viewMode !== "sidebar" && (
        <button
          onClick={() => {
            if (!isDesktop && mobileCallMode === "video") {
              setMobileChatSheet("half");
              return;
            }
            if (!isDesktop && mobileCallMode === "chat") {
              setMobileCallMode("video", { user: true });
              return;
            }
            setChatCollapsed();
          }}
          className={clsx(
            "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-transparent transition-colors active:scale-[0.98]",
            !chatCollapsed
              ? "text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
              : "bg-stable-purple/20 text-stable-purple-light hover:bg-stable-purple/30",
          )}
          aria-label={
            !isDesktop && mobileCallMode === "video"
              ? "Open chat"
              : chatCollapsed
                ? "Show chat"
                : "Hide chat"
          }
          aria-pressed={chatCollapsed}
          title={
            !isDesktop && mobileCallMode === "video"
              ? "Open chat as a sheet"
              : chatCollapsed
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

      {/* Leave is duplicated into safeControls for mobile Video chrome-fade. */}
      {!(mobileVideoChrome) && (
        <button
          onClick={disconnect}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
          aria-label="End call"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      )}
    </div>
  );

  // Slim single-row layout: audio compact with no transcript. An open transcript
  // needs vertical room, so fall back to the column layout even in compact.
  const slim = viewMode === "compact" && !showTranscript;

  // LiveKit mid-call reconnect: show a dismissible strip so a long reconnect
  // doesn't feel like a frozen, un-dismissable chrome over the stage (same
  // class of bug as the websocket "live updates paused" banner).
  const showLkReconnect = isConnecting && !!room && !isConnected;

  // Mobile PiP surface: stage only — no chrome (tap returns to Video).
  if (mobilePipSurface) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        {showChips ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-1">
            {chipsRow}
          </div>
        ) : poppedOut ? (
          <PoppedOutPlaceholder onBringBack={bringBackPopout} />
        ) : (
          <div className="min-h-0 flex-1 p-0.5">{stageSurface}</div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      onPointerDown={mobileVideoChrome ? () => bumpChrome() : undefined}
    >
      {showLkReconnect && (
        <div
          role="status"
          className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-400/20 bg-amber-400/15 px-4 py-1.5 text-xs text-amber-200"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Reconnecting to the call…
          </span>
          <span className="flex items-center gap-1">
            {(poppedOut || poppedFeedKeys.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  if (poppedOut) bringBackPopout();
                  feedPopoutCloseAll();
                }}
                className="focus-ring rounded-md bg-amber-400/20 px-2 py-0.5 font-semibold transition-colors hover:bg-amber-400/30"
              >
                Close pop-outs
              </button>
            )}
            <button
              type="button"
              onClick={disconnect}
              className="focus-ring rounded-md px-2 py-0.5 font-semibold text-rose-300 transition-colors hover:bg-rose-500/20"
            >
              Leave call
            </button>
          </span>
        </div>
      )}

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

      {/* Screen-share AUDIO owners. Mounted here — a sibling of the stage, in
          the MAIN document — so they survive pagination, view-mode switches and
          every pop-out. Audio never rides a portal into a child window (see
          ScreenAudioSink), which is what keeps a single autoplay prompt and a
          single copy of the sound. */}
      {screenShares.map((s) =>
        s.audioTrack ? (
          <ScreenAudioSink
            key={`audio:${s.sid}`}
            audioTrack={s.audioTrack}
            muted={mutedScreens.has(s.sid)}
          />
        ) : null,
      )}

      {/* PER-FEED POP-OUT HOSTS — the multi-window seam.
          One Host per open window; each portals exactly ONE feed's tile into
          its own document. Rendered HERE, at the component root, and NOT inside
          `stageSurface`, which matters for two reasons:

           • PAGINATION: VideoGrid mounts only the current page's tiles, so a
             popped-out feed rendered inside the grid would be unmounted (and
             its LiveKit layer paused) the moment you paged past it. From here
             the grid can never unmount it — paging only ever swaps the cheap
             placeholder.
           • VIEW MODES: switching compact/grid/focus/sidebar rebuilds
             `stageSurface` wholesale. These Hosts are unaffected, so a detached
             feed doesn't blink through a detach/re-attach on every switch. */}
      {poppedFeedKeys.map((feedKey) => (
        <feedPopouts.Host key={feedKey} feedKey={feedKey}>
          <div className="flex h-full w-full flex-col bg-surface-0 p-2">
            {renderPoppedFeed(feedKey)}
          </div>
        </feedPopouts.Host>
      ))}

      {/* A blocked per-feed pop-out. Same reasoning as the whole-stage banner:
          `window.open` returning null is the browser's only signal and it is
          otherwise completely invisible, so the button would just appear dead.
          Opening 4 windows is the classic blocker trigger, so this names WHICH
          feed failed — with 4 windows in play "the pop-out was blocked" isn't
          actionable on its own. */}
      {feedPopouts.error && (
        <div
          role="alert"
          className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-400/20 bg-amber-400/15 px-4 py-2 text-sm text-amber-200"
        >
          <span className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 shrink-0" />
            {feedPopouts.error.failure === "blocked"
              ? `Your browser blocked the window for ${feedPopouts.error.label}. Allow pop-ups for this site, then try again — browsers often block the 2nd and later windows even when the first one worked.`
              : `This browser can’t open a separate window for ${feedPopouts.error.label}.`}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {feedPopouts.error.failure === "blocked" && (
              <button
                type="button"
                // A fresh user gesture — the retry is a real click, so it can
                // succeed where the original was blocked.
                onClick={() => {
                  const err = feedPopouts.error;
                  if (!err) return;
                  if (feedPopouts.open(err.feedKey, { label: err.label })) {
                    feedPopouts.clearError();
                  }
                }}
                className="focus-ring rounded-md bg-amber-400/20 px-2 py-0.5 text-xs font-semibold transition-colors hover:bg-amber-400/30"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={feedPopouts.clearError}
              className="focus-ring rounded-md px-1.5 py-0.5 text-xs text-amber-200/70 transition-colors hover:text-amber-100"
              aria-label="Dismiss the pop-out warning"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

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
            "flex shrink-0 items-center gap-2 transition-opacity duration-300",
            slim ? "" : "justify-between pt-1",
            mobileVideoChrome &&
              !chromeVisible &&
              !prefersReducedMotion &&
              "pointer-events-none opacity-0",
          )}
        >
          {/* Desktop / Split keep the full switcher; mobile Video hides it so
              intent modes (Video/Split/Chat) own the mental model. */}
          {(isDesktop || mobileCallMode === "split") && (
            <ViewModeSwitcher
              roomId={roomId}
              compact={slim || !isDesktop}
              activeParticipantId={focused?.id ?? null}
              screenShareActive={screenShares.length > 0}
            />
          )}
          {mobileVideoChrome ? (
            // Extended chrome only while visible; safe strip is always below.
            <div
              className={clsx(
                "flex min-w-0 flex-1 items-center justify-end gap-1.5",
                !chromeVisible && !prefersReducedMotion && "invisible",
              )}
            >
              {controls}
            </div>
          ) : (
            controls
          )}
        </div>

        {/* Always-reachable safe chrome in mobile Video mode */}
        {mobileVideoChrome && (
          <div
            className={clsx(
              "flex shrink-0 justify-center pt-1 transition-opacity duration-300",
              // When extended chrome is visible, Leave is in the extended row
              // already for desktop-style bars — here safeControls is the
              // permanent dock for mic/cam/leave.
            )}
          >
            {safeControls}
          </div>
        )}
      </div>
    </div>
  );
}

/** True when the user prefers reduced motion (no aggressive chrome auto-fade). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
