export type StableDeviceKind = "audioinput" | "videoinput" | "audiooutput";

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
