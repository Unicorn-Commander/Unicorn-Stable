import { describe, expect, it } from "vitest";
import { parseGuestInviteLink } from "./guest";
import {
  DEFAULT_GUEST_INVITE_DRAFT,
  GUEST_HISTORY_MAX_HOURS,
  GUEST_INVITE_MAX_TTL_HOURS,
  GUEST_INVITE_MAX_USES_CAP,
  applyGuestInviteRevoked,
  applyGuestSessionRevoked,
  applyGuestSessionsRevokedForInvite,
  buildGuestInviteUrl,
  countLiveGuestSessions,
  guestExpiryLabel,
  guestHistoryWindowLabel,
  guestInviteDraftErrors,
  guestInviteGrantChips,
  guestInviteMintBody,
  guestInviteStatus,
  guestInviteStatusLabel,
  guestInviteUsageLabel,
  guestInviteWideningWarnings,
  guestRevokeSummary,
  guestSessionStatus,
  isGuestHistoryWidened,
  isGuestInviteDraftValid,
  isGuestInviteLive,
  isGuestInviteWidened,
  mergeGuestSessionPages,
  sortGuestSessions,
  type GuestGrantChip,
  type GuestInviteDraft,
  type GuestInviteRow,
  type GuestSessionRow,
} from "./guestInvite";

const NOW = Date.parse("2026-08-12T12:00:00Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const HOUR = 3_600_000;

const draft = (over: Partial<GuestInviteDraft> = {}): GuestInviteDraft => ({
  ...DEFAULT_GUEST_INVITE_DRAFT,
  ...over,
});

/** A minted-just-now, entirely default invite: the safest link the server makes. */
const invite = (over: Partial<GuestInviteRow> = {}): GuestInviteRow => ({
  id: "inv-1",
  room_id: "room-1",
  token_prefix: "sgi-abcdefg",
  has_passphrase: false,
  can_publish: true,
  max_uses: null,
  use_count: 0,
  label: null,
  created_at: iso(0),
  expires_at: iso(24 * HOUR),
  revoked_at: null,
  last_used_at: null,
  active: true,
  allow_agent_trigger: false,
  allow_mention_email: false,
  history_from: iso(0),
  ...over,
});

const session = (over: Partial<GuestSessionRow> = {}): GuestSessionRow => ({
  id: "sess-1",
  invite_id: "inv-1",
  participant_id: "p-1",
  display_name: "Ada",
  created_at: iso(0),
  expires_at: iso(12 * HOUR),
  revoked_at: null,
  last_seen_at: null,
  active: true,
  ...over,
});

const chipFor = (chips: GuestGrantChip[], key: string) =>
  chips.find((c) => c.key === key);

describe("DEFAULT_GUEST_INVITE_DRAFT", () => {
  it("starts with both capability grants OFF and history at the mint", () => {
    // THIS IS THE PRODUCT DECISION, not an initialization detail. A host who
    // wants a guest who can wake the agent, or send mail from our domain, or
    // read the room's past has to ask for it. If this test is ever "fixed" by
    // flipping a default, the feature has quietly changed shape.
    expect(DEFAULT_GUEST_INVITE_DRAFT.allowAgentTrigger).toBe(false);
    expect(DEFAULT_GUEST_INVITE_DRAFT.allowMentionEmail).toBe(false);
    expect(DEFAULT_GUEST_INVITE_DRAFT.historyMode).toBe("since_mint");
  });

  it("does default to camera + mic, matching the server", () => {
    // A guest is a guest ON the show. This one is permissive on purpose, and
    // the server agrees (`can_publish: bool = True`) — the point of the other
    // three defaults is that they are the ones with blast radius.
    expect(DEFAULT_GUEST_INVITE_DRAFT.canPublish).toBe(true);
  });

  it("is valid as it stands, so the safest link needs no typing", () => {
    expect(guestInviteDraftErrors(DEFAULT_GUEST_INVITE_DRAFT)).toEqual({});
  });
});

describe("guestInviteDraftErrors", () => {
  it("accepts a blank max-uses as unlimited", () => {
    expect(guestInviteDraftErrors(draft({ maxUses: "" })).maxUses).toBeUndefined();
  });

  it("rejects a max-uses of zero, which would mint a link nobody can use", () => {
    expect(guestInviteDraftErrors(draft({ maxUses: "0" })).maxUses).toBeDefined();
  });

  it("rejects non-integer and out-of-range use counts", () => {
    expect(guestInviteDraftErrors(draft({ maxUses: "1.5" })).maxUses).toBeDefined();
    expect(guestInviteDraftErrors(draft({ maxUses: "12abc" })).maxUses).toBeDefined();
    expect(
      guestInviteDraftErrors(draft({ maxUses: String(GUEST_INVITE_MAX_USES_CAP + 1) }))
        .maxUses,
    ).toBeDefined();
    expect(
      guestInviteDraftErrors(draft({ maxUses: String(GUEST_INVITE_MAX_USES_CAP) }))
        .maxUses,
    ).toBeUndefined();
  });

  it("treats a blank passphrase as 'none' but a short one as a mistake", () => {
    // The server's field is `min_length=4`, so "abc" is a 422 rather than a
    // weaker passphrase — and "" is not a passphrase at all.
    expect(guestInviteDraftErrors(draft({ passphrase: "" })).passphrase).toBeUndefined();
    expect(guestInviteDraftErrors(draft({ passphrase: "abc" })).passphrase).toBeDefined();
    expect(guestInviteDraftErrors(draft({ passphrase: "abcd" })).passphrase).toBeUndefined();
    expect(
      guestInviteDraftErrors(draft({ passphrase: "x".repeat(129) })).passphrase,
    ).toBeDefined();
  });

  it("bounds the expiry to the server's cap", () => {
    expect(guestInviteDraftErrors(draft({ ttlHours: 0 })).ttlHours).toBeDefined();
    expect(
      guestInviteDraftErrors(draft({ ttlHours: GUEST_INVITE_MAX_TTL_HOURS + 1 })).ttlHours,
    ).toBeDefined();
    expect(
      guestInviteDraftErrors(draft({ ttlHours: GUEST_INVITE_MAX_TTL_HOURS })).ttlHours,
    ).toBeUndefined();
  });

  it("only judges the history hours when that mode is selected", () => {
    // A stale "0" left in the box from a mode the host switched away from must
    // not block a mint that never sends it.
    expect(
      guestInviteDraftErrors(draft({ historyMode: "since_mint", historyHours: "0" }))
        .historyHours,
    ).toBeUndefined();
    expect(
      guestInviteDraftErrors(draft({ historyMode: "all", historyHours: "nonsense" }))
        .historyHours,
    ).toBeUndefined();
    expect(
      guestInviteDraftErrors(draft({ historyMode: "hours", historyHours: "0" }))
        .historyHours,
    ).toBeDefined();
    expect(
      guestInviteDraftErrors(
        draft({ historyMode: "hours", historyHours: String(GUEST_HISTORY_MAX_HOURS + 1) }),
      ).historyHours,
    ).toBeDefined();
    expect(
      guestInviteDraftErrors(draft({ historyMode: "hours", historyHours: "12" }))
        .historyHours,
    ).toBeUndefined();
  });

  it("agrees with isGuestInviteDraftValid", () => {
    expect(isGuestInviteDraftValid(draft())).toBe(true);
    expect(isGuestInviteDraftValid(draft({ passphrase: "no" }))).toBe(false);
  });
});

describe("guestInviteMintBody", () => {
  it("states both capability flags explicitly, even when they are off", () => {
    // Omitting them would mean the same thing to today's server. It would stop
    // meaning the same thing the moment a default moves, and this is the
    // request that lets a stranger into a live room.
    const body = guestInviteMintBody(draft());
    expect(body.allow_agent_trigger).toBe(false);
    expect(body.allow_mention_email).toBe(false);
    expect(body.can_publish).toBe(true);
  });

  it("sends no history field at all for the default window", () => {
    // The server's own default IS 'since the mint', so the safest invite is
    // also the one that states the least.
    const body = guestInviteMintBody(draft());
    expect("history_hours" in body).toBe(false);
    expect("history_all" in body).toBe(false);
  });

  it("sends history_all only when the host explicitly chose it", () => {
    expect(guestInviteMintBody(draft({ historyMode: "all" })).history_all).toBe(true);
    expect(
      guestInviteMintBody(draft({ historyMode: "hours", historyHours: "6" })).history_hours,
    ).toBe(6);
    // 'hours' must never smuggle history_all through.
    expect(
      "history_all" in guestInviteMintBody(draft({ historyMode: "hours", historyHours: "6" })),
    ).toBe(false);
  });

  it("omits the optional narrowings rather than sending empty strings", () => {
    // An empty-string passphrase is a 422 (`min_length=4`), not 'no passphrase'.
    const body = guestInviteMintBody(draft({ passphrase: "   ", label: "  ", maxUses: "" }));
    expect("passphrase" in body).toBe(false);
    expect("label" in body).toBe(false);
    expect("max_uses" in body).toBe(false);
  });

  it("trims the narrowings it does send", () => {
    const body = guestInviteMintBody(
      draft({ passphrase: "  hunter22  ", label: "  Fireside  ", maxUses: " 3 " }),
    );
    expect(body.passphrase).toBe("hunter22");
    expect(body.label).toBe("Fireside");
    expect(body.max_uses).toBe(3);
  });
});

describe("guestInviteWideningWarnings", () => {
  it("says nothing for a default draft", () => {
    // A host doing the safe thing should not be lectured.
    expect(guestInviteWideningWarnings(draft())).toEqual([]);
  });

  it("names each widening in plain language", () => {
    const all = guestInviteWideningWarnings(
      draft({ historyMode: "all", allowAgentTrigger: true, allowMentionEmail: true }),
    );
    expect(all).toHaveLength(3);
    expect(all.join(" ")).toContain("every message this room has ever held");
    expect(all.join(" ")).toContain("agent");
    expect(all.join(" ")).toContain("email");
  });

  it("does not warn about a bounded history window", () => {
    // 'the last six hours' is a normal thing to want; only the whole back
    // catalogue earns a warning.
    expect(
      guestInviteWideningWarnings(draft({ historyMode: "hours", historyHours: "6" })),
    ).toEqual([]);
  });
});

describe("buildGuestInviteUrl", () => {
  it("builds the absolute link the guest page parses", () => {
    const url = buildGuestInviteUrl({
      origin: "https://stable.example.com",
      token: "sgi-abc123",
    });
    expect(url).toBe("https://stable.example.com/guest/sgi-abc123");
  });

  it("normalizes a trailing slash on the origin", () => {
    expect(
      buildGuestInviteUrl({ origin: "https://stable.example.com//", token: "sgi-x" }),
    ).toBe("https://stable.example.com/guest/sgi-x");
  });

  it("adds the passphrase hint only when there is one", () => {
    expect(
      buildGuestInviteUrl({ origin: "https://s.io", token: "sgi-x", passphraseHint: true }),
    ).toBe("https://s.io/guest/sgi-x?p=1");
    expect(buildGuestInviteUrl({ origin: "https://s.io", token: "sgi-x" })).toBe(
      "https://s.io/guest/sgi-x",
    );
  });

  it("round-trips through the guest page's own parser", () => {
    // The two halves of this feature are separate modules on separate screens.
    // Pinning them to each other here is what stops a shape change on one side
    // from producing a link the other side reads as 'no token'.
    const url = buildGuestInviteUrl({
      origin: "https://stable.example.com",
      token: "sgi-round-trip-token",
      passphraseHint: true,
    });
    const { pathname, search } = new URL(url);
    const parsed = parseGuestInviteLink(pathname, search);
    expect(parsed.token).toBe("sgi-round-trip-token");
    expect(parsed.passphraseHint).toBe(true);
  });
});

describe("guestInviteStatus", () => {
  it("calls a fresh link live", () => {
    expect(guestInviteStatus(invite(), NOW)).toBe("active");
    expect(isGuestInviteLive(invite(), NOW)).toBe(true);
  });

  it("reports revocation ahead of every other reason", () => {
    // A link that was revoked AND has since expired is a link someone turned
    // off; that is the fact the host acted on and the one to show back.
    const dead = invite({ revoked_at: iso(-HOUR), expires_at: iso(-1) });
    expect(guestInviteStatus(dead, NOW)).toBe("revoked");
  });

  it("expires locally instead of trusting a stale `active` from the last poll", () => {
    // The server computed `active` when it answered. Fifteen seconds later the
    // link can be dead; rendering 'Live' off a cached true is the exact way
    // this list goes stale.
    const stale = invite({ expires_at: iso(-1), active: true });
    expect(guestInviteStatus(stale, NOW)).toBe("expired");
  });

  it("believes the server when it says inactive for a reason we cannot see", () => {
    // Clock skew is the overwhelmingly likely cause, and the alternative is
    // rendering 'Live' for a link that will refuse.
    expect(guestInviteStatus(invite({ active: false }), NOW)).toBe("expired");
  });

  it("counts an exhausted link as used up rather than expired", () => {
    const spent = invite({ max_uses: 2, use_count: 2 });
    expect(guestInviteStatus(spent, NOW)).toBe("used_up");
    expect(guestInviteStatusLabel(guestInviteStatus(spent, NOW))).toBe("All uses taken");
  });
});

describe("guestHistoryWindowLabel", () => {
  it("recognises the epoch sentinel as the whole back catalogue", () => {
    // Missing this renders the room's entire history as '496,000 hours of
    // earlier history', which reads like a rounding bug rather than a grant.
    expect(guestHistoryWindowLabel(invite({ history_from: "1970-01-01T00:00:00Z" }))).toBe(
      "All history",
    );
  });

  it("reads a mint-time floor as no earlier history", () => {
    expect(guestHistoryWindowLabel(invite())).toBe("No earlier history");
  });

  it("tolerates the server's two separate clock reads", () => {
    // `history_from` and `created_at` are read microseconds apart server-side;
    // an exact-equality test would flip this to '1 hour' on sub-second drift.
    expect(guestHistoryWindowLabel(invite({ history_from: iso(-800) }))).toBe(
      "No earlier history",
    );
  });

  it("names a bounded window in hours", () => {
    expect(guestHistoryWindowLabel(invite({ history_from: iso(-6 * HOUR) }))).toBe(
      "6 hours of earlier history",
    );
    expect(guestHistoryWindowLabel(invite({ history_from: iso(-HOUR) }))).toBe(
      "1 hour of earlier history",
    );
  });

  it("says so rather than guessing when the floor is unreadable", () => {
    expect(guestHistoryWindowLabel(invite({ history_from: "not-a-date" }))).toBe(
      "History window unknown",
    );
  });
});

describe("isGuestInviteWidened", () => {
  it("is false for an entirely default link", () => {
    expect(isGuestInviteWidened(invite())).toBe(false);
    expect(isGuestHistoryWidened(invite())).toBe(false);
  });

  it("is true for each widening on its own", () => {
    expect(isGuestInviteWidened(invite({ allow_agent_trigger: true }))).toBe(true);
    expect(isGuestInviteWidened(invite({ allow_mention_email: true }))).toBe(true);
    expect(isGuestInviteWidened(invite({ history_from: iso(-6 * HOUR) }))).toBe(true);
    expect(isGuestInviteWidened(invite({ history_from: "1970-01-01T00:00:00Z" }))).toBe(true);
  });

  it("is not tripped by a passphrase or a watch-only grant", () => {
    // Both of those NARROW the link. Flagging them would train a host to
    // ignore the marker that matters.
    expect(isGuestInviteWidened(invite({ has_passphrase: true, can_publish: false }))).toBe(
      false,
    );
  });
});

describe("guestInviteGrantChips", () => {
  it("describes a default link with nothing flagged loud", () => {
    const chips = guestInviteGrantChips(invite());
    expect(chips.every((c) => c.tone === "plain")).toBe(true);
    expect(chipFor(chips, "publish")?.label).toBe("Camera + mic");
    expect(chipFor(chips, "agent")).toBeUndefined();
    expect(chipFor(chips, "email")).toBeUndefined();
  });

  it("marks a watch-only link and a passphrase without shouting", () => {
    const chips = guestInviteGrantChips(invite({ can_publish: false, has_passphrase: true }));
    expect(chipFor(chips, "publish")?.label).toBe("Watch only");
    expect(chipFor(chips, "passphrase")?.tone).toBe("plain");
  });

  it("flags every widening loud", () => {
    const chips = guestInviteGrantChips(
      invite({
        allow_agent_trigger: true,
        allow_mention_email: true,
        history_from: "1970-01-01T00:00:00Z",
      }),
    );
    expect(chipFor(chips, "agent")?.tone).toBe("wide");
    expect(chipFor(chips, "email")?.tone).toBe("wide");
    expect(chipFor(chips, "history")?.tone).toBe("wide");
    expect(chipFor(chips, "history")?.label).toBe("All history");
  });

  it("gives every chip a title, so nothing is a bare label", () => {
    for (const chip of guestInviteGrantChips(invite({ has_passphrase: true }))) {
      expect(chip.title.length).toBeGreaterThan(0);
    }
  });
});

describe("guestExpiryLabel", () => {
  it("scales from minutes to days", () => {
    expect(guestExpiryLabel(iso(25 * 60_000), NOW)).toBe("Expires in 25 minutes");
    expect(guestExpiryLabel(iso(3 * HOUR), NOW)).toBe("Expires in 3 hours");
    expect(guestExpiryLabel(iso(HOUR), NOW)).toBe("Expires in 1 hour");
    expect(guestExpiryLabel(iso(7 * 24 * HOUR), NOW)).toBe("Expires in 7 days");
  });

  it("says Expired rather than counting backwards", () => {
    expect(guestExpiryLabel(iso(-HOUR), NOW)).toBe("Expired");
    expect(guestExpiryLabel(iso(0), NOW)).toBe("Expired");
  });

  it("admits it cannot read a broken expiry", () => {
    // The failure mode to avoid is an unreadable date rendering as plenty of
    // time left, which is how a link outlives the show it was minted for.
    expect(guestExpiryLabel("not-a-date", NOW)).toBe("Expiry unknown");
    expect(guestExpiryLabel(null, NOW)).toBe("Expiry unknown");
  });
});

describe("guestInviteUsageLabel", () => {
  it("distinguishes a capped link from an unlimited one", () => {
    expect(guestInviteUsageLabel(invite({ max_uses: null, use_count: 3 }))).toBe(
      "3 used · no limit",
    );
    expect(guestInviteUsageLabel(invite({ max_uses: 5, use_count: 3 }))).toBe("3 of 5 used");
  });
});

describe("guestSessionStatus", () => {
  it("reports revoked, expired and live apart", () => {
    expect(guestSessionStatus(session(), NOW)).toBe("active");
    expect(guestSessionStatus(session({ revoked_at: iso(-1) }), NOW)).toBe("revoked");
    expect(guestSessionStatus(session({ expires_at: iso(-1) }), NOW)).toBe("expired");
  });

  it("expires locally rather than trusting a cached `active`", () => {
    expect(guestSessionStatus(session({ expires_at: iso(-1), active: true }), NOW)).toBe(
      "expired",
    );
  });
});

describe("sortGuestSessions", () => {
  it("puts the newest first", () => {
    const sorted = sortGuestSessions([
      session({ id: "old", created_at: iso(-2 * HOUR) }),
      session({ id: "new", created_at: iso(-1) }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("is stable for identical timestamps", () => {
    // Two guests redeeming the same link in the same second must not swap
    // places on every poll — the host is about to click Remove on one of them.
    const rows = [
      session({ id: "b", created_at: iso(0) }),
      session({ id: "a", created_at: iso(0) }),
    ];
    expect(sortGuestSessions(rows).map((s) => s.id)).toEqual(["a", "b"]);
    expect(sortGuestSessions(rows.slice().reverse()).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [session({ id: "a", created_at: iso(-HOUR) }), session({ id: "b" })];
    sortGuestSessions(rows);
    expect(rows.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("mergeGuestSessionPages", () => {
  it("flattens the per-invite fan-out into one list", () => {
    // The server has no room-wide session route; sessions hang off an invite.
    const { sessions, incomplete } = mergeGuestSessionPages([
      [session({ id: "s1", invite_id: "inv-1", created_at: iso(-HOUR) })],
      [session({ id: "s2", invite_id: "inv-2", created_at: iso(0) })],
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(incomplete).toBe(false);
  });

  it("drops duplicates rather than double-listing a guest", () => {
    const { sessions } = mergeGuestSessionPages([
      [session({ id: "s1" })],
      [session({ id: "s1" })],
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("flags a failed page instead of reading it as 'nobody redeemed this'", () => {
    // Silent degradation, exactly here, would tell a host that a link nobody
    // could read the sessions of has no one on it.
    const { sessions, incomplete } = mergeGuestSessionPages([[session()], null]);
    expect(sessions).toHaveLength(1);
    expect(incomplete).toBe(true);
  });

  it("handles no invites at all", () => {
    expect(mergeGuestSessionPages([])).toEqual({ sessions: [], incomplete: false });
  });
});

describe("countLiveGuestSessions", () => {
  it("counts only the guests actually still in the room", () => {
    const rows = [
      session({ id: "a" }),
      session({ id: "b", revoked_at: iso(-1) }),
      session({ id: "c", expires_at: iso(-1) }),
    ];
    expect(countLiveGuestSessions(rows, NOW)).toBe(1);
  });
});

describe("revocation reflected in the list", () => {
  it("marks the invite revoked and inactive", () => {
    const rows = [invite({ id: "a" }), invite({ id: "b" })];
    const next = applyGuestInviteRevoked(rows, "a", NOW);
    const revoked = next.find((r) => r.id === "a");
    expect(revoked?.revoked_at).toBe(new Date(NOW).toISOString());
    expect(revoked?.active).toBe(false);
    // `active` must move too: guestInviteStatus falls back to it, so leaving it
    // true would render a revoked link as live until the next poll landed.
    expect(guestInviteStatus(revoked as GuestInviteRow, NOW)).toBe("revoked");
    expect(next.find((r) => r.id === "b")?.revoked_at).toBeNull();
  });

  it("cascades an invite revocation to the sessions it produced", () => {
    // The server terminates them in the same call. Missing this is what makes
    // the list look stale in the one way that matters: the link reads 'Revoked'
    // while the people it let in are still listed as connected.
    const rows = [
      session({ id: "s1", invite_id: "inv-1" }),
      session({ id: "s2", invite_id: "inv-2" }),
    ];
    const next = applyGuestSessionsRevokedForInvite(rows, "inv-1", NOW);
    expect(next.find((s) => s.id === "s1")?.active).toBe(false);
    expect(next.find((s) => s.id === "s2")?.active).toBe(true);
  });

  it("boots one guest without touching the others", () => {
    const rows = [session({ id: "s1" }), session({ id: "s2" })];
    const next = applyGuestSessionRevoked(rows, "s1", NOW);
    expect(guestSessionStatus(next[0] as GuestSessionRow, NOW)).toBe("revoked");
    expect(guestSessionStatus(next[1] as GuestSessionRow, NOW)).toBe("active");
  });

  it("returns the same array when nothing matched, so no re-render happens", () => {
    const invites = [invite({ id: "a" })];
    expect(applyGuestInviteRevoked(invites, "missing", NOW)).toBe(invites);
    const sessions = [session({ id: "s1" })];
    expect(applyGuestSessionRevoked(sessions, "missing", NOW)).toBe(sessions);
    expect(applyGuestSessionsRevokedForInvite(sessions, "missing", NOW)).toBe(sessions);
  });

  it("leaves an already-revoked row's original timestamp alone", () => {
    // Re-stamping it would move the 'revoked at' a host is reading.
    const first = iso(-HOUR);
    const rows = [invite({ id: "a", revoked_at: first, active: false })];
    expect(applyGuestInviteRevoked(rows, "a", NOW)).toBe(rows);
    expect(rows[0]?.revoked_at).toBe(first);
  });
});

describe("guestRevokeSummary", () => {
  it("reports what the server actually terminated", () => {
    // From `sessions_terminated`, not from what the list happened to show.
    expect(guestRevokeSummary({ id: "a", revoked: true, sessions_terminated: 0 })).toBe(
      "No one was connected on it.",
    );
    expect(guestRevokeSummary({ id: "a", revoked: true, sessions_terminated: 1 })).toBe(
      "1 guest disconnected.",
    );
    expect(guestRevokeSummary({ id: "a", revoked: true, sessions_terminated: 3 })).toBe(
      "3 guests disconnected.",
    );
  });
});
