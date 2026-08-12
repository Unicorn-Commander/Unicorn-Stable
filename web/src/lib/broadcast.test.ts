import { describe, expect, it } from "vitest";
import {
  LIVEKIT_TOKEN_MAX_TTL_S,
  MIN_REFRESH_DELAY_S,
  backoffDelayMs,
  buildBroadcastUrl,
  isBroadcastTarget,
  livekitIdentityForMember,
  livekitTokenTtlSeconds,
  parseBroadcastOptions,
  pickBroadcastAudioPublication,
  pickBroadcastVideoPublication,
  refreshDelayMs,
  shouldPlayAudio,
} from "./broadcast";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("parseBroadcastOptions", () => {
  it("reads the token, the background mode and the audio request", () => {
    const opts = parseBroadcastOptions("?token=sbt-abc&bg=transparent&audio=1");
    expect(opts.token).toBe("sbt-abc");
    expect(opts.transparent).toBe(true);
    expect(opts.wantAudio).toBe(true);
  });

  it("defaults to an opaque, silent feed", () => {
    // The safe default matters: a feed that paints transparent by accident
    // shows whatever OBS has underneath, and one that unmutes by accident
    // puts a room's audio on a live stream.
    const opts = parseBroadcastOptions("?token=sbt-abc");
    expect(opts.transparent).toBe(false);
    expect(opts.wantAudio).toBe(false);
  });

  it("treats bg=black and any other value as opaque", () => {
    expect(parseBroadcastOptions("?bg=black").transparent).toBe(false);
    expect(parseBroadcastOptions("?bg=chartreuse").transparent).toBe(false);
    expect(parseBroadcastOptions("?bg=TRANSPARENT").transparent).toBe(true);
  });

  it("accepts the human spellings of audio=on and nothing else", () => {
    expect(parseBroadcastOptions("?audio=true").wantAudio).toBe(true);
    expect(parseBroadcastOptions("?audio=yes").wantAudio).toBe(true);
    expect(parseBroadcastOptions("?audio=0").wantAudio).toBe(false);
    expect(parseBroadcastOptions("?audio=maybe").wantAudio).toBe(false);
    expect(parseBroadcastOptions("").wantAudio).toBe(false);
  });

  it("returns an empty token rather than undefined when none is present", () => {
    expect(parseBroadcastOptions("?bg=transparent").token).toBe("");
  });
});

describe("shouldPlayAudio", () => {
  it("needs BOTH the server's grant and the URL's request", () => {
    expect(shouldPlayAudio(true, true)).toBe(true);
    expect(shouldPlayAudio(true, false)).toBe(false);
    // The consent half: ?audio=1 on a video-only link must stay silent.
    expect(shouldPlayAudio(false, true)).toBe(false);
    expect(shouldPlayAudio(undefined, true)).toBe(false);
  });
});

describe("livekitTokenTtlSeconds", () => {
  it("mirrors the server clamp: max(60, min(3600, remaining))", () => {
    expect(livekitTokenTtlSeconds(NOW + 8 * 3600_000, NOW)).toBe(3600);
    expect(livekitTokenTtlSeconds(NOW + 900_000, NOW)).toBe(900);
    expect(livekitTokenTtlSeconds(NOW + 10_000, NOW)).toBe(60);
    expect(livekitTokenTtlSeconds(NOW - 10_000, NOW)).toBe(60);
  });
});

describe("refreshDelayMs", () => {
  it("re-mints well inside the one-hour LiveKit cap on a long link", () => {
    // An 8h broadcast link still gets a 1h LiveKit token, so the page must
    // come back long before the hour is up or the stream dies mid-show.
    const delay = refreshDelayMs(iso(8 * 3600_000), NOW);
    expect(delay).toBe(2_880_000); // 48 min
    expect(delay).toBeLessThan(LIVEKIT_TOKEN_MAX_TTL_S * 1000);
    expect(delay).toBeLessThanOrEqual((LIVEKIT_TOKEN_MAX_TTL_S - 300) * 1000);
  });

  it("shortens as the broadcast link itself runs out", () => {
    // 10 min left → 10 min token → refresh at the 5-min safety margin.
    expect(refreshDelayMs(iso(600_000), NOW)).toBe(300_000);
    // 20 min left → the 0.8 fraction is looser than the margin, margin wins.
    expect(refreshDelayMs(iso(1_200_000), NOW)).toBe(900_000);
  });

  it("never schedules in the past and never spins", () => {
    // Under the safety margin the naive `ttl - 300` goes negative; the
    // fraction and the floor keep the timer sane instead of firing instantly
    // forever against a link that is already dying.
    expect(refreshDelayMs(iso(120_000), NOW)).toBe(MIN_REFRESH_DELAY_S * 1000);
    expect(refreshDelayMs(iso(-60_000), NOW)).toBe(MIN_REFRESH_DELAY_S * 1000);
  });

  it("stays strictly inside the token it is refreshing", () => {
    for (const remainingS of [61, 90, 300, 601, 1800, 3599, 3600, 86_400]) {
      const delay = refreshDelayMs(iso(remainingS * 1000), NOW);
      const ttlMs = livekitTokenTtlSeconds(NOW + remainingS * 1000, NOW) * 1000;
      expect(delay).toBeLessThan(ttlMs);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it("falls back to the full-TTL schedule on a missing or junk expiry", () => {
    // "Never refresh" is the failure this whole mechanism exists to prevent,
    // so an unparseable expiry must still produce a timer.
    const fallback = refreshDelayMs(null, NOW);
    expect(fallback).toBe(2_880_000);
    expect(refreshDelayMs("not-a-date", NOW)).toBe(2_880_000);
    expect(refreshDelayMs(undefined, NOW)).toBe(2_880_000);
  });
});

describe("backoffDelayMs", () => {
  it("doubles from 2s and caps at 30s", () => {
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(10)).toBe(30_000);
    expect(backoffDelayMs(0)).toBe(2_000);
  });
});

describe("buildBroadcastUrl", () => {
  it("produces an absolute, pasteable OBS URL", () => {
    expect(
      buildBroadcastUrl({
        origin: "https://stable.example.com",
        roomId: "11111111-2222-3333-4444-555555555555",
        participantIdentity: "aaron_99999999-8888-7777-6666-555555555555",
        token: "sbt-abc123",
      }),
    ).toBe(
      "https://stable.example.com/broadcast/11111111-2222-3333-4444-555555555555/aaron_99999999-8888-7777-6666-555555555555?token=sbt-abc123",
    );
  });

  it("appends bg and audio only when asked", () => {
    const url = buildBroadcastUrl({
      origin: "https://stable.example.com/",
      roomId: "r",
      participantIdentity: "p",
      token: "t",
      transparent: true,
      audio: true,
    });
    expect(url).toBe(
      "https://stable.example.com/broadcast/r/p?token=t&bg=transparent&audio=1",
    );
    expect(
      buildBroadcastUrl({
        origin: "https://x.test",
        roomId: "r",
        participantIdentity: "p",
        token: "t",
      }),
    ).not.toMatch(/bg=|audio=/);
  });

  it("escapes identities and tokens so nothing truncates the query", () => {
    // A '?' or '#' landing in an identity would silently cut the token off
    // the pasted URL — the feed would then just 401 with no clue why.
    const url = buildBroadcastUrl({
      origin: "https://x.test",
      roomId: "room/1",
      participantIdentity: "od?d #name",
      token: "sbt-a+b/c=",
    });
    expect(url).toContain("/broadcast/room%2F1/od%3Fd%20%23name?");
    expect(url).toContain("token=sbt-a%2Bb%2Fc%3D");
  });
});

describe("isBroadcastTarget", () => {
  it("matches exactly and nothing else", () => {
    expect(isBroadcastTarget("aaron_abc", "aaron_abc")).toBe(true);
    // A fuzzy match here would put the wrong person on a live stream.
    expect(isBroadcastTarget("aaron_abcd", "aaron_abc")).toBe(false);
    expect(isBroadcastTarget("AARON_abc", "aaron_abc")).toBe(false);
    expect(isBroadcastTarget("", "aaron_abc")).toBe(false);
    expect(isBroadcastTarget("aaron_abc", undefined)).toBe(false);
    expect(isBroadcastTarget(null, null)).toBe(false);
  });
});

describe("livekitIdentityForMember", () => {
  it("rebuilds the server's '<username>_<participant id>' identity", () => {
    expect(livekitIdentityForMember("aaron", "abc-123")).toBe("aaron_abc-123");
  });

  it("returns null rather than a half-built identity", () => {
    expect(livekitIdentityForMember("aaron", null)).toBeNull();
    expect(livekitIdentityForMember(undefined, "abc-123")).toBeNull();
    expect(livekitIdentityForMember("", "")).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * Track selection
 * ---------------------------------------------------------------- */

const cam = { kind: "video", source: "camera", track: {} };
const camMuted = { kind: "video", source: "camera", isMuted: true, track: {} };
const camUnsubscribed = { kind: "video", source: "camera" };
const screen = { kind: "video", source: "screen_share", track: {} };
const mic = { kind: "audio", source: "microphone", track: {} };
const micMuted = { kind: "audio", source: "microphone", isMuted: true, track: {} };
const screenAudio = { kind: "audio", source: "screen_share_audio", track: {} };

describe("pickBroadcastVideoPublication", () => {
  it("prefers the camera over a screen share", () => {
    // The inversion of StageView, which filters FOR screen_share: a broadcast
    // feed is a person, not a presentation.
    expect(pickBroadcastVideoPublication([screen, cam])).toBe(cam);
  });

  it("falls back to a screen share when that is all there is", () => {
    expect(pickBroadcastVideoPublication([screen])).toBe(screen);
  });

  it("renders NOTHING when the camera is off", () => {
    // Not a placeholder, not the screen share the person happens to also be
    // publishing while their camera is muted — nothing. Whatever this returns
    // gets composited into a live broadcast.
    expect(pickBroadcastVideoPublication([camMuted])).toBeNull();
    expect(pickBroadcastVideoPublication([])).toBeNull();
    expect(pickBroadcastVideoPublication([mic])).toBeNull();
  });

  it("ignores audio publications entirely", () => {
    expect(pickBroadcastVideoPublication([mic, screenAudio])).toBeNull();
  });

  it("requireTrack separates 'what to subscribe to' from 'what to attach'", () => {
    // Subscription intent runs BEFORE anything is subscribed, so a publication
    // with no track yet must still be pickable; attachment must not be.
    expect(pickBroadcastVideoPublication([camUnsubscribed])).toBe(
      camUnsubscribed,
    );
    expect(
      pickBroadcastVideoPublication([camUnsubscribed], { requireTrack: true }),
    ).toBeNull();
    expect(
      pickBroadcastVideoPublication([camUnsubscribed, screen], {
        requireTrack: true,
      }),
    ).toBe(screen);
  });
});

describe("pickBroadcastAudioPublication", () => {
  it("prefers the microphone, then anything else audible", () => {
    expect(pickBroadcastAudioPublication([screenAudio, mic])).toBe(mic);
    expect(pickBroadcastAudioPublication([screenAudio])).toBe(screenAudio);
  });

  it("skips a muted mic and video publications", () => {
    expect(pickBroadcastAudioPublication([micMuted])).toBeNull();
    expect(pickBroadcastAudioPublication([cam, screen])).toBeNull();
  });
});
