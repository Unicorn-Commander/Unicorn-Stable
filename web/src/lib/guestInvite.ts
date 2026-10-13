/**
 * Guest invites — the pure logic behind the HOST's half of guest access: minting
 * a link, reading what an existing link actually grants, and revoking one.
 *
 * The guest's half lives in `lib/guest.ts`. This module is the other end of the
 * same server contract (server/app/api/guests.py) and never imports it: the two
 * surfaces share a server, not a code path, and a guest client has no business
 * carrying the owner's shapes.
 *
 * WHAT THIS IS FOR: a room owner mints an expiring, revocable link and hands it
 * to an outsider with NO Unicorn Commander account, so a "Build In Public" show
 * can have real guests on camera. THE LINK IS A CREDENTIAL — it opens a live
 * room with no login — which is why the mint response's raw token exists exactly
 * once (the server stores only its SHA-256) and why nothing here writes it
 * anywhere. `buildGuestInviteUrl` returns a string for the clipboard and the
 * caller is expected to drop it.
 *
 * THE THREE WIDENINGS. An invite carries three ways to be more permissive than
 * the default, and the server defaults all three to the closed answer so the
 * least-typing invite is the safest one. This module keeps them that way:
 * {@link DEFAULT_GUEST_INVITE_DRAFT} matches the server's defaults exactly, and
 * {@link guestInviteMintBody} states each one explicitly on the wire rather than
 * relying on an omitted field to mean "off". A grant should be something someone
 * asked for in two places, not something that fell out of a missing key.
 *
 * Everything here is deliberately free of React and `fetch`, so the things most
 * likely to be wrong on a live show — WHAT a link grants, WHETHER the form is
 * about to widen something, and WHETHER a revoked link still looks live — are
 * unit-testable without a browser or a running server.
 */

/* ------------------------------------------------------------------ *
 * Server contract (server/app/api/guests.py)
 * ------------------------------------------------------------------ */

/** `POST /api/v1/rooms/{id}/guest-invites` — mirrors `MintInviteBody`. */
export interface MintGuestInviteBody {
  ttl_hours?: number;
  passphrase?: string;
  can_publish?: boolean;
  max_uses?: number;
  label?: string;
  allow_agent_trigger?: boolean;
  allow_mention_email?: boolean;
  history_hours?: number;
  history_all?: boolean;
}

/**
 * One row of `GET /api/v1/rooms/{id}/guest-invites` — mirrors `GuestInviteInfo`.
 * Metadata only: `token_prefix` is the first 12 characters the server stores in
 * the clear, and there is no route that returns the rest.
 */
export interface GuestInviteRow {
  id: string;
  room_id: string;
  token_prefix: string;
  has_passphrase: boolean;
  can_publish: boolean;
  max_uses: number | null;
  use_count: number;
  label: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  /** The server's own verdict, computed at response time. See {@link guestInviteStatus}. */
  active: boolean;
  allow_agent_trigger: boolean;
  allow_mention_email: boolean;
  /** ISO-8601. The epoch (1970) is the server's "entire back-history" sentinel. */
  history_from: string;
}

/** The mint response — `GuestInviteInfo` plus the two one-time fields. */
export interface MintGuestInviteResponse extends GuestInviteRow {
  /** Returned ONCE, stored nowhere, never retrievable. Treat as a credential. */
  token: string;
  /** The server's own `/guest/<token>` path. We build our own — see
   *  {@link buildGuestInviteUrl} — and keep this only for parity checks. */
  url_path: string;
}

/** One row of `…/guest-invites/{id}/sessions` — mirrors `GuestSessionInfo`. */
export interface GuestSessionRow {
  id: string;
  invite_id: string;
  participant_id: string;
  display_name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  active: boolean;
}

/** Both revoke endpoints answer with this. `sessions_terminated` is the number
 *  of live guests actually hung up on, which is the only honest thing to put in
 *  a confirmation toast. */
export interface GuestRevokeResult {
  id: string;
  revoked: boolean;
  sessions_terminated: number;
}

/* ------------------------------------------------------------------ *
 * Server-side limits, mirrored so the form refuses before the network does
 * ------------------------------------------------------------------ */

/** `Settings.guest_invite_default_ttl_hours`. */
export const GUEST_INVITE_DEFAULT_TTL_HOURS = 24;
/** `Settings.guest_invite_max_ttl_hours`. The server 400s past it; an operator
 *  may have lowered it, so this is the form's guard, not the authority. */
export const GUEST_INVITE_MAX_TTL_HOURS = 168;
/** `MintInviteBody.history_hours` — `le=8760`, i.e. one year. */
export const GUEST_HISTORY_MAX_HOURS = 8760;
/** `MintInviteBody.max_uses` — `ge=1, le=500`. */
export const GUEST_INVITE_MAX_USES_CAP = 500;
/** `MintInviteBody.passphrase` — `min_length=4, max_length=128`. */
export const GUEST_PASSPHRASE_MIN = 4;
export const GUEST_PASSPHRASE_MAX = 128;
/** `MintInviteBody.label` — `max_length=255`. */
export const GUEST_INVITE_LABEL_MAX = 255;

/**
 * How often the host's invite/session lists refresh.
 *
 * Revocation is INSTANT server-side — the row is marked, the membership row is
 * deleted, the socket is force-disconnected and LiveKit evicts the publisher —
 * so a list that only refreshed on mount would show a link as live minutes after
 * it stopped being one. Fifteen seconds is the backstop; every action in the UI
 * also writes the result into the cache immediately, so the poll is never what
 * you are waiting for.
 */
export const GUEST_INVITE_POLL_MS = 15_000;

/**
 * Anything with a history floor older than this is the server's "entire
 * back-history" sentinel (`_FULL_HISTORY_FLOOR`, the Unix epoch). Compared
 * against a date rather than `=== 0` so a server that moves the sentinel by a
 * second does not silently start rendering "all history" as "a very long window".
 * A real window can be at most a year, so nothing legitimate lands here.
 */
const FULL_HISTORY_SENTINEL_BEFORE_MS = Date.parse("2000-01-01T00:00:00Z");

/* ------------------------------------------------------------------ *
 * The mint form
 * ------------------------------------------------------------------ */

/**
 * How far back a guest may read.
 *
 *  - `since_mint` — nothing said before the link existed. THE DEFAULT, and the
 *    server's: an invite to today's call is not retroactive access to the
 *    channel's whole past.
 *  - `hours`      — a window before the mint, for "catch up on this morning".
 *  - `all`        — the room's entire back catalogue. Always an explicit act.
 */
export type GuestHistoryMode = "since_mint" | "hours" | "all";

/**
 * The mint form's state. The numeric fields are STRINGS because they are typed
 * into: a half-entered "1" in "12" must stay a half-entered value rather than
 * being coerced to a number and written back under the cursor, and an emptied
 * field must read as "unset" instead of 0 (which for `max_uses` would mean an
 * invite nobody can use).
 */
export interface GuestInviteDraft {
  label: string;
  ttlHours: number;
  /** "" = unlimited redemptions (the server's NULL). */
  maxUses: string;
  /** "" = no second factor. */
  passphrase: string;
  /** May the guest turn a camera/mic on? Server default is true — a guest is a
   *  guest ON the show. False mints a watch-only link. */
  canPublish: boolean;
  allowAgentTrigger: boolean;
  allowMentionEmail: boolean;
  historyMode: GuestHistoryMode;
  /** Only read when `historyMode === "hours"`. */
  historyHours: string;
}

/**
 * The starting form. Every field here is the server's own default, on purpose:
 * the two capability flags are OFF and history starts at the mint. These are a
 * product decision, not an accident of initialization — a host who wants a guest
 * who can wake the agent has to say so.
 */
export const DEFAULT_GUEST_INVITE_DRAFT: GuestInviteDraft = {
  label: "",
  ttlHours: GUEST_INVITE_DEFAULT_TTL_HOURS,
  maxUses: "",
  passphrase: "",
  canPublish: true,
  allowAgentTrigger: false,
  allowMentionEmail: false,
  historyMode: "since_mint",
  historyHours: "12",
};

/** Expiry choices. Bounded by the server's 7-day cap, which is also the last
 *  entry — there is no "never", and the form should not imply one. */
export const GUEST_TTL_CHOICES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
  { hours: 168, label: "7 days" },
];

export type GuestInviteField =
  | "ttlHours"
  | "maxUses"
  | "passphrase"
  | "label"
  | "historyHours";

export type GuestInviteDraftErrors = Partial<Record<GuestInviteField, string>>;

/** A trimmed integer, or null for blank/unparseable. Rejects "12abc" and "1.5"
 *  rather than silently truncating them into a grant nobody typed. */
function readInt(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return Number.NaN;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

/**
 * What is wrong with this draft, per field. Empty object = ready to mint.
 *
 * This mirrors the server's own Pydantic bounds rather than replacing them —
 * the server still refuses out-of-range values, and would answer 422 with a
 * validation blob nobody can read. This exists so the host sees "at most 500"
 * next to the box instead.
 */
export function guestInviteDraftErrors(
  draft: GuestInviteDraft,
): GuestInviteDraftErrors {
  const errors: GuestInviteDraftErrors = {};

  if (
    !Number.isSafeInteger(draft.ttlHours) ||
    draft.ttlHours < 1 ||
    draft.ttlHours > GUEST_INVITE_MAX_TTL_HOURS
  ) {
    errors.ttlHours = `Pick an expiry between 1 hour and ${GUEST_INVITE_MAX_TTL_HOURS} hours.`;
  }

  const uses = readInt(draft.maxUses);
  if (uses !== null && (Number.isNaN(uses) || uses < 1 || uses > GUEST_INVITE_MAX_USES_CAP)) {
    errors.maxUses = `Leave blank for unlimited, or use a whole number from 1 to ${GUEST_INVITE_MAX_USES_CAP}.`;
  }

  const passphrase = draft.passphrase.trim();
  if (passphrase && passphrase.length < GUEST_PASSPHRASE_MIN) {
    errors.passphrase = `A passphrase needs at least ${GUEST_PASSPHRASE_MIN} characters. Leave it blank for none.`;
  }
  if (passphrase.length > GUEST_PASSPHRASE_MAX) {
    errors.passphrase = `A passphrase can be at most ${GUEST_PASSPHRASE_MAX} characters.`;
  }

  if (draft.label.trim().length > GUEST_INVITE_LABEL_MAX) {
    errors.label = `Keep the note under ${GUEST_INVITE_LABEL_MAX} characters.`;
  }

  if (draft.historyMode === "hours") {
    const hours = readInt(draft.historyHours);
    if (hours === null || Number.isNaN(hours) || hours < 1 || hours > GUEST_HISTORY_MAX_HOURS) {
      errors.historyHours = `Use a whole number of hours from 1 to ${GUEST_HISTORY_MAX_HOURS}.`;
    }
  }

  return errors;
}

export function isGuestInviteDraftValid(draft: GuestInviteDraft): boolean {
  return Object.keys(guestInviteDraftErrors(draft)).length === 0;
}

/**
 * The wire body for a valid draft.
 *
 * BOTH CAPABILITY FLAGS ARE ALWAYS SENT, including when they are false. They
 * default to false server-side too, so omitting them would be equivalent today —
 * but "the grant is off because we said so" and "the grant is off because we
 * forgot to mention it" are the same request only until someone changes a
 * default, and this is the request that lets a stranger into a live room.
 *
 * The optional NARROWINGS (passphrase, max_uses, label) are omitted when unset:
 * an empty-string passphrase is a 422 (`min_length=4`), not "no passphrase".
 */
export function guestInviteMintBody(draft: GuestInviteDraft): MintGuestInviteBody {
  const body: MintGuestInviteBody = {
    ttl_hours: draft.ttlHours,
    can_publish: draft.canPublish,
    allow_agent_trigger: draft.allowAgentTrigger,
    allow_mention_email: draft.allowMentionEmail,
  };

  const passphrase = draft.passphrase.trim();
  if (passphrase) body.passphrase = passphrase;

  const uses = readInt(draft.maxUses);
  if (uses !== null && Number.isFinite(uses)) body.max_uses = uses;

  const label = draft.label.trim();
  if (label) body.label = label;

  if (draft.historyMode === "all") {
    body.history_all = true;
  } else if (draft.historyMode === "hours") {
    const hours = readInt(draft.historyHours);
    if (hours !== null && Number.isFinite(hours)) body.history_hours = hours;
  }
  // `since_mint` sends neither field: the server's own default IS this mode, so
  // the safest invite is also the one that states the least.

  return body;
}

/**
 * The plain-language consequences of everything this draft widens.
 *
 * Rendered next to the form so the widening is visible at the moment it is
 * chosen, not discovered afterwards in the invite list. Empty for a default
 * draft — a host doing the safe thing should not be lectured.
 */
export function guestInviteWideningWarnings(draft: GuestInviteDraft): string[] {
  const out: string[] = [];
  if (draft.historyMode === "all") {
    out.push(
      "This link hands over every message this room has ever held, including anything posted long before the guest was invited.",
    );
  }
  if (draft.allowAgentTrigger) {
    out.push(
      "The guest's messages become prompts for the room's agent — with this room's knowledge, tools and paid budget behind them.",
    );
  }
  if (draft.allowMentionEmail) {
    out.push(
      "The guest can cause email to be sent from your domain, carrying a name and text they chose.",
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The link
 * ------------------------------------------------------------------ */

export interface GuestInviteUrlParts {
  /** Absolute origin supplied by the runtime instance descriptor. */
  origin: string;
  /** The raw token from the mint response. Exists once. */
  token: string;
  /** Mirrors the server's `?p=1`: a UX hint so the landing page renders the
   *  passphrase box up front. NOT authorization and carries no secret. */
  passphraseHint?: boolean;
}

/**
 * The absolute URL to hand a guest.
 *
 * Built from parts rather than from the server's `url_path`, which is assembled
 * with plain interpolation — same reasoning as `buildBroadcastUrl`. The shape
 * has to stay in step with `parseGuestInviteLink` in lib/guest.ts, which reads
 * only the FIRST path segment as the token.
 */
export function buildGuestInviteUrl(parts: GuestInviteUrlParts): string {
  const origin = parts.origin.replace(/\/+$/, "");
  const path = `guest/${encodeURIComponent(parts.token)}`;
  return `${origin}/${path}${parts.passphraseHint ? "?p=1" : ""}`;
}

/* ------------------------------------------------------------------ *
 * Reading an existing invite
 * ------------------------------------------------------------------ */

export type GuestInviteStatus = "active" | "revoked" | "expired" | "used_up";

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is this link still usable, and if not, why?
 *
 * Recomputed locally rather than read off the server's `active`, because that
 * field was true at RESPONSE time and a link that expires between two polls
 * would otherwise keep rendering as live. The server stays the authority in one
 * direction only: if it says a link is inactive and we cannot see why, we
 * believe it and call it expired — clock skew is the overwhelmingly likely
 * cause, and the alternative is showing "active" for a link that will refuse.
 */
export function guestInviteStatus(
  invite: GuestInviteRow,
  nowMs: number = Date.now(),
): GuestInviteStatus {
  if (invite.revoked_at) return "revoked";
  const expiresMs = parseMs(invite.expires_at);
  if (expiresMs !== null && expiresMs <= nowMs) return "expired";
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
    return "used_up";
  }
  return invite.active ? "active" : "expired";
}

export function isGuestInviteLive(
  invite: GuestInviteRow,
  nowMs: number = Date.now(),
): boolean {
  return guestInviteStatus(invite, nowMs) === "active";
}

export function guestInviteStatusLabel(status: GuestInviteStatus): string {
  switch (status) {
    case "revoked":
      return "Revoked";
    case "expired":
      return "Expired";
    case "used_up":
      return "All uses taken";
    case "active":
    default:
      return "Live";
  }
}

/**
 * How far back this link lets a guest read, in words.
 *
 * `history_from` is an absolute timestamp, so the window has to be recovered by
 * subtracting it from the mint — and the epoch sentinel has to be recognised
 * BEFORE that subtraction, or the room's whole back catalogue renders as
 * "the 496,000 hours before the link was made".
 */
export function guestHistoryWindowLabel(invite: GuestInviteRow): string {
  const fromMs = parseMs(invite.history_from);
  if (fromMs === null) return "History window unknown";
  if (fromMs < FULL_HISTORY_SENTINEL_BEFORE_MS) return "All history";
  const createdMs = parseMs(invite.created_at);
  if (createdMs === null) return "History from the link's start";
  // A minute of slack: `history_from` and `created_at` are two separate clock
  // reads on the server, so an exact-equality test would flip to "1 hour" on
  // sub-second drift.
  const hours = Math.round((createdMs - fromMs) / 3_600_000);
  if (hours <= 0) return "No earlier history";
  return `${hours} hour${hours === 1 ? "" : "s"} of earlier history`;
}

/** Does this link reach back past the moment it was minted? True for both the
 *  epoch sentinel ("all history") and any explicit window. */
export function isGuestHistoryWidened(invite: GuestInviteRow): boolean {
  const fromMs = parseMs(invite.history_from);
  if (fromMs === null) return false;
  if (fromMs < FULL_HISTORY_SENTINEL_BEFORE_MS) return true;
  const createdMs = parseMs(invite.created_at);
  if (createdMs === null) return false;
  // More than a minute of back-history is a deliberate widening; anything inside
  // that is the two-clock-reads slack described above.
  return createdMs - fromMs > 60_000;
}

/** Does this link grant more than the default? Drives whether the row is worth
 *  flagging in a list a host is skimming. */
export function isGuestInviteWidened(invite: GuestInviteRow): boolean {
  return (
    invite.allow_agent_trigger ||
    invite.allow_mention_email ||
    isGuestHistoryWidened(invite)
  );
}

export type GuestGrantTone = "plain" | "wide";

export interface GuestGrantChip {
  key: string;
  label: string;
  /** "wide" = this link grants more than a default one. The caller renders it
   *  louder; nothing else changes. */
  tone: GuestGrantTone;
  title: string;
}

/**
 * Everything this link actually grants, as chips — so a host reviewing a list of
 * links can SEE which ones are wider than the default instead of having to
 * remember what they ticked when they minted it.
 */
export function guestInviteGrantChips(invite: GuestInviteRow): GuestGrantChip[] {
  const chips: GuestGrantChip[] = [
    {
      key: "publish",
      label: invite.can_publish ? "Camera + mic" : "Watch only",
      tone: "plain",
      title: invite.can_publish
        ? "This guest may turn on their camera and microphone."
        : "This guest can watch and type, but cannot publish audio or video.",
    },
    {
      key: "history",
      label: guestHistoryWindowLabel(invite),
      tone: isGuestHistoryWidened(invite) ? "wide" : "plain",
      title: "How far back before the link was made this guest may read.",
    },
  ];
  if (invite.has_passphrase) {
    chips.push({
      key: "passphrase",
      label: "Passphrase",
      tone: "plain",
      title: "The guest must also type the passphrase you set.",
    });
  }
  if (invite.allow_agent_trigger) {
    chips.push({
      key: "agent",
      label: "Wakes the agent",
      tone: "wide",
      title: "This guest's messages can make the room's agent answer.",
    });
  }
  if (invite.allow_mention_email) {
    chips.push({
      key: "email",
      label: "@mentions send email",
      tone: "wide",
      title: "This guest's @mentions can send email from your domain.",
    });
  }
  return chips;
}

/**
 * "Expires in 3 hours" / "Expires in 25 minutes" / "Expired".
 *
 * Coarse on purpose: a host needs to know whether a link outlives tonight's
 * show, not the second it dies. An unreadable expiry says so rather than
 * rendering "Expires in NaN hours" or, worse, quietly reading as plenty of time.
 */
export function guestExpiryLabel(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const expiresMs = parseMs(expiresAt);
  if (expiresMs === null) return "Expiry unknown";
  const remaining = expiresMs - nowMs;
  if (remaining <= 0) return "Expired";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(remaining / 86_400_000);
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** "3 of 5 used" / "3 used · unlimited". */
export function guestInviteUsageLabel(invite: GuestInviteRow): string {
  if (invite.max_uses === null) {
    return `${invite.use_count} used · no limit`;
  }
  return `${invite.use_count} of ${invite.max_uses} used`;
}

/* ------------------------------------------------------------------ *
 * Reading a redeemed session
 * ------------------------------------------------------------------ */

export type GuestSessionStatus = "active" | "revoked" | "expired";

export function guestSessionStatus(
  session: GuestSessionRow,
  nowMs: number = Date.now(),
): GuestSessionStatus {
  if (session.revoked_at) return "revoked";
  const expiresMs = parseMs(session.expires_at);
  if (expiresMs !== null && expiresMs <= nowMs) return "expired";
  return session.active ? "active" : "expired";
}

/** Newest first, matching the server's own ordering — and stable when two
 *  sessions share a timestamp, so a poll never reshuffles the list under a
 *  cursor that is about to press Remove. */
export function sortGuestSessions(
  sessions: readonly GuestSessionRow[],
): GuestSessionRow[] {
  return [...sessions].sort((a, b) => {
    const delta = (parseMs(b.created_at) ?? 0) - (parseMs(a.created_at) ?? 0);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/**
 * Flatten the per-invite session pages into one room-wide list.
 *
 * The server has no "all sessions in this room" route — sessions hang off an
 * INVITE (`…/guest-invites/{id}/sessions`) — so the host's one list is a fan-out
 * this reassembles. A page that failed is `null` rather than `[]`: an invite
 * whose sessions could not be read must not silently read as "nobody redeemed
 * this", which is exactly the reassurance a host must not be given by accident.
 */
export function mergeGuestSessionPages(
  pages: ReadonlyArray<readonly GuestSessionRow[] | null>,
): { sessions: GuestSessionRow[]; incomplete: boolean } {
  const seen = new Set<string>();
  const merged: GuestSessionRow[] = [];
  let incomplete = false;
  for (const page of pages) {
    if (page === null) {
      incomplete = true;
      continue;
    }
    for (const session of page) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
  }
  return { sessions: sortGuestSessions(merged), incomplete };
}

export function countLiveGuestSessions(
  sessions: readonly GuestSessionRow[],
  nowMs: number = Date.now(),
): number {
  return sessions.filter((s) => guestSessionStatus(s, nowMs) === "active").length;
}

/* ------------------------------------------------------------------ *
 * Revocation, reflected immediately
 * ------------------------------------------------------------------ */

/**
 * Revoking is INSTANT on the server: the row is marked, the membership row is
 * deleted, the live socket is force-disconnected and LiveKit evicts the
 * publisher, all before the response returns. So by the time these run, the
 * thing they describe has already happened — they are not an optimistic guess
 * about a request in flight, they are the list catching up with a fact.
 *
 * Each returns the SAME array when nothing matched, so a caller writing straight
 * into a cache cannot cause a re-render over a no-op.
 */
export function applyGuestInviteRevoked(
  invites: readonly GuestInviteRow[],
  inviteId: string,
  nowMs: number = Date.now(),
): GuestInviteRow[] {
  const at = new Date(nowMs).toISOString();
  let changed = false;
  const next = invites.map((invite) => {
    if (invite.id !== inviteId || invite.revoked_at) return invite;
    changed = true;
    return { ...invite, revoked_at: at, active: false };
  });
  return changed ? next : (invites as GuestInviteRow[]);
}

export function applyGuestSessionRevoked(
  sessions: readonly GuestSessionRow[],
  sessionId: string,
  nowMs: number = Date.now(),
): GuestSessionRow[] {
  const at = new Date(nowMs).toISOString();
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId || session.revoked_at) return session;
    changed = true;
    return { ...session, revoked_at: at, active: false };
  });
  return changed ? next : (sessions as GuestSessionRow[]);
}

/**
 * Revoking an INVITE also terminates every session it produced — see
 * `_terminate_sessions` in api/guests.py. Missing this is what makes a list look
 * stale in the one way that matters: the link reads "Revoked" while the people
 * it let in are still listed as connected.
 */
export function applyGuestSessionsRevokedForInvite(
  sessions: readonly GuestSessionRow[],
  inviteId: string,
  nowMs: number = Date.now(),
): GuestSessionRow[] {
  const at = new Date(nowMs).toISOString();
  let changed = false;
  const next = sessions.map((session) => {
    if (session.invite_id !== inviteId || session.revoked_at) return session;
    changed = true;
    return { ...session, revoked_at: at, active: false };
  });
  return changed ? next : (sessions as GuestSessionRow[]);
}

/** "Link revoked — 2 guests disconnected." The count comes from the server's
 *  own `sessions_terminated`, so it says what actually happened rather than what
 *  the list happened to be showing. */
export function guestRevokeSummary(result: GuestRevokeResult): string {
  const n = result.sessions_terminated;
  if (n <= 0) return "No one was connected on it.";
  return `${n} guest${n === 1 ? "" : "s"} disconnected.`;
}
