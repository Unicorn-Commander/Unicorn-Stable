import { useMemo, useCallback } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Volume2, Bot } from "lucide-react";
import clsx from "clsx";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useAppStore } from "@/stores/appStore";

interface VoiceVideoBarProps {
  roomId: string;
}

interface ParticipantTileProps {
  name: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  avatarUrl?: string | null;
  videoRef?: (el: HTMLVideoElement | null) => void;
  hasVideo: boolean;
}

function ParticipantTile({
  name,
  isAgent,
  isSpeaking,
  isMuted,
  avatarUrl,
  videoRef,
  hasVideo,
}: ParticipantTileProps) {
  const initial = name.charAt(0).toUpperCase();

  return (
    <div
      className={clsx(
        "relative flex flex-col items-center gap-1 rounded-xl p-2 transition-all",
        isSpeaking
          ? "ring-2 ring-green-500/50 bg-green-500/5"
          : "bg-slate-800/40",
      )}
      style={{ width: 100, minHeight: 80 }}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-14 w-full rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={name}
              className={clsx(
                "h-10 w-10 rounded-full object-cover",
                isAgent && "ring-1 ring-stable-cyan/30",
              )}
            />
          ) : (
            <div
              className={clsx(
                "flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold",
                isAgent
                  ? "bg-stable-cyan/20 text-stable-cyan"
                  : "bg-stable-purple/20 text-stable-purple-light",
                isSpeaking && "animate-pulse-soft",
              )}
            >
              {isAgent ? <Bot className="h-5 w-5" /> : initial}
            </div>
          )}
        </div>
      )}

      <span className="max-w-full truncate text-[10px] font-medium text-slate-300">
        {name}
      </span>

      {isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-red-500/80 p-0.5">
          <MicOff className="h-2.5 w-2.5 text-white" />
        </div>
      )}

      {isSpeaking && !isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-green-500/80 p-0.5">
          <Volume2 className="h-2.5 w-2.5 text-white" />
        </div>
      )}
    </div>
  );
}

export function VoiceVideoBar({ roomId }: VoiceVideoBarProps) {
  const {
    room,
    localParticipant,
    remoteParticipants,
    isConnected,
    disconnect,
  } = useStableRoom(roomId);

  const agents = useAppStore((s) => s.agents);

  const localVideoTrack = useMemo(() => {
    if (!localParticipant) return null;
    const pub = Array.from(localParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "camera",
    );
    return pub?.track ?? null;
  }, [localParticipant]);

  const attachLocal = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && localVideoTrack) {
        localVideoTrack.attach(el);
        return () => {
          localVideoTrack.detach(el);
        };
      }
    },
    [localVideoTrack],
  );

  if (!isConnected || !room) {
    return null;
  }

  const isMicOn = localParticipant?.isMicrophoneEnabled ?? false;
  const isCamOn = localParticipant?.isCameraEnabled ?? false;

  async function toggleMic() {
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!isMicOn);
  }

  async function toggleCam() {
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!isCamOn);
  }

  function isAgentParticipant(identity: string): boolean {
    return agents.some(
      (a) => identity.includes(a.id) || identity.includes(a.name),
    );
  }

  return (
    <div
      className="flex items-center gap-3 border-b border-slate-700/50 bg-slate-900/80 px-4 py-2"
      role="region"
      aria-label="Voice and video call"
    >
      <div className="flex flex-1 items-center gap-2 overflow-x-auto py-1">
        <ParticipantTile
          name="You"
          isAgent={false}
          isSpeaking={localParticipant?.isSpeaking ?? false}
          isMuted={!isMicOn}
          hasVideo={!!localVideoTrack}
          videoRef={attachLocal}
        />

        {remoteParticipants.map((participant) => {
          const identity = participant.identity;
          const isAgent = isAgentParticipant(identity);
          const name = participant.name || identity;

          const videoPublication = Array.from(
            participant.trackPublications.values(),
          ).find((t) => t.kind === "video" && t.track && t.source === "camera");

          const videoTrack = videoPublication?.track ?? null;

          return (
            <ParticipantTile
              key={participant.sid}
              name={name}
              isAgent={isAgent}
              isSpeaking={participant.isSpeaking}
              isMuted={!participant.isMicrophoneEnabled}
              hasVideo={!!videoTrack}
              videoRef={
                videoTrack
                  ? (el) => {
                      if (el) videoTrack.attach(el);
                    }
                  : undefined
              }
            />
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={toggleMic}
          className={clsx(
            "rounded-lg p-2 transition-colors",
            isMicOn
              ? "text-slate-300 hover:bg-slate-800"
              : "bg-red-500/20 text-red-400 hover:bg-red-500/30",
          )}
          aria-label={isMicOn ? "Mute" : "Unmute"}
        >
          {isMicOn ? (
            <Mic className="h-4 w-4" />
          ) : (
            <MicOff className="h-4 w-4" />
          )}
        </button>

        <button
          onClick={toggleCam}
          className={clsx(
            "rounded-lg p-2 transition-colors",
            isCamOn
              ? "text-slate-300 hover:bg-slate-800"
              : "text-slate-500 hover:bg-slate-800 hover:text-slate-300",
          )}
          aria-label={isCamOn ? "Turn off camera" : "Turn on camera"}
        >
          {isCamOn ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </button>

        <button
          onClick={disconnect}
          className="rounded-lg bg-red-500/20 p-2 text-red-400 transition-colors hover:bg-red-500/30"
          aria-label="End call"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
