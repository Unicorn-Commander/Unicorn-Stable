import { useState } from "react";
import { Camera, Circle, Mic, Volume2, ShieldCheck, Captions } from "lucide-react";
import clsx from "clsx";
import { useVoice } from "@/contexts/VoiceProvider";
import type { StableDeviceKind } from "@/lib/mediaDevices";
import { loadRecordMyCalls, saveRecordMyCalls } from "@/lib/recordMyCalls";
import type { TileNameMode } from "@/lib/tileChrome";
import {
  useSetTileChromePrefs,
  useTileChromePrefs,
} from "@/lib/tileChromePrefs";

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
  const [recordMine, setRecordMine] = useState(() => loadRecordMyCalls());
  const tileChrome = useTileChromePrefs();
  const setTileChrome = useSetTileChromePrefs();
  const nameModes: { id: TileNameMode; label: string }[] = [
    { id: "always", label: "Always" },
    { id: "hover", label: "On hover" },
    { id: "off", label: "Off" },
  ];
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
      <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-2/40 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-stable-purple"
          checked={recordMine}
          onChange={(event) => {
            const next = event.target.checked;
            setRecordMine(next);
            saveRecordMyCalls(next);
          }}
          data-testid="record-my-calls"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Circle className="h-4 w-4 fill-rose-500 text-rose-500" />
            Record calls I start
          </span>
          <span className="mt-0.5 block text-xs text-slate-400">
            When you start a call in a room set to Ask, and you have the
            recorder role, the call is recorded. Off rooms never record.
            Always rooms record every call. This choice stays on this device.
          </span>
        </span>
      </label>
      <div className="mb-3 space-y-2 rounded-xl border border-line bg-surface-2/40 p-3">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <Captions className="h-4 w-4 text-stable-purple-light" />
          Show names on tiles
        </span>
        <span className="block text-xs text-slate-400">
          The name this app draws on every call tile, including agents. Always,
          only while the pointer is over the tile, or off. An agent&apos;s video
          can still carry a name burned into the picture by the room — that is
          the room&apos;s voice-relay face plate, and this choice leaves it
          alone. Stays on this device for your account. The compact audio bar
          keeps a name beside each face so a voice call stays readable.
        </span>
        <div
          role="radiogroup"
          aria-label="Show names on tiles"
          data-testid="tile-name-mode"
          className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-1 p-1"
        >
          {nameModes.map((mode) => {
            const active = tileChrome.tileNames === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`tile-name-mode-${mode.id}`}
                onClick={() => setTileChrome({ tileNames: mode.id })}
                className={clsx(
                  "focus-ring min-h-11 rounded-md px-2 text-sm transition-colors",
                  active
                    ? "bg-stable-purple/20 font-medium text-slate-100"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-2/40 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-stable-purple"
          checked={tileChrome.lowerThird}
          onChange={(event) =>
            setTileChrome({ lowerThird: event.target.checked })
          }
          data-testid="lower-third-opt-in"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Captions className="h-4 w-4 text-stable-cyan" />
            Lower third for the active speaker
          </span>
          <span className="mt-0.5 block text-xs text-slate-400">
            A name strip at the bottom left of the stage while someone is
            speaking. Agents show their roster role under the name when they
            have one. The strip steps aside after about four seconds, and it
            does not appear on the compact bar or the filmstrip. A broadcast
            link you copy while this is on includes the strip for OBS. A link
            copied while this is off stays a bare camera. Off by default. Stays
            on this device.
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
