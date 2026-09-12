import { useEffect, useRef, useState } from "react";
import { Camera, Mic, Volume2, X } from "lucide-react";
import {
  PREFERRED_AUDIO_INPUT_LABEL,
  quietMicWarning,
  type StableDeviceKind,
} from "@/lib/mediaDevices";
import { CALL_KIND_LABEL, type CallKind } from "@/lib/callEntry";

interface Props {
  /** Which call this check is for — labels the dialog and the join button. */
  kind?: CallKind;
  devices: Record<StableDeviceKind, MediaDeviceInfo[]>;
  selected: Record<StableDeviceKind, string>;
  onSelect: (kind: StableDeviceKind, deviceId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onJoin: () => void;
  /** Join with the microphone only (camera failed, denied, or not wanted). */
  onJoinAudioOnly?: () => void;
  onCancel: () => void;
}

function mediaErrorText(error: unknown, noun: "Camera" | "Microphone"): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return `${noun} access is blocked. Allow it for this site in your browser settings, then try again.`;
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return `No ${noun.toLowerCase()} was found.`;
  if (name === "NotReadableError" || name === "AbortError")
    return `The ${noun.toLowerCase()} is busy in another app.`;
  return error instanceof Error && error.message
    ? error.message
    : `${noun} is unavailable.`;
}

/**
 * The optional pre-join check (video calls only, and only when the user asked
 * for it — see lib/callEntry). It is a preview, never a gate: the camera and
 * the microphone are acquired SEPARATELY so a blocked camera still shows the
 * mic meter, and every failure leaves a way in ("Join with mic only"). The
 * panel scrolls on short screens so the buttons are always reachable — the
 * old fixed-height dialog put "Join room" below the fold on a phone.
 */
export function DeviceCheckDialog({
  kind = "video",
  devices,
  selected,
  onSelect,
  onRefresh,
  onJoin,
  onJoinAudioOnly,
  onCancel,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [level, setLevel] = useState(0);
  const [sampledMs, setSampledMs] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  // False until the AudioContext is actually running (iOS: after a tap).
  const [meterLive, setMeterLive] = useState(false);
  const sampleStartRef = useRef(0);
  const wantsCamera = kind === "video";

  // One capture for everything the preview needs. iOS Safari mutes or ends
  // an earlier capture when a second one starts (single-capture WebKit), so
  // mic and camera are requested in ONE getUserMedia when a camera is wanted,
  // falling back to mic-only when the camera is blocked/missing — a blocked
  // camera must never hide the mic meter. Every await is followed by a
  // `stopped` check: onRefresh() can change the selected device ids (the
  // first grant unlocks them), which re-runs this effect, and the superseded
  // run must not leave a meter loop or an AudioContext behind.
  useEffect(() => {
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let audio: AudioContext | null = null;
    const audioConstraint: MediaTrackConstraints | boolean = selected.audioinput
      ? { deviceId: { exact: selected.audioinput } }
      : true;
    const videoConstraint: MediaTrackConstraints | boolean = selected.videoinput
      ? { deviceId: { exact: selected.videoinput } }
      : true;
    const stopStream = (st: MediaStream | null) =>
      st?.getTracks().forEach((track) => track.stop());
    // iOS creates the AudioContext suspended when it is not born in a user
    // gesture (this dialog opens after several awaits). Resume on the first
    // touch/click; until then the meter reads flat and must not warn.
    const resumeAudio = () => {
      if (audio && audio.state !== "running") void audio.resume().catch(() => undefined);
    };
    void (async () => {
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia(
            wantsCamera
              ? { audio: audioConstraint, video: videoConstraint }
              : { audio: audioConstraint },
          );
          if (!stopped) setCameraError(null);
        } catch (error) {
          if (stopped) return;
          if (!wantsCamera) throw error;
          // Camera blocked or missing: keep the call possible, keep the meter.
          setCameraError(mediaErrorText(error, "Camera"));
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        }
        if (stopped) return stopStream(stream);
        setMicError(null);
        await onRefresh(); // permission grants unlock the browser's friendly labels
        if (stopped) return stopStream(stream);

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && videoRef.current) {
          videoRef.current.srcObject = stream;
          videoTrack.addEventListener("mute", () =>
            setCameraError("Camera is not producing video."),
          );
          videoTrack.addEventListener("unmute", () => setCameraError(null));
        }

        audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 256;
        audio.createMediaStreamSource(stream).connect(analyser);
        setMeterLive(audio.state === "running");
        audio.addEventListener("statechange", () => {
          if (!stopped) setMeterLive(audio?.state === "running");
        });
        resumeAudio();
        window.addEventListener("pointerdown", resumeAudio, { passive: true });
        window.addEventListener("keydown", resumeAudio);
        const values = new Uint8Array(analyser.frequencyBinCount);
        sampleStartRef.current = performance.now();
        const sample = () => {
          if (stopped) return;
          analyser.getByteTimeDomainData(values);
          let sum = 0;
          for (const value of values) sum += ((value - 128) / 128) ** 2;
          setLevel(Math.min(1, Math.sqrt(sum / values.length) * 4));
          setSampledMs(performance.now() - sampleStartRef.current);
          frame = requestAnimationFrame(sample);
        };
        sample();
      } catch (error) {
        if (!stopped) setMicError(mediaErrorText(error, "Microphone"));
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", resumeAudio);
      window.removeEventListener("keydown", resumeAudio);
      stopStream(stream);
      void audio?.close().catch(() => undefined);
    };
  }, [wantsCamera, selected.audioinput, selected.videoinput, onRefresh]);

  const picker = (deviceKind: StableDeviceKind, label: string, Icon: typeof Mic) => (
    <label className="block space-y-1.5 text-sm text-slate-300">
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <select
        className="focus-ring w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
        value={selected[deviceKind]}
        onChange={(e) => void onSelect(deviceKind, e.target.value)}
      >
        {devices[deviceKind].length === 0 && (
          <option value="">No {label.toLowerCase()} found</option>
        )}
        {devices[deviceKind].map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  const selectedMic = devices.audioinput.find(
    (d) => d.deviceId === selected.audioinput,
  );
  const preferred = devices.audioinput.find(
    (d) =>
      d.label === PREFERRED_AUDIO_INPUT_LABEL ||
      d.label.startsWith(`${PREFERRED_AUDIO_INPUT_LABEL} `),
  );
  // Only judge the mic once the meter is real; a suspended context reads
  // flat and would call every iPhone "very quiet".
  const warning = meterLive
    ? quietMicWarning({
        selectedLabel: selectedMic?.label || "",
        hasPreferredAlternative: !!preferred,
        level,
        sampledMs,
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto overscroll-contain bg-slate-950/80 backdrop-blur-sm"
      data-testid="device-check-dialog"
    >
      <div className="flex min-h-full items-end justify-center p-3 sm:items-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-check-title"
          className="glass-heavy w-full max-w-xl rounded-2xl p-4 shadow-pop sm:p-5"
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
                {CALL_KIND_LABEL[kind]} — you are not in the room yet.
              </p>
            </div>
            <button
              aria-label="Cancel call"
              onClick={onCancel}
              className="focus-ring rounded-lg p-2 text-slate-400 hover:text-slate-100"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {wantsCamera && (
            <div className="relative mb-4 aspect-video max-h-[38vh] w-full overflow-hidden rounded-xl bg-black">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
              />
              {cameraError && (
                <div className="absolute inset-0 grid place-items-center bg-red-950/80 p-6 text-center text-sm text-red-100">
                  {cameraError}
                </div>
              )}
            </div>
          )}

          <div className="mb-4">
            <div className="mb-1 flex justify-between text-xs text-slate-400">
              <span>Microphone signal</span>
              <span>
                {micError
                  ? "Unavailable"
                  : !meterLive
                    ? "Tap anywhere to start the meter"
                    : level > 0.02
                      ? "Receiving audio"
                      : "No signal"}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-slate-800">
              <div
                className="h-full bg-emerald-400 transition-[width]"
                style={{ width: `${Math.max(2, level * 100)}%` }}
              />
            </div>
            {micError && (
              <p className="mt-2 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-100">
                {micError}
              </p>
            )}
            {warning && (
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
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {wantsCamera && picker("videoinput", "Camera", Camera)}
            {picker("audioinput", "Microphone", Mic)}
            <div className={wantsCamera ? "sm:col-span-2" : ""}>
              {picker("audiooutput", "Speaker", Volume2)}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
            <button
              onClick={onJoin}
              className="focus-ring min-h-11 flex-1 rounded-lg bg-stable-purple px-4 py-2.5 font-medium text-white"
              data-testid="device-check-join"
            >
              {wantsCamera && !cameraError ? "Join with video" : "Join room"}
            </button>
            {wantsCamera && onJoinAudioOnly && (
              <button
                onClick={onJoinAudioOnly}
                className="focus-ring min-h-11 flex-1 rounded-lg border border-line px-4 py-2.5 font-medium text-slate-100 hover:bg-white/[0.06]"
                data-testid="device-check-join-audio-only"
              >
                Join with mic only
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
