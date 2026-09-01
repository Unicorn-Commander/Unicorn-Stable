export type StableDeviceKind = "audioinput" | "videoinput" | "audiooutput";

/** Studio default. Chrome otherwise picks "ZOOM AMS-44 Driver", ~14 dB quieter. */
export const PREFERRED_AUDIO_INPUT_LABEL = "AMS Microphone";
/** Known-quiet sibling of the preferred input on the studio AMS-44. */
export const QUIET_AUDIO_INPUT_LABEL = "ZOOM AMS-44 Driver";

function labelIs(device: { label: string }, wanted: string): boolean {
  const label = device.label || "";
  return label === wanted || label.startsWith(`${wanted} `);
}

/**
 * Pick the microphone for a new call.
 *
 * Studio machines have two names for the same box: "AMS Microphone" and
 * "ZOOM AMS-44 Driver". Chrome defaults to the Driver; the relay then hears
 * near-silence and captions never appear (measured −25.5 dB vs −39.9 dB on
 * the same spoken line, 2026-08-30). If the preferred label exists, use it
 * unless the saved pick is a different, non-quiet device the user chose.
 */
export function pickAudioInputDevice(
  devices: Array<{ deviceId: string; label: string }>,
  savedId?: string,
): string {
  const [first] = devices;
  if (!first) return "";
  const preferred = devices.find((d) =>
    labelIs(d, PREFERRED_AUDIO_INPUT_LABEL),
  );
  const saved = devices.find((d) => d.deviceId === savedId);
  const savedIsQuiet = !!saved && labelIs(saved, QUIET_AUDIO_INPUT_LABEL);
  if (preferred && (!saved || savedIsQuiet)) return preferred.deviceId;
  if (saved) return saved.deviceId;
  if (preferred) return preferred.deviceId;
  return first.deviceId;
}

/**
 * Warning copy when the selected mic is the known-quiet driver or the
 * live meter is too low to produce captions. Null when nothing is wrong.
 */
export function quietMicWarning(opts: {
  selectedLabel: string;
  hasPreferredAlternative: boolean;
  level: number;
  sampledMs: number;
}): string | null {
  const selectedIsQuiet = labelIs(
    { label: opts.selectedLabel },
    QUIET_AUDIO_INPUT_LABEL,
  );
  if (selectedIsQuiet && opts.hasPreferredAlternative) {
    return `This input (${QUIET_AUDIO_INPUT_LABEL}) is about 14 dB quieter than ${PREFERRED_AUDIO_INPUT_LABEL}. The relay will hear near-silence. Switch before you join.`;
  }
  if (opts.sampledMs >= 2500 && opts.level < 0.03) {
    return "Microphone signal is very quiet. Speak, or pick a different input. A silent mic looks like the agent is not responding.";
  }
  return null;
}

export interface DevicePreferences {
  audioinput?: string;
  videoinput?: string;
  audiooutput?: string;
}

const KEY = "stable.call-devices.v1";

function userKey(userId?: string | null): string {
  return userId || "anonymous";
}

export function readDevicePreferences(
  userId?: string | null,
): DevicePreferences {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<
      string,
      DevicePreferences
    >;
    return all[userKey(userId)] || {};
  } catch {
    return {};
  }
}

export function saveDevicePreference(
  userId: string | null | undefined,
  kind: StableDeviceKind,
  deviceId: string,
): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<
      string,
      DevicePreferences
    >;
    all[userKey(userId)] = {
      ...(all[userKey(userId)] || {}),
      [kind]: deviceId,
    };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage may be unavailable; the active Room still retains the selection.
  }
}

export async function setElementSink(
  element: HTMLMediaElement,
  deviceId?: string,
): Promise<boolean> {
  if (!deviceId) return false;
  const sinkable = element as HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (!sinkable.setSinkId) return false;
  await sinkable.setSinkId(deviceId);
  return true;
}
