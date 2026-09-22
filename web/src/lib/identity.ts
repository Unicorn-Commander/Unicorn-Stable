/**
 * Identity — the colour wheel, and the one face resolver.
 *
 * COLOUR (`identityFor`) is dependency-free on purpose. Guest pages import it,
 * and this module must not import the Keycloak client or the federation store
 * or those pages start constructing an IdP session. The face resolver below
 * stays inside that fence: bundled puppet tables, a host allowlist, and a
 * `registerAvatarSrc` hook the signed-in avatar module fills in so API-relative
 * portraits follow the active instance. Until that hook runs, a relative path
 * stays same-origin, which is correct for `/agent-puppets/*`.
 *
 * Colour: every resident of the Stable (human or agent) gets a stable, curated
 * hue. Deterministic: the same id always resolves to the same hue, on every
 * device, with no server round-trip.
 *
 * Usage:
 *   const id = identityFor(message.sender_id, message.sender_name);
 *   <span style={{ color: id.text }}>{name}</span>
 *   <div style={{ background: id.soft, borderColor: id.border }} />
 *
 * Hues carry two text tunings — a bright variant readable on the dark violet
 * surface, and a darker variant readable on the light theme's white surface.
 * These are inline-style hex (identity is applied via style props, which never
 * see CSS vars), so identityFor() reads the active theme at call time and hands
 * back the right one. The soft/faint/ring/border washes read on both surfaces.
 */

import { brandAvatarFor } from "@/lib/brandAvatars";
import { normalizeAgentKey, puppetForTexture } from "@/lib/puppetRig";

export interface Identity {
  /** Hue family name, e.g. "iris" — handy for debugging/keys. */
  name: string;
  /** Solid anchor — avatar fills, orb cores, progress. */
  color: string;
  /** Readable text variant — theme-aware (bright on dark, deep on light). */
  text: string;
  /** 12% wash — tinted containers (agent reply cards, active rows). */
  soft: string;
  /** 6% wash — hover tints, faint fills. */
  faint: string;
  /** 45% — rings around avatars, focus accents. */
  ring: string;
  /** 25% — hairline borders on tinted containers. */
  border: string;
  /** Avatar gradient (subtle two-stop of the same family). */
  gradient: string;
}

interface HueDef {
  name: string;
  base: string; // solid
  text: string; // readable-on-dark variant
  textLight: string; // readable-on-white variant (light theme)
  rgb: [number, number, number];
  to: string; // gradient partner
}

/** Curated 12-hue wheel, ordered for maximum adjacent contrast. */
const WHEEL: HueDef[] = [
  { name: "iris",    base: "#8b5cf6", text: "#b5a0fc", textLight: "#6d28d9", rgb: [139, 92, 246],  to: "#6d28d9" },
  { name: "aqua",    base: "#22d3ee", text: "#67e8f9", textLight: "#0e7490", rgb: [34, 211, 238],  to: "#0891b2" },
  { name: "mint",    base: "#34d399", text: "#6ee7b7", textLight: "#047857", rgb: [52, 211, 153],  to: "#059669" },
  { name: "gold",    base: "#fbbf24", text: "#fcd34d", textLight: "#b45309", rgb: [251, 191, 36],  to: "#d97706" },
  { name: "coral",   base: "#fb7185", text: "#fda4af", textLight: "#be123c", rgb: [251, 113, 133], to: "#e11d48" },
  { name: "sky",     base: "#38bdf8", text: "#7dd3fc", textLight: "#0369a1", rgb: [56, 189, 248],  to: "#0284c7" },
  { name: "orchid",  base: "#e879f9", text: "#f0abfc", textLight: "#a21caf", rgb: [232, 121, 249], to: "#a21caf" },
  { name: "lime",    base: "#a3e635", text: "#bef264", textLight: "#4d7c0f", rgb: [163, 230, 53],  to: "#65a30d" },
  { name: "indigo",  base: "#818cf8", text: "#a5b4fc", textLight: "#4338ca", rgb: [129, 140, 248], to: "#4f46e5" },
  { name: "ember",   base: "#fb923c", text: "#fdba74", textLight: "#c2410c", rgb: [251, 146, 60],  to: "#ea580c" },
  { name: "teal",    base: "#2dd4bf", text: "#5eead4", textLight: "#0f766e", rgb: [45, 212, 191],  to: "#0d9488" },
  { name: "rose",    base: "#f472b6", text: "#f9a8d4", textLight: "#be185d", rgb: [244, 114, 182], to: "#be185d" },
];

/**
 * Pinned identities — residents whose color is part of the brand. Everyone
 * else hashes onto the wheel. Keys are matched against id AND lowercased name.
 */
const PINNED: Record<string, number> = {
  majik: 0, // iris — the flagship stays brand-violet
  "the-general": 3, // gold — command
  claude: 9, // ember — Anthropic's warm orange
  gunny: 4, // coral
  triage: 5, // sky
};

/** FNV-1a — tiny, stable, good spread on short ids. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Is the light theme active right now? Read live so a toggle takes effect on
 *  the next identityFor() call (see reactivity note below). */
function isLight(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "light"
  );
}

function build(def: HueDef, light: boolean): Identity {
  const [r, g, b] = def.rgb;
  const a = (alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  return {
    name: def.name,
    color: def.base,
    text: light ? def.textLight : def.text,
    soft: a(0.12),
    faint: a(0.06),
    ring: a(0.45),
    border: a(0.25),
    gradient: `linear-gradient(135deg, ${def.base}, ${def.to})`,
  };
}

// Keyed by `${theme}:${resident}` so a theme flip returns the correctly-tuned
// text hue rather than a stale cached one. Components that already rendered
// won't recolor until their next render (acceptable for v1 — the modal that
// hosts the toggle re-renders in place; message rows recolor on next update).
const CACHE = new Map<string, Identity>();

/**
 * Resolve the identity hue for a resident. Pass whatever ids you have — the
 * first non-empty one wins; pinned names beat the hash.
 */
export function identityFor(
  id?: string | null,
  name?: string | null,
): Identity {
  const light = isLight();
  const resident = (id || name || "unknown").toLowerCase();
  const key = `${light ? "l" : "d"}:${resident}`;
  const cached = CACHE.get(key);
  if (cached) return cached;

  let idx = PINNED[resident];
  if (idx === undefined && name) {
    const byName = PINNED[name.toLowerCase()];
    if (byName !== undefined) idx = byName;
  }
  if (idx === undefined) idx = hash(resident) % WHEEL.length;

  const identity = build(WHEEL[idx % WHEEL.length] ?? (WHEEL[0] as HueDef), light);
  CACHE.set(key, identity);
  return identity;
}

/** The full wheel, for legends/pickers. */
export function identityWheel(): Identity[] {
  const light = isLight();
  return WHEEL.map((d) => build(d, light));
}

/* -------------------------------------------------------------------------
 * Faces. One resolver for every resident a surface can be handed.
 *
 * Humans: Stable override → Keycloak picture (`avatar_url`) → initials.
 * Agents: bundled puppet → allowlisted Brigade roster URL → procedural
 *         unicorn (the component draws that; this function returns src null).
 *         Never initials.
 * Apps: Project-Ops, Meeting-Ops, and webhook-* senders that are not an
 *       agent seat with a puppet.
 * A room: agent hub (brigade id or type agent_hub) → that agent; dm → the
 *         other human; group → up to three faces.
 * ---------------------------------------------------------------------- */

/**
 * Vendor logo tiles. `kind: "external"` in
 * `web/public/agent-puppets/manifest.json` — grey ring, not the amber frame
 * the crew puppets wear. The unit test locks this list to that file.
 */
export const EXTERNAL_VENDOR_AGENT_IDS = [
  "codex",
  "chatgpt",
  "grok",
  "gemini",
  "deepseek",
  "qwen",
] as const;

const EXTERNAL_VENDOR_AGENTS = new Set<string>(EXTERNAL_VENDOR_AGENT_IDS);

/** Manifest frame colours. Amber is the crew; grey is an external vendor. */
export const AGENT_RING_AMBER = "#F5A623";
export const AGENT_RING_GREY = "#8A8F98";

const APP_LOGOS = {
  "project-ops": { id: "project-ops", name: "Project-Ops", src: "/app-logos/project-ops.svg" },
  "meeting-ops": { id: "meeting-ops", name: "Meeting-Ops", src: "/app-logos/meeting-ops.svg" },
  webhook: { id: "webhook", name: "Webhook", src: "/app-logos/webhook.svg" },
} as const;

/** Hosts an `<img>` may point at. Same rule as `lib/avatar.ts`. */
const ALLOWED_AVATAR_HOST_SUFFIXES = [
  "magicunicorn.dev",
  "magicunicorn.tech",
  "unicorncommander.ai",
];

export type IdentityKind = "human" | "agent" | "app" | "guest";
export type IdentityRing = "amber" | "grey" | "dashed" | "none";
/**
 * `online` — a client is connected. `available` — an agent can be invoked
 * but holds no socket. `unknown` — we looked and cannot claim either.
 * Null means "don't draw a dot" (humans who are simply not in the room).
 */
export type IdentityPresence = "online" | "available" | "unknown" | null;
/** `name-only` — the room list had no member row, so there is no photo to use. */
export type IdentityOrigin = "subject" | "name-only" | "channel";

export interface ResolvedIdentity {
  kind: IdentityKind;
  id: string;
  name: string;
  /** Winning picture. Null → initials (human/guest) or the procedural unicorn (agent). */
  src: string | null;
  ring: IdentityRing;
  presence: IdentityPresence;
  subtitle: string | null;
  /** Further image URLs, in ladder order, for `<img onError>`. */
  fallbacks: string[];
  /** Group rooms: up to three member faces. Absent otherwise. */
  faces?: ResolvedIdentity[];
  /** Signed-in human with no photo on any rung. */
  needsPhoto?: boolean;
  origin?: IdentityOrigin;
}

export interface ResolveIdentityOptions {
  /** Participant id (or Keycloak sub) of the signed-in user, for "the other member". */
  selfId?: string | null;
  /** Members from the participants store when `room.members` is empty. */
  members?: readonly object[] | null;
  /** Brigade roster, so an agent hub can pick up `avatar_url` without a member row. */
  agents?: readonly object[] | null;
}

type Loose = Record<string, unknown>;

function asLoose(value: unknown): Loose {
  return value && typeof value === "object" ? (value as Loose) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strOrNull(value: unknown): string | null {
  const s = str(value);
  return s || null;
}

/**
 * Up to two initials. Handles "Aaron Stransky" → AS, "majik" → MA,
 * "agent-corporal-qwen" → CQ, and degrades to "?" rather than an empty circle.
 * Humans and guests only — agents never render this.
 */
export function initialsFor(name?: string | null): string {
  const cleaned = (name ?? "")
    .replace(/^agent[-_\s]+/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return "?";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  const w = words[0]!;
  return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
}

/**
 * Same-origin and allowlisted https only. Relative paths stay relative
 * (bundle art and, before `registerAvatarSrc`, API paths). Protocol-relative
 * URLs, `javascript:`, and `http:` are dropped.
 */
export function safeAvatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw || raw.startsWith("//")) return null;
  if (raw.startsWith("/")) {
    if (raw.includes("\\") || /[\s]/.test(raw)) return null;
    return raw;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (typeof window !== "undefined" && host === window.location.hostname) {
    return raw;
  }
  const ok = ALLOWED_AVATAR_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith("." + suffix),
  );
  return ok ? raw : null;
}

let srcFn: (url: string | null | undefined) => string | null = safeAvatarSrc;

/**
 * The signed-in avatar module registers `toAvatarSrc` so a relative Brigade
 * path is prefixed with the active instance. Guest pages never do this, and
 * this module does not import that module.
 */
export function registerAvatarSrc(
  fn: (url: string | null | undefined) => string | null,
): void {
  srcFn = fn;
}

function picture(url: string | null | undefined): string | null {
  return srcFn(url);
}

function pushUnique(out: string[], url: string | null): void {
  if (url && !out.includes(url)) out.push(url);
}

function isExternalAgent(id: string, name: string): boolean {
  return [id, name].some((value) => EXTERNAL_VENDOR_AGENTS.has(normalizeAgentKey(value)));
}

function appMatch(
  id: string,
  name: string,
): { id: string; name: string; src: string } | null {
  const idKey = normalizeAgentKey(id);
  const nameKey = normalizeAgentKey(name);
  if (idKey === "project-ops" || nameKey === "project-ops") return APP_LOGOS["project-ops"];
  if (idKey === "meeting-ops" || nameKey === "meeting-ops") return APP_LOGOS["meeting-ops"];
  const rawId = id.trim().toLowerCase();
  const rawName = name.trim().toLowerCase();
  if (
    rawId.startsWith("webhook-") ||
    rawName.startsWith("webhook-") ||
    idKey.startsWith("webhook-") ||
    nameKey.startsWith("webhook-")
  ) {
    return {
      id: rawId.startsWith("webhook-") ? rawId : rawName || "webhook",
      name: name || id || APP_LOGOS.webhook.name,
      src: APP_LOGOS.webhook.src,
    };
  }
  return null;
}

function presenceOf(kind: IdentityKind, x: Loose): IdentityPresence {
  if (x.is_online === true) return "online";
  if (kind === "agent") {
    if (x.availability === "available") return "available";
    if (x.availability === "unavailable" || x.availability === "unknown") {
      return "unknown";
    }
  }
  return null;
}

function agentSources(
  id: string,
  name: string,
  avatarUrl: string | null,
  artUrl: string | null,
  username: string | null,
): string[] {
  const out: string[] = [];
  // A member row that names a puppet we ship outranks the slug. The value
  // returned is our constant, never the caller's string (see puppetForTexture).
  pushUnique(out, puppetForTexture(artUrl)?.texture ?? null);
  pushUnique(out, puppetForTexture(avatarUrl)?.texture ?? null);
  // Bundled art before any roster URL: Brigade bindings 404 in bulk, and a
  // dangling-but-allowlisted URL must not win and then die as initials.
  // Username is included because a member row's id is a participant UUID,
  // which never matches a Brigade slug — `agent-majik` does.
  pushUnique(out, brandAvatarFor(name));
  pushUnique(out, brandAvatarFor(username));
  pushUnique(out, brandAvatarFor(id));
  pushUnique(out, picture(avatarUrl));
  return out;
}

function humanSources(x: Loose): string[] {
  const out: string[] = [];
  pushUnique(out, picture(strOrNull(x.override_url) ?? strOrNull(x.overrideUrl)));
  pushUnique(
    out,
    picture(
      strOrNull(x.avatar_url) ??
        strOrNull(x.avatarUrl) ??
        strOrNull(x.keycloak_url) ??
        strOrNull(x.keycloakUrl) ??
        strOrNull(x.sender_avatar),
    ),
  );
  pushUnique(out, picture(strOrNull(x.effective_url)));
  return out;
}

function isMessage(x: Loose): boolean {
  return "sender_type" in x || ("sender_id" in x && "sender_name" in x);
}

function isRoom(x: Loose): boolean {
  if (isMessage(x)) return false;
  const t = str(x.type);
  return (
    (t === "dm" || t === "group_dm" || t === "channel" || t === "agent_hub") &&
    ("members" in x || "member_count" in x || "brigade_agent_id" in x || "metadata_" in x)
  );
}

function isAvatarState(x: Loose): boolean {
  return "effective_url" in x && "override_url" in x && "keycloak_url" in x && !isMessage(x);
}

function isAgentRosterShape(x: Loose): boolean {
  if (isMessage(x) || isRoom(x)) return false;
  if (
    typeof x.username === "string" &&
    !("model" in x) &&
    !("capabilities" in x)
  ) {
    return false;
  }
  return (
    "model" in x ||
    "capabilities" in x ||
    "reports_to" in x ||
    ("status" in x && "avatar_url" in x && !("email" in x) && !("roles" in x))
  );
}

function personId(x: Loose): string {
  return (
    str(x.participant_id) ||
    str(x.user_id) ||
    str(x.id) ||
    str(x.username) ||
    str(x.keycloak_sub)
  );
}

function personName(x: Loose): string {
  return (
    str(x.display_name) ||
    str(x.displayName) ||
    str(x.sender_name) ||
    str(x.name) ||
    str(x.username) ||
    "Someone"
  );
}

function messageAsPerson(x: Loose): Loose {
  const senderType = str(x.sender_type);
  return {
    id: str(x.sender_id),
    display_name: str(x.sender_name) || "Someone",
    username: str(x.sender_name),
    avatar_url: x.sender_avatar ?? x.avatar_url ?? null,
    participant_type: senderType === "system" ? "" : senderType,
    is_self: x.is_self === true,
    art_url: x.art_url ?? null,
    availability: x.availability ?? null,
    is_online: x.is_online ?? null,
    title: x.title ?? null,
    rank: x.rank ?? null,
  };
}

function avatarStateAsPerson(x: Loose): Loose {
  return {
    id: str(x.username) || str(x.display_name),
    display_name: str(x.display_name) || str(x.username) || "You",
    username: str(x.username),
    override_url: x.override_url ?? null,
    avatar_url: x.keycloak_url ?? null,
    effective_url: x.effective_url ?? null,
    participant_type: "human",
    is_self: true,
  };
}

function withSources(
  base: Omit<ResolvedIdentity, "src" | "fallbacks">,
  sources: string[],
): ResolvedIdentity {
  return {
    ...base,
    src: sources[0] ?? null,
    fallbacks: sources.slice(1),
  };
}

function resolveAgent(x: Loose, id: string, name: string): ResolvedIdentity {
  const sources = agentSources(
    id,
    name,
    strOrNull(x.avatar_url) ?? strOrNull(x.avatarUrl) ?? strOrNull(x.sender_avatar),
    strOrNull(x.art_url),
    strOrNull(x.username),
  );
  const app = appMatch(id, name);
  // A webhook seat that has a puppet stays that character. A bare
  // "Project-Ops" / "webhook-*" label with no art is the product logo.
  if (sources.length === 0 && app) {
    return {
      kind: "app",
      id: app.id,
      name: app.name,
      src: app.src,
      fallbacks: [],
      ring: "none",
      presence: null,
      subtitle: null,
      origin: "subject",
    };
  }
  const subtitle = str(x.title) || str(x.rank) || null;
  return withSources(
    {
      kind: "agent",
      id: id || name,
      name,
      ring: isExternalAgent(id, name) ? "grey" : "amber",
      presence: presenceOf("agent", x),
      subtitle,
      origin: "subject",
    },
    sources,
  );
}

function resolveHuman(x: Loose, id: string, name: string, guest: boolean): ResolvedIdentity {
  const sources = humanSources(x);
  const self = x.is_self === true;
  return withSources(
    {
      kind: guest ? "guest" : "human",
      id: id || name,
      name,
      ring: guest ? "dashed" : "none",
      presence: presenceOf(guest ? "guest" : "human", x),
      subtitle: guest ? "Guest" : null,
      needsPhoto: !guest && self && sources.length === 0,
      origin: "subject",
    },
    sources,
  );
}

function resolveSubject(x: Loose): ResolvedIdentity {
  const id = personId(x);
  const name = personName(x);
  const typed = str(x.participant_type) || str(x.sender_type);
  const agent = typed === "agent" || isAgentRosterShape(x);
  const guest = typed === "guest" || str(x.role) === "guest";
  if (agent) return resolveAgent(x, id, name);
  const app = appMatch(id, name);
  if (app && typed !== "human" && typed !== "guest") {
    return {
      kind: "app",
      id: app.id,
      name: app.name,
      src: app.src,
      fallbacks: [],
      ring: "none",
      presence: null,
      subtitle: null,
      origin: "subject",
    };
  }
  return resolveHuman(x, id, name, guest);
}

function memberIsSelf(member: Loose, selfId?: string | null): boolean {
  if (member.is_self === true) return true;
  if (!selfId) return false;
  return [member.participant_id, member.user_id, member.id, member.username].some(
    (value) => typeof value === "string" && value === selfId,
  );
}

function memberList(value: unknown): Loose[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object") as Loose[];
}

function nameOnly(id: string, name: string, origin: IdentityOrigin): ResolvedIdentity {
  return {
    kind: "human",
    id,
    name,
    src: null,
    fallbacks: [],
    ring: "none",
    presence: null,
    subtitle: origin === "channel" ? "channel" : null,
    origin,
  };
}

function brigadeIdOf(room: Loose): string | null {
  const direct = strOrNull(room.brigade_agent_id);
  if (direct) return direct;
  const meta = asLoose(room.metadata_ ?? room.metadata);
  return strOrNull(meta.brigade_agent_id);
}

function resolveAgentRoom(
  room: Loose,
  brigade: string | null,
  members: Loose[],
  opts: ResolveIdentityOptions | undefined,
  roomName: string,
): ResolvedIdentity {
  const roster = memberList(opts?.agents).find((agent) => {
    const id = str(agent.id);
    return !!brigade && (id === brigade || normalizeAgentKey(id) === normalizeAgentKey(brigade));
  });
  const agentMember =
    members.find((member) => {
      if (str(member.participant_type) !== "agent") return false;
      if (!brigade) return true;
      const username = str(member.username).replace(/^agent-/, "");
      return (
        username === brigade ||
        str(member.user_id) === brigade ||
        str(member.participant_id) === brigade ||
        normalizeAgentKey(str(member.display_name)) === normalizeAgentKey(brigade)
      );
    }) ?? members.find((member) => str(member.participant_type) === "agent");

  const id = brigade || personId(agentMember ?? {}) || str(roster?.id) || str(room.id);
  const name =
    personName(roster ?? {}) !== "Someone"
      ? personName(roster ?? {})
      : agentMember
        ? personName(agentMember)
        : roomName.replace(/^chat with\s+/i, "") || id;
  return resolveAgent(
    {
      id,
      display_name: name,
      avatar_url: agentMember?.avatar_url ?? roster?.avatar_url ?? null,
      participant_type: "agent",
      is_online: agentMember?.is_online ?? null,
      availability: agentMember?.availability ?? roster?.availability ?? null,
      title: roster?.title ?? null,
      rank: roster?.rank ?? null,
    },
    id,
    name,
  );
}

/**
 * List rows for a DM or hub often have no member payload. `counterpart` is
 * the face the server already resolved; use it before falling through to a
 * name-only human (initials) or an agent with no picture.
 */
function counterpartMember(room: Loose): Loose | null {
  const c = asLoose(room.counterpart);
  const name = str(c.display_name);
  const id = str(c.participant_id) || str(c.agent_id);
  if (!name && !id) return null;
  const kind = str(c.kind);
  return {
    participant_id: str(c.participant_id) || id,
    display_name: name || id,
    username: c.username,
    avatar_url: c.avatar_url,
    participant_type: kind || (str(c.agent_id) ? "agent" : "human"),
    user_id: str(c.agent_id) || undefined,
  };
}

function resolveRoom(room: Loose, opts?: ResolveIdentityOptions): ResolvedIdentity {
  const type = str(room.type);
  const brigade = brigadeIdOf(room);
  const stored = memberList(opts?.members);
  const listed = stored.length > 0 ? stored : memberList(room.members);
  const fallback = counterpartMember(room);
  const members = listed.length > 0 ? listed : fallback ? [fallback] : [];
  const name = str(room.display_name) || str(room.name) || "Conversation";
  const id = str(room.id) || name;

  // An agent hub wins over "dm", including today's agent DMs which are still
  // type "dm" plus a brigade id. A group keeps its facepile; the agent is one
  // of those faces when the member rows are loaded.
  const agentHub = type === "agent_hub" || (!!brigade && type !== "group_dm");
  if (agentHub) return resolveAgentRoom(room, brigade, members, opts, name);

  if (type === "dm") {
    const others = members.filter((member) => !memberIsSelf(member, opts?.selfId));
    const human =
      others.find((member) => str(member.participant_type) !== "agent") ?? others[0];
    if (human) return resolveSubject(human);
    return nameOnly(id, name, "name-only");
  }

  if (type === "group_dm") {
    const others = members
      .filter((member) => !memberIsSelf(member, opts?.selfId))
      .slice(0, 3);
    const faces = others.map((member) => {
      const face = resolveSubject(member);
      if (!face.faces) return face;
      const next = { ...face };
      delete next.faces;
      return next;
    });
    if (faces.length >= 2) {
      return {
        kind: "human",
        id,
        name,
        src: null,
        fallbacks: [],
        ring: "none",
        presence: null,
        subtitle: null,
        faces,
        origin: "subject",
      };
    }
    if (faces[0]) return faces[0];
    return nameOnly(id, name, "name-only");
  }

  return nameOnly(id, name, "channel");
}

/**
 * Resolve one face. Accepts a room member, a roster agent, a room, a message,
 * the signed-in user (`displayName` / `avatarUrl`), or the avatar API state
 * (`override_url` + `keycloak_url`). Never throws.
 */
export function resolveIdentity(
  input: unknown,
  opts?: ResolveIdentityOptions,
): ResolvedIdentity {
  const x = asLoose(input);
  if (isRoom(x)) return resolveRoom(x, opts);
  if (isMessage(x)) return resolveSubject(messageAsPerson(x));
  if (isAvatarState(x)) return resolveSubject(avatarStateAsPerson(x));
  return resolveSubject(x);
}

export const PHOTO_NUDGE_STORAGE_KEY = "stable.identity.photo-nudge.dismissed";

export function isPhotoNudgeDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(PHOTO_NUDGE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPhotoNudge(): void {
  try {
    globalThis.localStorage?.setItem(PHOTO_NUDGE_STORAGE_KEY, "1");
  } catch {
    /* Private mode: the nudge comes back next visit. */
  }
}
