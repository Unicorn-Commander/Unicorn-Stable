import { describe, expect, it } from "vitest";
import {
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  END_RECORDING,
  START_RECORDING,
  CompositeRecordingGate,
  columnsForCount,
  compositeAudioTracks,
  compositeGrid,
  compositeLayoutKind,
  compositeTiles,
  containRect,
  credentialsFromExchange,
  isCompositeBroadcastPath,
  parseCompositeQuery,
  planCompositeConnect,
  shouldEmitStart,
  tileInitials,
  type Rect,
} from "./composite";

const CANVAS: Rect = { x: 0, y: 0, width: COMPOSITE_WIDTH, height: COMPOSITE_HEIGHT };

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function inside(inner: Rect, outer: Rect): boolean {
  const slop = 1e-6;
  return (
    inner.width > 0 &&
    inner.height > 0 &&
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.width <= outer.x + outer.width + slop &&
    inner.y + inner.height <= outer.y + outer.height + slop
  );
}

describe("compositeGrid", () => {
  it("is sized for the 720p composite canvas", () => {
    expect(COMPOSITE_WIDTH).toBe(1280);
    expect(COMPOSITE_HEIGHT).toBe(720);
  });

  it("fits 1..17 tiles with no crop and the name plate inside the tile", () => {
    expect(columnsForCount(17)).toBe(5);

    for (let count = 1; count <= 17; count++) {
      const tiles = compositeGrid(count);
      expect(tiles, `count ${count}`).toHaveLength(count);

      for (let i = 0; i < tiles.length; i++) {
        const layout = tiles[i];
        if (!layout) throw new Error(`missing tile ${i} of ${count}`);

        expect(inside(layout.tile, CANVAS), `tile ${i} of ${count} on canvas`).toBe(
          true,
        );
        expect(inside(layout.plate, layout.tile), `plate ${i} of ${count}`).toBe(
          true,
        );
        expect(inside(layout.video, layout.tile), `video ${i} of ${count}`).toBe(
          true,
        );
        expect(overlaps(layout.video, layout.plate), `plate covers video ${i}`).toBe(
          false,
        );
        // A plate that is only a hairline would clip the name. 24px clears
        // a 16px line with room for the inset.
        expect(layout.plate.height).toBeGreaterThanOrEqual(24);
        expect(layout.plate.width).toBeGreaterThanOrEqual(48);

        for (const [frameW, frameH] of [
          [1920, 1080],
          [1080, 1920],
          [640, 480],
        ] as const) {
          const frame = containRect(frameW, frameH, layout.video);
          expect(inside(frame, layout.tile), `frame ${frameW}x${frameH}`).toBe(
            true,
          );
          expect(overlaps(frame, layout.plate)).toBe(false);
          expect(frame.width).toBeLessThanOrEqual(layout.video.width + 1e-6);
          expect(frame.height).toBeLessThanOrEqual(layout.video.height + 1e-6);
          // Aspect preserved ⇒ object-fit contain, not cover (cover would crop).
          expect(frame.width / frame.height).toBeCloseTo(frameW / frameH, 4);
        }
      }

      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const a = tiles[i]?.tile;
          const b = tiles[j]?.tile;
          if (!a || !b) continue;
          expect(overlaps(a, b), `tiles ${i} and ${j} of ${count} overlap`).toBe(
            false,
          );
        }
      }
    }
  });
});

describe("composite participants", () => {
  it("gives a camera-less participant an initials tile and still returns their audio", () => {
    const mic = { id: "mic" };
    const tiles = compositeTiles([
      {
        identity: "agent-persephone",
        name: "Persephone",
        joinedAtMs: 2,
        publications: [
          { kind: "audio", source: "microphone", sid: "a1", track: mic },
        ],
      },
    ]);
    expect(tiles).toEqual([
      {
        identity: "agent-persephone",
        label: "Persephone",
        initials: "PE",
        cameraTrack: null,
      },
    ]);
    expect(tileInitials("Ada Lovelace")).toBe("AL");
    expect(compositeAudioTracks([
      {
        identity: "agent-persephone",
        name: "Persephone",
        publications: [
          { kind: "audio", source: "microphone", sid: "a1", track: mic },
          {
            kind: "audio",
            source: "screen_share_audio",
            sid: "a2",
            track: { id: "share" },
          },
          { kind: "audio", source: "microphone", sid: "a3", isMuted: true, track: { id: "muted" } },
        ],
      },
    ]).map((sink) => sink.key)).toEqual(["a1", "a2"]);
  });

  it("orders tiles by join time and keeps a live camera", () => {
    const camera = { id: "cam" };
    const tiles = compositeTiles([
      {
        identity: "b",
        name: "",
        joinedAtMs: 20,
        publications: [
          { kind: "video", source: "camera", track: camera },
        ],
      },
      {
        identity: "a",
        name: "Ada",
        joinedAtMs: 10,
        publications: [
          { kind: "video", source: "camera", isMuted: true, track: { id: "off" } },
        ],
      },
    ]);
    expect(tiles.map((tile) => tile.identity)).toEqual(["a", "b"]);
    expect(tiles[0]?.cameraTrack).toBeNull();
    expect(tiles[1]?.cameraTrack).toBe(camera);
    expect(tiles[1]?.label).toBe("b");
  });
});

describe("composite connect plan", () => {
  it("prefers rt when LiveKit also appended url, token, and layout", () => {
    const query = parseCompositeQuery(
      "?rt=recorder-secret&url=wss%3A%2F%2Flk.example%2Fws&token=lk-jwt&layout=grid",
    );
    expect(query.url).toBe("wss://lk.example/ws");
    expect(planCompositeConnect(query)).toEqual({
      source: "rt",
      rt: "recorder-secret",
      layout: "grid",
    });
  });

  it("falls back to url and token when rt is missing, and accepts the layout hint", () => {
    const query = parseCompositeQuery(
      "?url=wss%3A%2F%2Flk.example%2Fws&token=lk-jwt&layout=speaker",
    );
    expect(planCompositeConnect(query)).toEqual({
      source: "url-token",
      url: "wss://lk.example/ws",
      token: "lk-jwt",
      layout: "speaker",
    });
    expect(planCompositeConnect(parseCompositeQuery("?token=only-half"))).toEqual({
      source: "none",
      layout: "grid",
    });
    expect(planCompositeConnect(parseCompositeQuery("?url=wss://lk.example/ws"))).toEqual({
      source: "none",
      layout: "grid",
    });
    for (const layout of ["grid", "speaker", "single-speaker", "GRID", "", "nope"]) {
      expect(compositeLayoutKind(layout)).toBe("grid");
    }
  });

  it("requires mode composite on an exchanged token", () => {
    expect(
      credentialsFromExchange({
        mode: "composite",
        livekit_url: "wss://lk.example/ws",
        token: "lk-jwt",
        expires_at: "2026-09-24T18:00:00Z",
      }),
    ).toEqual({
      livekitUrl: "wss://lk.example/ws",
      token: "lk-jwt",
      expiresAt: "2026-09-24T18:00:00Z",
    });
    expect(
      credentialsFromExchange({
        mode: "participant",
        livekit_url: "wss://lk.example/ws",
        token: "lk-jwt",
      }),
    ).toBeNull();
    expect(
      credentialsFromExchange({
        livekit_url: "wss://lk.example/ws",
        token: "lk-jwt",
      }),
    ).toBeNull();
  });

  it("claims only the composite path inside /broadcast", () => {
    expect(isCompositeBroadcastPath("/broadcast/room-1/composite")).toBe(true);
    expect(
      isCompositeBroadcastPath("/broadcast/4d93103e-aaaa-bbbb-cccc-ddddeeeeffff/composite"),
    ).toBe(true);
    expect(isCompositeBroadcastPath("/broadcast/room-1/composite/")).toBe(true);
    expect(isCompositeBroadcastPath("/broadcast/room-1/ada")).toBe(false);
    expect(isCompositeBroadcastPath("/broadcast/composite")).toBe(false);
    expect(isCompositeBroadcastPath("/broadcast/room-1/composite/extra")).toBe(false);
    expect(isCompositeBroadcastPath("/")).toBe(false);
  });
});

describe("recording signals", () => {
  it("logs START and END exactly once", () => {
    const lines: string[] = [];
    const gate = new CompositeRecordingGate((line) => lines.push(line));
    gate.noteLayoutPainted(3);
    gate.noteLayoutPainted(3);
    gate.noteSessionEnded();
    gate.noteSessionEnded();
    expect(lines).toEqual([START_RECORDING, END_RECORDING]);
  });

  it("starts an audio-only layout and does not start again after END", () => {
    expect(
      shouldEmitStart({
        connected: true,
        layoutPainted: true,
        videoTrackCount: 0,
        alreadyStarted: false,
      }),
    ).toBe(true);
    expect(
      shouldEmitStart({
        connected: false,
        layoutPainted: true,
        videoTrackCount: 0,
        alreadyStarted: false,
      }),
    ).toBe(false);

    const lines: string[] = [];
    const gate = new CompositeRecordingGate((line) => lines.push(line));
    gate.noteLayoutPainted(0);
    gate.noteSessionEnded();
    gate.noteLayoutPainted(0);
    expect(lines).toEqual([START_RECORDING, END_RECORDING]);
  });

  it("logs END once even when the room ended before the first paint", () => {
    const lines: string[] = [];
    const gate = new CompositeRecordingGate((line) => lines.push(line));
    gate.noteSessionEnded();
    gate.noteSessionEnded();
    gate.noteLayoutPainted(0);
    expect(lines).toEqual([END_RECORDING]);
  });
});
