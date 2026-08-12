import { describe, expect, it } from "vitest";
import {
  GUEST_LINK_INVALID_MESSAGE,
  GUEST_SESSION_STORAGE_KEY,
  MAX_GUEST_DISPLAY_NAME,
  cleanGuestDisplayName,
  clearStoredGuestSession,
  endReasonMessage,
  guestCan,
  guestExpiryNotice,
  guestInviteKey,
  guestReconnectDelayMs,
  guestSessionExpiresInMs,
  guestSessionFromRedeem,
  initialGuestState,
  isAcceptableGuestDisplayName,
  isAuthOkFrame,
  isGuestCallIdentity,
  isGuestParticipant,
  isGuestSender,
  isGuestSessionExpired,
  isGuestSessionToken,
  isMessageVisibleToGuest,
  isRetryableRedeemOutcome,
  isSessionEndedFrame,
  mergeGuestMe,
  nextGuestState,
  parseGuestInviteLink,
  readStoredGuestSession,
  redeemMessageFor,
  redeemOutcomeFor,
  shouldReconnectAfterClose,
  storedSessionMatchesLink,
  writeStoredGuestSession,
  type GuestSession,
  type StorageLike,
} from "./guest";

const NOW = Date.parse("2026-08-12T12:00:00Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

/** A complete redeem response, as server/app/api/guests.py sends it today. */
const REDEEM = {
  session_token: "sgs-abcdefghijklmnop",
  session_id: "11111111-1111-4111-8111-111111111111",
  participant_id: "22222222-2222-4222-8222-222222222222",
  display_name: "Ada Lovelace",
  room_id: "33333333-3333-4333-8333-333333333333",
  room_display_name: "Build In Public",
  can_publish: true,
  expires_at: iso(4 * 3600_000),
};

function session(overrides: Partial<GuestSession> = {}): GuestSession {
  return { ...guestSessionFromRedeem(REDEEM)!, ...overrides };
}

/** In-memory Storage stand-in — the persistence round-trip should not need a
 *  browser, and neither should the "private mode throws" path. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("parseGuestInviteLink", () => {
  it("reads the token the server minted into the invite path", () => {
    const link = parseGuestInviteLink("/guest/sgi-Xy9_token", "?p=1");
    expect(link.token).toBe("sgi-Xy9_token");
    expect(link.passphraseHint).toBe(true);
  });

  it("defaults to no passphrase hint", () => {
    expect(parseGuestInviteLink("/guest/sgi-abc").passphraseHint).toBe(false);
    expect(parseGuestInviteLink("/guest/sgi-abc", "?p=0").passphraseHint).toBe(false);
    expect(parseGuestInviteLink("/guest/sgi-abc", "?p=maybe").passphraseHint).toBe(
      false,
    );
  });

  it("takes only the FIRST path segment as the token", () => {
    // A pasted URL with something appended must not redeem a longer string —
    // and must not silently redeem a DIFFERENT one either.
    expect(parseGuestInviteLink("/guest/sgi-abc/extra").token).toBe("sgi-abc");
  });

  it("percent-decodes a token a chat client escaped", () => {
    expect(parseGuestInviteLink("/guest/sgi-a%2Db").token).toBe("sgi-a-b");
  });

  it("survives a malformed escape rather than throwing away the page", () => {
    // decodeURIComponent throws on a lone "%". The raw segment is still a
    // better answer than a crashed redeem page.
    expect(parseGuestInviteLink("/guest/sgi-100%").token).toBe("sgi-100%");
  });

  it("returns an empty token for a path that carries none", () => {
    expect(parseGuestInviteLink("/guest/").token).toBe("");
    expect(parseGuestInviteLink("/").token).toBe("");
    expect(parseGuestInviteLink("/guests/sgi-abc").token).toBe("");
  });
});

describe("cleanGuestDisplayName", () => {
  it("keeps an ordinary name intact", () => {
    expect(cleanGuestDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("strips the invisible and bidi-override characters", () => {
    // A guest picks their own name, so these are attacker-chosen: zero-width
    // characters make two 'Aaron's different strings, and RLO reverses a name
    // in the member list.
    const zwsp = String.fromCharCode(0x200b);
    const rlo = String.fromCharCode(0x202e);
    const bom = String.fromCharCode(0xfeff);
    expect(cleanGuestDisplayName(`Aa${zwsp}ron`)).toBe("Aaron");
    expect(cleanGuestDisplayName(`${rlo}Aaron`)).toBe("Aaron");
    expect(cleanGuestDisplayName(`${bom}Aaron`)).toBe("Aaron");
  });

  it("turns a newline into a separator instead of joining the words", () => {
    // Dropping it outright would silently produce "AdaLovelace".
    expect(cleanGuestDisplayName("Ada\nLovelace")).toBe("Ada Lovelace");
    expect(cleanGuestDisplayName("Ada\tLovelace")).toBe("Ada Lovelace");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(cleanGuestDisplayName("   Ada    Lovelace   ")).toBe("Ada Lovelace");
  });

  it("caps at the server's limit", () => {
    const long = "a".repeat(200);
    expect(cleanGuestDisplayName(long)).toHaveLength(MAX_GUEST_DISPLAY_NAME);
  });

  it("returns empty for nothing usable, so the form can block Join", () => {
    // The SERVER falls back to "Guest" here; the client deliberately does not,
    // because "" is what tells the form the person has not typed a name yet.
    expect(cleanGuestDisplayName("")).toBe("");
    expect(cleanGuestDisplayName(null)).toBe("");
    expect(cleanGuestDisplayName(undefined)).toBe("");
    expect(cleanGuestDisplayName("   ")).toBe("");
    expect(cleanGuestDisplayName(String.fromCharCode(0x200b))).toBe("");
    expect(isAcceptableGuestDisplayName(" \n ")).toBe(false);
    expect(isAcceptableGuestDisplayName("Ada")).toBe(true);
  });
});

describe("redeemOutcomeFor", () => {
  it("folds every refusal into ONE outcome", () => {
    // Unknown / revoked / expired / exhausted / wrong passphrase are one 403,
    // and a disabled feature is a 404 shaped like a link that never existed.
    expect(redeemOutcomeFor(403)).toBe("invalid");
    expect(redeemOutcomeFor(401)).toBe("invalid");
    expect(redeemOutcomeFor(404)).toBe("invalid");
    expect(redeemOutcomeFor(422)).toBe("invalid");
    expect(redeemMessageFor("invalid")).toBe(GUEST_LINK_INVALID_MESSAGE);
  });

  it("distinguishes only the conditions that are not about the link", () => {
    expect(redeemOutcomeFor(429)).toBe("rate_limited");
    // The server FAILS CLOSED on a Redis outage rather than lifting its only
    // brute-force guard, so a 503 is a real answer and not a refusal.
    expect(redeemOutcomeFor(503)).toBe("unavailable");
    expect(redeemOutcomeFor(500)).toBe("unavailable");
    expect(redeemOutcomeFor(0)).toBe("offline");
  });

  it("offers Try again only where trying again can work", () => {
    expect(isRetryableRedeemOutcome("invalid")).toBe(false);
    expect(isRetryableRedeemOutcome("rate_limited")).toBe(true);
    expect(isRetryableRedeemOutcome("unavailable")).toBe(true);
    expect(isRetryableRedeemOutcome("offline")).toBe(true);
  });

  it("gives one byte-identical answer to every refusal status", () => {
    // The uniformity IS the security property: 401, 403, 404 and 422 must be
    // indistinguishable to the person holding the link, exactly as the server
    // made them indistinguishable by body and by latency.
    const answers = new Set(
      [401, 403, 404, 400, 422].map((s) => redeemMessageFor(redeemOutcomeFor(s))),
    );
    expect(answers.size).toBe(1);
  });

  it("names every cause at once rather than singling one out", () => {
    // Listing all of them distinguishes none of them — the opposite of a
    // "this link was revoked" message, which would rebuild the oracle.
    const message = redeemMessageFor("invalid").toLowerCase();
    for (const cause of ["expired", "used up", "turned off", "passphrase"]) {
      expect(message).toContain(cause);
    }
  });
});

describe("guestSessionFromRedeem", () => {
  it("normalizes the response the server sends today", () => {
    const s = guestSessionFromRedeem(REDEEM)!;
    expect(s.token).toBe(REDEEM.session_token);
    expect(s.roomId).toBe(REDEEM.room_id);
    expect(s.roomName).toBe("Build In Public");
    expect(s.canPublish).toBe(true);
    expect(s.historyFromMs).toBeNull();
    expect(s.capabilities).toEqual({});
    expect(s.inviteKey).toBe("");
  });

  it("remembers WHICH link produced it, by prefix only", () => {
    const s = guestSessionFromRedeem(REDEEM, "sgi-01234567-REST-OF-THE-CREDENTIAL")!;
    // 12 chars, exactly the non-secret `token_prefix` the server itself stores.
    expect(s.inviteKey).toBe("sgi-01234567");
    expect(s.inviteKey.length).toBe(12);
    // The rest of the reusable credential never lands in the session.
    expect(JSON.stringify(s)).not.toContain("REST-OF-THE-CREDENTIAL");
  });

  it("refuses a response missing a field the shell cannot run without", () => {
    expect(guestSessionFromRedeem({ ...REDEEM, room_id: undefined })).toBeNull();
    expect(guestSessionFromRedeem({ ...REDEEM, session_token: undefined })).toBeNull();
    expect(guestSessionFromRedeem(null)).toBeNull();
    expect(guestSessionFromRedeem("sgs-nope")).toBeNull();
  });

  it("refuses a credential that is not a guest session token", () => {
    // A broadcast token or a Keycloak JWT landing here would be sent as a
    // guest bearer on every subsequent call.
    expect(guestSessionFromRedeem({ ...REDEEM, session_token: "sbt-abc" })).toBeNull();
  });

  it("denies publish when the grant is absent, rather than assuming it", () => {
    const s = guestSessionFromRedeem({ ...REDEEM, can_publish: undefined })!;
    expect(s.canPublish).toBe(false);
    // Never coerced: a truthy string is not a grant.
    expect(guestSessionFromRedeem({ ...REDEEM, can_publish: "yes" })!.canPublish).toBe(
      false,
    );
  });

  it("accepts optional fields the server may add later without crashing", () => {
    const s = guestSessionFromRedeem({
      ...REDEEM,
      history_from: iso(-3600_000),
      capabilities: { chat: false, publish: true, nonsense: "maybe" },
      some_future_field: { nested: [1, 2, 3] },
    })!;
    expect(s.historyFromMs).toBe(NOW - 3600_000);
    // Non-boolean entries are dropped, not coerced.
    expect(s.capabilities).toEqual({ chat: false, publish: true });
  });

  it("reads a numeric history boundary in either seconds or milliseconds", () => {
    expect(guestSessionFromRedeem({ ...REDEEM, history_from: NOW })!.historyFromMs).toBe(
      NOW,
    );
    expect(
      guestSessionFromRedeem({ ...REDEEM, history_from: Math.floor(NOW / 1000) })!
        .historyFromMs,
    ).toBe(Math.floor(NOW / 1000) * 1000);
  });

  it("treats an unreadable boundary as no boundary, not as hide-everything", () => {
    expect(
      guestSessionFromRedeem({ ...REDEEM, history_from: "not a date" })!.historyFromMs,
    ).toBeNull();
  });
});

describe("storedSessionMatchesLink", () => {
  it("keeps a restored session when the URL carries no token", () => {
    // A bare /guest reload has nothing to disagree with.
    expect(storedSessionMatchesLink(session({ inviteKey: "sgi-aaaaaaaa" }), "")).toBe(
      true,
    );
    expect(
      storedSessionMatchesLink(session({ inviteKey: "sgi-aaaaaaaa" }), null),
    ).toBe(true);
  });

  it("refuses a session that came from a DIFFERENT invite", () => {
    // Otherwise opening a second link in the same tab silently drops you back
    // into the first room.
    const s = session({ inviteKey: guestInviteKey("sgi-first-link-token") });
    expect(storedSessionMatchesLink(s, "sgi-first-link-token")).toBe(true);
    expect(storedSessionMatchesLink(s, "sgi-second-link-token")).toBe(false);
    // A session stored before this field existed matches nothing but a bare URL.
    expect(storedSessionMatchesLink(session({ inviteKey: "" }), "sgi-any")).toBe(
      false,
    );
  });
});

describe("guestCan", () => {
  it("falls back to today's behaviour for a flag the server never sent", () => {
    expect(guestCan(session(), "chat", true)).toBe(true);
    expect(guestCan(null, "chat", true)).toBe(true);
    expect(guestCan(undefined, "anything", false)).toBe(false);
  });

  it("honours a flag the server did send", () => {
    const s = session({ capabilities: { chat: false } });
    expect(guestCan(s, "chat", true)).toBe(false);
  });
});

describe("mergeGuestMe", () => {
  it("refreshes the fields /guest/me carries and keeps the token", () => {
    const merged = mergeGuestMe(session(), {
      display_name: "Ada L.",
      room_display_name: "Renamed Room",
      can_publish: false,
      expires_at: iso(60_000),
    });
    expect(merged.token).toBe(REDEEM.session_token);
    expect(merged.displayName).toBe("Ada L.");
    expect(merged.roomName).toBe("Renamed Room");
    expect(merged.canPublish).toBe(false);
  });

  it("leaves existing values alone when a field is absent", () => {
    // /guest/me is polled. A partial rollout that dropped a field must not
    // blank the room name or silently revoke the camera.
    const merged = mergeGuestMe(session(), { display_name: "Ada L." });
    expect(merged.roomName).toBe("Build In Public");
    expect(merged.canPublish).toBe(true);
    expect(mergeGuestMe(session(), null).roomName).toBe("Build In Public");
  });
});

describe("nextGuestState", () => {
  it("starts on the redeem form, or live when a session was restored", () => {
    expect(initialGuestState().phase).toBe("redeem");
    expect(initialGuestState(session()).phase).toBe("live");
  });

  it("drops the token on EVERY ending", () => {
    // A dead credential left in state is one something will retry with.
    for (const event of ["session_ended", "unauthorized", "expired", "left"] as const) {
      const ended = nextGuestState(initialGuestState(session()), { type: event });
      expect(ended.phase).toBe("ended");
      expect(ended.session).toBeNull();
    }
  });

  it("maps a revocation and a 401 to the same terminal reason", () => {
    const live = initialGuestState(session());
    expect(nextGuestState(live, { type: "session_ended" }).ended).toBe("revoked");
    expect(nextGuestState(live, { type: "unauthorized" }).ended).toBe("revoked");
    expect(nextGuestState(live, { type: "expired" }).ended).toBe("expired");
    expect(nextGuestState(live, { type: "left" }).ended).toBe("left");
  });

  it("keeps the FIRST ending — a late frame cannot rewrite it", () => {
    const left = nextGuestState(initialGuestState(session()), { type: "left" });
    const after = nextGuestState(left, { type: "session_ended" });
    expect(after.ended).toBe("left");
    expect(after).toBe(left);
  });

  it("only a fresh redemption reopens the room", () => {
    const ended = nextGuestState(initialGuestState(session()), {
      type: "session_ended",
    });
    const rejoined = nextGuestState(ended, { type: "joined", session: session() });
    expect(rejoined.phase).toBe("live");
    expect(rejoined.ended).toBeNull();
  });

  it("says the same uniform thing about a revocation as about a lapse", () => {
    expect(endReasonMessage("revoked")).toContain("no longer valid");
    expect(endReasonMessage("revoked").toLowerCase()).not.toContain("revoked by");
    expect(endReasonMessage("expired")).toContain("ended");
    expect(endReasonMessage("left")).toContain("left");
  });
});

describe("expiry", () => {
  it("counts down from the server's expiry", () => {
    expect(guestSessionExpiresInMs(iso(60_000), NOW)).toBe(60_000);
    expect(guestSessionExpiresInMs(iso(-1), NOW)).toBe(-1);
  });

  it("treats an absent or unreadable expiry as NOT expired", () => {
    // The server re-checks the credential on every request and every 4s on the
    // socket, so it is the authority. Guessing "expired" from a field we could
    // not parse would throw a working guest off a live show.
    expect(isGuestSessionExpired(null, NOW)).toBe(false);
    expect(isGuestSessionExpired(undefined, NOW)).toBe(false);
    expect(isGuestSessionExpired("whenever", NOW)).toBe(false);
    expect(guestSessionExpiresInMs("whenever", NOW)).toBeNull();
  });

  it("expires exactly at the boundary", () => {
    expect(isGuestSessionExpired(iso(1), NOW)).toBe(false);
    expect(isGuestSessionExpired(iso(0), NOW)).toBe(true);
    expect(isGuestSessionExpired(iso(-1), NOW)).toBe(true);
  });

  it("warns only inside the last ten minutes", () => {
    expect(guestExpiryNotice(iso(3600_000), NOW)).toBeNull();
    expect(guestExpiryNotice(iso(9 * 60_000), NOW)).toContain("9 minutes");
    expect(guestExpiryNotice(iso(60_000), NOW)).toContain("1 minute");
    // Nothing to warn about once it is over, and nothing to say with no expiry.
    expect(guestExpiryNotice(iso(-60_000), NOW)).toBeNull();
    expect(guestExpiryNotice(null, NOW)).toBeNull();
  });
});

describe("socket lifecycle", () => {
  it("recognises the stop-reconnecting frame", () => {
    expect(isSessionEndedFrame({ type: "session_ended" })).toBe(true);
    expect(isSessionEndedFrame({ type: "session_ended", reason: "guest_left" })).toBe(
      true,
    );
    expect(isSessionEndedFrame({ type: "message" })).toBe(false);
    expect(isSessionEndedFrame(null)).toBe(false);
    expect(isSessionEndedFrame("session_ended")).toBe(false);
  });

  it("recognises the auth ack", () => {
    expect(isAuthOkFrame({ type: "auth_ok", participant_id: "x" })).toBe(true);
    expect(isAuthOkFrame({ type: "auth" })).toBe(false);
  });

  it("stops on the server's verdicts and comes back from transport failures", () => {
    // 4001/4003/4004 are judgements on THIS credential — retrying replays a
    // refusal and leaves the browser looking connected while nothing is live.
    expect(shouldReconnectAfterClose(4001)).toBe(false);
    expect(shouldReconnectAfterClose(4003)).toBe(false);
    expect(shouldReconnectAfterClose(4004)).toBe(false);
    expect(shouldReconnectAfterClose(1006)).toBe(true);
    expect(shouldReconnectAfterClose(1001)).toBe(true);
  });

  it("backs off 1s -> 20s and never faster than 1s", () => {
    expect(guestReconnectDelayMs(1)).toBe(1_000);
    expect(guestReconnectDelayMs(2)).toBe(2_000);
    expect(guestReconnectDelayMs(5)).toBe(16_000);
    expect(guestReconnectDelayMs(6)).toBe(20_000);
    expect(guestReconnectDelayMs(99)).toBe(20_000);
    expect(guestReconnectDelayMs(0)).toBe(1_000);
  });
});

describe("badging guests", () => {
  it("reads the server's participant_type and nothing else", () => {
    expect(isGuestParticipant("guest")).toBe(true);
    expect(isGuestParticipant("human")).toBe(false);
    expect(isGuestParticipant("agent")).toBe(false);
    // A legacy row with no type is a human, as every other reader assumes.
    expect(isGuestParticipant(undefined)).toBe(false);
    expect(isGuestParticipant(null)).toBe(false);
  });

  it("badges a guest's messages from sender_type", () => {
    expect(isGuestSender("guest")).toBe(true);
    expect(isGuestSender("human")).toBe(false);
    expect(isGuestSender("system")).toBe(false);
  });

  it("joins a call tile back to the roster to find a guest", () => {
    // The LiveKit token carries no guest marker, so the badge has to come from
    // the member row — matched on <username>_<participant id>.
    const members = [
      { username: "aaron", participant_id: "u-1", participant_type: "human" },
      { username: "guest-deadbeef", participant_id: "g-1", participant_type: "guest" },
    ];
    expect(isGuestCallIdentity("guest-deadbeef_g-1", members)).toBe(true);
    expect(isGuestCallIdentity("aaron_u-1", members)).toBe(false);
    // A guest username on somebody ELSE's participant id is not a match.
    expect(isGuestCallIdentity("guest-deadbeef_u-1", members)).toBe(false);
    expect(isGuestCallIdentity("nobody_x", members)).toBe(false);
    expect(isGuestCallIdentity(null, members)).toBe(false);
    expect(isGuestCallIdentity("guest-deadbeef_g-1", [])).toBe(false);
    expect(isGuestCallIdentity("guest-deadbeef_g-1", undefined)).toBe(false);
  });
});

describe("isMessageVisibleToGuest", () => {
  it("shows everything when no boundary was sent (today's behaviour)", () => {
    expect(isMessageVisibleToGuest(iso(-99 * 3600_000), null)).toBe(true);
    expect(isMessageVisibleToGuest(undefined, null)).toBe(true);
  });

  it("hides what predates a boundary the server did send", () => {
    const boundary = NOW - 3600_000;
    expect(isMessageVisibleToGuest(iso(-2 * 3600_000), boundary)).toBe(false);
    expect(isMessageVisibleToGuest(iso(-3600_000), boundary)).toBe(true);
    expect(isMessageVisibleToGuest(iso(0), boundary)).toBe(true);
  });

  it("hides an unreadable timestamp rather than leaking the back catalogue", () => {
    expect(isMessageVisibleToGuest("not a date", NOW - 3600_000)).toBe(false);
    expect(isMessageVisibleToGuest(null, NOW - 3600_000)).toBe(false);
  });
});

describe("session persistence", () => {
  it("round-trips a session through storage", () => {
    const storage = fakeStorage();
    writeStoredGuestSession(session(), storage);
    const restored = readStoredGuestSession(storage);
    expect(restored).toEqual(session());
  });

  it("returns null for nothing stored, junk, or a tampered blob", () => {
    expect(readStoredGuestSession(fakeStorage())).toBeNull();
    expect(
      readStoredGuestSession(fakeStorage({ [GUEST_SESSION_STORAGE_KEY]: "{oops" })),
    ).toBeNull();
    // Same validator as the network path: a blob with the token filed off is
    // not a session, it is null.
    const gutted = JSON.stringify({ ...session(), token: "" });
    expect(
      readStoredGuestSession(fakeStorage({ [GUEST_SESSION_STORAGE_KEY]: gutted })),
    ).toBeNull();
  });

  it("clears the credential on demand", () => {
    const storage = fakeStorage();
    writeStoredGuestSession(session(), storage);
    clearStoredGuestSession(storage);
    expect(readStoredGuestSession(storage)).toBeNull();
  });

  it("survives a storage that throws (private mode) without taking the page down", () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => writeStoredGuestSession(session(), hostile)).not.toThrow();
    expect(readStoredGuestSession(hostile)).toBeNull();
    expect(() => clearStoredGuestSession(hostile)).not.toThrow();
    // A null storage (SSR / no sessionStorage at all) is simply no persistence.
    expect(readStoredGuestSession(null)).toBeNull();
    expect(() => writeStoredGuestSession(session(), null)).not.toThrow();
  });

  it("is keyed OUTSIDE the app's own returning-visitor markers", () => {
    // LandingGate treats any `stable.*` key in localStorage as "been here
    // before"; this lives in sessionStorage precisely so a guest is not
    // mistaken for a returning user (and so the token dies with the tab).
    expect(GUEST_SESSION_STORAGE_KEY).toBe("stable.guest.session.v1");
  });
});

describe("isGuestSessionToken", () => {
  it("recognises the session prefix and nothing else", () => {
    expect(isGuestSessionToken("sgs-abc")).toBe(true);
    // The INVITE token is a different credential and only /guest/redeem takes it.
    expect(isGuestSessionToken("sgi-abc")).toBe(false);
    expect(isGuestSessionToken("sbt-abc")).toBe(false);
    expect(isGuestSessionToken(null)).toBe(false);
    expect(isGuestSessionToken("")).toBe(false);
  });
});
