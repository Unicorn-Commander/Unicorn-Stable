import { useState } from "react";
import { Camera, Mic, Volume2, ShieldCheck } from "lucide-react";
import { useVoice } from "@/contexts/VoiceProvider";
import type { StableDeviceKind } from "@/lib/mediaDevices";

export function AudioVideoSection() {
  const {
    devices,
    selectedDevices,
    switchDevice,
    isConnected,
    deviceSignal,
    callPrefs,
    setCallPrefs,
  } = useVoice();
  const [saving, setSaving] = useState(false);
  function toggleVideoCheck(next: boolean) {
    setSaving(true);
    void setCallPrefs({ checkDevicesBeforeVideo: next }).finally(() =>
      setSaving(false),
    );
  }
  const row = (kind: StableDeviceKind, label: string, Icon: typeof Mic) => (
    <label className="block space-y-2 rounded-xl border border-line bg-surface-2/40 p-3">
      <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <Icon className="h-4 w-4 text-stable-purple-light" />
        {label}
        {kind !== "audiooutput" && isConnected && (
          <span
            className={`ml-auto text-xs ${deviceSignal[kind] ? "text-emerald-400" : "text-red-400"}`}
          >
            {deviceSignal[kind] ? "Signal" : "No signal"}
          </span>
        )}
      </span>
      <select
        value={selectedDevices[kind]}
        onChange={(event) => void switchDevice(kind, event.target.value)}
        className="focus-ring w-full rounded-lg border border-line bg-surface-1 px-3 py-2 text-sm text-slate-100"
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
    <div className="h-full overflow-y-auto p-5">
      <h3 className="font-display text-sm font-semibold text-slate-200">
        Audio &amp; video
      </h3>
      <p className="mb-4 mt-1 text-sm text-slate-400">
        Choose devices before or during a call. In-call camera and microphone
        changes replace the existing track, so the session and recording stay
        live.
      </p>
      <p className="mb-3 rounded-xl border border-line bg-surface-2/40 p-3 text-xs text-slate-400">
        <span className="block text-sm font-medium text-slate-200">
          Calls connect immediately
        </span>
        Voice calls always drop you straight in with the microphone below,
        camera off. Video calls do the same with the camera on. Switch mic,
        camera or speaker any time from the call bar.
      </p>
      <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-2/40 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-stable-purple"
          checked={callPrefs.checkDevicesBeforeVideo}
          disabled={saving}
          onChange={(e) => toggleVideoCheck(e.target.checked)}
          data-testid="check-devices-before-video"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <ShieldCheck className="h-4 w-4 text-stable-purple-light" />
            Check devices before video calls
          </span>
          <span className="mt-0.5 block text-xs text-slate-400">
            Preview your camera and mic before a video call connects. Voice
            calls never ask. This setting follows your account on every
            device.
          </span>
        </span>
      </label>
      <div className="space-y-3">
        {row("videoinput", "Camera", Camera)}
        {row("audioinput", "Microphone", Mic)}
        {row("audiooutput", "Call audio output", Volume2)}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        {isConnected
          ? "Changes apply to the current call immediately."
          : "These choices will be restored for your next call."}
      </p>
    </div>
  );
}
