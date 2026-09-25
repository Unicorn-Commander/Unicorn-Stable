/**
 * Composite recording page — the pure half of /broadcast/:room/composite.
 *
 * LiveKit's egress worker loads that URL in headless Chrome and records
 * whatever the page paints and plays. Two things here are load-bearing and
 * must stay free of React and livekit-client so they can be tested without
 * either:
 *
 *  - The grid math. Name plates on the stock LiveKit template are cropped at
 *    the tile edge. Every plate rect this module returns sits fully inside
 *    its tile, and the video rect above it is what `object-fit: contain`
 *    letterboxes into — the frame is scaled, never cropped.
 *  - The start/end signals. The worker waits for console.log("START_RECORDING")
 *    and stops on console.log("END_RECORDING"). START is a paint signal, not
 *    a "a camera showed up" signal: an audio-only call still has to record.
 */

export const COMPOSITE_WIDTH = 1280;
export const COMPOSITE_HEIGHT = 720;

/** Gap between tiles, and the margin between the grid and the canvas edge. */
export const COMPOSITE_GAP = 10;
export const COMPOSITE_PAD = 16;

/** Name plate. Reserved at the bottom of every tile, inset from the tile edge. */
export const PLATE_HEIGHT = 32;
export const PLATE_INSET_X = 10;
export const PLATE_BOTTOM = 8;

/** Gap between the contained video box and the tile edge / the plate. */
export const VIDEO_INSET = 8;
export const VIDEO_PLATE_GAP = 6;

/** Dark brand field (slate-950). The page paints this, not a banner. */
export const COMPOSITE_BACKGROUND = "#08080f";

/** Same dark-theme anchors as the identity wheel. Always the dark set — a
 * recording must not flip because the egress profile has a light theme. */
const TILE_HUES = [
  "#8b5cf6",
  "#22d3ee",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#38bdf8",
  "#e879f9",
  "#a3e635",
  "#818cf8",
  "#fb923c",
  "#2dd4bf",
  "#f472b6",
] as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositeTileLayout {
  tile: Rect;
  /** Box the camera is contained in. Never overlaps the plate. */
  video: Rect;
  /** Name plate. Fully inside the tile. */
  plate: Rect;
}

export type CompositeSpeakerLayout = CompositeTileLayout;

export interface CompositeCanvas {
  width: number;
  height: number;
}

const CANVAS: CompositeCanvas = {
  width: COMPOSITE_WIDTH,
  height: COMPOSITE_HEIGHT,
};

/**
 * Columns for a gallery that stays readable at 720p.
 * 17 is the contract ceiling: 5×4, last row centered, tiles still tall
 * enough for a plate and a contained 16:9 frame.
 */
export function columnsForCount(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return 5;
}

export function compositeGrid(
  count: number,
  canvas: CompositeCanvas = CANVAS,
): CompositeTileLayout[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];

  const cols = columnsForCount(n);
  const rows = Math.ceil(n / cols);
  const gap = COMPOSITE_GAP;
  const pad = COMPOSITE_PAD;
  const tileW = Math.floor(
    (canvas.width - pad * 2 - gap * (cols - 1)) / cols,
  );
  const tileH = Math.floor(
    (canvas.height - pad * 2 - gap * (rows - 1)) / rows,
  );
  if (tileW <= 0 || tileH <= 0) return [];

  const gridW = cols * tileW + (cols - 1) * gap;
  const gridH = rows * tileH + (rows - 1) * gap;
  const originX = Math.floor((canvas.width - gridW) / 2);
  const originY = Math.floor((canvas.height - gridH) / 2);

  const tiles: CompositeTileLayout[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const rowCount = row === rows - 1 ? n - row * cols : cols;
    const rowW = rowCount * tileW + (rowCount - 1) * gap;
    const rowX = originX + Math.floor((gridW - rowW) / 2);
    const tile: Rect = {
      x: rowX + col * (tileW + gap),
      y: originY + row * (tileH + gap),
      width: tileW,
      height: tileH,
    };
    tiles.push({ tile, ...tileInsets(tile) });
  }
  return tiles;
}

function tileInsets(tile: Rect): { video: Rect; plate: Rect } {
  const plateH = Math.min(
    PLATE_HEIGHT,
    Math.max(1, tile.height - VIDEO_INSET - VIDEO_PLATE_GAP - 1 - PLATE_BOTTOM),
  );
  const plate: Rect = {
    x: tile.x + Math.min(PLATE_INSET_X, Math.floor(tile.width / 4)),
    y: tile.y + tile.height - PLATE_BOTTOM - plateH,
    width: Math.max(
      1,
      tile.width - Math.min(PLATE_INSET_X, Math.floor(tile.width / 4)) * 2,
    ),
    height: plateH,
  };
  // If the reserved plate would cross the top inset, pin it under the inset
  // and let the video box shrink to whatever is left. 1..17 at 720p never
  // hits this; it keeps a hostile canvas from producing a negative box.
  if (plate.y < tile.y) plate.y = tile.y;
  if (plate.y + plate.height > tile.y + tile.height) {
    plate.height = tile.y + tile.height - plate.y;
  }

  const videoTop = tile.y + VIDEO_INSET;
  const videoBottom = Math.min(
    plate.y - VIDEO_PLATE_GAP,
    tile.y + tile.height - VIDEO_INSET,
  );
  const video: Rect = {
    x: tile.x + VIDEO_INSET,
    y: videoTop,
    width: Math.max(1, tile.width - VIDEO_INSET * 2),
    height: Math.max(1, videoBottom - videoTop),
  };
  return { video, plate };
}

/**
 * `object-fit: contain` for a frame of `contentWidth`×`contentHeight` inside
 * `box`. The result keeps the source aspect ratio and never exceeds the box,
 * which is the "no crop" half of the grid contract. CSS does this on the
 * video element; the tests use this function to prove the box allows it.
 */
export function containRect(
  contentWidth: number,
  contentHeight: number,
  box: Rect,
): Rect {
  if (
    contentWidth <= 0 ||
    contentHeight <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return { x: box.x, y: box.y, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / contentWidth, box.height / contentHeight);
  const width = Math.min(box.width, contentWidth * scale);
  const height = Math.min(box.height, contentHeight * scale);
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function tileHue(identity: string): string {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) >>> 0;
  }
  return TILE_HUES[hash % TILE_HUES.length] ?? "#8b5cf6";
}

export function tileLabel(
  name: string | null | undefined,
  identity: string,
): string {
  const trimmed = (name ?? "").trim();
  return trimmed || identity;
}

export function tileInitials(label: string): string {
  const parts = label
    .trim()
    .split(/[\s_\-.]+/)
    .filter((part) => part.length > 0);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) {
    const chars = first.replace(/[^A-Za-z0-9]/g, "");
    return (chars.slice(0, 2) || "?").toUpperCase();
  }
  const last = parts[parts.length - 1] ?? first;
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Who is on the canvas
 * ------------------------------------------------------------------ */

export interface CompositePublication<T> {
  kind: string;
  source: string;
  isMuted?: boolean;
  sid?: string;
  track?: T | null;
}

export interface CompositeParticipant<T> {
  identity: string;
  name?: string | null;
  joinedAtMs?: number | null;
  publications: readonly CompositePublication<T>[];
}

export interface CompositeTileModel<T> {
  identity: string;
  label: string;
  initials: string;
  /** Live camera track, or null when the tile should be initials. */
  cameraTrack: T | null;
}

export interface CompositeScreenShare<T> {
  key: string;
  identity: string;
  label: string;
  track: T;
}

export interface CompositeAudioSink<T> {
  key: string;
  track: T;
}

/**
 * One tile per remote participant, cameras only. Someone with no live camera
 * still gets a tile (initials) — an empty black cell would be baked into the
 * file. Order is join time, then identity, so a new arrival appends instead
 * of shuffling the people already on screen.
 */
export function compositeTiles<T>(
  participants: readonly CompositeParticipant<T>[],
): CompositeTileModel<T>[] {
  const sorted = [...participants].sort((a, b) => {
    const aj = a.joinedAtMs ?? 0;
    const bj = b.joinedAtMs ?? 0;
    if (aj !== bj) return aj - bj;
    return a.identity.localeCompare(b.identity);
  });
  return sorted.map((participant) => {
    const label = tileLabel(participant.name, participant.identity);
    const camera = participant.publications.find(
      (pub) =>
        pub.kind === "video" &&
        pub.source === "camera" &&
        !pub.isMuted &&
        pub.track != null,
    );
    return {
      identity: participant.identity,
      label,
      initials: tileInitials(label),
      cameraTrack: camera?.track ?? null,
    };
  });
}

/** Every live screen share or unknown-source video, in publication order. */
export function compositeScreenShares<T>(
  participants: readonly CompositeParticipant<T>[],
): CompositeScreenShare<T>[] {
  const shares: CompositeScreenShare<T>[] = [];
  for (const participant of participants) {
    const label = tileLabel(participant.name, participant.identity);
    for (const pub of participant.publications) {
      if (
        pub.kind !== "video" ||
        (pub.source !== "screen_share" && pub.source !== "unknown") ||
        pub.isMuted ||
        pub.track == null
      ) {
        continue;
      }
      shares.push({
        key: pub.sid || `${participant.identity}:${pub.source}`,
        identity: participant.identity,
        label,
        track: pub.track,
      });
    }
  }
  return shares;
}

/**
 * Speaker layout: a single share gets half the canvas and cameras use a
 * readable 16:9 strip. Six rows per column is the maximum that fits at 720p;
 * above three columns the ordinary grid is safer, with the share spanning a
 * 2x2 block at the front.
 */
export function compositeSpeakerLayout(
  cameraCount: number,
  shareCount: number,
  canvas: CompositeCanvas = CANVAS,
): CompositeSpeakerLayout[] {
  const cameras = Math.max(0, Math.floor(cameraCount));
  const shares = Math.max(0, Math.floor(shareCount));
  if (shares === 0) return compositeGrid(cameras, canvas);
  if (shares === 1 && cameras <= 18) {
    const shareWidth = Math.floor(canvas.width / 2);
    const main: Rect = { x: 0, y: 0, width: shareWidth, height: canvas.height };
    const stripWidth = canvas.width - shareWidth;
    const columns = Math.min(3, Math.max(1, Math.ceil(cameras / 6)));
    const rows = Math.min(cameras, 6);
    const cameraWidth = stripWidth / columns;
    const cameraHeight = canvas.height / rows;
    const layouts: CompositeSpeakerLayout[] = [{ tile: main, ...tileInsets(main) }];
    for (let i = 0; i < cameras; i++) {
      const row = i % rows;
      const column = Math.floor(i / rows);
      const tile: Rect = {
        x: shareWidth + column * cameraWidth,
        y: row * cameraHeight,
        width: cameraWidth,
        height: cameraHeight,
      };
      layouts.push({ tile, ...speakerTileInsets(tile) });
    }
    return layouts;
  }

  // More than 18 cameras cannot retain a useful strip. Keep the share as a
  // prominent 2x2 grid tile and let the normal gallery handle the rest.
  const cameraLayouts = compositeGrid(cameras, canvas);
  const shareTile = cameraLayouts[0]?.tile ?? {
    x: 0,
    y: 0,
    width: Math.floor(canvas.width / 2),
    height: Math.floor(canvas.height / 2),
  };
  const span: Rect = {
    x: shareTile.x,
    y: shareTile.y,
    width: shareTile.width * 2 + COMPOSITE_GAP,
    height: shareTile.height * 2 + COMPOSITE_GAP,
  };
  const shareLayout = { tile: span, ...tileInsets(span) };
  return [shareLayout, ...cameraLayouts.slice(0, Math.max(0, cameras))];
}

function speakerTileInsets(tile: Rect): { video: Rect; plate: Rect } {
  const videoWidth = Math.max(1, tile.width - VIDEO_INSET * 2);
  const videoHeight = Math.max(1, Math.min(tile.height - VIDEO_INSET * 2, videoWidth * 9 / 16));
  const video: Rect = {
    x: tile.x + VIDEO_INSET,
    y: tile.y + Math.max(VIDEO_INSET, (tile.height - videoHeight) / 2),
    width: videoWidth,
    height: videoHeight,
  };
  const plateHeight = Math.min(PLATE_HEIGHT, Math.max(24, tile.height - 2));
  const plate: Rect = {
    x: tile.x + PLATE_INSET_X,
    y: tile.y + tile.height - PLATE_BOTTOM - plateHeight,
    width: Math.max(1, tile.width - PLATE_INSET_X * 2),
    height: plateHeight,
  };
  return { video, plate };
}

/** Every live audio publication. Screen-share audio counts; a muted mic does not. */
export function compositeAudioTracks<T>(
  participants: readonly CompositeParticipant<T>[],
): CompositeAudioSink<T>[] {
  const sinks: CompositeAudioSink<T>[] = [];
  for (const participant of participants) {
    for (const pub of participant.publications) {
      if (pub.kind !== "audio" || pub.isMuted || pub.track == null) continue;
      sinks.push({
        key: pub.sid || `${participant.identity}:${pub.source}`,
        track: pub.track,
      });
    }
  }
  return sinks;
}

/* ------------------------------------------------------------------ *
 * How the page connects
 * ------------------------------------------------------------------ */

export interface CompositeQuery {
  /** Recorder token. The worker appends its own `token` and would clobber this name. */
  rt: string;
  /** LiveKit websocket URL, appended by the egress worker. */
  url: string;
  /** LiveKit JWT, appended by the egress worker. Not our recorder token. */
  token: string;
  /** Worker hint: grid | speaker | single-speaker. Empty when absent. */
  layout: string;
}

export function parseCompositeQuery(search: string): CompositeQuery {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  return {
    rt: (params.get("rt") ?? "").trim(),
    url: (params.get("url") ?? "").trim(),
    token: (params.get("token") ?? "").trim(),
    layout: (params.get("layout") ?? "").trim().toLowerCase(),
  };
}

export type CompositeConnectPlan =
  | { source: "rt"; rt: string; layout: string }
  | { source: "url-token"; url: string; token: string; layout: string }
  | { source: "none"; layout: string };

/**
 * Prefer the recorder-token exchange. Fall back to the worker's url+token
 * only when `rt` is absent — those params are appended, not a substitute,
 * whenever the backend built the template URL.
 */
export function planCompositeConnect(query: CompositeQuery): CompositeConnectPlan {
  const layout = query.layout || "grid";
  if (query.rt) return { source: "rt", rt: query.rt, layout };
  if (query.url && query.token) {
    return { source: "url-token", url: query.url, token: query.token, layout };
  }
  return { source: "none", layout };
}

/**
 * The worker's layout query must not throw. This page always paints the grid;
 * speaker and single-speaker are accepted and ignored.
 */
export function compositeLayoutKind(
  _layout: string | null | undefined,
): "grid" {
  return "grid";
}

export interface CompositeCredentials {
  livekitUrl: string;
  token: string;
  expiresAt: string | null;
}

/**
 * The join response may be used only when it says this token is a recorder.
 * A participant broadcast token landing on this URL must not be rendered.
 */
export function credentialsFromExchange(join: {
  mode?: string | null;
  livekit_url?: string | null;
  token?: string | null;
  expires_at?: string | null;
}): CompositeCredentials | null {
  if (join.mode !== "composite") return null;
  const livekitUrl = (join.livekit_url ?? "").trim();
  const token = (join.token ?? "").trim();
  if (!livekitUrl || !token) return null;
  return {
    livekitUrl,
    token,
    expiresAt: join.expires_at ?? null,
  };
}

/** /broadcast/:room/composite — and not the one-tile OBS feed under the same subtree. */
export function isCompositeBroadcastPath(pathname: string): boolean {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  const room = parts[1];
  return (
    parts.length === 3 &&
    parts[0] === "broadcast" &&
    parts[2] === "composite" &&
    typeof room === "string" &&
    room.length > 0
  );
}

/* ------------------------------------------------------------------ *
 * LiveKit custom-template protocol
 * ------------------------------------------------------------------ */

export const START_RECORDING = "START_RECORDING";
export const END_RECORDING = "END_RECORDING";

/**
 * START fires after the bounded media-readiness wait and a painted layout.
 * `videoTrackCount` is retained for callers that want to assert that zero is
 * not a reason to wait.
 */
export function shouldEmitStart(input: {
  connected: boolean;
  layoutPainted: boolean;
  videoTrackCount: number;
  alreadyStarted: boolean;
}): boolean {
  return (
    input.connected &&
    input.layoutPainted &&
    !input.alreadyStarted &&
    input.videoTrackCount >= 0
  );
}

function emitRecordingSignal(line: string): void {
  console.log(line);
}

/**
 * Exactly-once START and END for one page lifetime. A re-mint that evicts
 * the previous LiveKit session must not call `noteSessionEnded` — that is
 * the caller's job to filter. Calling either method twice is a no-op.
 */
export class CompositeRecordingGate {
  private started = false;
  private ended = false;

  constructor(
    private readonly emit: (line: string) => void = emitRecordingSignal,
  ) {}

  get hasStarted(): boolean {
    return this.started;
  }

  get hasEnded(): boolean {
    return this.ended;
  }

  noteLayoutPainted(videoTrackCount = 0): void {
    if (
      !shouldEmitStart({
        connected: true,
        layoutPainted: true,
        videoTrackCount,
        alreadyStarted: this.started || this.ended,
      })
    ) {
      return;
    }
    this.started = true;
    this.emit(START_RECORDING);
  }

  noteSessionEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.started) this.emit(END_RECORDING);
  }
}
