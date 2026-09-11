import { useEffect, useRef, useState } from "react";
import { microphonePermission, micSnapshot, type MicDiagnostic, type MicPermission } from "@/lib/micDiagnostics";
export function useMicDiagnostics(track: MediaStreamTrack | undefined, contextState: string, onDiagnostic?: (value: MicDiagnostic) => void) {
  const send = useRef(onDiagnostic); send.current = onDiagnostic;
  const [snapshot, setSnapshot] = useState(() => micSnapshot(track, contextState, "unsupported", "publish"));
  useEffect(() => {
    let active = true;
    let permission: MicPermission = "unsupported";
    let status: PermissionStatus | null = null;
    const report = (reason: string) => {
      if (!active) return;
      const next = micSnapshot(track, contextState, permission, reason);
      setSnapshot(next); send.current?.(next);
    };
    const permissionChanged = () => { permission = status?.state ?? "unsupported"; report("permission"); };
    const route = () => report("route_change");
    const visible = () => { if (document.visibilityState === "visible") report("resume"); };
    const changed = () => report("track_change");
    report("publish");
    void microphonePermission().then((value) => {
      if (!active) return;
      status = value; status?.addEventListener("change", permissionChanged); permissionChanged();
    });
    navigator.mediaDevices?.addEventListener("devicechange", route);
    window.addEventListener("pageshow", route);
    document.addEventListener("visibilitychange", visible);
    for (const event of ["mute", "unmute", "ended"]) track?.addEventListener(event, changed);
    return () => {
      active = false; status?.removeEventListener("change", permissionChanged);
      navigator.mediaDevices?.removeEventListener("devicechange", route);
      window.removeEventListener("pageshow", route); document.removeEventListener("visibilitychange", visible);
      for (const event of ["mute", "unmute", "ended"]) track?.removeEventListener(event, changed);
    };
  }, [track, contextState]);
  return snapshot;
}
