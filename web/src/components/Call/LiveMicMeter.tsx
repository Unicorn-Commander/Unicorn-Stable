import { useMicDiagnostics } from "./useMicDiagnostics";
import { micWarning, type MicDiagnostic } from "@/lib/micDiagnostics";
import { useEffect, useState } from "react";
/** Observe the published microphone; never open a second capture device. */
export function LiveMicMeter({
  track,
  muted,
  onDiagnostic,
}: {
  track?: MediaStreamTrack;
  muted: boolean;
  onDiagnostic?: (value: MicDiagnostic) => void;
}) {
  const [contextState, setContextState] = useState("unavailable");
  const diagnostic = useMicDiagnostics(track, contextState, onDiagnostic);
  const warning = micWarning(diagnostic);
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    setLevel(null);
    setContextState("unavailable");
    if (!track || muted) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const contextChanged = () => setContextState(context.state);
    contextChanged();
    context.addEventListener("statechange", contextChanged);
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    const resume = () => {
      void context.resume().catch(() => {});
    };
    resume();
    window.addEventListener("pointerdown", resume, { capture: true });
    const timer = window.setInterval(() => {
      if (context.state !== "running" || track.readyState !== "live") {
        setLevel(null);
        return;
      }
      analyser.getFloatTimeDomainData(values);
      let sum = 0;
      for (const n of values) sum += n * n;
      setLevel(Math.min(1, Math.sqrt(sum / values.length) * 5));
    }, 150);
    return () => {
      window.removeEventListener("pointerdown", resume, { capture: true });
      clearInterval(timer);
      context.removeEventListener("statechange", contextChanged);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  }, [track, muted]);
  const label = muted
    ? "Mic muted"
    : level === null
      ? "Mic meter unavailable"
      : level < 0.005
        ? "No mic signal"
        : "Mic signal";
  return (
    <div className="flex max-w-sm flex-col gap-1">
    {warning && <div role="alert" className="rounded bg-red-950 p-2 text-xs text-red-100">{warning}</div>}
    <span className="text-[10px] text-slate-300">Mic permission: {diagnostic.permission === "unsupported" ? "not exposed by this browser" : diagnostic.permission}</span>
    <span
      className="flex items-center gap-1 text-[10px] text-slate-300"
      title={label}
    >
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((level ?? 0) * 100)}
        className="h-2 w-10 overflow-hidden rounded bg-slate-700"
      >
        <span
          className="block h-full bg-emerald-400"
          style={{ width: `${muted ? 0 : (level ?? 0) * 100}%` }}
        />
      </span>
      <span>{label}</span>
    </span>
    </div>
  );
}
