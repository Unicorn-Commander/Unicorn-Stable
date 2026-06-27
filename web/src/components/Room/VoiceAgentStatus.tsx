import { useEffect, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Participant, RemoteParticipant } from "livekit-client";
import { useVoice } from "@/contexts/VoiceProvider";

/**
 * VoiceAgentStatus — a compact "orb that moves with the voice" + a clear
 * working-state label for the agent during a voice call.
 *
 * The agent (a livekit-agents worker) publishes its lifecycle as the standard
 * `lk.agent.state` participant attribute — `initializing` → `listening` →
 * `thinking` → `speaking`. We surface that as a labelled, colour-coded orb so
 * the user can SEE the agent is listening / thinking / about to speak instead
 * of staring at silence. The orb also pulses with the agent's live audio level
 * while it speaks. Everything is read directly from livekit-client (no extra
 * provider wiring) and degrades gracefully: no agent + not connecting → nothing.
 */

const STATE_META: Record<
  string,
  { label: string; dot: string; pulse: boolean }
> = {
  initializing: { label: "Connecting…", dot: "bg-slate-400", pulse: true },
  listening: { label: "Listening", dot: "bg-emerald-400", pulse: false },
  thinking: { label: "Thinking…", dot: "bg-amber-400", pulse: true },
  speaking: { label: "Speaking", dot: "bg-stable-cyan", pulse: false },
};

function findAgent(parts: RemoteParticipant[]): RemoteParticipant | null {
  return parts.find((p) => (p.identity || "").startsWith("agent-")) ?? null;
}

export function VoiceAgentStatus() {
  const { room, remoteParticipants, isConnecting, isConnected, version } =
    useVoice();
  const agent = findAgent(remoteParticipants);

  const [state, setState] = useState<string>("");
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Follow the agent's published lifecycle attribute.
  useEffect(() => {
    if (!room || !agent) {
      setState("");
      return;
    }
    const read = () =>
      setState((agent.attributes?.["lk.agent.state"] as string) || "");
    read();
    const onAttr = (_changed: Record<string, string>, p: Participant) => {
      if (p.identity === agent.identity) read();
    };
    room.on(RoomEvent.ParticipantAttributesChanged, onAttr);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, onAttr);
    };
  }, [room, agent, version]);

  // Smoothly track the agent's live audio level to size the orb.
  useEffect(() => {
    if (!agent) {
      setLevel(0);
      return;
    }
    const tick = () => {
      const target = agent.audioLevel || 0;
      levelRef.current += (target - levelRef.current) * 0.25;
      setLevel(levelRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [agent]);

  if (!agent && !isConnecting) return null;

  const meta = STATE_META[state] ?? {
    label: isConnected ? "Connected" : "Connecting…",
    dot: "bg-slate-400",
    pulse: !isConnected,
  };

  // Idle 1.0 → up to ~1.7 with voice; clamp so a loud burst doesn't overflow.
  const scale = 1 + Math.min(level * 3, 0.7);

  return (
    <div className="flex shrink-0 items-center justify-center gap-2.5 border-b border-slate-700/40 bg-slate-900/40 px-4 py-2">
      <div className="relative grid h-9 w-9 place-items-center">
        {/* Halo that swells with the voice */}
        <div
          className={`absolute h-9 w-9 rounded-full ${meta.dot} opacity-25`}
          style={{
            transform: `scale(${scale})`,
            transition: "transform 80ms linear",
          }}
        />
        {/* Core orb */}
        <div
          className={`h-4 w-4 rounded-full ${meta.dot} ${
            meta.pulse ? "animate-pulse" : ""
          }`}
        />
      </div>
      <span className="text-xs font-medium text-slate-300">{meta.label}</span>
    </div>
  );
}
