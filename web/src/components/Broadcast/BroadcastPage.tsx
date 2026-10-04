import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, VideoQuality } from "livekit-client";
import type { RemoteTrack, RemoteTrackPublication } from "livekit-client";
import {
  backoffDelayMs,
  isBroadcastTarget,
  pickBroadcastAudioPublication,
  pickBroadcastVideoPublication,
  parseBroadcastOptions,
  refreshDelayMs,
  shouldPlayAudio,
  type BroadcastJoinResponse,
} from "@/lib/broadcast";
import {
  broadcastLowerThirdOptIn,
  roomLowerThirdOptIn,
  subtitleFromMetadata,
} from "@/lib/tileChrome";
import { BroadcastLowerThird } from "@/components/Room/LowerThird";

/**
 * /broadcast/:roomId/:participantIdentity?token=…&source=…&bg=…&audio=…
 *
 * ONE participant's camera, full-bleed, with zero app UI — a URL an OBS browser
 * source can point at. It replaces screen-scraping Stable's `window.open`
 * pop-out, which OBS binds by macOS window id: reopening the pop-out mints a
 * NEW id, OBS's binding orphans silently, and the guest disappears from the
 * live stream mid-show. A URL re-fetches on OBS restart and cannot orphan.
 *
 * FIVE THINGS THIS PAGE MUST NEVER DO, all learned from a live broadcast:
 *
 *  1. Require a session. It mounts ABOVE AuthGate (see App.tsx) — an OBS
 *     browser source cannot complete a Keycloak redirect, so a route inside the
 *     gate renders for nobody. The join call is a bare `fetch`, NOT the `api`
 *     client, whose getAuthHeaders() unconditionally reaches for a Keycloak
 *     token.
 *  2. Render anything but video. No avatar, no placeholder, no spinner, no
 *     error text — every one of those would be composited into a live stream.
 *     Camera off, participant gone, token refused: all render the background.
 *     The one exception is an opt-in lower third: `?lowerThird=1` on the
 *     token URL, or `lower_third: true` on the join payload if a room ever
 *     sends it. The join payload does not send that field today. Default off
 *     — a link without either still paints nothing but the camera. The strip
 *     is a name, never a button.
 *  3. Say WHY it failed. The server answers unknown / revoked / expired with
 *     one identical 403 so the endpoint is not a token oracle. Neither the DOM
 *     nor the console gets to undo that.
 *  4. Freeze. LiveKit keys "background" off the MAIN document's visibility and
 *     an OBS browser source is never foreground, so `pauseVideoInBackground:
 *     false` is load-bearing, not a tuning knob.
 *  5. Die at the one-hour mark. The server caps every LiveKit token at 3600s
 *     while a broadcast link lives up to 24h, so the page re-mints on a timer
 *     and swaps connections under a frozen frame. See `cycle()`.
 *
 * The route's :roomId and :participantIdentity are documentation for the human
 * pasting the URL. The SERVER's join response is the only authority on which
 * room and which participant this token may render.
 */

/** Same-origin by default: nginx serves the SPA and proxies /api from one host. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

/**
 * How long a captured still may cover a reconnect before we give up on it.
 *
 * A LiveKit reconnect + resubscribe lands well inside this. Kept SHORT because
 * the still is a picture of a person: if the swap fails, or they came back with
 * their camera off, holding their face on a live stream is the wrong failure.
 */
const FREEZE_MAX_MS = 4_000;

/**
 * Extra hold after the replacement <video> reports `playing`.
 *
 * MEASURED against a real LiveKit: the first frame after a swap arrives on the
 * LOW simulcast layer and takes another ~1s to ramp to the top one — 320x180
 * blown up to the full OBS canvas, which is very visible on a stream. Holding
 * the still a beat longer trades an imperceptibly stale frame for that blur.
 */
const FREEZE_SETTLE_MS = 900;

/** The server's uniform refusal — unknown, revoked and expired are one case. */
class BroadcastRefused extends Error {}

async function joinBroadcast(token: string): Promise<BroadcastJoinResponse> {
  const response = await fetch(`${API_BASE}/api/v1/broadcast/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new BroadcastRefused();
  }
  if (!response.ok) {
    // Transport / server trouble — worth retrying, unlike a refusal.
    throw new Error(`broadcast join failed (${response.status})`);
  }
  return (await response.json()) as BroadcastJoinResponse;
}

interface BroadcastSession {
  room: Room;
  join: BroadcastJoinResponse;
  /**
   * The cycle that owns this session. Compared against the effect's live
   * `generation` counter, and it is the ONLY thing that decides whether a
   * session's events may touch the DOM.
   *
   * MEASURED BUG this exists to fix: a re-mint reuses the same LiveKit identity
   * (the server derives it from the token id), so connecting the replacement
   * EVICTS the old session — mid-`connect()`, i.e. before any "the new one is
   * live now" flag could be set. The old session's Disconnected handler then
   * read itself as still current, blanked the feed and scheduled a recovery
   * that minted yet another token. End-to-end against a real LiveKit that was
   * 18 joins in 35 seconds instead of 4, with a black frame at every one.
   * Bumping `generation` at the TOP of each cycle closes the window entirely.
   */
  gen: number;
}

export function BroadcastPage() {
  // The URL never changes under this page (OBS loads it once), so parse once.
  const options = useMemo(
    () => parseBroadcastOptions(window.location.search),
    [],
  );

  const [videoTrack, setVideoTrack] = useState<RemoteTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<RemoteTrack | null>(null);
  /** Room asked for a lower third via the join payload. The URL flag is separate. */
  const [broadcastRoomOptIn, setBroadcastRoomOptIn] = useState(false);
  const [broadcastSpeaker, setBroadcastSpeaker] = useState<{
    id: string;
    name: string;
    subtitle: string | null;
  } | null>(null);
  /** A still of the outgoing feed, held over a re-mint so it doesn't blink. */
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  /**
   * A re-mint is in flight and the still is standing in for the picture.
   *
   * A ref, not effect-local state, because the thing that ENDS a swap is the
   * <video> element firing `playing` — which happens in the render tree, not
   * in the connection effect.
   */
  const swappingRef = useRef(false);

  /**
   * Drop the held still. MEASURED: clearing it the moment the replacement
   * TRACK arrived showed 1.1s of black on every re-mint, because a freshly
   * mounted <video> needs roughly that long to attach and decode its first
   * frame. Only the element saying it is playing (or the hard timeout) may
   * end the cover.
   */
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const clearFreeze = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = undefined;
    swappingRef.current = false;
    setFrozenFrame(null);
  }, []);

  /** The replacement feed is really playing — let it settle, then reveal it. */
  const handleVideoPlaying = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(clearFreeze, FREEZE_SETTLE_MS);
  }, [clearFreeze]);

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  /* The page paints nothing of its own: no app background, no aurora, no
     scrollbars. `?bg=transparent` goes further so OBS can lay the feed over
     another source. Scoped to the document because #root sits on top of a
     body background this page must not inherit. */
  useEffect(() => {
    const targets = [document.documentElement, document.body];
    for (const el of targets) {
      el.classList.add("stable-broadcast");
      if (options.transparent) el.classList.add("stable-broadcast-transparent");
    }
    const previousTitle = document.title;
    document.title = "Stable broadcast";
    return () => {
      for (const el of targets) {
        el.classList.remove(
          "stable-broadcast",
          "stable-broadcast-transparent",
        );
      }
      document.title = previousTitle;
    };
  }, [options.transparent]);

  useEffect(() => {
    // No token: nothing to join and nothing to say about it. Stay black.
    if (!options.token) return;

    let disposed = false;
    /** The session whose events own what is on screen. */
    let current: BroadcastSession | null = null;
    /**
     * The latest cycle. Bumped BEFORE anything a cycle does, so the instant a
     * refresh starts, every older session is superseded and its events — very
     * much including the DUPLICATE_IDENTITY eviction our own reconnect causes —
     * become no-ops.
     */
    let generation = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let freezeTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function clearTimers() {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
      refreshTimer = undefined;
      retryTimer = undefined;
    }

    /**
     * Subscribe to exactly ONE publication (plus audio when permitted) and
     * nothing else. `autoSubscribe: false` + this is deliberate: the LiveKit
     * grant is room-scoped, so autoSubscribe would pull every publisher's video
     * down an OBS box that only ever renders one of them.
     */
    function applySubscriptions(session: BroadcastSession) {
      if (disposed) return;
      const playAudio = shouldPlayAudio(
        session.join.allow_audio,
        options.wantAudio,
      );
      for (const participant of session.room.remoteParticipants.values()) {
        const pubs = Array.from(
          participant.trackPublications.values(),
        ) as RemoteTrackPublication[];
        const isTarget = isBroadcastTarget(
          participant.identity,
          session.join.participant_identity,
        );
        const wantVideo = isTarget
          ? pickBroadcastVideoPublication(pubs, options.source)
          : null;
        const wantAudio =
          isTarget && playAudio
            ? pickBroadcastAudioPublication(pubs, options.source)
            : null;
        for (const pub of pubs) {
          const wanted = pub === wantVideo || pub === wantAudio;
          if (pub.isSubscribed !== wanted) pub.setSubscribed(wanted);
          if (wanted && pub.kind === Track.Kind.Video) {
            // Ask for the top simulcast layer. Adaptive stream still clamps to
            // the element's measured size when that is SMALLER, which for a
            // full-bleed 1920x1080 OBS source is the layer we want anyway.
            pub.setVideoQuality(VideoQuality.HIGH);
          }
        }
      }
    }

    /** Push the session's tracks into the DOM — only if it still owns the screen. */
    function sync(session: BroadcastSession) {
      // Generation, not `current`: a session being replaced is superseded from
      // the moment its successor's cycle STARTS, which is before the successor
      // exists. Gating on `current` left the evicted session briefly in charge.
      if (disposed || session.gen !== generation) return;
      const target = Array.from(session.room.remoteParticipants.values()).find(
        (p) =>
          isBroadcastTarget(p.identity, session.join.participant_identity),
      );
      const pubs = target
        ? (Array.from(target.trackPublications.values()) as RemoteTrackPublication[])
        : [];
      const videoPub = pickBroadcastVideoPublication(
        pubs,
        options.source,
        { requireTrack: true },
      );
      const audioPub = shouldPlayAudio(
        session.join.allow_audio,
        options.wantAudio,
      )
        ? pickBroadcastAudioPublication(pubs, options.source, {
            requireTrack: true,
          })
        : null;
      setVideoTrack(videoPub?.track ?? null);
      setAudioTrack(audioPub?.track ?? null);
      // A held still of someone whose camera has since gone off is worse than
      // black: it keeps broadcasting them after they stopped. Only an in-flight
      // swap may hold one, and only until the element plays or FREEZE_MAX_MS.
      if (!videoPub && !swappingRef.current) setFrozenFrame(null);
      syncSpeaker(session);
    }

    /**
     * Capture the frame currently on screen so the re-mint reconnect doesn't
     * blink. Necessary because the LiveKit identity is per-TOKEN: the new
     * connection EVICTS the old one (DUPLICATE_IDENTITY) the instant it lands,
     * so the two feeds can never overlap.
     */
    function freezeCurrentFrame() {
      const el = videoElRef.current;
      if (!el || el.readyState < 2 || !el.videoWidth) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = el.videoWidth;
        canvas.height = el.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        swappingRef.current = true;
        setFrozenFrame(canvas.toDataURL("image/jpeg", 0.92));
        if (freezeTimer) clearTimeout(freezeTimer);
        freezeTimer = setTimeout(clearFreeze, FREEZE_MAX_MS);
      } catch {
        // Worst case the reconnect blinks black for a beat. Never fatal.
      }
    }

    function roomOptInFromJoin(join: BroadcastJoinResponse): boolean {
      return roomLowerThirdOptIn({
        lower_third: (join as { lower_third?: unknown }).lower_third,
      });
    }

    /** Name strip for the person this token was minted for, while they speak. */
    function syncSpeaker(session: BroadcastSession) {
      if (disposed || session.gen !== generation) return;
      const roomOn = roomOptInFromJoin(session.join);
      if (
        !broadcastLowerThirdOptIn({
          search: window.location.search,
          roomOptIn: roomOn,
        })
      ) {
        return;
      }
      const target = (session.room.activeSpeakers ?? []).find((speaker) =>
        isBroadcastTarget(speaker.identity, session.join.participant_identity),
      );
      if (!target) {
        setBroadcastSpeaker(null);
        return;
      }
      const label = (session.join.participant_label || target.name || "").trim();
      setBroadcastSpeaker({
        id: target.identity,
        name: label || target.identity,
        subtitle: subtitleFromMetadata(target.metadata),
      });
    }

    function goDark() {
      clearTimers();
      const dead = current;
      current = null;
      roomRef.current = null;
      setVideoTrack(null);
      setAudioTrack(null);
      setBroadcastSpeaker(null);
      setBroadcastRoomOptIn(false);
      clearFreeze();
      if (dead) void dead.room.disconnect();
    }

    function scheduleRetry(isRefresh: boolean) {
      attempt += 1;
      retryTimer = setTimeout(() => void cycle(isRefresh), backoffDelayMs(attempt));
    }

    async function openSession(
      join: BroadcastJoinResponse,
      gen: number,
    ): Promise<BroadcastSession> {
      const room = new Room({
        // MANDATORY, not a tuning knob: livekit decides "background" from the
        // MAIN document's visibility, and an OBS browser source is never the
        // foreground window. Without this the feed freezes the moment OBS
        // stops being frontmost — which is always, during a show.
        adaptiveStream: { pauseVideoInBackground: false },
        dynacast: true,
      });
      const session: BroadcastSession = { room, join, gen };

      const resubscribe = () => {
        applySubscriptions(session);
        sync(session);
      };

      room
        .on(RoomEvent.ParticipantConnected, resubscribe)
        .on(RoomEvent.ParticipantDisconnected, resubscribe)
        .on(RoomEvent.TrackPublished, resubscribe)
        .on(RoomEvent.TrackUnpublished, resubscribe)
        .on(RoomEvent.TrackMuted, resubscribe)
        .on(RoomEvent.TrackUnmuted, resubscribe)
        .on(RoomEvent.TrackSubscribed, resubscribe)
        .on(RoomEvent.TrackUnsubscribed, resubscribe)
        .on(RoomEvent.Reconnected, resubscribe)
        .on(RoomEvent.ActiveSpeakersChanged, () => syncSpeaker(session))
        .on(RoomEvent.Disconnected, () => {
          // A SUPERSEDED session was evicted by our own re-mint (the LiveKit
          // identity is per broadcast token, so the replacement kicks its
          // predecessor off) — expected, and emphatically not a reason to blank
          // a live feed or to mint yet another token.
          if (disposed || session.gen !== generation) return;
          goDark();
          scheduleRetry(false);
        });

      // Subscribe-only grant; no devices are ever opened by this page.
      await room.connect(join.livekit_url, join.token, {
        autoSubscribe: false,
      });
      return session;
    }

    /**
     * One join → connect → schedule-the-next-join turn.
     *
     * `isRefresh` distinguishes the scheduled re-mint (hold a still over the
     * swap) from a cold start or a recovery (nothing worth holding).
     */
    async function cycle(isRefresh: boolean) {
      if (disposed) return;
      // Claim ownership FIRST. Everything older is superseded from here on,
      // including the eviction this cycle is about to cause.
      const gen = ++generation;
      clearTimers();

      let join: BroadcastJoinResponse;
      try {
        join = await joinBroadcast(options.token);
      } catch (error) {
        if (disposed || gen !== generation) return;
        if (error instanceof BroadcastRefused) {
          // Unknown, revoked or expired — the server refuses to distinguish
          // them and so do we. Stop for good; a revoked link must stay dead.
          goDark();
          return;
        }
        scheduleRetry(isRefresh);
        return;
      }
      if (disposed || gen !== generation) return;
      setBroadcastRoomOptIn(roomOptInFromJoin(join));

      const previous = current;
      if (isRefresh) freezeCurrentFrame();

      let session: BroadcastSession;
      try {
        session = await openSession(join, gen);
      } catch {
        if (disposed || gen !== generation) return;
        scheduleRetry(isRefresh);
        return;
      }
      if (disposed || gen !== generation) {
        void session.room.disconnect();
        return;
      }

      attempt = 0;
      current = session;
      roomRef.current = session.room;
      applySubscriptions(session);
      sync(session);

      // The new connection already evicted this one; just release the handles.
      if (previous && previous !== session) void previous.room.disconnect();

      // THE ANTI-DEATH TIMER. Without it the show ends at the LiveKit token's
      // one-hour cap with no error anywhere — the exact silent failure this
      // page exists to remove.
      refreshTimer = setTimeout(
        () => void cycle(true),
        refreshDelayMs(join.expires_at),
      );
    }

    void cycle(false);

    return () => {
      disposed = true;
      clearTimers();
      if (freezeTimer) clearTimeout(freezeTimer);
      const dead = current;
      current = null;
      roomRef.current = null;
      if (dead) void dead.room.disconnect();
    };
  }, [options.source, options.token, options.wantAudio, clearFreeze]);

  /* Autoplay. An OBS browser source is allowed to start audio unprompted; a
     normal tab is not, and the FIRST gesture unblocks it. Deliberately no UI —
     a "click to unmute" banner would be composited into the stream. */
  useEffect(() => {
    if (!audioTrack) return;
    const start = () => {
      void roomRef.current?.startAudio().catch(() => {});
    };
    start();
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, [audioTrack]);

  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoElRef.current = el;
      if (el && videoTrack) {
        videoTrack.attach(el);
        return () => {
          videoTrack.detach(el);
          videoElRef.current = null;
        };
      }
    },
    [videoTrack],
  );

  const attachAudio = useCallback(
    (el: HTMLAudioElement | null) => {
      if (el && audioTrack) {
        audioTrack.attach(el);
        return () => {
          audioTrack.detach(el);
        };
      }
    },
    [audioTrack],
  );

  const background = options.transparent ? "transparent" : "#000";

  return (
    <div
      // Fixed + inset-0 so the feed fills the OBS canvas whatever #root's app
      // height rules say. object-cover, never contain: letterboxing would bake
      // black bars into the composite.
      className="fixed inset-0 overflow-hidden"
      style={{ background }}
    >
      {videoTrack && (
        <video
          ref={attachVideo}
          autoPlay
          playsInline
          muted
          // `playing`, not `loadeddata`: loadeddata fires while the first
          // frame may still be undecoded, which is precisely the moment the
          // still must NOT be pulled away.
          onPlaying={handleVideoPlaying}
          className="block h-full w-full object-cover"
          style={{ background }}
        />
      )}
      {frozenFrame && (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${frozenFrame})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      )}
      {audioTrack && <audio ref={attachAudio} autoPlay />}
      <BroadcastLowerThird
        search={window.location.search}
        roomOptIn={broadcastRoomOptIn}
        speakerId={broadcastSpeaker?.id ?? null}
        name={broadcastSpeaker?.name ?? ""}
        subtitle={broadcastSpeaker?.subtitle}
      />
    </div>
  );
}

export default BroadcastPage;
