/**
 * Per-user agent entitlement — the client half.
 *
 * The server annotates every roster entry with `entitled` (grants +
 * AGENT_ACCESS_DEFAULT) and 403s any attempt to bind an un-entitled agent
 * (DM creation, room invite, call-time dispatch). The client's chosen UX is
 * LOCK, not hide: directories still show everyone, but action affordances
 * (Pick/Chat/Call) render a lock with "Ask an admin" and don't fire.
 * These helpers keep that decision — and the wording — in one place.
 *
 * `entitled` is optional and defaults to true so a client talking to an
 * older server (no annotation) behaves exactly as before the feature.
 */

import type { ApiError } from "@/services/api";

/** The one consistent lock hint every locked affordance shows. */
export const AGENT_LOCK_HINT = "Ask an admin for access";

/** May the current user reach this agent? Absent annotation = yes. */
export function isAgentEntitled(
  agent: { entitled?: boolean } | null | undefined,
): boolean {
  return agent?.entitled !== false;
}

function asApiError(err: unknown): Partial<ApiError> | null {
  if (err && typeof err === "object" && "status" in err) {
    return err as Partial<ApiError>;
  }
  return null;
}

/**
 * Did this request die on the server's entitlement gate (403)? Used to pick
 * the toast copy and to stop retry loops that would re-hit the same wall.
 */
export function isEntitlementDenial(err: unknown): boolean {
  return asApiError(err)?.status === 403;
}

/**
 * Human-readable message for a failed request. ApiError carries the server's
 * clean `detail` ("You don't have access to the agent '…'"); `Error.message`
 * and the fallback cover everything else. Toasting `(err as Error).message`
 * on an ApiError yields just the statusText ("Forbidden") — never do that.
 */
export function apiErrorText(err: unknown, fallback: string): string {
  const apiErr = asApiError(err);
  if (apiErr) return apiErr.detail || apiErr.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
