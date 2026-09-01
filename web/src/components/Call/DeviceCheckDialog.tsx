import { useEffect, useRef, useState } from "react";
import { Camera, Mic, Volume2, X } from "lucide-react";
import {
  PREFERRED_AUDIO_INPUT_LABEL,
  quietMicWarning,
  type StableDeviceKind,
} from "@/lib/mediaDevices";

interface Props {
  devices: Record<StableDeviceKind, MediaDeviceInfo[]>;
  selected: Record<StableDeviceKind, string>;
  onSelect: (kind: StableDeviceKind, deviceId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onJoin: () => void;
  onCancel: () => void;
}

export function DeviceCheckDialog({
  devices,
  selected,
  onSelect,
  onRefresh,
  onJoin,
  onCancel,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const [sampledMs, setSampledMs] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sampleStartRef = useRef(0);

  useEffect(() => {
    let stopped = false;
    let frame = 0;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selected.videoinput
            ? { deviceId: { exact: selected.videoinput } }
            : true,
          audio: selected.audioinput
            ? { deviceId: { exact: selected.audioinput } }
            : true,
        });
        if (stopped) return stream.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        await onRefresh(); // permission grants unlock the browser's friendly labels
        if (videoRef.current) videoRef.current.srcObject = stream;
        const audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 256;
        audio.createMediaStreamSource(stream).connect(analyser);
        const values = new Uint8Array(analyser.frequencyBinCount);
        sampleStartRef.current = performance.now();
        const sample = () => {
          analyser.getByteTimeDomainData(values);
          let sum = 0;
          for (const value of values) sum += ((value - 128) / 128) ** 2;
          setLevel(Math.min(1, Math.sqrt(sum / values.length) * 4));
          setSampledMs(performance.now() - sampleStartRef.current);
          frame = requestAnimationFrame(sample);
        };
        sample();
        stream
          .getVideoTracks()[0]
          ?.addEventListener("mute", () =>
            setPreviewError("Camera is not producing video."),
          );
        return () => audio.close();
      } catch (error) {
        setPreviewError(
          error instanceof Error
            ? error.message
            : "Camera or microphone is unavailable.",
        );
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [selected.audioinput, selected.videoinput, onRefresh]);

  const picker = (kind: StableDeviceKind, label: string, Icon: typeof Mic) => (
    <label className="block space-y-1.5 text-sm text-slate-300">
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <select
        className="focus-ring w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
        value={selected[kind]}
        onChange={(e) => void onSelect(kind, e.target.value)}
      >
        {devices[kind].map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-check-title"
        className="glass-heavy w-full max-w-xl rounded-2xl p-5 shadow-pop"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2
              id="device-check-title"
              className="font-display text-lg font-semibold text-slate-100"
            >
              Check your devices
            </h2>
            <p className="text-sm text-slate-400">
              You are not in the room yet.
            </p>
          </div>
          <button aria-label="Cancel call" onClick={onCancel}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="relative mb-4 aspect-video overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover"
          />
          {previewError && (
            <div className="absolute inset-0 grid place-items-center bg-red-950/80 p-6 text-center text-sm text-red-100">
              {previewError}
            </div>
          )}
        </div>
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-xs text-slate-400">
            <span>Microphone signal</span>
            <span>{level > 0.02 ? "Receiving audio" : "No signal"}</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-800">
            <div
              className="h-full bg-emerald-400 transition-[width]"
              style={{ width: `${Math.max(2, level * 100)}%` }}
            />
          </div>
          {(() => {
            const selectedMic = devices.audioinput.find(
              (d) => d.deviceId === selected.audioinput,
            );
            const warning = quietMicWarning({
              selectedLabel: selectedMic?.label || "",
              hasPreferredAlternative: devices.audioinput.some(
                (d) =>
                  d.label === PREFERRED_AUDIO_INPUT_LABEL ||
                  d.label.startsWith(`${PREFERRED_AUDIO_INPUT_LABEL} `),
              ),
              level,
              sampledMs,
            });
            if (!warning) return null;
            const preferred = devices.audioinput.find(
              (d) =>
                d.label === PREFERRED_AUDIO_INPUT_LABEL ||
                d.label.startsWith(`${PREFERRED_AUDIO_INPUT_LABEL} `),
            );
            return (
              <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
                <p>{warning}</p>
                {preferred && preferred.deviceId !== selected.audioinput && (
                  <button
                    type="button"
                    className="mt-2 font-medium text-amber-50 underline"
                    onClick={() => void onSelect("audioinput", preferred.deviceId)}
                  >
                    Switch to {PREFERRED_AUDIO_INPUT_LABEL}
                  </button>
                )}
              </div>
            );
          })()}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {picker("videoinput", "Camera", Camera)}
          {picker("audioinput", "Microphone", Mic)}
          <div className="sm:col-span-2">
            {picker("audiooutput", "Speaker", Volume2)}
          </div>
        </div>
        <button
          onClick={onJoin}
          className="focus-ring mt-5 w-full rounded-lg bg-stable-purple px-4 py-2.5 font-medium text-white"
        >
          Join room
        </button>
      </div>
    </div>
  );
}
