export type MicPermission = PermissionState | "unsupported";
export interface MicDiagnostic {
  reason: string;
  track_muted: boolean | null;
  track_enabled: boolean | null;
  ready_state: string;
  device_id: string | null;
  sample_rate: number | null;
  audio_context_state: string;
  permission: MicPermission;
}
export async function microphonePermission(nav: Pick<Navigator, "permissions"> = navigator): Promise<PermissionStatus | null> {
  try { return await nav.permissions.query({ name: "microphone" as PermissionName }); }
  catch { return null; }
}
export function micSnapshot(track: MediaStreamTrack | undefined, audioContextState: string, permission: MicPermission, reason: string): MicDiagnostic {
  const settings = track?.getSettings() ?? {};
  return { reason, track_muted: track?.muted ?? null, track_enabled: track?.enabled ?? null,
    ready_state: track?.readyState ?? "missing", device_id: settings.deviceId ?? null,
    sample_rate: settings.sampleRate ?? null, audio_context_state: audioContextState, permission };
}
export function micWarning(diagnostic: Pick<MicDiagnostic, "permission" | "track_muted" | "ready_state">): string | null {
  if (diagnostic.permission === "denied") return "Microphone permission blocked. Allow microphone access in this browser or installed app's settings, then tap Repair audio.";
  if (diagnostic.track_muted || diagnostic.ready_state === "ended") return "Microphone interrupted. Another app or audio route may be using it. End other audio calls, select the phone microphone or disconnect CarPlay/Bluetooth, then tap Repair audio.";
  return null;
}
