export type StableDeviceKind = "audioinput" | "videoinput" | "audiooutput";

/**
 * Studio default: the ZOOM AMS-44 USB interface, which is always on the desk.
 *
 * History, so nobody reverses this again: until 2026-09-12 the preferred
 * label was "AMS Microphone" and the Driver was treated as a "quiet sibling".
 * Measured that day: "AMS Microphone" is Aaron's iPhone (Apple, mono, 48 kHz,
 * Continuity) and only exists when the phone is nearby; "ZOOM AMS-44 Driver"
 * is the interface itself, a 4-channel device at 44.1 kHz. Chrome captures
 * only the first channel(s) of a multichannel input and downmixes to mono,
 * so a mic on input 3 or 4 is digital silence to a browser call and a mic on
 * input 1 alone reads ~12 dB down from a mono device (1 of 4 averaged) —
 * that was the "14 dB quieter" of 2026-08-30. The fix is on the desk (mic on
 * input 1), not in the picker.
 */
export const PREFERRED_AUDIO_INPUT_LABEL = "ZOOM AMS-44 Driver";
/**
 * A device we should not silently choose over the preferred one: the phone's
 * Continuity mic comes and goes with the phone and captures the room from
 * wherever the phone happens to be lying.
 */
export const TRANSIENT_AUDIO_INPUT_LABEL = "AMS Microphone";
/** @deprecated kept for callers; the Driver is no longer "quiet" — see above. */
export const QUIET_AUDIO_INPUT_LABEL = TRANSIENT_AUDIO_INPUT_LABEL;

/**
 * Chrome lists the OS default input twice: once as itself and once as a
 * pseudo-device (`deviceId` "default" / "communications", label
 * "Default - <name>"). A pick of that alias follows whatever macOS has as
 * its default — on the studio Mac that is the quiet Driver — and its label
 * hides the real name behind the prefix, so every label check strips it.
 */
export const PSEUDO_DEFAULT_IDS = new Set(["default", "communications"]);

export function underlyingLabel(label: string | undefined | null): string {
  return (label || "").replace(/^(Default|Communications) - /i, "");
}

function labelIs(device: { label: string }, wanted: string): boolean {
  const label = underlyingLabel(device.label);
  return label === wanted || label.startsWith(`${wanted} `);
}

/** True when this pick is the transient phone mic (directly or via the OS-default alias). */
export function isQuietAudioInput(device: { deviceId: string; label: string } | undefined): boolean {
  return !!device && labelIs(device, TRANSIENT_AUDIO_INPUT_LABEL);
}

/**
 * Pick the microphone for a new call.
 *
 * If the studio interface is present, use it — unless the saved pick is a
 * different device the user chose on purpose (not the OS-default alias, not
 * the phone's Continuity mic, which appears and disappears with the phone).
 */
export function pickAudioInputDevice(
  devices: Array<{ deviceId: string; label: string }>,
  savedId?: string,
): string {
  const [first] = devices;
  if (!first) return "";
  // Prefer the real device over its "Default - …" alias so the pick stays
  // pinned to the box, not to whatever the OS default drifts to.
  const preferred =
    devices.find(
      (d) => labelIs(d, PREFERRED_AUDIO_INPUT_LABEL) && !PSEUDO_DEFAULT_IDS.has(d.deviceId),
    ) ?? devices.find((d) => labelIs(d, PREFERRED_AUDIO_INPUT_LABEL));
  const saved = devices.find((d) => d.deviceId === savedId);
  // A saved alias ("default") is not a choice the user made for a device;
  // it is whatever the OS had that day. Treat it like no save at all when a
  // preferred input is present.
  const savedIsAlias = !!saved && PSEUDO_DEFAULT_IDS.has(saved.deviceId);
  const savedIsQuiet = isQuietAudioInput(saved);
  if (preferred && (!saved || savedIsQuiet || savedIsAlias)) return preferred.deviceId;
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
    return `This input (${TRANSIENT_AUDIO_INPUT_LABEL}) is the phone's mic and goes away with the phone. ${PREFERRED_AUDIO_INPUT_LABEL} is available — switch before you join.`;
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
