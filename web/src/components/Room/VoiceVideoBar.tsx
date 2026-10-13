import { LiveMicMeter } from "@/components/Call/LiveMicMeter";
import { useIsLandscape } from "@/hooks/useIsLandscape";
import { shouldUsePortraitStage } from "@/lib/portraitCall";
import { PortraitCallStage } from "./PortraitCallStage";

import { isGuestCallIdentity } from "@/lib/guest";
import { GuestBadge } from "@/components/ui/GuestBadge";
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
import { RoomEvent, Track } from "livekit-client";
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
  RefreshCw,
  Plus,
  Sparkles,
  Smile,
  Box,
  Radio,
  Image as ImageIcon,
  Shield,
  Ear,
  EarOff,
  UserMinus,
  type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { identityFor } from "@/lib/identity";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useDirectCall } from "@/hooks/useDirectCall";
import { useVoice } from "@/contexts/VoiceProvider";
import { DevicePickerButton } from "@/components/Call/DevicePickerButton";
import { useIsDesktop } from "@/hooks/usePanelResize";
import { useRoomBroadcasts } from "@/hooks/useRoomBroadcasts";
import {
  broadcastBadgeTitle,
  broadcastCopyVariantConfig,
  broadcastMenuHeader,
  broadcastViewerWarning,
  buildBroadcastUrl,
  type BroadcastCopyVariant,
} from "@/lib/broadcast";
import {
  agentRosterRole,
  humanTitleFromMember,
  localTilePlate,
  lowerThirdLayoutForCall,
  resolveLocalDisplayName,
  resolveLowerThirdSubtitle,
  roomLowerThirdOptIn,
  withLowerThirdParam,
} from "@/lib/tileChrome";
import {
  readTileChromePrefs,
  useTileChromePrefs,
} from "@/lib/tileChromePrefs";
import { StageLowerThird } from "./LowerThird";
import { CallTileName, TileNamePlate } from "./TileNamePlate";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  useCallUiStore,
  uiCommandBus,
  DEFAULT_CALL_VIEW_MODE,
} from "@/stores/callUiStore";
import { isAgentParticipant, type CallViewMode } from "@/lib/roomDataProtocol";
import {
  api,
  type ApiError,
  type BrigadeAgent,
  type CallModerationAction,
} from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  runScreenShareAction,
  windowShareGuidance,
  monitorShareHint,
  localScreenShareCount,
} from "@/lib/screenShare";
import { ViewModeSwitcher } from "./ViewModeSwitcher";
import { TranscriptPanel } from "./TranscriptPanel";
import { VoiceAgentStatus } from "./VoiceAgentStatus";
import { TalkGateIndicator } from "./TalkGateIndicator";
import { VideoGrid } from "./VideoGrid";
import { SplitPane } from "./SplitPane";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { ChatToggleButton } from "@/components/Call/ChatToggleButton";
import { LayoutPresetMenu } from "@/components/Call/LayoutPresetMenu";
import { RecPillForRoom } from "@/components/Call/RecPillForRoom";
import { RecordMenu } from "@/components/Call/RecordMenu";
import { PanelHost } from "@/components/Layout/PanelHost";
import { registerPanelOpener } from "@/components/Layout/panelOpeners";
import { popPanel } from "@/lib/callLayoutActions";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import { AgentPresenceFace } from "@/components/Agents/AgentPresenceFace";
import { frameHasPicture, frameLumaStats } from "@/lib/videoFrame";
import {
  isAgentIdentity,
  isVrmSurfaceEligible,
  mapAgentState,
  resolveCallTilePersona,
  agentFaceBudget,
  type CallTilePersona,
  type RoomAgentMember,
} from "@/lib/presenceFace";
import { FACE_STYLE_META, type FaceStyle } from "@/lib/facePreference";
import { useFacePrefStore } from "@/stores/facePrefStore";
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
import { useTileFullscreen } from "@/hooks/useTileFullscreen";

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
// Takes the IDENTITY-derived ScreenShareVM.feedId, never the LiveKit sid.
// 565943e moved the three key-MINTING sites to feedId (stable across reloads,
// so pop-out geometry persists) but the old `screenSid` parameter name lived
// on and hid that the one key-CONSUMING site, renderPoppedFeed, still
// resolved by sid — for every remote share feedId ≠ sid, so its pop-out
// window rendered NOTHING from 18 minutes after the feature shipped.
const screenFeedKey = (feedId: string): string => `screen:${feedId}`;

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
  /**
   * LiveKit says this participant is an agent worker — `ParticipantKind.AGENT`,
   * the `agent-` identity convention, or `participant_type: "agent"` metadata.
   *
   * Separate from `isAgent`, which is really "the Brigade roster matched" and
   * therefore also carries the display name and portrait. Verified on dogfood:
   * the worker joins as `stable-brigade`, which matches no roster row and has
   * no `agent-` prefix, so `isAgent` is FALSE for a participant that is very
   * obviously an agent. Anything that must be right about agent-ness rather
   * than about roster enrichment reads this.
   */
  isAgentKind: boolean;
  isLocal: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  /** Camera track if publishing one, else null. */
  videoTrack: LocalTrack | RemoteTrack | null;
  /** LiveKit participant metadata, when the publisher sent any. */
  metadata: string;
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
function useAttachTrack(): (
  track: LocalTrack | RemoteTrack | null,
) => AttachRef {
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
 * Fullscreen — per-tile, cross-vendor. The document-aware hook that used to
 * live here is now hooks/useTileFullscreen.ts over the tested engine in
 * lib/tileFullscreen.ts, because EVERY call surface needs it (this file,
 * StageView, the guest stage) and the iPhone video-tag rung
 * (`video.webkitEnterFullscreen()`) made it real logic: tiles register their
 * <video> via `fs.videoRef` so iPhone — which has no element fullscreen —
 * can present the native player instead of hiding the button.
 * ------------------------------------------------------------------ */

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
        // Same responsive touch-target treatment as FaceStyleTileButton below:
        // a full 44px button on touch layouts — where the cluster is always
        // visible, fingers are blunt, and mobile Chrome's touch-adjustment has
        // a history of snapping taps onto the wrong tiny handle — compacting
        // to the cluster's 24px beside its siblings on md+.
        "glass focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-white md:h-6 md:w-6",
        active && "text-stable-purple-light ring-1 ring-stable-purple/60",
      )}
    >
      <Icon className="h-3.5 w-3.5 md:h-3 md:w-3" />
    </button>
  );
}

const BROADCAST_COPY_ITEMS: Array<{
  variant: BroadcastCopyVariant;
  icon: LucideIcon;
  label: string;
  title: string;
}> = [
  {
    variant: "camera",
    icon: Video,
    label: "Copy camera link",
    title: "Mint a video-only camera feed link",
  },
  {
    variant: "camera-audio",
    icon: Volume2,
    label: "Copy camera link with audio",
    title: "Mint a camera feed link with microphone audio",
  },
  {
    variant: "screen",
    icon: MonitorUp,
    label: "Copy screen link",
    title: "Mint a screen-share feed link; it stays black until a share starts",
  },
  {
    variant: "screen-audio",
    icon: Volume2,
    label: "Copy screen link with audio",
    title:
      "Mint a screen-share feed link with audio; it stays black until a share starts",
  },
];

/** Owner-only broadcast variants. Portal it because participant tiles clip menus. */
function BroadcastCopyMenu({
  targetName,
  isBroadcasting,
  viewerCount,
  maxViewersPerLink,
  onCopy,
}: {
  targetName: string;
  isBroadcasting?: boolean;
  /** Viewers across every live link for this participant. */
  viewerCount?: number | null;
  /** The most viewers on any single link: what the leak warning reads. */
  maxViewersPerLink?: number | null;
  onCopy: (variant: BroadcastCopyVariant) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setOpen((current) => !current);
  }

  function choose(e: ReactMouseEvent, variant: BroadcastCopyVariant) {
    e.stopPropagation();
    setOpen(false);
    onCopy(variant);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={`Broadcast options for ${targetName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Broadcast options for ${targetName}. Each link is a credential: anyone with it can watch until it expires or you revoke it.`}
        className={clsx(
          "glass focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-white md:h-6 md:w-6",
          isBroadcasting &&
            "text-stable-purple-light ring-1 ring-stable-purple/60",
          open && "text-stable-cyan ring-1 ring-stable-cyan/60",
        )}
      >
        <Radio className="h-3.5 w-3.5 md:h-3 md:w-3" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Broadcast links for ${targetName}`}
            style={{ top: pos.top, right: pos.right }}
            className="glass-heavy fixed z-[70] w-64 overflow-hidden rounded-xl p-1 text-xs shadow-pop animate-fade-in"
          >
            <p className="truncate px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              {broadcastMenuHeader(targetName, viewerCount)}
            </p>
            {broadcastViewerWarning(maxViewersPerLink) && (
              <p className="px-2 py-1 text-[10px] leading-snug text-amber-200">
                {broadcastViewerWarning(maxViewersPerLink)}
              </p>
            )}
            {BROADCAST_COPY_ITEMS.map((item) => (
              <button
                key={item.variant}
                type="button"
                role="menuitem"
                onClick={(e) => choose(e, item.variant)}
                title={item.title}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
              >
                <item.icon className="h-3.5 w-3.5 text-slate-400" />
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Current-state icon for the face-style cycle control. */
const FACE_STYLE_ICON: Record<FaceStyle, LucideIcon> = {
  auto: Sparkles,
  puppet: Smile,
  vrm: Box,
  portrait: ImageIcon,
};

/**
 * FaceStyleTileButton — the per-tile face-style affordance ("the Unicorn's
 * window"). Cycles auto → 2D puppet → 3D model → portrait and writes the
 * GLOBAL preference (stores/facePrefStore) — one choice for every agent tile,
 * deliberately, per the v1 scope; per-agent overrides are the noted v2.
 *
 * Same glass-chip idiom as TileControlButton, with the responsive touch-target
 * treatment RoomView's header buttons use (`p-2.5 md:p-1.5`): a full 44px
 * button on touch layouts — where the cluster is always visible and fingers
 * are blunt — compacting to the cluster's 24px beside its siblings on md+.
 * A negative-margin hit hack was tried first and rejected: the tile is
 * overflow-hidden, so an inflated hit box just gets clipped at the tile edge.
 */
function FaceStyleTileButton({
  onCycled,
}: {
  /** Receives the NEW style's label, for the tile's transient toast. */
  onCycled: (label: string) => void;
}) {
  const style = useFacePrefStore((s) => s.style);
  const cycleStyle = useFacePrefStore((s) => s.cycleStyle);
  const Icon = FACE_STYLE_ICON[style];
  const meta = FACE_STYLE_META[style];
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCycled(FACE_STYLE_META[cycleStyle()].label);
      }}
      aria-label={`Agent face style: ${meta.label}. Activate to switch`}
      title={`Agent face style — now “${meta.label}”. Cycles Auto → 2D puppet → 3D model → Portrait, for agent faces everywhere (also in Settings → Appearance)`}
      className="glass focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-white md:h-6 md:w-6"
    >
      <Icon className="h-3.5 w-3.5 md:h-3 md:w-3" />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * CallModerationMenu — owner/admin actions on ONE live-call participant.
 * ------------------------------------------------------------------ */

interface ModerationItem {
  action: CallModerationAction;
  icon: LucideIcon;
  label: string;
  title: string;
}

/** Mute — the item's meaning flips per target, so it is not in the static list. */
const MUTE_MIC_ITEM: ModerationItem = {
  action: "mute_mic",
  icon: MicOff,
  label: "Mute mic",
  title: "Server-mute their mic — they can unmute themselves",
};

/**
 * AGENT-ONLY. LiveKit refuses the server-side unmute (412 "remote unmute not
 * enabled" — see server/app/api/moderation.py), so a human target still
 * re-enables their own mic; there is no menu item for that. An agent has no
 * hands, so this asks its voice relay to unmute itself over the data channel.
 */
const UNMUTE_MIC_ITEM: ModerationItem = {
  action: "unmute_mic",
  icon: Mic,
  label: "Unmute mic",
  title: "Ask the agent to unmute itself — the only way back from a server mute",
};

const MODERATION_ITEMS: ModerationItem[] = [
  {
    action: "silence",
    icon: VolumeX,
    label: "Silence",
    title:
      "Mute + revoke publishing — no mic/camera/share until you unsilence",
  },
  {
    action: "unsilence",
    icon: Volume2,
    label: "Unsilence",
    title:
      "Restore publishing. Their mic stays off until THEY re-enable it",
  },
  {
    action: "deafen",
    icon: EarOff,
    label: "Deafen",
    title: "Cut what they receive — they stop hearing/seeing the room",
  },
  {
    action: "undeafen",
    icon: Ear,
    label: "Undeafen",
    title: "Restore what they receive",
  },
];

/**
 * The per-tile moderation submenu. Rendered ONLY when the local user's room
 * role is owner/admin AND the ladder allows acting on this tile (computed in
 * `buildTile`; the server's 403 is the backstop, not the rule — same stance
 * as the owner-only broadcast control above).
 *
 * The dropdown is PORTALED to document.body with fixed positioning: the tile
 * is `overflow-hidden`, so an in-tile absolute menu would clip to nothing on
 * small tiles. Portaling means the control is dropped inside pop-out windows
 * (`inPopout` guard at the call site) — the main stage always has it.
 *
 * One click per action, no confirm — moderation during a live show has to be
 * FAST. The single exception is Remove from call, which is disruptive enough
 * to warrant the shared ConfirmDialog.
 */
function CallModerationMenu({
  targetName,
  onAction,
  isAgentTarget,
  micMuted,
}: {
  targetName: string;
  onAction: (action: CallModerationAction) => void;
  /** Only an agent target can be sent `unmute_mic` — the server 400s a human. */
  isAgentTarget: boolean;
  /** Current mic state (`!isMicrophoneEnabled`) — decides Mute vs. Unmute. */
  micMuted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Scroll/resize invalidate the cached rect — close rather than drift.
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({
        top: r.bottom + 4,
        right: Math.max(8, window.innerWidth - r.right),
      });
    }
    setOpen((v) => !v);
  }

  function fire(e: ReactMouseEvent, action: CallModerationAction) {
    e.stopPropagation();
    setOpen(false);
    if (action === "remove_from_call") {
      setConfirmRemove(true);
      return;
    }
    onAction(action);
  }

  // Unmute only replaces Mute when there is something to undo AND someone to
  // send it to — a muted human re-enables their own mic instead (see
  // UNMUTE_MIC_ITEM), so the item never appears for a human target.
  const micItem = isAgentTarget && micMuted ? UNMUTE_MIC_ITEM : MUTE_MIC_ITEM;
  const items = [micItem, ...MODERATION_ITEMS];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={`Moderate ${targetName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Moderate ${targetName}`}
        className={clsx(
          "glass focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-white md:h-6 md:w-6",
          open && "text-stable-purple-light ring-1 ring-stable-purple/60",
        )}
      >
        <Shield className="h-3.5 w-3.5 md:h-3 md:w-3" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Moderation — ${targetName}`}
            style={{ top: pos.top, right: pos.right }}
            className="glass-heavy fixed z-[70] w-48 overflow-hidden rounded-xl p-1 text-xs shadow-pop animate-fade-in"
          >
            <p className="truncate px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Moderate {targetName}
            </p>
            {items.map((item) => (
              <button
                key={item.action}
                role="menuitem"
                onClick={(e) => fire(e, item.action)}
                title={item.title}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
              >
                <item.icon className="h-3.5 w-3.5 text-slate-400" />
                {item.label}
              </button>
            ))}
            <div className="my-1 border-t border-line" />
            <button
              role="menuitem"
              onClick={(e) => fire(e, "remove_from_call")}
              title="Kick them out of the call (they stay a room member)"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-rose-400 transition-colors hover:bg-rose-500/15 focus-ring"
            >
              <UserMinus className="h-3.5 w-3.5" /> Remove from call
            </button>
          </div>,
          document.body,
        )}
      {confirmRemove &&
        createPortal(
          <ConfirmDialog
            title="Remove from call?"
            message={
              <>
                Remove{" "}
                <span className="font-semibold text-slate-100">
                  {targetName}
                </span>{" "}
                from this call? They stay a member and can rejoin.
              </>
            }
            confirmLabel="Remove"
            icon={UserMinus}
            busy={false}
            onConfirm={() => {
              setConfirmRemove(false);
              onAction("remove_from_call");
            }}
            onClose={() => setConfirmRemove(false)}
          />,
          document.body,
        )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * ParticipantTile — one camera/avatar tile with the full interaction set.
 * ------------------------------------------------------------------ */

interface ParticipantTileProps {
  p: CallParticipant;
  /**
   * The Stable room this call lives in — how an agent tile resolves its
   * PERSONA (`brigade_agent_id` off the room) when the worker joined under a
   * type-shaped LiveKit identity ("stable-brigade") instead of a persona one.
   */
  roomId: string;
  /**
   * The call's agent-tile count is within MAX_AGENT_FACE_CONTEXTS, so agent
   * tiles may take the face rung on ANY stage surface (Gallery/sidebar), not
   * only the Speaker big tile. Computed once per call surface by the parent.
   */
  agentFaceBudgetOk: boolean;
  /** Attach ref for the camera track (present only when a video should show). */
  videoRef?: AttachRef;
  /** Event-driven speaking state (active-speaker OR isSpeaking). */
  speaking: boolean;
  size?: "normal" | "large";
  /** Fill the container (big-stage tiles) rather than a fixed 16:9 box. */
  fill?: boolean;
  immersive?: boolean;
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
  /**
   * Mint + copy an OBS broadcast URL for this participant. Supplied ONLY to a
   * room OWNER (minting a no-login URL to someone else's camera is an
   * owner-level act); the server's 403 is the backstop, not the rule.
   */
  onCopyBroadcastUrl?: (variant: BroadcastCopyVariant) => void;
  /**
   * A live broadcast link exists for this participant right now.
   *
   * Shown to EVERYONE, deliberately. Broadcast viewers join LiveKit
   * `hidden=True` so an OBS feed never shows up as a participant — which,
   * with a no-login URL, would mean being streamed to the internet with no
   * indication anywhere. The feed stays invisible; the FACT of it does not.
   */
  isBroadcasting?: boolean;
  viewerCount?: number | null;
  maxViewersPerLink?: number | null;
  /**
   * Run a moderation action on THIS participant's live-call connection.
   * Supplied only to a room owner/admin, and never for your own tile; the
   * server's 403 and its role ladder are the backstop, not the rule.
   */
  onModerate?: (action: CallModerationAction) => void;
}

/** LiveKit identity is `<username>_<participant id>`, or the participant id alone. */
function memberMatchesCallIdentity(
  member: { participant_id?: string; user_id?: string; username?: string },
  identity: string,
): boolean {
  const pid = member.participant_id || member.user_id;
  if (!pid) return false;
  return identity === pid || identity === `${member.username}_${pid}`;
}

function ParticipantTile({
  p,
  roomId,
  agentFaceBudgetOk,
  videoRef,
  speaking,
  size = "normal",
  fill = false,
  immersive = false,
  hidden,
  isPinned,
  onTogglePin,
  onToggleHide,
  onClick,
  showGrip,
  onPopOut,
  inPopout,
  onCopyBroadcastUrl,
  isBroadcasting,
  viewerCount,
  maxViewersPerLink,
  onModerate,
}: ParticipantTileProps) {
  const pip = usePipTile();
  const fs = useTileFullscreen();
  const showVideoEl = !!videoRef && !hidden;
  const ident = identityFor(p.id.replace(/^agent-/, ""), p.name);
  /* WHICH SIDE OF THE FLAG THINGS LIVE ON.
   *
   * An agent tile ALWAYS gets the presence-face ladder — portrait ->
   * UnicornAvatar -> initials — flag or no flag. That is not a feature, it is
   * the absence of a bug: the alternative, which is what shipped, is a black
   * rectangle where a colleague's face should be.
   *
   * The flag `stable.talkingFace.v1` gates exactly one thing: the WebGL rung.
   * `AgentPresenceFace` reads it itself, so nothing here has to.
   *
   * Agent detection is by IDENTITY and by LiveKit's participant kind, not by
   * `p.isAgent`. `p.isAgent` means "the Brigade roster query matched", and that
   * query can be empty, slow or failed — on dogfood the agent's roster lookup
   * misses entirely, so `p.isAgent` is false for a participant that is
   * unmistakably an agent. The roster is still consulted, but only to ENRICH
   * (portrait, emoji). */
  const isAgentTile = isAgentIdentity(p.id) || p.isAgentKind || p.isAgent;
  /* Face-eligibility. Two ways in:
   *   1. ROLE — the Speaker/Spotlight big tile, a stage-fill layout, a
   *      pop-out (`isVrmSurfaceEligible`, unchanged).
   *   2. BUDGET — an AGENT tile on any stage surface (Gallery, sidebar,
   *      Presentation filmstrip) while the call's agent-tile count is within
   *      MAX_AGENT_FACE_CONTEXTS. This is the fix for "in video it was just
   *      the static avatar image": Gallery — the mode every show-video path
   *      lifts to — passed size "normal" and was therefore NEVER face
   *      eligible, so the branded talking puppet could not mount anywhere
   *      but the Speaker big tile. Tiles physically smaller than
   *      MIN_FACE_BOX_PX (the w-32 filmstrip) still refuse a renderer
   *      before any WebGL context exists, and humans never mount WebGL. */
  const faceEligible =
    isVrmSurfaceEligible({ size, fill, inPopout }) ||
    (isAgentTile && agentFaceBudgetOk);
  /* WHICH CHARACTER this tile draws. The worker's LiveKit identity is
   * TYPE-shaped (verified on dogfood: it joins as `stable-brigade`;
   * registry.py accepts as `agent-<agent_type>`) — it does not name the
   * persona. Keying art off it resolved no puppet, no portrait and no roster
   * row, which is exactly why Majik rendered as the generic 2D unicorn on
   * every call. The room's `brigade_agent_id` (the same metadata the server
   * dispatched the worker from) is the persona fallback; a persona-shaped
   * identity like `agent-majik` still wins when it resolves art itself. */
  const roomBrigadeAgentId = useAppStore((s) =>
    isAgentTile
      ? (s.rooms.find((r) => r.id === roomId)?.brigade_agent_id ?? null)
      : null,
  );
  /* Is this tile a room GUEST? A LiveKit token carries no guest marker — a
   * guest joins with an ordinary identity on purpose, so presence and the
   * occupancy webhook treat them like anyone else — so the badge has to come
   * from the member roster, joined on `<username>_<participant id>`. Computed
   * INSIDE the selector so the subscription's value is a stable boolean rather
   * than a new array on every store write. */
  const isGuestTile = useAppStore((s) =>
    isGuestCallIdentity(p.id, s.participants[roomId]),
  );
  const tileMember = useAppStore((s) =>
    (s.participants[roomId] ?? []).find((m) => memberMatchesCallIdentity(m, p.id)),
  );
  /* The room's agent MEMBERS — persona fallback #3. `brigade_agent_id` above
   * comes off the sidebar LIST row, which an in-room invite does not refresh
   * (BrigadeAgentPicker heals it now, but a room invited before that fix, or a
   * list that simply hasn't refetched, still reads null). The membership
   * roster is created server-side at invite time and re-fetched on every
   * member event, so it names the resident persona — this is what fixed the
   * group-DM call where Majik rendered as the green generic head. */
  const roomMembers = useAppStore((s) =>
    isAgentTile ? s.participants[roomId] : undefined,
  );
  const agentMembers = useMemo<RoomAgentMember[]>(
    () =>
      (roomMembers ?? [])
        .filter((m) => m.participant_type === "agent")
        .map((m) => ({
          slug:
            (m as { brigade_agent_id?: string }).brigade_agent_id ||
            (m.username ?? "").replace(/^agent-/, ""),
          name: m.display_name,
          /* The member row's own picture. A slug can name a WHOLE CLASS of
           * residents (`claude-code` is every Claude Code seat we have), so
           * this row is the finest grain the art has — see the artUrl note on
           * CallTilePersona. */
          avatarUrl: m.avatar_url,
        })),
    [roomMembers],
  );
  const persona: CallTilePersona = isAgentTile
    ? resolveCallTilePersona(p.id, p.name, roomBrigadeAgentId, agentMembers)
    : { slug: p.id.replace(/^agent-/, ""), name: p.name };
  const agent = useAppStore((s) =>
    isAgentTile
      ? s.agents.find((candidate) => candidate.id === persona.slug)
      : undefined,
  );
  const tileNameMode = useTileChromePrefs().tileNames;

  // Compose the LiveKit attach ref with the PiP ref on ONE <video> (audit §4a).
  // useMergedVideoRef memoizes internally (CONTRACT §3.1) so the track isn't
  // detached+reattached every render; safe to call unconditionally with an
  // undefined attach ref (the <video> only renders when showVideoEl anyway).
  // The third ref just records the element; it is a useCallback with no deps, so
  // it is stable and does not break that memoization.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const captureVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
  }, []);
  const composedVideoRef = useMergedVideoRef(
    videoRef,
    pip.videoRef,
    captureVideoEl,
    // Registers the <video> for the iPhone fullscreen rung; stable identity,
    // so the memoization above still holds.
    fs.videoRef,
  );

  /* A PUBLISHED-BUT-EMPTY AGENT VIDEO TRACK. NOT FLAG-GATED — this is a bug fix.
   *
   * Root cause, traced end to end: `agents/agent_runtime/stage.py` publishes the
   * agent's STAGE track (its "show my work" display) with
   * `TrackSource.SOURCE_CAMERA`, from the moment the agent joins, forever, and
   * its default content is `_render_blank()` — a 1280x720 fill of #0f1117.
   * Rec.601 luma of #0f1117 is 17.09; sampled off the live tile it reads 17.3
   * with a spread of 0.0. The web client's `getCameraTrack` sees a camera-source
   * video and paints it as the agent's FACE.
   *
   * That is the black rectangle Aaron keeps hitting, and it is why every avatar
   * improvement has been invisible in the one place it matters most: the
   * <Avatar> branch below was simply unreachable for agents. It also explains
   * his popout repro — "when I did a popout it appeared, and also when I popped
   * back in, but it disappeared". A remount paints the avatar first, then the
   * track subscribes, `showVideoEl` flips, and the dead video covers the face.
   *
   * The publisher is fixed too (stage.py now publishes lazily), but the client
   * must not depend on that: an old worker, a mid-rollout room, or any future
   * track that goes quiet has to degrade to a face rather than to a hole.
   *
   * So "is there a video" is the wrong question. "Is there a PICTURE" is the
   * right one, and the only honest way to ask is to look at the pixels: 576
   * luma samples every 500 ms, on agent tiles only.
   *
   * Three details that matter —
   *
   *   * The <video> stays MOUNTED, just parked at 1px/opacity-0. Unmounting
   *     detaches the track and we could never notice a real picture arriving;
   *     parked, it keeps decoding, and the moment it has content the face steps
   *     aside and the camera takes the tile back. This is also what makes the
   *     remount race unwinnable in the bad direction: the state starts at
   *     "no picture", so the face paints first and only yields to a real feed.
   *   * setInterval, not requestAnimationFrame — rAF does not fire in a hidden
   *     tab, and this must settle in a background window, in a pop-out that has
   *     lost focus, and under automation.
   *   * If the pixels cannot be read we assume there IS a picture. Failing
   *     toward showing a real feed is the safe direction. */
  const [videoHasPicture, setVideoHasPicture] = useState(false);
  useEffect(() => {
    if (!isAgentTile || !showVideoEl) {
      setVideoHasPicture(false);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let last = false;
    let warned = false;

    const sample = (): boolean => {
      const el = videoElRef.current;
      if (!el || el.videoWidth === 0 || el.readyState < 2) return false;
      if (!ctx) return true;
      try {
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return frameHasPicture(frameLumaStats(data));
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn("[talking-face] cannot inspect video pixels", e);
        }
        return true;
      }
    };

    const check = () => {
      const live = sample();
      if (live !== last) {
        last = live;
        setVideoHasPicture(live);
      }
    };
    check();
    const id = window.setInterval(check, 500);
    return () => window.clearInterval(id);
  }, [isAgentTile, showVideoEl, videoRef]);

  /** The tile is showing a video element with nothing in it. */
  const videoIsBlank = showVideoEl && isAgentTile && !videoHasPicture;

  /* Transient "Face: …" toast after the per-tile style cycle — the immediate
   * confirmation of what the click just did, since the face itself may take a
   * beat to remount. State is per tile; the PREFERENCE it announces is global. */
  const [faceStyleFlash, setFaceStyleFlash] = useState<string | null>(null);
  const faceFlashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(faceFlashTimer.current), []);
  const flashFaceStyle = useCallback((label: string) => {
    setFaceStyleFlash(label);
    window.clearTimeout(faceFlashTimer.current);
    faceFlashTimer.current = window.setTimeout(
      () => setFaceStyleFlash(null),
      1600,
    );
  }, []);

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
        "group relative flex w-full items-center justify-center overflow-hidden bg-surface-1/80 transition-all",
        immersive ? "rounded-none border-0" : "rounded-2xl border border-line",
        fs.isFullscreen ? "h-full" : fill ? "h-full" : "aspect-video",
        onClick && "cursor-pointer",
      )}
      style={immersive ? undefined : ringStyle}
    >
      {showVideoEl && (
        <video
          ref={composedVideoRef}
          autoPlay
          playsInline
          muted
          className={clsx(
            "h-full w-full",
            fs.isFullscreen && !immersive ? "object-contain" : "object-cover",
            // Mounted but parked while it has no frames — see videoIsBlank.
            videoIsBlank && "pointer-events-none absolute h-px w-px opacity-0",
          )}
        />
      )}
      {showVideoEl && !videoIsBlank ? null : isAgentTile ? (
        /* Agent tiles: the presence-face ladder, always.
         *
         * `surface` is the WebGL gate — stage-class tiles only, decided by the
         * tile's ROLE (large / fill / pop-out), never by its pixel size, since
         * normal and filmstrip tiles are 64px and would otherwise each take a
         * WebGL context. The flag itself is read inside AgentPresenceFace and
         * controls only whether that rung is reachable; with it off this renders
         * the portrait, or the animated unicorn, or initials — but always a
         * face. Humans are untouched and keep the plain <Avatar>. */
        <AgentPresenceFace
          /* The REAL LiveKit identity — the mouth is driven off this
           * participant's live audioLevel, so it must never be the persona. */
          participantId={p.id}
          /* The PERSONA — what character the art lookups resolve. */
          id={persona.slug}
          name={persona.name}
          avatarUrl={agent?.avatar_url}
          /* The art THIS participant's member row names, which outranks the
           * slug's when it names a puppet we ship. Rook's seat is why: his
           * username resolves to `claude-code`, a slug shared with every other
           * Claude Code resident and bound to the generic Claude drawing, so
           * without this his tile animates somebody else's face. */
          artUrl={persona.artUrl}
          emoji={agent?.emoji}
          size={size === "large" ? 96 : 64}
          surface={faceEligible ? "stage" : "filmstrip"}
          expression={mapAgentState(null, {
            isSpeaking: speaking && !p.isMuted,
          })}
          isSpeaking={speaking && !p.isMuted}
          alt=""
        />
      ) : (
        <Identity
          {...resolveIdentity(
            tileMember ?? {
              id: p.id,
              display_name: p.name,
              participant_type: isGuestTile ? "guest" : "human",
            },
          )}
          size={size === "large" ? 96 : 64}
          className={clsx(speaking && !p.isMuted && "animate-pulse-soft")}
        />
      )}

      {/* Client name plate. The relay may also burn a name into an agent's
          video (voice_relay_face_plate); that one is the room's, and this
          setting does not remove it. The guest badge and the immersive mute
          mark stay when the name hides. */}
      {(tileNameMode !== "off" || isGuestTile || (immersive && p.isMuted)) && (
        <span
          className={clsx(
            "absolute flex max-w-[calc(100%-0.75rem)] items-center gap-1.5",
            immersive
              ? "left-3 top-14 max-w-[calc(100%-9rem)]"
              : "bottom-1.5 left-1.5",
          )}
        >
          <CallTileName
            name={isAgentTile ? persona.name : p.name}
            isLocal={p.isLocal && !isAgentTile}
            mode={tileNameMode}
            className={immersive ? "py-1" : "py-0.5"}
          />
          {immersive && p.isMuted && (
            <MicOff className="h-3 w-3 shrink-0 text-slate-100" />
          )}
          {isGuestTile && <GuestBadge />}
        </span>
      )}

      {/* Transient confirmation of a face-style cycle. aria-live so the mode
          change is announced, pointer-events-none so it never eats a click. */}
      {faceStyleFlash && (
        <span
          aria-live="polite"
          className="glass pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-100"
        >
          Face: {faceStyleFlash}
        </span>
      )}

      {/* CONSENT, not chrome. Top-centre so it never collides with the pin
          (top-left) or the control cluster (top-right), and so it is the first
          thing you see on your own tile. Always visible — never hover-revealed,
          never hidden inside a pop-out: being streamed is not a detail. */}
      {isBroadcasting && (
        <span
          className={clsx("pointer-events-none absolute flex items-center gap-1 whitespace-nowrap rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-pop", immersive ? "left-3 top-24" : "left-1/2 top-1.5 -translate-x-1/2")}
          title={broadcastBadgeTitle(p.name, viewerCount)}
        >
          <span aria-hidden="true" className="text-[8px] leading-none">
            ●
          </span>
          Broadcasting
        </span>
      )}

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
      {!immersive && p.isMuted && (
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
          immersive ? "hidden" : "absolute right-1.5 top-1.5 flex items-center gap-1",
          inPopout
            ? "opacity-100"
            : "transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100",
        )}
      >
        {/* Agent tiles only: cycle the face style (writes the global
            preference). First in the cluster — it's about the face the tile
            shows, so it reads before the layout controls. */}
        {isAgentTile && <FaceStyleTileButton onCycled={flashFaceStyle} />}
        {/* Owner/admin only: mute, silence, deafen, or remove this
            participant from the live call. Not rendered inside a pop-out —
            the menu portals to the main document, so it would be dropped
            into a window that cannot show it. */}
        {onModerate && !inPopout && (
          <CallModerationMenu
            targetName={p.name}
            onAction={onModerate}
            isAgentTarget={isAgentTile}
            micMuted={p.isMuted}
          />
        )}
        {/* Owner-only: mint a URL an OBS browser source can point at. Solves
            the window-id orphaning that made pop-out capture unusable on a
            live show — see components/Broadcast/BroadcastPage.tsx. */}
        {onCopyBroadcastUrl && (
          <BroadcastCopyMenu
            targetName={p.name}
            isBroadcasting={isBroadcasting}
            viewerCount={viewerCount}
            maxViewersPerLink={maxViewersPerLink}
            onCopy={onCopyBroadcastUrl}
          />
        )}
        {onTogglePin && (
          <TileControlButton
            icon={isPinned ? PinOff : Pin}
            label={
              isPinned ? `Unpin ${p.name}` : `Pin ${p.name} to the big tile`
            }
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
        {onPopOut && (p.videoTrack || isAgentTile) && (
          <TileControlButton
            icon={ExternalLink}
            label={`Pop out ${p.name} to its own window`}
            title={`Pop out to window — opens ${p.name}${p.videoTrack ? "’s camera" : ""} in a separate window you can drag to another monitor (different from “Picture in picture”, which floats a small always-on-top thumbnail)`}
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
  const { claimScreenAudio, releaseScreenAudio, selectedDevices } =
    useStableRoom();
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    audioTrack.attach(el);
    const sinkable = el as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (selectedDevices.audiooutput && sinkable.setSinkId) {
      void sinkable.setSinkId(selectedDevices.audiooutput);
    }
    claimScreenAudio(audioTrack);
    return () => {
      audioTrack.detach(el);
      releaseScreenAudio(audioTrack);
    };
  }, [
    audioTrack,
    claimScreenAudio,
    releaseScreenAudio,
    selectedDevices.audiooutput,
  ]);

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
  const fs = useTileFullscreen();
  const tileNameMode = useTileChromePrefs().tileNames;
  // fs.videoRef registers the <video> for the iPhone fullscreen rung.
  const composedVideoRef = useMergedVideoRef(
    videoRef,
    pip.videoRef,
    fs.videoRef,
  );

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

      <TileNamePlate
        mode={tileNameMode}
        className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] py-0.5 text-stable-cyan"
      >
        <MonitorUp className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </TileNamePlate>

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
  /** Persona resolution — see ParticipantTile's roomBrigadeAgentId note. */
  roomId: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
}

function AudioChip({
  id,
  name,
  roomId,
  isAgent,
  isSpeaking,
  isMuted,
}: AudioChipProps) {
  const ident = identityFor(id.replace(/^agent-/, ""), name);
  // Same persona resolution as the stage tile: the worker's type-shaped
  // LiveKit identity ("stable-brigade") names no character, so the chip in
  // the AUDIO layout — where an audio call now lives — must resolve the
  // room's resident brigade agent to show Majik's art and name, not initials.
  const roomBrigadeAgentId = useAppStore((s) =>
    isAgent
      ? (s.rooms.find((r) => r.id === roomId)?.brigade_agent_id ?? null)
      : null,
  );
  /* Same roster join as the video tile — the audio layout must not disagree
   * with it about who in the call is a guest. */
  const isGuestChip = useAppStore((s) =>
    isGuestCallIdentity(id, s.participants[roomId]),
  );
  const chipMember = useAppStore((s) =>
    isAgent
      ? undefined
      : (s.participants[roomId] ?? []).find((m) => memberMatchesCallIdentity(m, id)),
  );
  // Member-roster fallback, same as ParticipantTile — the audio layout must
  // not name the character differently than the video tile does.
  const roomMembers = useAppStore((s) =>
    isAgent ? s.participants[roomId] : undefined,
  );
  const agentMembers = useMemo<RoomAgentMember[]>(
    () =>
      (roomMembers ?? [])
        .filter((m) => m.participant_type === "agent")
        .map((m) => ({
          slug:
            (m as { brigade_agent_id?: string }).brigade_agent_id ||
            (m.username ?? "").replace(/^agent-/, ""),
          name: m.display_name,
          avatarUrl: m.avatar_url,
        })),
    [roomMembers],
  );
  const persona: CallTilePersona = isAgent
    ? resolveCallTilePersona(id, name, roomBrigadeAgentId, agentMembers)
    : { slug: id.replace(/^agent-/, ""), name };
  const agent = useAppStore((s) =>
    isAgent
      ? s.agents.find((candidate) => candidate.id === persona.slug)
      : undefined,
  );
  return (
    <div
      className={clsx(
        "relative flex shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 transition-all",
        !isSpeaking && "border-transparent bg-surface-2/70",
      )}
      style={
        isSpeaking
          ? { background: ident.faint, borderColor: ident.ring }
          : undefined
      }
    >
      <Identity
        {...(isAgent
          ? resolveIdentity({
              id: persona.slug,
              display_name: persona.name,
              avatar_url: agent?.avatar_url,
              art_url: persona.artUrl,
              participant_type: "agent",
            })
          : resolveIdentity(
              chipMember ?? {
                id,
                display_name: persona.name,
                participant_type: isGuestChip ? "guest" : "human",
              },
            ))}
        size={32}
        className={clsx(isSpeaking && !isMuted && "animate-pulse-soft")}
      />
      <span className="max-w-[10ch] truncate text-xs font-medium text-slate-200">
        {id === "local" ? localTilePlate(persona.name) : persona.name}
      </span>
      {isGuestChip && <GuestBadge />}
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

/** Stage region that can host the lower third without joining the filmstrip. */
function StageFrame({
  children,
  chrome,
  className,
}: {
  children: ReactNode;
  chrome?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        className,
      )}
    >
      {children}
      {chrome}
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
    runnerVoiceCanonicalOnly: runnerVoiceNotice,
    version,
    startAudio,
    disconnect,
  } = useStableRoom(roomId);
  const { startCanonicalCall } = useDirectCall();
  const roomMeta = useAppStore((s) => s.rooms.find((item) => item.id === roomId));
  const runnerSeatLabel =
    roomMeta?.agent_members?.find(
      (member) => member.agent_id === runnerVoiceNotice?.seat,
    )?.display_name ?? runnerVoiceNotice?.seat;
  // One-click device switching from the call bar (chevron beside mic/cam).
  const { devices, selectedDevices, switchDevice, repairAudio } = useVoice();

  // Call-UI state.
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const showVideo = useCallUiStore((s) => s.showVideo);
  const toggleVideo = useCallUiStore((s) => s.toggleVideo);
  const showTranscript = useCallUiStore((s) => s.showTranscript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);
  const mobileCallMode = useCallUiStore((s) => s.mobileCallMode);
  const mobileCallModeUserOverride = useCallUiStore(
    (s) => s.mobileCallModeUserOverride,
  );
  const setMobileCallMode = useCallUiStore((s) => s.setMobileCallMode);
  const hiddenTileIds = useCallUiStore((s) => s.hiddenTileIds);
  const setTileHidden = useCallUiStore((s) => s.setTileHidden);
  const focusedParticipantId = useCallUiStore((s) => s.focusedParticipantId);
  const pinnedId = useCallUiStore((s) => s.pinnedParticipantId[roomId] ?? null);
  const setPopoutOpen = useCallUiStore((s) => s.setPopoutOpen);
  const videoPrompted = useCallUiStore((s) => s.videoPrompted);
  const setVideoPrompted = useCallUiStore((s) => s.setVideoPrompted);
  const setAnyVideoLive = useCallUiStore((s) => s.setAnyVideoLive);

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

  const accountDisplayName = useAppStore(
    (s) => s.currentUser?.displayName ?? null,
  );
  const accountUsername = useAppStore((s) => s.currentUser?.username ?? null);
  const roster = useAppStore((s) => s.agents);
  const callRoom = useAppStore(
    (s) => s.rooms.find((r) => r.id === roomId) ?? null,
  );
  const tileChrome = useTileChromePrefs();
  // The local tile used to hardcode "You". Everyone else already sees the
  // display name LiveKit was minted with; this is that same name.
  const localName = resolveLocalDisplayName({
    displayName: accountDisplayName,
    liveKitName: localParticipant?.name,
    username: accountUsername,
  });

  /* ---------------------------------------------------------------- *
   * Broadcast feeds (OBS)
   * ---------------------------------------------------------------- */

  // Who is being streamed right now — the consent surface, read by every
  // member. Drives the "● Broadcasting" badge on the tiles below.
  const {
    isBroadcasting,
    viewerCountFor,
    maxViewersPerLinkFor,
    refresh: refreshBroadcasts,
  } =
    useRoomBroadcasts(roomId);

  // Minting is OWNER-only on the server. Read the caller's own membership row
  // (server-flagged is_self, the only reliable "this is me" marker — the
  // Keycloak id never equals the participant UUID) so a member never sees a
  // control that can only 403.
  const roomMembers = useAppStore((s) => s.participants[roomId]);
  const isRoomOwner = roomMembers?.find((m) => m.is_self)?.role === "owner";
  // Moderation is the owner/admin tier — the same ladder the server enforces.
  const isRoomModerator = ["owner", "admin"].includes(
    roomMembers?.find((m) => m.is_self)?.role ?? "",
  );

  const [mintingFor, setMintingFor] = useState<string | null>(null);

  /**
   * Mint a broadcast token for ONE participant and put the absolute URL on the
   * clipboard, ready to paste into an OBS browser source.
   *
   * Minted on demand rather than reusing an existing token: the raw value is
   * returned exactly once (the server stores only its SHA-256), so there is no
   * "show me the link again" — copying is minting.
   */
  /**
   * Run one moderation action against a live-call participant.
   *
   * Reports the OUTCOME, not the request: a mute that touched no audio track
   * (their mic was never on) says so rather than claiming success, because a
   * moderator who believes someone is muted when they are not is exactly the
   * failure this control exists to prevent.
   */
  const moderateParticipant = useCallback(
    async (identity: string, label: string, action: CallModerationAction) => {
      const verb: Record<CallModerationAction, string> = {
        mute_mic: "Muted",
        unmute_mic: "Unmuted",
        silence: "Silenced",
        unsilence: "Unsilenced",
        deafen: "Deafened",
        undeafen: "Undeafened",
        remove_from_call: "Removed",
      };
      try {
        const result = await api.moderateCallParticipant(
          roomId,
          identity,
          action,
        );
        const noAudio =
          (action === "mute_mic" || action === "silence") &&
          result.muted_track_sids.length === 0;
        useAppStore.getState().pushToast({
          title: `${verb[action]} ${label}`,
          body:
            action === "unsilence"
              ? "They can publish again. Their mic stays off until they turn it back on."
              : noAudio
                ? action === "silence"
                  ? "They had no mic open; publishing is now revoked, so they cannot open one."
                  : "They had no mic open — nothing to mute."
                : undefined,
          kind: "success",
        });
      } catch (err) {
        useAppStore.getState().pushToast({
          title: `Could not ${action.replace(/_/g, " ")} ${label}`,
          body:
            (err as { message?: string })?.message ||
            "The server refused the action.",
          kind: "error",
        });
      }
    },
    [roomId],
  );

  const copyBroadcastUrl = useCallback(
    async (
      identity: string,
      label: string,
      variant: BroadcastCopyVariant,
    ) => {
      if (mintingFor) return;
      const config = broadcastCopyVariantConfig(variant);
      setMintingFor(identity);
      try {
        const minted = await api.mintBroadcastToken({
          room: roomId,
          participant_identity: identity,
          participant_label: label,
          allow_audio: config.allowAudio,
          label: `OBS · ${label}`,
        });
        const userId = useAppStore.getState().currentUser?.id;
        const roomMeta =
          useAppStore.getState().rooms.find((r) => r.id === roomId)?.metadata_ ??
          null;
        const url = withLowerThirdParam(
          buildBroadcastUrl({
            origin: window.location.origin,
            roomId: minted.room_id,
            participantIdentity: minted.participant_identity,
            token: minted.token,
            source: config.source,
            audio: config.audio,
          }),
          readTileChromePrefs(userId).lowerThird || roomLowerThirdOptIn(roomMeta),
        );
        const copied = await copyTextToClipboard(url);
        refreshBroadcasts();
        useAppStore.getState().pushToast(
          copied
            ? {
                title: `${config.label} link copied — ${label}`,
                body: `Paste it into an OBS browser source. It is a credential: anyone with the link can watch this ${config.source === "screen" ? "screen share" : "camera"} until it expires or you revoke it.${config.source === "screen" ? " The page stays black until a screen share starts." : ""}`,
                kind: "success",
              }
            : {
                // The clipboard API is absent in an insecure context (plain-HTTP
                // LAN self-hosts). Never swallow that — the URL is minted and
                // unrecoverable, so it has to be readable somewhere.
                title: `Couldn't reach the clipboard — copy the ${config.label.toLowerCase()} link by hand`,
                body: `${url}${config.source === "screen" ? "\n\nThe page stays black until a screen share starts." : ""}`,
                kind: "error",
                sticky: true,
              },
        );
      } catch (error) {
        const err = error as ApiError;
        useAppStore.getState().pushToast({
          title: `Couldn't create the ${config.label.toLowerCase()} link`,
          body:
            (typeof err?.detail === "string" && err.detail) ||
            err?.message ||
            "Request failed",
          kind: "error",
        });
      } finally {
        setMintingFor(null);
      }
    },
    [mintingFor, roomId, refreshBroadcasts],
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
        name: localName || "You",
        isAgent: false,
        isAgentKind: false,
        isLocal: true,
        isSpeaking: localParticipant.isSpeaking,
        isMuted: !localParticipant.isMicrophoneEnabled,
        videoTrack: getCameraTrack(
          Array.from(localParticipant.trackPublications.values()),
        ),
        metadata: localParticipant.metadata ?? "",
      });
    }
    for (const p of remoteParticipants) {
      const agent = matchAgent(p.identity);
      out.push({
        id: p.identity,
        sid: p.sid,
        name: agent?.name || p.name || p.identity,
        isAgent: !!agent,
        isAgentKind: isAgentParticipant(p),
        isLocal: false,
        isSpeaking: p.isSpeaking,
        isMuted: !p.isMicrophoneEnabled,
        videoTrack: getCameraTrack(Array.from(p.trackPublications.values())),
        metadata: p.metadata ?? "",
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    localParticipant,
    remoteParticipants,
    version,
    matchAgent,
    getCameraTrack,
    localName,
  ]);

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
      setActiveSpeakerIds(
        speakers.map((s) => (s.isLocal ? "local" : s.identity)),
      );
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
        const screenName = localName || "You";
        out.push({
          sid: multi ? `local-screen:${trackSid}` : "local-screen",
          feedId: multi ? `local-screen:${trackSid}` : "local-screen",
          label: multi
            ? `${screenName} — screen ${i + 1}`
            : `${screenName} — screen`,
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
  }, [localParticipant, remoteParticipants, version, matchAgent, localName]);

  const hasAnyVideo = useMemo(
    () => participants.some((p) => p.videoTrack) || screenShares.length > 0,
    [participants, screenShares],
  );

  // WebGL-face budget: agent tiles may talk on ANY stage surface while the
  // call has few enough agents that one context each stays cheap. Counts the
  // same robust agent-ness the tiles use (identity/kind/roster).
  // Spent, not forfeited: over the limit the budget goes to whoever is
  // SPEAKING plus the next tiles in stable order, instead of every agent
  // losing its face at once (a six-agent show room used to animate nobody).
  const agentFaceBudgetIds = useMemo(() => {
    const agentIds = participants
      .filter((p) => isAgentIdentity(p.id) || p.isAgentKind || p.isAgent)
      .map((p) => p.id);
    const speaking = agentIds.find((id) => speakingIds.has(id)) ?? null;
    return agentFaceBudget(agentIds, speaking);
  }, [participants, speakingIds]);

  // Mirror the REAL video-presence signal into the call-UI store so layout
  // decisions (CallRoomLayout's audio-first intent) can tell an audio call
  // from a video call without reaching into LiveKit track state. Cleared on
  // call change by setActiveCallRoom; kept false while disconnected.
  useEffect(() => {
    setAnyVideoLive(isConnected && hasAnyVideo);
  }, [isConnected, hasAnyVideo, setAnyVideoLive]);

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
  const isLandscape = useIsLandscape();
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
      const mode = usePanelChromeStore.getState().getPanel(roomId, "stage").mode;
      if (mode === "popped") {
        usePanelChromeStore.getState().setPanelMode(roomId, "stage", "docked");
      }
    },
  });
  const roomPanels = useRoomPanels(roomId);
  const openStageRef = useRef<() => boolean>(() => false);
  const closeStageRef = useRef<() => void>(() => {});
  const stageIsOpenRef = useRef(false);
  stageIsOpenRef.current = popout.isOpen;
  useEffect(() => {
    return registerPanelOpener(roomId, "stage", {
      open: () => openStageRef.current(),
      close: () => closeStageRef.current(),
      isOpen: () => stageIsOpenRef.current,
    });
  }, [roomId]);

  // Per-feed windows: N open at once, one per camera / screen share.
  const feedPopouts = useFeedPopouts();
  const { openKeys: poppedFeedKeys, isOpen: isFeedPoppedOut } = feedPopouts;
  const feedPopoutClose = feedPopouts.close;
  const feedPopoutCloseAll = feedPopouts.closeAll;

  // Every feed that currently EXISTS and is therefore poppable.
  const liveFeedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const p of participants) {
      /* An AGENT is a poppable feed whether or not it has a camera track: its
       * presence face IS the feed, and putting a colleague's face on a second
       * monitor is exactly what pop-out is for. Before the stage-track fix an
       * agent tile qualified here by accident, via the blank camera track it
       * should never have been publishing; without this it would silently lose
       * an affordance Aaron actively uses. */
      if (p.videoTrack || p.isAgentKind || p.isAgent || isAgentIdentity(p.id)) {
        keys.add(camFeedKey(p.id));
      }
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
      if (
        viewMode !== "screen" &&
        viewMode !== "grid" &&
        viewMode !== "spotlight"
      ) {
        setViewMode(roomId, "screen");
      }
    }
  }

  function openPopout(): boolean {
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
    if (!popout.open()) return false;
    if (showChips) {
      // Record the pre-pop-out view BEFORE mutating it so closing the window
      // restores it (setViewMode persists — see `popoutPriorViewRef`).
      popoutPriorViewRef.current = { mode: viewMode, showVideo };
      toggleVideo(true);
      if (viewMode === "compact") setViewMode(roomId, "grid");
    }
    setPopoutOpen(roomId, true);
    return true;
  }
  function bringBackPopout() {
    // `close()` runs the handle's teardown synchronously, which fires the
    // `onClose` above → `restorePrePopoutView()`. No second restore here.
    popout.close();
    setPopoutOpen(roomId, false);
  }
  openStageRef.current = openPopout;
  closeStageRef.current = bringBackPopout;

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
    screenShares.find((s) => s.sid === stageScreenSid) ??
    screenShares[0] ??
    null;

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
      immersive?: boolean;
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
    // `p.id` is "local" for yourself — a UI label, not a LiveKit identity. A
    // broadcast token is scoped to the REAL identity ("<username>_<pid>"), so
    // minting one against "local" would produce a URL that renders nobody.
    const lkIdentity = p.isLocal ? (localParticipant?.identity ?? null) : p.id;
    const viewerCount = viewerCountFor(lkIdentity);
    const maxViewersPerLink = maxViewersPerLinkFor(lkIdentity);
    // The tile may read "Aaron (you)"; the token list should say the name.
    const lkLabel = p.isLocal ? localParticipant?.name || p.name : p.name;
    return (
      <ParticipantTile
        key={p.id}
        p={p}
        roomId={roomId}
        isBroadcasting={isBroadcasting(lkIdentity)}
        viewerCount={viewerCount}
        maxViewersPerLink={maxViewersPerLink}
        onCopyBroadcastUrl={
          isRoomOwner && lkIdentity
            ? (variant) => void copyBroadcastUrl(lkIdentity, lkLabel, variant)
            : undefined
        }
        onModerate={
          // Never your own tile: the server refuses self-moderation, and
          // offering a control that always errors is worse than no control.
          isRoomModerator && lkIdentity && !p.isLocal
            ? (action) => void moderateParticipant(lkIdentity, lkLabel, action)
            : undefined
        }
        agentFaceBudgetOk={agentFaceBudgetIds.has(p.id)}
        size={opts?.size ?? "normal"}
        fill={opts?.fill}
        immersive={opts?.immersive}
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
    opts?: {
      size?: "normal" | "large";
      onClick?: () => void;
      grip?: boolean;
      fill?: boolean;
      immersive?: boolean;
    },
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
        onToggleMuted={
          s.audioTrack ? () => toggleScreenMuted(s.sid) : undefined
        }
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
  function renderScreen(
    s: ScreenShareVM,
    opts?: { fill?: boolean; onClick?: () => void },
  ) {
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
      return p
        ? buildTile(p, { fill: true, inPopout: true, size: "large" })
        : null;
    }
    if (feedKey.startsWith("screen:")) {
      const fid = feedKey.slice("screen:".length);
      // Resolve by feedId — the field the key was minted from. Matching sid
      // here is the bug that blanked every remote share's pop-out window.
      const s = screenShares.find((x) => x.feedId === fid);
      if (!s) {
        // A miss while the reaper still counts this key alive means key-shape
        // drift (this exact class of bug). Say so in the window instead of
        // silently rendering an empty frame nobody can diagnose.
        console.warn("popout: no feed for live key", feedKey);
        return (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            This feed is no longer available.
          </div>
        );
      }
      return buildScreen(s, { fill: true, inPopout: true });
    }
    return null;
  }

  const remotes = participants.filter((p) => !p.isLocal);
  const self = participants.find((p) => p.isLocal);
  const portraitOneToOne = shouldUsePortraitStage({
    desktop: isDesktop, landscape: isLandscape, mode: mobileCallMode,
    remoteCount: remotes.length, screenCount: screenShares.length,
    view: viewMode, chips: showChips,
  });

  const lowerOptIn =
    tileChrome.lowerThird || roomLowerThirdOptIn(callRoom?.metadata_ ?? null);
  const activeSpeaker =
    participants.find((p) => p.id === liveSpeakerId) ?? null;
  const speakerIdentity = activeSpeaker
    ? activeSpeaker.isLocal
      ? (localParticipant?.identity ?? "")
      : activeSpeaker.id
    : "";
  const speakerMember = speakerIdentity
    ? roomMembers?.find((m) => memberMatchesCallIdentity(m, speakerIdentity))
    : undefined;
  const speakerName = activeSpeaker
    ? activeSpeaker.isLocal
      ? localName || "You"
      : activeSpeaker.name
    : "";
  const speakerSubtitle = activeSpeaker
    ? resolveLowerThirdSubtitle({
        isAgent:
          activeSpeaker.isAgent ||
          activeSpeaker.isAgentKind ||
          isAgentIdentity(activeSpeaker.id),
        agentRole: agentRosterRole(
          activeSpeaker.id,
          activeSpeaker.name,
          roster,
          callRoom?.brigade_agent_id,
        ),
        humanTitle: humanTitleFromMember(speakerMember),
        metadata: activeSpeaker.metadata,
      })
    : null;
  const stageLowerThird = (region: "stage" | "filmstrip" = "stage") => (
    <StageLowerThird
      optedIn={lowerOptIn}
      layout={lowerThirdLayoutForCall({ viewMode, showChips, region })}
      speakerId={activeSpeaker?.id ?? null}
      name={speakerName}
      subtitle={speakerSubtitle}
      className={portraitOneToOne ? "bottom-28" : undefined}
    />
  );

  // ---- The stage surface (the pop-out-able tiles), per mode -----------------

  let stageSurface: ReactNode = null;
  if (!showChips) {
    if (portraitOneToOne) {
      stageSurface = (
        <StageFrame chrome={stageLowerThird("stage")}>
          <PortraitCallStage
            remote={renderTile(remotes[0]!, { fill: true, size: "large", immersive: true })}
            self={self ? renderTile(self, { fill: true }) : undefined}
          />
        </StageFrame>
      );
    } else if (viewMode === "grid") {
      // Gallery: equal, paginated, drag-to-reorder tiles.
      stageSurface = (
        <StageFrame chrome={stageLowerThird("stage")}>
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
        </StageFrame>
      );
    } else if (viewMode === "focus" || viewMode === "spotlight") {
      // Speaker / Spotlight: one big tile + a filmstrip of the rest.
      // The lower third sits on the stage, never in the filmstrip.
      stageSurface = (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <StageFrame chrome={stageLowerThird("stage")}>
            {focused && renderTile(focused, { size: "large", fill: true })}
          </StageFrame>
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
        <div className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {screenShares.map((s) => renderScreen(s))}
          {orderedParticipants.map((p) => renderTile(p))}
          {stageLowerThird("stage")}
        </div>
      );
    } else if (viewMode === "screen") {
      // Presentation: a screen share fills the stage + a people filmstrip.
      // The lower third sits on the shared screen, never in the filmstrip.
      stageSurface = stageScreen ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <StageFrame chrome={stageLowerThird("stage")}>
            {renderScreen(stageScreen, { fill: true })}
          </StageFrame>
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
          <StageFrame chrome={stageLowerThird("stage")}>
            <VideoGrid
              items={orderedParticipants.map((p) => ({
                key: p.id,
                node: renderTile(p),
              }))}
            />
          </StageFrame>
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
          roomId={roomId}
          /* Robust agent-ness (identity/kind), not just the roster match —
           * p.isAgent is false whenever the Brigade roster query misses. */
          isAgent={isAgentIdentity(p.id) || p.isAgentKind || p.isAgent}
          isSpeaking={speakingIds.has(p.id)}
          isMuted={p.isMuted}
        />
      ))}
    </div>
  );

  // Safe chrome: mic / cam / leave always visible in mobile Video (even when
  // the extended control cluster fades). Extended chrome includes share, hide
  // video/chat, pop-out, and the view-mode switcher.
  const audioHealth = (
    <div className="flex items-center justify-center gap-2">
      <LiveMicMeter
        onDiagnostic={(value) => {
          if (!localParticipant) return;
          void api.reportVoiceDiagnostic(roomId, { ...value, participant_sid: localParticipant.sid,
            track_sid: localParticipant.getTrackPublication(Track.Source.Microphone)?.trackSid }).catch(() => {});
        }}
        track={
          localParticipant?.getTrackPublication(Track.Source.Microphone)?.track
            ?.mediaStreamTrack
        }
        muted={!isMicOn}
      />
      <button
        type="button"
        onClick={() => void repairAudio()}
        className="focus-ring rounded px-2 py-1 text-xs text-slate-200"
      >
        Repair audio
      </button>
    </div>
  );

  const safeControls = (
    <div className="glass flex max-w-full shrink-0 items-center justify-center gap-1.5 overflow-x-auto rounded-2xl p-1.5">
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
      <DevicePickerButton
        kind="audioinput"
        devices={devices.audioinput}
        selected={selectedDevices.audioinput}
        also={[
          {
            kind: "audiooutput",
            devices: devices.audiooutput,
            selected: selectedDevices.audiooutput,
          },
        ]}
        onSelect={switchDevice}
        size="lg"
      />
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
        {isCamOn ? (
          <Video className="h-5 w-5" />
        ) : (
          <VideoOff className="h-5 w-5" />
        )}
      </button>
      <DevicePickerButton
        kind="videoinput"
        devices={devices.videoinput}
        selected={selectedDevices.videoinput}
        onSelect={switchDevice}
        size="lg"
      />
      <ChatToggleButton roomId={roomId} size="lg" />
      <LayoutPresetMenu roomId={roomId} />
      <RecordMenu roomId={roomId} size="lg" />
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
            {isMicOn ? (
              <Mic className="h-5 w-5" />
            ) : (
              <MicOff className="h-5 w-5" />
            )}
          </button>
          <DevicePickerButton
            kind="audioinput"
            devices={devices.audioinput}
            selected={selectedDevices.audioinput}
            also={[
              {
                kind: "audiooutput",
                devices: devices.audiooutput,
                selected: selectedDevices.audiooutput,
              },
            ]}
            onSelect={switchDevice}
          />
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
            {isCamOn ? (
              <Video className="h-5 w-5" />
            ) : (
              <VideoOff className="h-5 w-5" />
            )}
          </button>
          <DevicePickerButton
            kind="videoinput"
            devices={devices.videoinput}
            selected={selectedDevices.videoinput}
            onSelect={switchDevice}
          />
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
          aria-label={isScreenSharing ? "Screen share options" : "Share screen"}
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
        {videoHidden ? (
          <EyeOff className="h-5 w-5" />
        ) : (
          <Eye className="h-5 w-5" />
        )}
      </button>

      {/* Chat on/off. The button's fill follows the registry: hidden means
          the stage is the full width. On a phone, Video hides chat and Split
          puts it below the stage — this never opens a sheet over the picture. */}
      {!mobileVideoChrome && <ChatToggleButton roomId={roomId} />}
      {!mobileVideoChrome && <LayoutPresetMenu roomId={roomId} />}
      {!mobileVideoChrome && <RecordMenu roomId={roomId} />}

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
          onClick={() => popPanel(roomId, "stage")}
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
      {!mobileVideoChrome && (
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
      {runnerVoiceNotice && (
        <div
          role="alert"
          className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-400/20 bg-amber-400/15 px-4 py-2 text-sm text-amber-200"
          data-testid="runner-voice-canonical-notice"
        >
          <span>
            {runnerSeatLabel} can take calls in {runnerVoiceNotice.canonical_room_name}
          </span>
          <button
            type="button"
            className="focus-ring rounded-md bg-amber-400/20 px-2 py-1 text-xs font-semibold transition-colors hover:bg-amber-400/30"
            onClick={() =>
              void startCanonicalCall({
                id: runnerVoiceNotice.canonical_room_id,
                name: runnerVoiceNotice.canonical_room_name,
              })
            }
          >
            Call in {runnerVoiceNotice.canonical_room_name}
          </button>
        </div>
      )}
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

      {/* External talk gate (foot pedal via the gateway): "<agent> can hear
          you" while held. Self-gating on the callUiStore talk-gate signal, so
          it renders nothing in the (overwhelmingly common) no-pedal case. */}
      <TalkGateIndicator roomId={roomId} />

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

      {/* Transcript / canvas-class panels read the call store through this
          portal. Mounted beside the stage host, not inside it, so the
          transcript split never enters the popped window. */}
      <PanelHost
        roomId={roomId}
        panelId="transcript"
        title="Transcript"
        present={
          roomPanels.transcript.mode === "docked"
            ? "hidden"
            : roomPanels.transcript.mode
        }
      >
        {roomPanels.transcript.mode === "popped" ||
        roomPanels.transcript.mode === "floating" ? (
          <TranscriptPanel />
        ) : null}
      </PanelHost>

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
          "relative flex min-h-0 flex-1",
          !portraitOneToOne && "border-b border-line bg-surface-1/70 backdrop-blur-md",
          portraitOneToOne ? "flex-col bg-black" : slim
            ? "flex-row items-center gap-3 px-4 py-2"
            : "flex-col gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
        role="region"
        aria-label="Voice and video call"
      >
        {showChips ? (
          <div
            className={clsx(
              "flex min-h-0 flex-1",
              slim ? "items-center" : "flex-col gap-2",
            )}
          >
            <div className="flex min-h-0 flex-1">{chipsRow}</div>
            {/* Stay mounted when captions hide. Unmounting dropped the scroll
                position; the split's collapsed pane is display:none for the
                same reason. */}
            <div
              className={clsx(
                showTranscript && roomPanels.transcript.mode === "docked"
                  ? "h-40 shrink-0 overflow-hidden rounded-xl border border-line"
                  : "hidden",
              )}
              hidden={!(showTranscript && roomPanels.transcript.mode === "docked")}
            >
              <TranscriptPanel />
            </div>
          </div>
        ) : (
          // The split stays in this window so the stage never remounts and
          // never rides into a pop-out. A popped transcript is only the panel
          // body, portaled by PanelHost below. The secondary stays mounted
          // while collapsed (display:none) so a caption toggle does not
          // remount TranscriptPanel.
          <SplitPane
            storageKey="call-transcript"
            orientation="vertical"
            defaultSize={168}
            min={96}
            max={360}
            collapsible
            collapsed={
              !(showTranscript && roomPanels.transcript.mode === "docked")
            }
            fullBleedWhenCollapsed
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
            portraitOneToOne ? "absolute inset-x-2 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 justify-center rounded-2xl bg-black/60 p-1" : slim ? "" : "justify-between pt-1",
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
          {isDesktop && <RecPillForRoom roomId={roomId} />}
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

        {!mobileVideoChrome && audioHealth}

        {/* Always-reachable safe chrome in mobile Video mode */}
        {mobileVideoChrome && (
          <div
            className={clsx(
              "flex shrink-0 justify-center pt-1 pb-[env(safe-area-inset-bottom)] transition-opacity duration-300",
              portraitOneToOne && "absolute inset-x-0 bottom-2 z-20",
              // When extended chrome is visible, Leave is in the extended row
              // already for desktop-style bars — here safeControls is the
              // permanent dock for mic/cam/leave.
            )}
          >
            <div className="rounded-2xl bg-black/70 p-1">
              {audioHealth}
              {safeControls}
            </div>
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
