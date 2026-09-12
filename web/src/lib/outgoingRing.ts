export const RING_BACKSTOP_SLACK_MS = 6000;
export function ringDeadlinePassed(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  return !Number.isFinite(deadline) || now >= deadline + RING_BACKSTOP_SLACK_MS;
}
export function shouldPulseRing(phase: string | undefined, expiresAt: string | null, agentsJoined: boolean, now = Date.now()): boolean {
  return phase === "ringing" && !agentsJoined && !ringDeadlinePassed(expiresAt, now);
}
export function hasJoinedCast(connected: boolean, activeRoomId: string | null, callRoomId: string | null, hasAgent: boolean): boolean {
  return connected && !!callRoomId && activeRoomId === callRoomId && hasAgent;
}
