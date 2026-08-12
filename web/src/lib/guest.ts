/**
 * Guest access — the pure logic behind Stable's invite-redemption page and the
 * guest-scoped room shell (`/guest/:token`).
 *
 * WHAT A GUEST IS: an outsider with NO Unicorn Commander account who redeems an
 * expiring, revocable link and becomes an ephemeral participant in EXACTLY ONE
 * room, so a "Build In Public" show can have outside guests on camera. Their
 * credential is a Stable row, not a Keycloak session — see
 * server/app/auth/guest_auth.py for why routing a guest through ANY OIDC path
 * would silently mint a real suite account for a stranger.
 *
 * Everything in this module is deliberately free of React, LiveKit values and
 * `fetch`, so the four things most likely to be wrong on a live show — WHAT the
 * invite URL says, WHETHER a refusal leaked which check failed, WHEN we stop
 * reconnecting, and WHO gets badged as a guest — are unit-testable without a
 * browser or a running server.
 *
 * FORWARD COMPATIBILITY IS A REQUIREMENT HERE, not a nicety. The server may add
 * optional response fields (a history boundary, per-invite capability flags)
 * after this client ships, and an older browser tab left open through a
 * redeploy must degrade rather than crash. So every server value is read
 * through a normalizer that tolerates absent/unknown/wrong-typed fields, and
 * an absent optional always falls back to today's behaviour.
 */

/* ------------------------------------------------------------------ *
 * Server contract (server/app/api/guests.py, server/app/auth/guest_auth.py)
 * ------------------------------------------------------------------ */

/** Prefix of the token in an invite URL. Only `POST /guest/redeem` accepts it. */
export const GUEST_INVITE_PREFIX = "sgi-";

/** Prefix of the session credential. Sent as `Authorization: Bearer <…>` and
 *  as the WebSocket auth frame's token. Distinct from the gateway's ("sbk-",
 *  "ubk-", "sk-") and the broadcast token's ("sbt-"). */
export const GUEST_SESSION_PREFIX = "sgs-";

/** Server-side hard cap on a guest display name (auth/guest_auth.py). */
export const MAX_GUEST_DISPLAY_NAME = 64;

/** The badge every guest participant carries, everywhere one is rendered. */
export const GUEST_BADGE_LABEL = "Guest";

/**
 * THE ONE REFUSAL.
 *
 * The server answers unknown token, revoked invite, expired invite, exhausted
 * invite and WRONG PASSPHRASE with one identical 403 — and burns the same
 * PBKDF2 time on the unknown-token path so the five cases are indistinguishable
 * by latency too. A UI that said which one it was would hand back the oracle
 * the server spent that effort closing, so there is exactly one string here and
 * it names every cause at once. Do not add a second variant.
 */
export const GUEST_LINK_INVALID_MESSAGE =
  "This guest link isn't valid. It may have expired, been used up, been turned " +
  "off, or the passphrase may not match. Ask whoever invited you for a new link.";

/** `POST /api/v1/guest/redeem` → the guest's credential + the one room. */
export interface GuestRedeemBody {
  token: string;
  display_name?: string;
  passphrase?: string;
}

/* ------------------------------------------------------------------ *
 * The client's own session shape
 * ------------------------------------------------------------------ */

/**
 * Everything the guest client knows about itself. Built by
 * {@link guestSessionFromRedeem} and refreshed by {@link mergeGuestMe}; nothing
 * else may construct one, so there is a single place where a server field
 * becomes a client fact.
 */
export interface GuestSession {
  /** `sgs-…`. The whole credential — HTTP bearer AND WebSocket auth frame. */
  token: string;
  sessionId: string;
  participantId: string;
  displayName: string;
  /** The ONE room. A guest client never has a room list to pick from. */
  roomId: string;
  roomName: string;
  /**
   * May this guest turn a camera/mic on? Comes from the INVITE, via the
   * server. The client never decides this: the LiveKit grant is built from the
   * same field server-side, so a client that ignored it would just fail to
   * publish.
   */
  canPublish: boolean;
  /** ISO-8601, or null when the server did not send one. Never invented. */
  expiresAt: string | null;
  /**
   * OPTIONAL, server may add later: the earliest message a guest may see, as
   * epoch ms. null = no boundary was sent, which is today's behaviour (the
   * server returns what the guest may read and the client shows it).
   */
  historyFromMs: number | null;
  /**
   * OPTIONAL, server may add later: per-invite capability flags. Read through
   * {@link guestCan}, which falls back to today's behaviour for any key the
   * server did not send. The server remains the enforcement point either way —
   * these only stop the client from OFFERING something that would 403.
   */
  capabilities: Record<string, boolean>;
  /**
   * WHICH LINK produced this session — the invite token's first 12 characters,
   * the same non-secret `token_prefix` the server stores and shows the room
   * owner. It exists so a restored session can be checked against the link
   * currently in the URL: without it, opening a SECOND invite in a tab that
   * already redeemed a first one would silently drop you back into the first
   * room. Never the whole token: an invite token is a reusable credential and
   * has no business sitting in storage.
   */
  inviteKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Optional boolean. Absent, null or a non-boolean all yield `fallback` rather
 * than coercing — `"false"` and `0` must never read as a grant, and a field the
 * server has not shipped yet must not read as a denial.
 */
function readBool(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A history boundary, whatever the server ends up calling it. Accepts an
 * ISO-8601 string or epoch ms/seconds, and returns null for anything it cannot
 * read — a boundary we cannot parse must not silently become "show nothing".
 */
function readHistoryBoundaryMs(raw: Record<string, unknown>): number | null {
  for (const key of ["history_from", "history_start_at", "history_since"]) {
    const value = raw[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      // Seconds vs milliseconds: anything below ~year 2286 in ms is a second
      // count that would otherwise land in 1970 and hide the whole room.
      return value < 1e11 ? value * 1000 : value;
    }
  }
  return null;
}

/** The server's top-level capability booleans, mapped to the capability keys
 *  this client asks about. `agent` is what gates offering an "ask the agent"
 *  affordance; `mention_email` is advisory only and enforced server-side. */
const TOP_LEVEL_CAPABILITIES: Record<string, string> = {
  allow_agent_trigger: "agent",
  allow_mention_email: "mention_email",
};

/** Per-invite capability flags, if the server sent any. Non-boolean entries are
 *  dropped rather than coerced, for the same reason as {@link readBool}.
 *
 *  The server sends these as TOP-LEVEL booleans on /guest/redeem and /guest/me
 *  (`allow_agent_trigger`, `allow_mention_email`) — reading only a nested
 *  `capabilities` object, as this did until 2026-08-12, left the map
 *  permanently empty, so {@link guestCan} always returned its fallback and the
 *  client never learned what the invite actually granted. The nested form is
 *  still honoured and wins, so a server that later sends one keeps working. */
function readCapabilities(raw: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [field, capability] of Object.entries(TOP_LEVEL_CAPABILITIES)) {
    const value = raw[field];
    if (typeof value === "boolean") out[capability] = value;
  }
  const source = raw.capabilities;
  if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "boolean") out[key] = value;
    }
  }
  return out;
}

/**
 * Is a capability granted? An ABSENT key returns `fallback`, which callers set
 * to today's behaviour — so shipping this client before the server grows the
 * field changes nothing, and a server that later denies something the client
 * offered is still the one enforcing it.
 */
export function guestCan(
  session: Pick<GuestSession, "capabilities"> | null | undefined,
  capability: string,
  fallback = true,
): boolean {
  const value = session?.capabilities?.[capability];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The non-secret prefix of an invite token — 12 characters, mirroring the
 * server's own `token_prefix` (api/guests.py), which it stores in the clear and
 * shows the room owner. Enough to tell two links apart, nowhere near enough to
 * be one.
 */
export function guestInviteKey(token: string | null | undefined): string {
  return typeof token === "string" ? token.trim().slice(0, 12) : "";
}

/**
 * Is a restored session the one this link would have produced?
 *
 * A URL with no token has nothing to disagree with, so the stored session
 * stands (that is a bare `/guest` reload). Otherwise the prefixes must match —
 * a mismatch means the person opened a different invite and must redeem it.
 */
export function storedSessionMatchesLink(
  session: Pick<GuestSession, "inviteKey">,
  linkToken: string | null | undefined,
): boolean {
  const key = guestInviteKey(linkToken);
  if (!key) return true;
  return session.inviteKey === key;
}

/**
 * Build a session from the redeem response. Returns null when a REQUIRED field
 * is missing — a half-built session would produce a shell pointed at no room,
 * which looks like a bug in the room rather than a bad response.
 */
export function guestSessionFromRedeem(
  raw: unknown,
  inviteToken?: string | null,
): GuestSession | null {
  if (!isRecord(raw)) return null;
  const token = readString(raw, "session_token");
  const roomId = readString(raw, "room_id");
  const participantId = readString(raw, "participant_id");
  if (!token || !roomId || !participantId) return null;
  if (!isGuestSessionToken(token)) return null;
  return {
    token,
    sessionId: readString(raw, "session_id") ?? "",
    participantId,
    displayName: readString(raw, "display_name") ?? GUEST_BADGE_LABEL,
    roomId,
    roomName: readString(raw, "room_display_name") ?? "",
    // Absent means "we were not granted publish", not "assume publish": this
    // decides whether the shell opens a camera.
    canPublish: readBool(raw, "can_publish", false),
    expiresAt: readString(raw, "expires_at"),
    historyFromMs: readHistoryBoundaryMs(raw),
    capabilities: readCapabilities(raw),
    // Falls back to whatever a stored blob carried, so the storage round-trip
    // goes through this one validator without losing the link it came from.
    inviteKey: guestInviteKey(inviteToken) || (readString(raw, "invite_key") ?? ""),
  };
}

/**
 * Fold a `GET /guest/me` response into the live session.
 *
 * Every field is optional here ON PURPOSE: /guest/me is polled, and a response
 * that dropped a field (older server, partial rollout) must leave the existing
 * value alone rather than blanking the room name or revoking the camera. The
 * token is never read from this response — it is not in it.
 */
export function mergeGuestMe(session: GuestSession, raw: unknown): GuestSession {
  if (!isRecord(raw)) return session;
  const capabilities = readCapabilities(raw);
  return {
    ...session,
    sessionId: readString(raw, "session_id") ?? session.sessionId,
    participantId: readString(raw, "participant_id") ?? session.participantId,
    displayName: readString(raw, "display_name") ?? session.displayName,
    roomId: readString(raw, "room_id") ?? session.roomId,
    roomName: readString(raw, "room_display_name") ?? session.roomName,
    canPublish: readBool(raw, "can_publish", session.canPublish),
    expiresAt: readString(raw, "expires_at") ?? session.expiresAt,
    historyFromMs: readHistoryBoundaryMs(raw) ?? session.historyFromMs,
    capabilities:
      Object.keys(capabilities).length > 0 ? capabilities : session.capabilities,
  };
}

export function isGuestSessionToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith(GUEST_SESSION_PREFIX);
}

/* ------------------------------------------------------------------ *
 * The invite URL
 * ------------------------------------------------------------------ */

export interface GuestInviteLink {
  /** The raw invite token from the path. "" when the URL carries none. */
  token: string;
  /**
   * `?p=1` — a pure UX hint (minted by the server) so the page can render the
   * passphrase field up front. NOT authorization, and it carries no secret: a
   * forged or missing flag changes nothing about what redemption accepts, so
   * the field stays available either way.
   */
  passphraseHint: boolean;
}

/**
 * Parse `/guest/<token>?p=1`.
 *
 * Only the FIRST path segment is the token — a trailing segment someone pasted
 * on must not become part of it — and it is percent-decoded defensively even
 * though `secrets.token_urlsafe` only ever emits `[A-Za-z0-9_-]`, because a
 * chat client that escaped the URL should still redeem.
 */
export function parseGuestInviteLink(
  pathname: string,
  search = "",
): GuestInviteLink {
  const match = /^\/guest\/([^/?#]+)/.exec(pathname ?? "");
  const segment = match?.[1] ?? "";
  let token = "";
  if (segment) {
    try {
      token = decodeURIComponent(segment).trim();
    } catch {
      // A lone "%" is not a valid escape sequence. Use the raw segment rather
      // than throwing a redeem page away over it.
      token = segment.trim();
    }
  }
  const params = new URLSearchParams(search ?? "");
  const hint = (params.get("p") ?? "").trim().toLowerCase();
  return {
    token,
    passphraseHint: hint === "1" || hint === "true" || hint === "yes",
  };
}

/* ------------------------------------------------------------------ *
 * The display name
 * ------------------------------------------------------------------ */

/** Zero-width joiners/spaces, bidi overrides, isolates and the BOM — the
 *  standard ways to make "Aaron" and "Aaron" different strings, or to
 *  reverse-render a name in a member list. Mirrors `_INVISIBLE_RE`. */
const INVISIBLE_RE =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** Control, format, surrogate and separator characters — the JS approximation
 *  of the `str.isprintable()` test the server applies. U+0020 is the one
 *  separator that survives. */
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * Sanitize the name the guest typed — the PREVIEW half only.
 *
 * `clean_display_name` on the server is the authority and runs again on
 * whatever we send; this exists so the field shows the person the name they
 * will actually get, and so the form can tell "typed nothing usable" from
 * "typed something". It deliberately returns "" rather than the server's
 * "Guest" fallback: an empty result is what the form needs to block Join.
 */
export function cleanGuestDisplayName(raw: string | null | undefined): string {
  const normalized = String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, "");
  let printable = "";
  for (const ch of normalized) {
    if (ch === " " || !NON_PRINTABLE_RE.test(ch)) {
      printable += ch;
    } else if (/\s/u.test(ch)) {
      // A newline becomes a SEPARATOR, not nothing: dropping it outright would
      // silently join "Ada\nLovelace" into "AdaLovelace".
      printable += " ";
    }
  }
  return printable.split(/\s+/u).filter(Boolean).join(" ").slice(0, MAX_GUEST_DISPLAY_NAME);
}

/** Would this name survive the server's cleaner as something renderable? */
export function isAcceptableGuestDisplayName(
  raw: string | null | undefined,
): boolean {
  return cleanGuestDisplayName(raw).length > 0;
}

/* ------------------------------------------------------------------ *
 * Redemption outcomes
 * ------------------------------------------------------------------ */

/**
 * What the redeem page may tell the person, and nothing finer.
 *
 *  - `invalid`     the uniform refusal (and a disabled feature, which answers
 *                  404 precisely so it looks like a link that never existed)
 *  - `rate_limited` the per-IP brute-force guard tripped
 *  - `unavailable` the server FAILS CLOSED on a Redis outage rather than
 *                  quietly lifting the only guard on its one unauthenticated
 *                  endpoint — a loud 503 is a real answer, not a refusal
 *  - `offline`     no HTTP response at all
 */
export type GuestRedeemOutcome =
  | "invalid"
  | "rate_limited"
  | "unavailable"
  | "offline";

export function redeemOutcomeFor(status: number): GuestRedeemOutcome {
  if (status === 429) return "rate_limited";
  // 0 is this client's "no response" sentinel (network drop / abort).
  if (status === 0) return "offline";
  if (status >= 500) return "unavailable";
  // 401/403 (refused), 404 (feature disabled — deliberately shaped like a link
  // that never existed), 400/422 (a token too short to be one) are ONE answer.
  return "invalid";
}

export function redeemMessageFor(outcome: GuestRedeemOutcome): string {
  switch (outcome) {
    case "rate_limited":
      return "Too many attempts from this network. Wait a minute, then try again.";
    case "unavailable":
      return "Guest access is temporarily unavailable. Try again in a moment.";
    case "offline":
      return "Couldn't reach the server. Check your connection and try again.";
    case "invalid":
    default:
      return GUEST_LINK_INVALID_MESSAGE;
  }
}

/** May the person usefully press Try again? A refusal is final; the rest are
 *  conditions that pass. */
export function isRetryableRedeemOutcome(outcome: GuestRedeemOutcome): boolean {
  return outcome !== "invalid";
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

/** Why a guest session is over. All three are TERMINAL — none retries. */
export type GuestEndReason = "revoked" | "expired" | "left";

export interface GuestState {
  phase: "redeem" | "live" | "ended";
  session: GuestSession | null;
  ended: GuestEndReason | null;
}

export type GuestEvent =
  /** Redemption succeeded, or a stored session was restored on reload. */
  | { type: "joined"; session: GuestSession }
  /** The `{"type":"session_ended"}` WS frame: revoked, or the session lapsed. */
  | { type: "session_ended" }
  /** Any guest endpoint answered 401 — the credential stopped authenticating. */
  | { type: "unauthorized" }
  /** The local expiry clock ran out with no server word yet. */
  | { type: "expired" }
  /** The guest pressed Leave. */
  | { type: "left" };

export function initialGuestState(
  session?: GuestSession | null,
): GuestState {
  return session
    ? { phase: "live", session, ended: null }
    : { phase: "redeem", session: null, ended: null };
}

/**
 * The whole guest lifecycle, as one pure transition.
 *
 * TWO INVARIANTS, both load-bearing:
 *
 *  1. Every ending DROPS THE TOKEN. A dead credential kept in state is a
 *     credential something will eventually retry with — which is exactly the
 *     "reconnect forever after revocation" behaviour `session_ended` exists to
 *     stop.
 *  2. "ended" is sticky. A late frame from a socket that was already torn down,
 *     or a 401 arriving after Leave, must not reopen a room or downgrade a
 *     revocation into "you left". Only a fresh `joined` (i.e. a new redemption)
 *     starts a session again.
 */
export function nextGuestState(
  state: GuestState,
  event: GuestEvent,
): GuestState {
  switch (event.type) {
    case "joined":
      return { phase: "live", session: event.session, ended: null };
    case "session_ended":
    case "unauthorized":
      if (state.phase === "ended") return state;
      return { phase: "ended", session: null, ended: "revoked" };
    case "expired":
      if (state.phase === "ended") return state;
      return { phase: "ended", session: null, ended: "expired" };
    case "left":
      if (state.phase === "ended") return state;
      return { phase: "ended", session: null, ended: "left" };
    default:
      return state;
  }
}

export function endReasonMessage(reason: GuestEndReason): string {
  switch (reason) {
    case "left":
      return "You've left the room. Your guest link may still work if it hasn't expired.";
    case "expired":
      return "This guest session has ended because the link's time ran out.";
    case "revoked":
    default:
      // Uniform again: revoked-by-host and lapsed-server-side are one answer,
      // and the client genuinely cannot tell them apart.
      return "This invite is no longer valid. Ask whoever invited you for a new link.";
  }
}

/* ------------------------------------------------------------------ *
 * Expiry
 * ------------------------------------------------------------------ */

/** Milliseconds until the session lapses, or null when there is no readable
 *  expiry. Negative once it has passed. */
export function guestSessionExpiresInMs(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!expiresAt) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed - nowMs : null;
}

/**
 * Has the session lapsed by the LOCAL clock?
 *
 * An absent or unreadable expiry is NOT expired. The server re-checks the
 * credential on every request and the socket re-checks it every 4 seconds, so
 * it is the authority; a client that guessed "expired" from a field it could
 * not parse would throw a working guest off a live show over a date format.
 */
export function isGuestSessionExpired(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const remaining = guestSessionExpiresInMs(expiresAt, nowMs);
  return remaining !== null && remaining <= 0;
}

/** Warn this long before the session lapses — enough notice to say goodbye on
 *  camera, short enough not to nag for the whole show. */
export const GUEST_EXPIRY_WARNING_MS = 10 * 60_000;

/** A "your access ends soon" line, or null while there is nothing useful to
 *  say (no readable expiry, plenty of time left, or already over). */
export function guestExpiryNotice(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const remaining = guestSessionExpiresInMs(expiresAt, nowMs);
  if (remaining === null || remaining > GUEST_EXPIRY_WARNING_MS) return null;
  if (remaining <= 0) return null;
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `Your guest access ends in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/* ------------------------------------------------------------------ *
 * The socket
 * ------------------------------------------------------------------ */

/**
 * A `{"type":"session_ended"}` frame. The server sends it on the force-
 * disconnect path (the host revoked the link or booted this guest) and on the
 * 4-second session re-check (the session or its invite lapsed under a live
 * socket). It means STOP: reconnecting replays a refusal forever and leaves the
 * browser looking connected while nothing is live.
 */
export function isSessionEndedFrame(frame: unknown): boolean {
  return isRecord(frame) && frame.type === "session_ended";
}

/** The server's `auth_ok` ack, which is when the socket is really usable. */
export function isAuthOkFrame(frame: unknown): boolean {
  return isRecord(frame) && frame.type === "auth_ok";
}

/**
 * Should the socket come back after this close code?
 *
 * 4001 (no/!bad auth frame), 4003 (authentication failed) and 4004 (participant
 * or guest membership not found) are the server's verdicts on THIS credential.
 * Retrying replays a refusal. Everything else — 1006 handshake refusal, a
 * network drop, a proxy stall — is transport, and a guest mid-show should
 * absolutely come back from those.
 */
export function shouldReconnectAfterClose(code: number): boolean {
  return code !== 4001 && code !== 4003 && code !== 4004;
}

/** Reconnect backoff: 1s doubling to a 20s ceiling. Shorter than the broadcast
 *  page's because a person is watching this one and a show does not wait. */
export function guestReconnectDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(20_000, 1_000 * 2 ** (n - 1));
}

/* ------------------------------------------------------------------ *
 * Rendering guests
 * ------------------------------------------------------------------ */

/**
 * Is this participant a guest?
 *
 * Read the SERVER's `participant_type`, never the display name (which the guest
 * chose) and never the `guest-<hex>` username convention (which is an identity
 * detail, not a claim about access). A legacy row with no participant_type is a
 * human, exactly as every other reader in the app already assumes.
 */
export function isGuestParticipant(
  participantType: string | null | undefined,
): boolean {
  return participantType === "guest";
}

/**
 * Is this MESSAGE from a guest? `sender_type` is serialized straight from
 * `Participant.participant_type` (server/app/api/messages.py), so a guest's
 * message arrives as `sender_type: "guest"` — a value the pre-existing
 * `"human" | "agent" | "system"` union never contained.
 */
export function isGuestSender(senderType: string | null | undefined): boolean {
  return senderType === "guest";
}

/** The subset of a room-member row this module needs to badge a call tile. */
export interface GuestBadgeMember {
  username?: string | null;
  participant_id?: string | null;
  user_id?: string | null;
  participant_type?: string | null;
}

/**
 * Is this LiveKit identity a guest's?
 *
 * A LiveKit token carries no guest marker (server/app/api/tokens.py mints an
 * ordinary identity for a guest, deliberately, so presence and the occupancy
 * webhook treat them like anyone else), so the CALL surface has to join back to
 * the roster — which does carry `participant_type`. Identity is
 * `<username>_<participant id>`, the same string `livekitIdentityForMember`
 * builds; matching on it rather than on a `guest-` username prefix keeps the
 * badge sourced from the server's type field like every other one.
 */
export function isGuestCallIdentity(
  identity: string | null | undefined,
  members: readonly GuestBadgeMember[] | null | undefined,
): boolean {
  if (!identity || !members?.length) return false;
  return members.some((m) => {
    if (!isGuestParticipant(m.participant_type)) return false;
    const pid = m.participant_id || m.user_id;
    if (!m.username || !pid) return false;
    return `${m.username}_${pid}` === identity;
  });
}

/* ------------------------------------------------------------------ *
 * History boundary
 * ------------------------------------------------------------------ */

/**
 * May a guest see this message, given the optional history boundary?
 *
 * The server is the enforcement point — it decides what `GET /rooms/{id}/
 * messages` returns for a guest — so this is the DISPLAY half, covering the
 * live WebSocket echo and anything already in hand. With no boundary set
 * (today) everything is visible, which is exactly current behaviour.
 *
 * A message whose timestamp cannot be read is HIDDEN when a boundary exists: a
 * boundary's whole purpose is "not what came before", and one unreadable
 * timestamp is a much smaller loss than leaking the room's back catalogue.
 */
export function isMessageVisibleToGuest(
  createdAt: string | null | undefined,
  historyFromMs: number | null,
): boolean {
  if (historyFromMs === null) return true;
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return false;
  return parsed >= historyFromMs;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export const GUEST_SESSION_STORAGE_KEY = "stable.guest.session.v1";

/** The slice of the Storage API this module uses. Injectable so the round-trip
 *  is testable without a browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * WHY sessionStorage AND NOT localStorage — two independent reasons:
 *
 *  1. `LandingGate` (App.tsx) treats ANY `stable.*` key in localStorage as
 *     "this browser has been here before" and skips the marketing front door.
 *     A stranger who joined one video call is not a returning user, and a guest
 *     session must not silently change what "/" shows them afterwards.
 *  2. A guest credential should not outlive the tab. These links get opened on
 *     borrowed and shared laptops at a show; a token that survives the browser
 *     closing is a room someone else can walk into.
 */
function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Private-mode Safari throws on access. No persistence is a fine outcome:
    // the session lives in memory for as long as the page does.
    return null;
  }
}

export function writeStoredGuestSession(
  session: GuestSession,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(GUEST_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* quota / private mode — the in-memory session still works */
  }
}

/**
 * Restore a session across a reload. Anything unreadable, truncated or tampered
 * with yields null rather than a partly-built session, because it goes back
 * through the same normalizer the network path uses.
 */
export function readStoredGuestSession(
  storage: StorageLike | null = defaultStorage(),
): GuestSession | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(GUEST_SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // Re-validate through the network normalizer by mapping the stored camelCase
  // back onto the wire names — one validator, so a stored blob can never become
  // a session the network path would have rejected.
  return guestSessionFromRedeem({
    session_token: parsed.token,
    session_id: parsed.sessionId,
    participant_id: parsed.participantId,
    display_name: parsed.displayName,
    room_id: parsed.roomId,
    room_display_name: parsed.roomName,
    can_publish: parsed.canPublish,
    expires_at: parsed.expiresAt,
    history_from:
      typeof parsed.historyFromMs === "number" ? parsed.historyFromMs : undefined,
    capabilities: parsed.capabilities,
    invite_key: parsed.inviteKey,
  });
}

export function clearStoredGuestSession(
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(GUEST_SESSION_STORAGE_KEY);
  } catch {
    /* nothing to clean up we can reach */
  }
}
