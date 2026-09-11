import { useEffect, useState } from "react";
/** Observe the published microphone; never open a second capture device. */
export function LiveMicMeter({
  track,
  muted,
}: {
  track?: MediaStreamTrack;
  muted: boolean;
}) {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    setLevel(null);
    if (!track || muted) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
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
  );
}
