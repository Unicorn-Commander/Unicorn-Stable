/** Room header asks AppShell to open Activity. That open state lives in the shell. */
export const OPEN_ACTIVITY_EVENT = "stable:open-activity";

export function requestOpenActivity(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_ACTIVITY_EVENT));
}
