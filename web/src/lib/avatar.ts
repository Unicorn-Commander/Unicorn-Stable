/**
 * Avatar resolution — the one place that decides which picture a resident of
 * the Stable renders with, for humans and agents alike.
 *
 * THE ORDER (top wins). Mirrored server-side in `models/participant.py` and
 * `api/participants.py`; change all three together or they will drift.
 *
 *   HUMANS
 *     1. Stable-local override   — a picture uploaded here, in Settings.
 *     2. Ops-Center picture      — the Keycloak `picture` claim, mirrored onto
 *                                  the Participant on every sign-in. This is
 *                                  the suite-wide identity and the auto-pull.
 *     3. Initials on the resident's identity colour (lib/identity.ts).
 *
 *   AGENTS
 *     1. Registered image        — Brigade `avatarUrl`. Brigade is canonical.
 *     2. `/avatars/<id>.webp`    — the convention, when Brigade serves it.
 *     3. EMOJI GLYPH             — Brigade's `avatar` field. Today this is the
 *                                  only agent avatar that actually exists.
 *     4. Initials on the identity colour.
 *
 * Tiers 1 and 2 collapse server-side into a single `avatar_url` on the wire, so
 * a caller only ever passes what it has: `avatarUrl` and (for agents) `emoji`.
 *
 * WHY THERE IS A HOST ALLOWLIST HERE
 * ----------------------------------
 * An avatar URL is attacker-influenced data that lands in an `<img src>` in
 * every connected client. A URL on a host we do not control is a tracking
 * pixel: it hands that host the IP address, user agent and rough online
 * schedule of everyone who so much as scrolls past the message. So a URL only
 * renders if it is same-origin or on one of our own hosts; anything else drops
 * to the next tier (emoji, then initials), which always renders something.
 *
 * This deliberately catches the GRAVATAR fallback that `auth/keycloak.py`
 * writes for users with no `picture` claim. `gravatar.com` is a third party,
 * and the URL embeds an MD5 of the user's email address, so it both leaks
 * viewers to Automattic and discloses a crackable email hash to anyone in the
 * room. It is also minted with `d=404`, so for any user without a Gravatar it
 * was only ever going to render a broken image. Those users now get initials.
 * The real fix is to stop minting it server-side — see the handoff notes.
 */
import { getToken, refreshToken } from "@/services/auth";
import { useFederationStore } from "@/stores/federationStore";
import {
  identityFor,
  initialsFor,
  registerAvatarSrc,
  type Identity,
} from "@/lib/identity";

/** Hosts we will point an `<img>` at. Suffix-matched on the parsed hostname,
 *  never on the raw string — `magicunicorn.dev.evil.com` must not match. */
const ALLOWED_AVATAR_HOST_SUFFIXES = [
  "magicunicorn.dev",
  "magicunicorn.tech",
  "unicorncommander.ai",
];

/**
 * Flip to allow third-party avatar hosts (Gravatar et al.). Off, and it should
 * stay off: see the privacy note above. Kept as a named constant so the choice
 * is visible and reversible rather than buried in a regex.
 */
const ALLOW_THIRD_PARTY_AVATAR_HOSTS = false;

/** The API origin of the active federated instance — mirrors api.ts, which
 *  keeps its copy private. Relative avatar paths are resolved against this so
 *  switching instances retargets them with everything else. */
export function avatarApiBase(): string {
  const fed = useFederationStore.getState();
  return (
    fed.accessibleInstances.find((i) => i.id === fed.activeInstanceId)
      ?.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    ""
  );
}

/**
 * Is this URL safe to render? Same-origin paths always are. Absolute URLs must
 * be https on one of our hosts.
 */
export function isSafeAvatarUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const raw = url.trim();
  if (!raw) return false;
  // Protocol-relative ("//evil.com/x.png") is an absolute URL wearing a
  // relative costume — check it before the leading-slash shortcut.
  if (raw.startsWith("//")) return false;
  if (raw.startsWith("/")) return true;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false; // blocks javascript:, data:, http:
  if (ALLOW_THIRD_PARTY_AVATAR_HOSTS) return true;
  const host = parsed.hostname.toLowerCase();
  if (typeof window !== "undefined" && host === window.location.hostname) {
    return true;
  }
  return ALLOWED_AVATAR_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith("." + s),
  );
}

/** Absolute src for an `<img>`, resolving our relative avatar paths against
 *  the active instance. Returns null for anything unsafe. */
export function toAvatarSrc(url: string | null | undefined): string | null {
  if (!isSafeAvatarUrl(url)) return null;
  const raw = (url as string).trim();
  // Bundle art ships with the WEB origin, not the API origin — a DB row that
  // points at "/agent-puppets/x.webp" must load from the SPA that rendered
  // it. Same host on both instances today, but the rewrite below is an
  // API-origin rewrite and would silently break the moment they split.
  if (raw.startsWith("/agent-puppets/") || raw.startsWith("/agent-avatars/")) {
    return raw;
  }
  return raw.startsWith("/") ? `${avatarApiBase()}${raw}` : raw;
}

// API-relative portraits follow the active instance. identity.ts cannot
// import this module (guest pages import identity.ts and must not pull
// Keycloak), so the signed-in app registers the resolver at load.
registerAvatarSrc(toAvatarSrc);

export { initialsFor } from "@/lib/identity";

export type AvatarKind = "image" | "emoji" | "initials";

export interface ResolvedAvatar {
  kind: AvatarKind;
  /** Set when kind === "image". Already absolute and safety-checked. */
  src: string | null;
  /** Set when kind === "emoji". */
  emoji: string | null;
  /** Always set — the last-resort render, and the label when an image fails. */
  initials: string;
  /** Deterministic hue for this resident, for the fallback fill. */
  identity: Identity;
}

export interface AvatarInput {
  /** Resolved avatar URL from the server (override already applied). */
  avatarUrl?: string | null;
  /** Agents only: Brigade's single-glyph avatar. */
  emoji?: string | null;
  /** Stable id — drives the identity colour. Prefer the participant/agent id. */
  id?: string | null;
  /** Display name — drives the initials. */
  name?: string | null;
}

/**
 * Resolve one resident's avatar. Never throws and never returns "nothing":
 * the initials tier always renders, so a missing or hostile URL degrades to a
 * legible circle rather than to a broken-image glyph.
 */
export function resolveAvatar(input: AvatarInput): ResolvedAvatar {
  const identity = identityFor(input.id, input.name);
  const initials = initialsFor(input.name ?? input.id);
  const src = toAvatarSrc(input.avatarUrl);
  // Carry the emoji THROUGH the image branch: ui/Avatar's onError falls back
  // to `resolved.emoji`, and returning null here made that branch dead code —
  // a dead URL skipped the emoji tier and landed on initials.
  const emoji = (input.emoji ?? "").trim();
  if (src) {
    return { kind: "image", src, emoji: emoji || null, initials, identity };
  }
  if (emoji) {
    return { kind: "emoji", src: null, emoji, initials, identity };
  }
  return { kind: "initials", src: null, emoji: null, initials, identity };
}

/* -------------------------------------------------------------------------
 * The "my avatar" API — the override tier.
 * ---------------------------------------------------------------------- */

export interface AvatarState {
  effective_url: string | null;
  source: "override" | "keycloak" | "none";
  keycloak_url: string | null;
  override_url: string | null;
  has_keycloak_picture: boolean;
  display_name: string;
  username: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  let token = getToken();
  if (!token) token = await refreshToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Error from the avatar API, carrying the HTTP status so the retry policy
 *  (and any caller) can classify it. `status` is null when the request never
 *  produced a response at all — DNS/socket/CORS failure. */
export class AvatarApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "AvatarApiError";
    this.status = status;
  }
}

/* Retry policy for the avatar READ path.
 *
 * This endpoint was once observed being hammered ~30× under a 401 — every
 * invocation site (login sync, settings mounts) re-fetched with the same dead
 * token and nothing anywhere classified the failure. The policy lives here, at
 * the single seam every request funnels through, so no caller can reintroduce
 * the storm:
 *
 *   - 401/403 NEVER retry. An expired or missing session does not heal
 *     because the client asks again; it heals on re-login/token refresh, and
 *     until then every extra request is pure load. All other 4xx are caller
 *     bugs and equally unretriable — except 408/429, which are the server
 *     saying "later", i.e. transient by definition.
 *   - Transient failures (no response at all, 408/429, any 5xx) retry with
 *     exponential backoff: 500ms → 1s → 2s, capped, 4 attempts total.
 *   - Mutations (upload/reset/refresh) never auto-retry: they are one user
 *     gesture each, surfaced in the Settings UI, and blind-retrying a POST is
 *     how you get double writes.
 */
export const AVATAR_RETRY_MAX_ATTEMPTS = 4;
export const AVATAR_RETRY_BASE_DELAY_MS = 500;
export const AVATAR_RETRY_MAX_DELAY_MS = 4_000;

export function isRetriableAvatarError(err: unknown): boolean {
  if (!(err instanceof AvatarApiError)) return false;
  if (err.status === null) return true; // network blip — the only guess-free retry
  if (err.status === 408 || err.status === 429) return true;
  return err.status >= 500;
}

/** Backoff before retry N (1-based): 500ms, 1s, 2s, … capped. */
export function avatarRetryDelayMs(attempt: number): number {
  return Math.min(
    AVATAR_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    AVATAR_RETRY_MAX_DELAY_MS,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= AVATAR_RETRY_MAX_ATTEMPTS || !isRetriableAvatarError(err)) {
        throw err;
      }
      await sleep(avatarRetryDelayMs(attempt));
    }
  }
}

async function call<T>(method: string, path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${avatarApiBase()}${path}`, {
      method,
      headers: await authHeaders(),
    });
  } catch (err) {
    // fetch() itself rejected: no response, no status. Distinguished from an
    // HTTP error so the retry policy can treat it as transient.
    throw new AvatarApiError(
      err instanceof Error ? err.message : "Network error",
      null,
    );
  }
  if (!resp.ok) throw new AvatarApiError(await errorText(resp), resp.status);
  return (await resp.json()) as T;
}

async function errorText(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: string };
    if (body.detail) return body.detail;
  } catch {
    /* non-JSON error body — fall through to the status line */
  }
  return `${resp.status} ${resp.statusText}`;
}

export function fetchMyAvatar(): Promise<AvatarState> {
  // Read-only and safe to repeat — the one avatar request that retries
  // (transient failures only; see the policy block above).
  return withRetry(() =>
    call<AvatarState>("GET", "/api/v1/participants/me/avatar"),
  );
}

/** Upload an override. Multipart — do NOT set Content-Type, the browser must
 *  add the boundary itself. */
export async function uploadMyAvatar(file: File): Promise<AvatarState> {
  const fd = new FormData();
  fd.append("file", file);
  const resp = await fetch(
    `${avatarApiBase()}/api/v1/participants/me/avatar`,
    { method: "POST", headers: await authHeaders(), body: fd },
  );
  // Single-shot on purpose: an upload is one user gesture with a visible
  // error line — never auto-retried (see the retry policy above).
  if (!resp.ok) throw new AvatarApiError(await errorText(resp), resp.status);
  return (await resp.json()) as AvatarState;
}

/** Drop the override and go back to the Ops-Center picture. */
export function resetMyAvatar(): Promise<AvatarState> {
  return call<AvatarState>("DELETE", "/api/v1/participants/me/avatar");
}

/** Re-pull the Ops-Center picture now, instead of waiting for the next token
 *  refresh to carry a new `picture` claim. */
export function refreshMyOpsCenterAvatar(): Promise<AvatarState> {
  return call<AvatarState>(
    "POST",
    "/api/v1/participants/me/avatar/refresh",
  );
}

/**
 * Reconcile the header avatar with the server's effective picture, in the
 * background, once per login.
 *
 * Why this exists: the header renders `currentUser.avatarUrl`, which is the
 * raw `picture` CLAIM from the access token — minted at login and stale the
 * moment anything changes server-side:
 *
 *   1. An override uploaded here (Settings) lives only in the Participant's
 *      metadata; the claim never carries it, so the header kept showing
 *      initials while every roster row showed the override.
 *   2. A photo added in Ops-Center after the last sign-in is invisible until
 *      the next token carries the `picture` claim — which can be the full
 *      token lifetime away.
 *
 * So on login we fetch the effective state once; when there is no effective
 * picture yet, we additionally ask for a Keycloak re-pull (the refresh
 * endpoint is quiet when there is nothing new). Any resulting URL is pushed
 * into the store, and the two render sites agree again. Never awaited by the
 * shell: a failure here must not block (or visibly error) the app.
 *
 * Failure behavior is inherited from the module retry policy: transient
 * errors back off and give up after a few tries; a 401/403 fails the sync
 * immediately and silently — a dead session is repaired by re-auth, not by
 * background requests.
 */
export async function syncMyAvatar(
  onUpdate: (effectiveUrl: string) => void,
): Promise<void> {
  try {
    let state = await fetchMyAvatar();
    if (!state.effective_url) {
      state = await refreshMyOpsCenterAvatar();
    }
    if (state.effective_url) onUpdate(state.effective_url);
  } catch {
    /* background sync — the initials fallback always renders */
  }
}

/** Client-side guard mirroring the server's. Kept in sync with
 *  `MAX_AVATAR_BYTES` / `_MAGIC` in api/participants.py. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** Returns an error string, or null when the file looks acceptable. The server
 *  re-checks by magic number regardless — this only saves a round trip and
 *  gives an instant, specific message. */
export function validateAvatarFile(file: File): string | null {
  if (file.size > MAX_AVATAR_BYTES) {
    return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`;
  }
  if (file.size === 0) return "That file is empty.";
  const type = (file.type || "").toLowerCase();
  if (type && !ACCEPTED_AVATAR_TYPES.split(",").includes(type)) {
    return "Pick a PNG, JPEG, GIF or WEBP image.";
  }
  return null;
}
