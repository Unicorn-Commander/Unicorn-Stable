import { hasRole } from "@/services/auth";

/**
 * Roles that may edit a server's identity. Mirrors the backend default in
 * `server/app/api/instance_meta.py` (`STABLE_ADMIN_ROLES`).
 *
 * This is a DISPLAY gate only — it decides whether to draw the "Edit this
 * server" affordance. Authorization lives on the server, which re-derives the
 * caller's roles from the validated Keycloak token on every write and answers
 * 403 otherwise. Never treat this as a security boundary.
 */
const ADMIN_ROLES = ["stable-admin", "realm-admin", "admin"];

/** True when the signed-in user administers the ACTIVE instance. */
export function isServerAdmin(): boolean {
  return ADMIN_ROLES.some((role) => hasRole(role));
}
