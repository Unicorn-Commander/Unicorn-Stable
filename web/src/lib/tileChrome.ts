/**
 * Call-tile name plates and the active-speaker lower third.
 *
 * Two different plates, on purpose:
 *   - The glass name on a tile is drawn by this client. A per-user setting
 *     shows it always, only while the pointer is over the tile, or never.
 *   - An agent's own video can also burn a name into the picture. That plate
 *     is the room's `voice_relay_face_plate` and is rendered by the voice
 *     relay, not by this module. Nothing here reads or writes that key.
 *
 * The lower third is a separate, opt-in strip for whoever is holding the
 * floor. It is not a name plate and it does not follow the tile setting.
 */
export type TileNameMode = "always" | "hover" | "off";

export type LowerThirdLayout = "stage" | "compact" | "filmstrip";

export type CallChromeView =
  | "compact"
  | "focus"
  | "grid"
  | "sidebar"
  | "spotlight"
  | "screen";

/** How long one speaker keeps the lower third before it steps aside. */
export const LOWER_THIRD_HOLD_MS = 4_000;

const ON_WORDS = new Set(["1", "true", "yes", "on"]);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The signed-in user's display name, in the order the tile should trust:
 * the account name, then the name LiveKit was minted with (the same display
 * name the token request sends), then the username.
 *
 * Empty string when none of those exist. The plate turns that into "You".
 */
export function resolveLocalDisplayName(input: {
  displayName?: string | null;
  liveKitName?: string | null;
  username?: string | null;
}): string {
  return (
    clean(input.displayName) ||
    clean(input.liveKitName) ||
    clean(input.username) ||
    ""
  );
}

/**
 * What the local tile prints. The display name comes first. "(you)" only
 * disambiguates it. With no name at all the participant list stores the
 * single word You, and the plate leaves that word alone.
 */
export function localTilePlate(name: string): string {
  const trimmed = clean(name);
  if (!trimmed || trimmed === "You") return "You";
  return `${trimmed} (you)`;
}

export function isTileNameMode(value: unknown): value is TileNameMode {
  return value === "always" || value === "hover" || value === "off";
}

/**
 * Where a lower third is allowed to exist.
 *
 * `filmstrip` is the row of small tiles beside a stage (Speaker, Spotlight,
 * Presentation). The strip belongs on the stage, so that region never mounts
 * one. Compact is the audio bar — there is no stage.
 */
export function lowerThirdLayoutForCall(input: {
  viewMode: CallChromeView;
  showChips: boolean;
  region: "stage" | "filmstrip";
}): LowerThirdLayout {
  if (input.region === "filmstrip") return "filmstrip";
  if (input.showChips || input.viewMode === "compact") return "compact";
  return "stage";
}

/**
 * Whether the strip is on screen. Hidden once the same speaker has held the
 * floor for `holdMs`. A new speaker id starts the clock over; the caller
 * passes `heldMs: 0` for that.
 */
export function lowerThirdPhase(input: {
  optedIn: boolean;
  layout: LowerThirdLayout;
  speakerId: string | null;
  heldMs: number;
  holdMs?: number;
}): "shown" | "hidden" {
  if (!input.optedIn) return "hidden";
  if (input.layout !== "stage") return "hidden";
  if (!input.speakerId) return "hidden";
  const hold = input.holdMs ?? LOWER_THIRD_HOLD_MS;
  if (input.heldMs >= hold) return "hidden";
  return "shown";
}

function flagOn(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ON_WORDS.has(value.trim().toLowerCase());
  return false;
}

/**
 * Room opt-in for the lower third. Only `lower_third`.
 *
 * `voice_relay_face_plate` is the relay's burned-in agent plate (default on).
 * Treating it as this opt-in would turn a name strip on in every relay room
 * and fight that setting. Absent or anything else stays off.
 */
export function roomLowerThirdOptIn(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata) return false;
  return flagOn(metadata.lower_third);
}

/** Token URL opt-in (`?lowerThird=1`) or an explicit room opt-in. Default off. */
export function broadcastLowerThirdOptIn(input: {
  search?: string | null;
  roomOptIn?: boolean;
}): boolean {
  if (input.roomOptIn === true) return true;
  const params = new URLSearchParams(input.search ?? "");
  return flagOn(params.get("lowerThird"));
}

/** Append the broadcast opt-in. A link without it stays a bare camera. */
export function withLowerThirdParam(url: string, on: boolean): string {
  if (!on) return url;
  const next = new URL(url);
  next.searchParams.set("lowerThird", "1");
  return next.toString();
}

export interface RosterRoleSource {
  id: string;
  name?: string | null;
  display_name?: string | null;
  title?: string | null;
}

/**
 * An agent's role for the lower third: the roster `title` (the same line the
 * org chart uses). Rank is not a role and is not used.
 */
export function agentRosterRole(
  identity: string,
  displayName: string,
  roster: readonly RosterRoleSource[],
  brigadeAgentId?: string | null,
): string | null {
  const slug = identity.replace(/^agent-/, "");
  const keys = new Set(
    [identity, slug, brigadeAgentId ?? ""].map((s) => s.trim()).filter(Boolean),
  );
  const wanted = clean(displayName);
  const hit = roster.find((agent) => {
    const id = agent.id.trim();
    if (id && (keys.has(id) || keys.has(id.replace(/^agent-/, "")))) return true;
    const shown = clean(agent.display_name) || clean(agent.name);
    return wanted !== "" && shown === wanted;
  });
  return clean(hit?.title) || null;
}

/**
 * A human title, when the member payload carries one.
 *
 * Participants have no title column today (`display_name` is the name). This
 * reads an optional `title` string so a later payload shows up, and returns
 * null for every member the API sends now.
 */
export function humanTitleFromMember(
  member: object | null | undefined,
): string | null {
  if (!member) return null;
  const title = (member as { title?: unknown }).title;
  if (typeof title !== "string") return null;
  return clean(title) || null;
}

/** Title or role stashed on a LiveKit participant metadata JSON blob. */
export function subtitleFromMetadata(
  metadata: string | null | undefined,
): string | null {
  const raw = clean(metadata);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    for (const key of ["title", "role"]) {
      const value = record[key];
      if (typeof value === "string" && clean(value)) return clean(value);
    }
  } catch {
    return null;
  }
  return null;
}

/** Agents: roster role. Humans: title, when one is set. Metadata fills a gap. */
export function resolveLowerThirdSubtitle(input: {
  isAgent: boolean;
  agentRole?: string | null;
  humanTitle?: string | null;
  metadata?: string | null;
}): string | null {
  if (input.isAgent) {
    return clean(input.agentRole) || subtitleFromMetadata(input.metadata);
  }
  return clean(input.humanTitle) || subtitleFromMetadata(input.metadata);
}
