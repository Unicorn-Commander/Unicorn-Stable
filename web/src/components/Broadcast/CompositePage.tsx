import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, VideoQuality } from "livekit-client";
import type { RemoteTrack } from "livekit-client";
import { backoffDelayMs, refreshDelayMs, type BroadcastJoinResponse } from "@/lib/broadcast";
import {
  COMPOSITE_BACKGROUND,
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  CompositeRecordingGate,
  compositeAudioTracks,
  compositeGrid,
  compositeLayoutKind,
  compositeTiles,
  credentialsFromExchange,
  parseCompositeQuery,
  planCompositeConnect,
  tileHue,
  type CompositeParticipant,
  type CompositePublication,
  type CompositeTileModel,
} from "@/lib/composite";

/**
 * /broadcast/:room/composite?rt=…&url=…&token=…&layout=…
 *
 * The page LiveKit's egress Chrome records. It is not the OBS one-tile feed:
 * that one stays on BroadcastPage. Everything painted here is burned into the
 * MP4, so the document has no buttons, no cursor, no banners, and no error
 * text. A refused token is a dark frame.
 *
 * The worker will not start the file until it sees console.log("START_RECORDING"),
 * and it finalizes on console.log("END_RECORDING"). START is requested from
 * requestAnimationFrame after connect and the first layout commit — not after
 * a camera track, because an audio-only call is still a recording. The
 * re-mint that keeps a long file alive past the one-hour LiveKit JWT must not
 * log either signal; only the live session's own disconnect does.
 *
 * The join call is a bare fetch. The shared API client attaches a Keycloak
 * header, and an egress browser cannot complete that redirect.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

class BroadcastRefused extends Error {}

async function exchangeRecorderToken(rt: string): Promise<BroadcastJoinResponse> {
  const response = await fetch(`${API_BASE}/api/v1/broadcast/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: rt }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new BroadcastRefused();
  }
  if (!response.ok) {
    throw new Error(`broadcast join failed (${response.status})`);
  }
  return (await response.json()) as BroadcastJoinResponse;
}

interface Session {
  room: Room;
  gen: number;
}

function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const measure = () => {
      const next = Math.min(
        window.innerWidth / COMPOSITE_WIDTH,
        window.innerHeight / COMPOSITE_HEIGHT,
      );
      setScale(Number.isFinite(next) && next > 0 ? next : 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return scale;
}

function remoteParticipants(room: Room): CompositeParticipant<RemoteTrack>[] {
  const people: CompositeParticipant<RemoteTrack>[] = [];
  room.remoteParticipants.forEach((participant) => {
    const publications: CompositePublication<RemoteTrack>[] = [];
    participant.trackPublications.forEach((pub) => {
      publications.push({
        kind: pub.kind,
        source: pub.source,
        isMuted: pub.isMuted,
        sid: pub.trackSid,
        track: pub.track ?? null,
      });
    });
    people.push({
      identity: participant.identity,
      name: participant.name,
      joinedAtMs: participant.joinedAt ? participant.joinedAt.getTime() : null,
      publications,
    });
  });
  return people;
}

function subscribeAll(room: Room) {
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      if (!pub.isSubscribed) pub.setSubscribed(true);
      if (pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
        pub.setVideoQuality(VideoQuality.HIGH);
      }
    });
  });
}

function AttachedVideo({
  track,
  box,
}: {
  track: RemoteTrack;
  box: { left: number; top: number; width: number; height: number };
}) {
  const ref = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el) return;
      track.attach(el);
      return () => {
        track.detach(el);
      };
    },
    [track],
  );
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      data-testid="composite-video"
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        objectFit: "contain",
        background: "transparent",
        cursor: "none",
      }}
    />
  );
}

function AttachedAudio({ track }: { track: RemoteTrack }) {
  const ref = useCallback(
    (el: HTMLAudioElement | null) => {
      if (!el) return;
      el.autoplay = true;
      el.muted = false;
      track.attach(el);
      try {
        const pending = el.play();
        void pending?.catch(() => {});
      } catch {
        // Egress Chrome allows autoplay. A normal tab may reject until a
        // gesture; the room's startAudio() covers that path.
      }
      return () => {
        track.detach(el);
      };
    },
    [track],
  );
  return <audio ref={ref} autoPlay data-testid="composite-audio" />;
}

export function CompositePage() {
  const plan = useMemo(
    () => planCompositeConnect(parseCompositeQuery(window.location.search)),
    [],
  );
  const gate = useMemo(() => new CompositeRecordingGate(), []);
  const layout = compositeLayoutKind(plan.layout);

  const [live, setLive] = useState(false);
  const [tiles, setTiles] = useState<CompositeTileModel<RemoteTrack>[]>([]);
  const [audios, setAudios] = useState<{ key: string; track: RemoteTrack }[]>([]);
  const scale = useStageScale();
  const roomRef = useRef<Room | null>(null);
  const videoCountRef = useRef(0);
  videoCountRef.current = tiles.reduce(
    (count, tile) => count + (tile.cameraTrack ? 1 : 0),
    0,
  );

  useLayoutEffect(() => {
    const targets = [document.documentElement, document.body];
    for (const el of targets) {
      el.classList.add("stable-broadcast", "stable-composite");
    }
    const previousTitle = document.title;
    document.title = "Stable composite";
    return () => {
      for (const el of targets) {
        el.classList.remove("stable-broadcast", "stable-composite");
      }
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    const handle = requestAnimationFrame(() => {
      gate.noteLayoutPainted(videoCountRef.current);
    });
    return () => cancelAnimationFrame(handle);
  }, [live, gate]);

  useEffect(() => {
    if (plan.source === "none") return;

    let disposed = false;
    let generation = 0;
    let current: Session | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const onPageHide = () => {
      gate.noteSessionEnded();
    };
    window.addEventListener("pagehide", onPageHide);

    function clearTimers() {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
      refreshTimer = undefined;
      retryTimer = undefined;
    }

    function publish(room: Room) {
      if (disposed) return;
      const people = remoteParticipants(room);
      setTiles(compositeTiles(people));
      setAudios(compositeAudioTracks(people));
    }

    function endLiveSession(session: Session) {
      if (disposed || session.gen !== generation || current !== session) return;
      gate.noteSessionEnded();
      setLive(false);
      setTiles([]);
      setAudios([]);
      roomRef.current = null;
    }

    async function openSession(
      livekitUrl: string,
      token: string,
      gen: number,
    ): Promise<Session> {
      const room = new Room({
        // Headless Chrome is not "the foreground window". Without this the
        // adaptive stream pauses every camera and the file is a still.
        adaptiveStream: { pauseVideoInBackground: false },
        dynacast: true,
      });
      const session: Session = { room, gen };
      const resubscribe = () => {
        if (disposed || session.gen !== generation || current !== session) return;
        subscribeAll(room);
        publish(room);
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
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          void room.startAudio().catch(() => {});
        })
        .on(RoomEvent.Disconnected, () => {
          endLiveSession(session);
        });
      await room.connect(livekitUrl, token, { autoSubscribe: true });
      await room.startAudio().catch(() => {});
      return session;
    }

    function scheduleRetry() {
      attempt += 1;
      retryTimer = setTimeout(() => void cycle(), backoffDelayMs(attempt));
    }

    async function cycle() {
      if (disposed) return;
      // Supersede first, so the eviction this cycle causes (same recorder
      // identity, new JWT) is not treated as the recording ending.
      const gen = ++generation;
      clearTimers();

      let livekitUrl = "";
      let token = "";
      let expiresAt: string | null = null;
      if (plan.source === "url-token") {
        livekitUrl = plan.url;
        token = plan.token;
      } else if (plan.source === "rt") {
        try {
          const join = await exchangeRecorderToken(plan.rt);
          if (disposed || gen !== generation) return;
          const creds = credentialsFromExchange(join);
          if (!creds) {
            // A participant token on this URL is not a recording. Stay dark.
            // END only if a file had already started (a refresh that came
            // back revoked) — logging END before START aborts the egress
            // before it ever had a frame.
            if (gate.hasStarted) gate.noteSessionEnded();
            setLive(false);
            return;
          }
          livekitUrl = creds.livekitUrl;
          token = creds.token;
          expiresAt = creds.expiresAt;
        } catch (error) {
          if (disposed || gen !== generation) return;
          if (error instanceof BroadcastRefused) {
            if (gate.hasStarted) gate.noteSessionEnded();
            setLive(false);
            return;
          }
          scheduleRetry();
          return;
        }
      } else {
        return;
      }
      if (disposed || gen !== generation) return;

      let session: Session;
      try {
        session = await openSession(livekitUrl, token, gen);
      } catch {
        if (disposed || gen !== generation) return;
        scheduleRetry();
        return;
      }
      if (disposed || gen !== generation) {
        void session.room.disconnect();
        return;
      }

      const previous = current;
      current = session;
      roomRef.current = session.room;
      attempt = 0;
      subscribeAll(session.room);
      publish(session.room);
      setLive(true);
      if (previous && previous !== session) void previous.room.disconnect();

      // Only the exchanged token has an expiry we can trust. The worker's
      // own JWT (url+token fallback) is left to the egress process lifetime.
      if (expiresAt) {
        refreshTimer = setTimeout(() => void cycle(), refreshDelayMs(expiresAt));
      }
    }

    void cycle();

    return () => {
      disposed = true;
      window.removeEventListener("pagehide", onPageHide);
      clearTimers();
      const dead = current;
      current = null;
      roomRef.current = null;
      if (dead) void dead.room.disconnect();
    };
  }, [plan, gate]);

  useEffect(() => {
    if (audios.length === 0) return;
    const start = () => {
      void roomRef.current?.startAudio().catch(() => {});
    };
    start();
    window.addEventListener("pointerdown", start, { once: true });
    return () => window.removeEventListener("pointerdown", start);
  }, [audios.length]);

  const layouts = compositeGrid(tiles.length);

  return (
    <div
      data-testid="composite-root"
      data-layout={layout}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: COMPOSITE_BACKGROUND,
        cursor: "none",
        zIndex: 1,
      }}
    >
      <div
        data-testid="composite-stage"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: COMPOSITE_WIDTH,
          height: COMPOSITE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
          overflow: "hidden",
          backgroundColor: COMPOSITE_BACKGROUND,
          backgroundImage:
            "radial-gradient(1000px 640px at 50% 42%, #16122c 0%, #08080f 72%)",
          fontFamily:
            '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
          cursor: "none",
        }}
      >
        {tiles.map((tile, index) => {
          const box = layouts[index];
          if (!box) return null;
          const hue = tileHue(tile.identity);
          const diameter = Math.max(
            36,
            Math.floor(Math.min(box.video.width, box.video.height) * 0.42),
          );
          return (
            <div
              key={tile.identity}
              data-testid="composite-tile"
              style={{
                position: "absolute",
                left: box.tile.x,
                top: box.tile.y,
                width: box.tile.width,
                height: box.tile.height,
                overflow: "hidden",
                borderRadius: 10,
                background: "#14141f",
                boxShadow: `inset 0 0 0 1px rgba(154, 158, 202, 0.28), inset 0 3px 0 ${hue}`,
                cursor: "none",
              }}
            >
              {tile.cameraTrack ? (
                <AttachedVideo
                  track={tile.cameraTrack}
                  box={{
                    left: box.video.x - box.tile.x,
                    top: box.video.y - box.tile.y,
                    width: box.video.width,
                    height: box.video.height,
                  }}
                />
              ) : (
                <div
                  data-testid="composite-initials"
                  style={{
                    position: "absolute",
                    left: box.video.x - box.tile.x,
                    top: box.video.y - box.tile.y,
                    width: box.video.width,
                    height: box.video.height,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: diameter,
                      height: diameter,
                      borderRadius: "50%",
                      background: `linear-gradient(160deg, ${hue}, #14141f 140%)`,
                      color: "#f8f8fd",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 650,
                      fontSize: Math.max(14, Math.floor(diameter * 0.34)),
                      letterSpacing: "0.02em",
                    }}
                  >
                    {tile.initials}
                  </div>
                </div>
              )}
              <div
                data-testid="composite-plate"
                style={{
                  position: "absolute",
                  left: box.plate.x - box.tile.x,
                  top: box.plate.y - box.tile.y,
                  width: box.plate.width,
                  height: box.plate.height,
                  boxSizing: "border-box",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 8px",
                  borderRadius: 6,
                  background: "rgba(8, 8, 15, 0.82)",
                  color: "#f8f8fd",
                  fontSize: Math.max(13, Math.min(18, Math.floor(box.plate.height * 0.5))),
                  lineHeight: 1.1,
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {tile.label}
              </div>
            </div>
          );
        })}
        {audios.map((audio) => (
          <AttachedAudio key={audio.key} track={audio.track} />
        ))}
      </div>
    </div>
  );
}

export default CompositePage;
