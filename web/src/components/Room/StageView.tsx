import { useCallback, useMemo } from "react";
import { Minimize2, Maximize2, Bot, X } from "lucide-react";
import { useState } from "react";
import clsx from "clsx";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useAppStore } from "@/stores/appStore";

interface StageViewProps {
  agentId: string;
  roomId: string;
}

export function StageView({ agentId, roomId }: StageViewProps) {
  const agents = useAppStore((s) => s.agents);
  const setStageAgentId = useAppStore((s) => s.setStageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const { remoteParticipants } = useStableRoom(voiceActive ? roomId : null);
  const [maximized, setMaximized] = useState(false);

  const agent = agents.find((a) => a.id === agentId);

  const agentParticipant = useMemo(() => {
    return remoteParticipants.find((p) => {
      const identity = p.identity;
      return identity.includes(agentId) || identity.includes(agent?.name ?? "");
    });
  }, [remoteParticipants, agentId, agent?.name]);

  const videoTrack = useMemo(() => {
    if (!agentParticipant) return null;
    const pub = Array.from(agentParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "screen_share",
    );
    return pub?.track ?? null;
  }, [agentParticipant]);

  const attachRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && videoTrack) {
        videoTrack.attach(el);
        return () => {
          videoTrack.detach(el);
        };
      }
    },
    [videoTrack],
  );

  function handleClose() {
    setStageAgentId(null);
  }

  return (
    <div
      className={clsx(
        "relative flex h-full w-full items-center justify-center bg-slate-950",
        maximized && "fixed inset-0 z-40",
      )}
      role="region"
      aria-label={`Stage view for ${agent?.display_name ?? "agent"}`}
    >
      {videoTrack ? (
        <video
          ref={attachRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-stable-cyan/20">
            <Bot className="h-8 w-8 text-stable-cyan" />
          </div>
          <p className="text-sm font-medium text-slate-300">
            {agent?.display_name ?? "Agent"}
          </p>
          <p className="text-xs text-slate-500">
            {voiceActive
              ? "No stage track active"
              : "Join a call to see the stage"}
          </p>

          {voiceActive && agentParticipant && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse-soft" />
              <span className="text-xs text-slate-400">Agent connected</span>
            </div>
          )}
        </div>
      )}

      <div className="absolute right-3 top-3 flex items-center gap-1">
        <button
          onClick={() => setMaximized(!maximized)}
          className="rounded-lg bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:text-slate-200"
          aria-label={maximized ? "Minimize stage" : "Maximize stage"}
        >
          {maximized ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={handleClose}
          className="rounded-lg bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:text-slate-200"
          aria-label="Close stage"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {agent && (
        <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-slate-900/80 px-3 py-1.5 backdrop-blur">
          <Bot className="h-3.5 w-3.5 text-stable-cyan" />
          <span className="text-xs font-medium text-slate-200">
            {agent.display_name}
          </span>
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              agent.status === "active" && "bg-green-500",
              agent.status === "working" && "bg-yellow-500 animate-pulse-soft",
              agent.status === "idle" && "bg-slate-500",
              agent.status === "offline" && "bg-slate-700",
            )}
          />
        </div>
      )}
    </div>
  );
}
