/**
 * Broadcast feeds — the pure logic behind Stable's OBS-ready, URL-addressable,
 * single-participant video page (`/broadcast/:roomId/:identity?token=…`).
 *
 * WHY THE PAGE EXISTS AT ALL: Stable's pop-out is a `window.open` CHILD
 * DOCUMENT, not a URL. OBS can only bind that by screen-scraping a window, and
 * macOS mints a NEW window id every time the pop-out is reopened — so OBS's
 * binding orphans silently and the guest vanishes from the live stream. A URL
 * cannot orphan: an OBS browser source re-fetches it on every restart.
 *
 * Everything in this module is deliberately free of React, LiveKit values and
 * `fetch`, so the three things most likely to be wrong on a live show —
 * WHICH track we show, WHEN we re-mint the LiveKit token, and WHAT the URL
 * says — are unit-testable without a browser or a running LiveKit.
 */

/* ------------------------------------------------------------------ *
 * Server contract (server/app/api/broadcast.py)
 * ------------------------------------------------------------------ */

/** `POST /api/v1/broadcast/join` — the ONLY endpoint a raw broadcast token opens. */
export interface BroadcastJoinResponse {
  livekit_url: string;
  /** Short-lived, subscribe-only, hidden LiveKit JWT. */
  token: string;
  room_name: string;
  /** WHO to render. Authoritative — never trust the URL path for this. */
  participant_identity: string;
  participant_label: string | null;
  /** Audio is minted opt-in; `?audio=1` alone must never unmute a feed. */
  allow_audio: boolean;
  /** ISO-8601 expiry of the BROADCAST TOKEN (up to 24h), not of the LiveKit JWT. */
  expires_at: string;
}

/* ------------------------------------------------------------------ *
 * Re-mint scheduling
 * ------------------------------------------------------------------ */

/**
 * The server clamps every LiveKit token it issues to at most one hour
 * (`LIVEKIT_TOKEN_MAX_TTL_S`), and never lets it outlive the broadcast token
 * that authorized it. A broadcast link, meanwhile, may live 24 hours.
 *
 * So a multi-hour stream WILL die mid-show unless the page re-calls /join and
 * reconnects on its own. These two constants mirror the server's clamp so the
 * page can compute the LiveKit token's real lifetime from `expires_at` alone —
 * the response does not state it.
 */
export const LIVEKIT_TOKEN_MIN_TTL_S = 60;
export const LIVEKIT_TOKEN_MAX_TTL_S = 3600;

/** Re-mint this far before the LiveKit token dies. Five minutes of slack. */
export const REFRESH_SAFETY_S = 300;

/**
 * Never spend more than this fraction of a short-lived token before refreshing.
 * Matters when the broadcast link itself is nearly expired: the safety margin
 * alone would compute a refresh in the past.
 */
export const REFRESH_FRACTION = 0.8;

/** Floor on the refresh timer, so a dying link can't spin a tight re-mint loop. */
export const MIN_REFRESH_DELAY_S = 10;

/**
 * How long the LiveKit token minted at `nowMs` will actually live, given the
 * broadcast token's expiry. Mirrors the server:
 *   ttl = max(60, min(3600, expires_at - now))
 */
export function livekitTokenTtlSeconds(
  expiresAtMs: number,
  nowMs: number,
): number {
  const remaining = Math.floor((expiresAtMs - nowMs) / 1000);
  return Math.max(
    LIVEKIT_TOKEN_MIN_TTL_S,
    Math.min(LIVEKIT_TOKEN_MAX_TTL_S, remaining),
  );
}

/**
 * Milliseconds to wait after a successful join before re-minting.
 *
 * A malformed/absent `expires_at` must never mean "never refresh" — that is
 * exactly the silent multi-hour death this whole mechanism exists to prevent —
 * so it falls back to the conservative full-TTL schedule.
 */
export function refreshDelayMs(
  expiresAtIso: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  const expiresAtMs = expiresAtIso ? Date.parse(expiresAtIso) : Number.NaN;
  const ttl = Number.isFinite(expiresAtMs)
    ? livekitTokenTtlSeconds(expiresAtMs, nowMs)
    : LIVEKIT_TOKEN_MAX_TTL_S;
  const target = Math.min(ttl - REFRESH_SAFETY_S, ttl * REFRESH_FRACTION);
  return Math.max(MIN_REFRESH_DELAY_S, target) * 1000;
}

/**
 * Reconnect/retry backoff. Doubles from 2s to a 30s ceiling — long enough that
 * two OBS sources pointed at the SAME link (which evict each other, one LiveKit
 * identity per token) damp out instead of flapping at full speed.
 */
export function backoffDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(30_000, 2_000 * 2 ** (n - 1));
}

/* ------------------------------------------------------------------ *
 * URL surface
 * ------------------------------------------------------------------ */

export interface BroadcastOptions {
  /** Raw broadcast token from `?token=`. Empty string when absent. */
  token: string;
  /** `?bg=transparent` — page paints nothing, so OBS can key it over a scene. */
  transparent: boolean;
  /** `?audio=1` — a REQUEST for audio. The server's `allow_audio` still decides. */
  wantAudio: boolean;
}

export function parseBroadcastOptions(search: string): BroadcastOptions {
  const params = new URLSearchParams(search);
  const bg = (params.get("bg") ?? "").trim().toLowerCase();
  const audio = (params.get("audio") ?? "").trim().toLowerCase();
  return {
    token: (params.get("token") ?? "").trim(),
    transparent: bg === "transparent",
    wantAudio: audio === "1" || audio === "true" || audio === "yes",
  };
}

export interface BroadcastUrlParts {
  /** Absolute origin, e.g. "https://stable.magicunicorn.tech". */
  origin: string;
  roomId: string;
  participantIdentity: string;
  token: string;
  transparent?: boolean;
  audio?: boolean;
}

/**
 * The absolute URL to paste into an OBS browser source.
 *
 * Built from parts rather than from the server's `url_path`, which is assembled
 * with plain interpolation: a LiveKit identity is `"<username>_<participant
 * uuid>"` today, but anything that ever lands a `?`, `#` or space in one would
 * silently truncate the token in the pasted URL.
 */
export function buildBroadcastUrl(parts: BroadcastUrlParts): string {
  const query = new URLSearchParams({ token: parts.token });
  if (parts.transparent) query.set("bg", "transparent");
  if (parts.audio) query.set("audio", "1");
  const path = [
    "broadcast",
    encodeURIComponent(parts.roomId),
    encodeURIComponent(parts.participantIdentity),
  ].join("/");
  return `${parts.origin.replace(/\/+$/, "")}/${path}?${query.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Who / what to render
 * ------------------------------------------------------------------ */

/**
 * Does this LiveKit participant identity match the one the token was minted
 * for? Exact, deliberately: a fuzzy match here would put the WRONG person's
 * camera on a live stream.
 */
export function isBroadcastTarget(
  identity: string | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!identity || !target) return false;
  return identity === target;
}

/**
 * The LiveKit identity Stable mints for a human member — `"<username>_<participant
 * id>"`, see server/app/api/tokens.py. Lets the room roster (which knows members,
 * not LiveKit identities) line up with `/broadcast/active`, whose rows are keyed
 * by LiveKit identity.
 */
export function livekitIdentityForMember(
  username: string | null | undefined,
  participantId: string | null | undefined,
): string | null {
  if (!username || !participantId) return null;
  return `${username}_${participantId}`;
}

/** The shape of a LiveKit TrackPublication this module needs. Structural on
 * purpose: local and remote publications both satisfy it, and so does a test. */
export interface BroadcastPublicationLike {
  /** "video" | "audio" */
  kind: string;
  /** "camera" | "screen_share" | "microphone" | "screen_share_audio" | … */
  source: string;
  /** Publisher-side mute. A muted camera must render NOTHING, not a frozen frame. */
  isMuted?: boolean;
  /** Present only once subscribed. */
  track?: unknown | null;
}

interface PickOptions {
  /**
   * Require the publication to carry a live track. False when deciding what to
   * SUBSCRIBE to (nothing is subscribed yet); true when deciding what to ATTACH.
   */
  requireTrack?: boolean;
}

function live<T extends BroadcastPublicationLike>(
  pubs: readonly T[],
  kind: string,
  opts?: PickOptions,
): T[] {
  return pubs.filter(
    (p) =>
      p.kind === kind &&
      !p.isMuted &&
      (opts?.requireTrack !== true || Boolean(p.track)),
  );
}

/**
 * The ONE video publication a broadcast feed renders.
 *
 * Camera first — a broadcast feed is a person, not a presentation — with
 * screen_share as the fallback for a participant who only ever publishes their
 * screen. Returns null when the camera is off, which the page renders as
 * black/transparent (never a placeholder: a placeholder would be composited
 * into a live stream).
 *
 * Note the inversion vs. StageView, which filters FOR `screen_share`.
 */
export function pickBroadcastVideoPublication<
  T extends BroadcastPublicationLike,
>(pubs: readonly T[], opts?: PickOptions): T | null {
  const candidates = live(pubs, "video", opts);
  return (
    candidates.find((p) => p.source === "camera") ??
    candidates.find((p) => p.source === "screen_share") ??
    null
  );
}

/**
 * The ONE audio publication a broadcast feed plays, when audio was BOTH minted
 * (`allow_audio`) and requested (`?audio=1`). Microphone first, then whatever
 * else is live (a screen share's audio).
 */
export function pickBroadcastAudioPublication<
  T extends BroadcastPublicationLike,
>(pubs: readonly T[], opts?: PickOptions): T | null {
  const candidates = live(pubs, "audio", opts);
  return (
    candidates.find((p) => p.source === "microphone") ?? candidates[0] ?? null
  );
}

/**
 * Audio plays only when the SERVER said the link may carry it and the URL asked
 * for it. Two independent switches, because `allow_audio` is the consent half:
 * a link minted video-only must stay video-only no matter what query string is
 * pasted around it.
 */
export function shouldPlayAudio(
  allowAudio: boolean | undefined,
  wantAudio: boolean,
): boolean {
  return Boolean(allowAudio) && wantAudio;
}
