import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Volume2,
  Bot,
  MonitorUp,
  EyeOff,
  Eye,
} from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import type { LocalTrack, RemoteTrack } from "livekit-client";
import { identityFor } from "@/lib/identity";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useCallUiStore } from "@/stores/callUiStore";
import { api, type BrigadeAgent } from "@/services/api";
import { CallViewSwitcher } from "./CallViewSwitcher";
import { TranscriptPanel } from "./TranscriptPanel";
import { VoiceAgentStatus } from "./VoiceAgentStatus";
import { VideoGrid } from "./VideoGrid";

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

interface ParticipantTileProps {
  p: CallParticipant;
  videoRef?: AttachRef;
  /** Render the per-tile hide control (grid/focus filmstrip). */
  onToggleHide?: () => void;
  /** Click the tile body (e.g. filmstrip → focus this participant). */
  onClick?: () => void;
  hidden?: boolean;
  size?: "normal" | "large";
}

function ParticipantTile({
  p,
  videoRef,
  onToggleHide,
  onClick,
  hidden,
  size = "normal",
}: ParticipantTileProps) {
  const initial = p.name.charAt(0).toUpperCase();
  const showVideo = !!videoRef && !hidden;
  const ident = identityFor(p.id.replace(/^agent-/, ""), p.name);

  return (
    <div
      onClick={onClick}
      className={clsx(
        "group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface-1/80 transition-all",
        p.isSpeaking && "ring-2",
        onClick && "cursor-pointer",
      )}
      style={
        p.isSpeaking
          ? ({ "--tw-ring-color": ident.ring } as CSSProperties)
          : undefined
      }
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className={clsx(
            "flex items-center justify-center rounded-full font-semibold text-white/95",
            size === "large" ? "h-24 w-24 text-3xl" : "h-14 w-14 text-lg sm:h-16 sm:w-16",
            p.isSpeaking && !p.isMuted && "animate-pulse-soft",
          )}
          style={{
            background: ident.gradient,
            boxShadow: p.isSpeaking ? `0 0 0 2px ${ident.ring}` : undefined,
          }}
        >
          {p.isAgent ? (
            <Bot className={size === "large" ? "h-12 w-12" : "h-7 w-7"} />
          ) : (
            initial
          )}
        </div>
      )}

      <span className="glass absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-md px-2 py-0.5 text-xs font-medium text-slate-100">
        {p.name}
      </span>

      {/* Per-tile hide toggle — only when there's a video track to hide. */}
      {onToggleHide && p.videoTrack && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleHide();
          }}
          className="glass focus-ring absolute left-1.5 top-1.5 rounded-full p-1 text-slate-300 opacity-0 transition-opacity hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={hidden ? `Show ${p.name} video` : `Hide ${p.name} video`}
          title={hidden ? "Show video" : "Hide this tile's video"}
        >
          {hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </button>
      )}

      {p.isMuted && (
        <div className="absolute right-1.5 top-1.5 rounded-full bg-rose-500/80 p-1">
          <MicOff className="h-3 w-3 text-white" />
        </div>
      )}
      {p.isSpeaking && !p.isMuted && (
        <div className="absolute right-1.5 top-1.5 rounded-full bg-stable-mint/90 p-1">
          <Volume2 className="h-3 w-3 text-slate-950" />
        </div>
      )}
    </div>
  );
}

interface ScreenShareTileProps {
  label: string;
  videoRef: AttachRef;
}

function ScreenShareTile({ label, videoRef }: ScreenShareTileProps) {
  return (
    <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border border-stable-cyan/30 bg-slate-950/80 ring-1 ring-stable-cyan/20">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full bg-black object-contain"
      />
      <div className="glass absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-stable-cyan">
        <MonitorUp className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

interface AudioChipProps {
  /** LiveKit identity — drives the resident's identity hue. */
  id: string;
  name: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
}

/** Compact avatar chip with a speaking-indicator ring (no video). */
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
        isSpeaking
          ? { background: ident.faint, borderColor: ident.ring }
          : undefined
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

type AttachRef = (el: HTMLVideoElement | null) => (() => void) | void;

/**
 * Returns a STABLE callback-ref per track that attaches it to the tile's
 * <video> and detaches on cleanup. Stability matters: a fresh ref function each
 * render would make React detach+reattach the track every render (flicker), so
 * we cache one callback per track object. Tracks are stable across renders until
 * the publication set changes (see VoiceProvider.version).
 */
const NOOP_REF: AttachRef = () => undefined;

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

  // Call-UI state (view mode + video/transcript toggles + focus + per-tile hide).
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const showVideo = useCallUiStore((s) => s.showVideo);
  const showTranscript = useCallUiStore((s) => s.showTranscript);
  const hiddenTileIds = useCallUiStore((s) => s.hiddenTileIds);
  const setTileHidden = useCallUiStore((s) => s.setTileHidden);
  const focusedParticipantId = useCallUiStore((s) => s.focusedParticipantId);
  const focusParticipant = useCallUiStore((s) => s.focusParticipant);
  const videoPrompted = useCallUiStore((s) => s.videoPrompted);
  const setVideoPrompted = useCallUiStore((s) => s.setVideoPrompted);

  // Real Brigade roster — used to label/detect agent participants by their
  // "agent-<brigade_id>" identity (matches ParticipantStrip/StageView).
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

  // Stable per-track attach callbacks (see useAttachTrack) — avoids tile flicker.
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

  // Active-speaker spotlight, DEBOUNCED. LiveKit flips isSpeaking on every
  // syllable, so keying the focus tile straight off it would let a brief cough
  // or "mm-hmm" yank the whole layout. Only promote a *new* speaker once they've
  // held the floor continuously for ~2s; a pause (nobody speaking) keeps the
  // current spotlight rather than snapping away. A manual focus pick (below)
  // still wins immediately. (Declared here — above the early returns — so the
  // hook order stays stable per the Rules of Hooks.)
  const liveSpeakerId = participants.find((p) => p.isSpeaking)?.id ?? null;
  const [stableSpeakerId, setStableSpeakerId] = useState<string | null>(null);
  useEffect(() => {
    // Silence, or the already-spotlighted speaker → nothing to promote. The
    // effect re-running on any change clears a still-pending timer, so a
    // speaker who drops out before 2s never gets promoted.
    if (liveSpeakerId === null || liveSpeakerId === stableSpeakerId) return;
    const t = setTimeout(() => setStableSpeakerId(liveSpeakerId), 2000);
    return () => clearTimeout(t);
  }, [liveSpeakerId, stableSpeakerId]);

  // Screen-shares (local + remote), one tile each.
  const screenShares = useMemo(() => {
    const out: { sid: string; label: string; track: LocalTrack | RemoteTrack }[] = [];
    if (localParticipant) {
      const pub = Array.from(localParticipant.trackPublications.values()).find(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      if (pub?.track) out.push({ sid: "local-screen", label: "You — screen", track: pub.track });
    }
    for (const p of remoteParticipants) {
      const pub = Array.from(p.trackPublications.values()).find(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      if (pub?.track) {
        const agent = matchAgent(p.identity);
        out.push({
          sid: p.sid,
          label: `${agent?.name || p.name || p.identity} — screen`,
          track: pub.track,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, remoteParticipants, version, matchAgent]);

  // Does anyone have a live camera/screen track?
  const hasAnyVideo = useMemo(
    () => participants.some((p) => p.videoTrack) || screenShares.length > 0,
    [participants, screenShares],
  );

  // Optional-video: when someone first turns a camera on while we're in the
  // audio-default compact mode, surface a non-forcing prompt (we never auto-
  // switch). When all video stops, reset the latch so the next camera re-prompts.
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
  // Whether to actually render video tiles: global toggle AND something to show.
  // "compact" is audio-by-design and never shows video tiles.
  const renderVideo = showVideo && hasAnyVideo && viewMode !== "compact";

  async function toggleMic() {
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!isMicOn);
  }

  async function toggleCam() {
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!isCamOn);
  }

  // Tile element for a participant, honoring global + per-tile video visibility.
  function renderTile(
    p: CallParticipant,
    size: "normal" | "large" = "normal",
    onClick?: () => void,
  ) {
    const hidden = hiddenTileIds.has(p.id);
    const trackVisible = renderVideo && !hidden && !!p.videoTrack;
    return (
      <ParticipantTile
        key={p.sid}
        p={p}
        size={size}
        hidden={hidden}
        onClick={onClick}
        videoRef={trackVisible ? attachTrack(p.videoTrack) : undefined}
        onToggleHide={
          p.videoTrack ? () => setTileHidden(p.id, !hidden) : undefined
        }
      />
    );
  }

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
      <button
        onClick={disconnect}
        className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
        aria-label="End call"
      >
        <PhoneOff className="h-5 w-5" />
      </button>
    </div>
  );

  // Active speaker for focus mode: explicit agent-focused pick > the debounced
  // active speaker (if still present) > first remote > self.
  const focused =
    participants.find((p) => p.id === focusedParticipantId) ??
    (stableSpeakerId
      ? participants.find((p) => p.id === stableSpeakerId)
      : undefined) ??
    participants.find((p) => !p.isLocal) ??
    participants[0];

  const stage = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sidebar mode lays the video column out vertically; transcript (when
          on) docks beneath the stage in every video mode. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* ---- The video/audio stage, per mode ---- */}
        {viewMode === "compact" || !renderVideo ? (
          // Compact (audio default) OR video globally hidden: avatar chips row.
          <div className="flex flex-1 items-center gap-2 overflow-x-auto py-1">
            {participants.map((p) => (
              <AudioChip
                key={p.sid}
                id={p.id}
                name={p.name}
                isAgent={p.isAgent}
                isSpeaking={p.isSpeaking}
                isMuted={p.isMuted}
              />
            ))}
          </div>
        ) : viewMode === "focus" ? (
          // Focus: one large active-speaker tile + a filmstrip of the rest.
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="min-h-0 flex-1">
              {focused && renderTile(focused, "large")}
            </div>
            <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
              {screenShares.map((s) => (
                <div key={s.sid} className="w-40 shrink-0">
                  <ScreenShareTile label={s.label} videoRef={attachTrack(s.track)} />
                </div>
              ))}
              {participants
                .filter((p) => p.id !== focused?.id)
                .map((p) => (
                  <div key={p.sid} className="w-32 shrink-0">
                    {renderTile(p, "normal", () => focusParticipant(p.id))}
                  </div>
                ))}
            </div>
          </div>
        ) : viewMode === "sidebar" ? (
          // Sidebar dock: a single vertical column of tiles (narrow).
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {screenShares.map((s) => (
              <ScreenShareTile key={s.sid} label={s.label} videoRef={attachTrack(s.track)} />
            ))}
            {participants.map((p) => renderTile(p))}
          </div>
        ) : (
          // Grid: responsive best-fit tiles (1 → full, 2 → 2-up, 3-4 → 2×2,
          // more → auto grid + pagination). Every tile keeps the SAME attach
          // wiring as the other modes — only the arrangement changes, so no
          // LiveKit track handling moves here.
          <VideoGrid
            items={[
              ...participants.map((p) => ({ key: p.sid, node: renderTile(p) })),
              ...screenShares.map((s) => ({
                key: s.sid,
                node: (
                  <ScreenShareTile
                    label={s.label}
                    videoRef={attachTrack(s.track)}
                  />
                ),
              })),
            ]}
          />
        )}
      </div>

      {/* Live transcript docks under the stage (toggleable). */}
      {showTranscript && (
        <div className="mt-2 h-40 shrink-0 overflow-hidden rounded-xl border border-line">
          <TranscriptPanel />
        </div>
      )}
    </div>
  );

  // The slim single-row layout: audio-only compact mode with no transcript. An
  // open transcript needs vertical room, so fall back to the column layout
  // (chips on top, transcript docked below, controls row) even in compact.
  const compactLayout =
    viewMode === "compact" && !renderVideo && !showTranscript;

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

      {/* Agent working-state orb: shows listening / thinking / speaking so the
          user can see the agent is alive and processing, not just silent. */}
      <VoiceAgentStatus />

      {/* Non-forcing prompt: someone turned a camera on while in audio compact. */}
      {videoPrompted && compactLayout && hasAnyVideo && (
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

      <div
        className={clsx(
          "flex min-h-0 flex-1 border-b border-line bg-surface-1/70 backdrop-blur-md",
          compactLayout ? "flex-row items-center gap-3 px-4 py-2" : "flex-col gap-2 p-3",
        )}
        role="region"
        aria-label="Voice and video call"
      >
        {stage}

        <div
          className={clsx(
            "flex shrink-0 items-center gap-2",
            compactLayout ? "" : "justify-between pt-1",
          )}
        >
          {/* View switcher: full controls when there's room, compact in the
              slim audio bar (modes only — video/transcript fold away). */}
          <CallViewSwitcher roomId={roomId} compact={compactLayout} />
          {controls}
        </div>
      </div>
    </div>
  );
}
