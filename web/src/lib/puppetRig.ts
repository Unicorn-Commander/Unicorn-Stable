/**
 * Which agents have a puppetable face, where its artwork lives, and where the
 * mouth and eyes are on it.
 *
 * ── Why this is keyed on the AGENT, not on the portrait URL ─────────────────
 * The first version gated the puppet on `resolveAgentPortrait(...)`, i.e. on
 * whatever URL the roster serves. That was wrong twice over:
 *
 *   1. Brigade's `avatar_url` is served from the Brigade UI's origin, not
 *      Stable's. A cross-origin image cannot be uploaded into a WebGL texture
 *      without CORS, so the puppet would have failed on exactly the agents
 *      that HAVE portraits.
 *   2. 41 of Brigade's 53 avatar bindings are DANGLING — they name files that
 *      do not exist on the server (`gunny-v2.png` when the file is
 *      `gunny.webp`). A dangling URL is indistinguishable from a good one
 *      until it 404s, long after the rung was chosen.
 *
 * So the puppet ships its own same-origin copy of the artwork under
 * `public/agent-puppets/<agent-id>.webp`, and the roster URL keeps driving the
 * flat portrait rung where a 404 is survivable. The two answer different
 * questions: "what picture of this agent exists" vs "what can we animate".
 *
 * ── Coordinates ────────────────────────────────────────────────────────────
 * TOP-DOWN, normalized 0..1, matching how you read the image in a viewer
 * (y=0 is the top edge). The shader wants y-up and `toUv` is the only place
 * that flips — do NOT pre-flip values here by hand.
 *
 * Tune with:  npm run puppet:calibrate
 */

export interface Ellipse {
  /** Center, 0..1 across the image, y from the TOP. */
  cx: number;
  cy: number;
  /** Radii, as a fraction of image width/height. */
  rx: number;
  ry: number;
}

export interface PuppetRigSpec {
  /** Closed-mouth line. The opening grows DOWNWARD from here. */
  mouth: Ellipse;
  /**
   * How far the mouth drops at FULL open, as a fraction of image height.
   *
   * Explicit rather than `mouth.ry * someConstant`, because the constant is
   * what got it wrong the first time: the muzzle is only ~7% of the image
   * tall, so a multiplier tuned on Majik punched the cavity through Gunny's
   * chin and onto his whistle. Measure from the mouth line to the BOTTOM OF
   * THE MUZZLE and leave margin — the calibration overlay draws exactly this.
   */
  openDepth: number;
  eyeL: Ellipse;
  eyeR: Ellipse;
  /**
   * How dark the mouth interior reads. The sticker style fills eyes with solid
   * black ink, so a near-black cavity is on-style rather than a compromise.
   */
  cavity?: [number, number, number];
}

export interface PuppetSpec extends PuppetRigSpec {
  /** Same-origin texture path. Must be under `public/agent-puppets/`. */
  texture: string;
  /** Display name, for the calibration report only. */
  label: string;
}

/**
 * Every portrait in this set was generated from one locked recipe — chibi white
 * unicorn bust, thick black outlines, white sticker border, dark navy ground —
 * so they frame almost identically and this default lands within a couple of
 * percent on most of them. That is what makes a 13-character set tractable:
 * only the outliers need their own numbers.
 */
export const DEFAULT_RIG: PuppetRigSpec = {
  mouth: { cx: 0.500, cy: 0.612, rx: 0.055, ry: 0.017 },
  openDepth: 0.048,
  eyeL: { cx: 0.432, cy: 0.430, rx: 0.035, ry: 0.038 },
  eyeR: { cx: 0.578, cy: 0.430, rx: 0.035, ry: 0.038 },
};

const T = (id: string) => `/agent-puppets/${id}.webp`;

/**
 * Keyed by BRIGADE AGENT ID (normalized). Adding a character is: drop the
 * 512² WebP in `public/agent-puppets/`, add a row, run the calibration script,
 * adjust. Nothing else in the app changes.
 */
export const PUPPETS: Record<string, PuppetSpec> = {
  "the-colonel": { label: "The Colonel", texture: T("the-colonel"), ...DEFAULT_RIG },
  "majik-mane-dj": { label: "DJ Majik Mane", texture: T("majik-mane-dj"), ...DEFAULT_RIG },
  "codex-astra": { label: "Codex Astra", texture: T("codex-astra"), ...DEFAULT_RIG },
  majik: {
    label: "Majik",
    texture: T("majik"),
    mouth: { cx: 0.503, cy: 0.611, rx: 0.050, ry: 0.017 },
    openDepth: 0.046,
    eyeL: { cx: 0.437, cy: 0.432, rx: 0.036, ry: 0.038 },
    eyeR: { cx: 0.575, cy: 0.432, rx: 0.036, ry: 0.038 },
  },
  sidekick: {
    label: "Sidekick",
    texture: T("sidekick"),
    mouth: { cx: 0.548, cy: 0.590, rx: 0.050, ry: 0.017 },
    openDepth: 0.045,
    eyeL: { cx: 0.424, cy: 0.407, rx: 0.038, ry: 0.042 },
    eyeR: { cx: 0.586, cy: 0.407, rx: 0.038, ry: 0.042 },
  },
  "corporal-qwen": {
    label: "Corporal Qwen",
    texture: T("corporal-qwen"),
    ...DEFAULT_RIG,
  },
  gunny: {
    label: "Gunny",
    texture: T("gunny"),
    mouth: { cx: 0.505, cy: 0.638, rx: 0.048, ry: 0.017 },
    openDepth: 0.042,
    eyeL: { cx: 0.428, cy: 0.452, rx: 0.034, ry: 0.036 },
    eyeR: { cx: 0.578, cy: 0.452, rx: 0.034, ry: 0.036 },
  },
  /**
   * The General's portrait has NO MOUTH DRAWN — muzzle and nostrils only.
   * Because the opening is composited rather than warped, the puppet draws him
   * the mouth the artist left out and he reads correctly from about a third
   * open. What he cannot do is REST: with nothing at the mouth line his closed
   * state is a blank muzzle, so he never quite settles between words.
   */
  "the-general": {
    label: "The General",
    texture: T("the-general"),
    mouth: { cx: 0.500, cy: 0.625, rx: 0.048, ry: 0.016 },
    openDepth: 0.045,
    eyeL: { cx: 0.432, cy: 0.446, rx: 0.034, ry: 0.035 },
    eyeR: { cx: 0.575, cy: 0.446, rx: 0.034, ry: 0.035 },
  },
  "cpl-colophon": { label: "Cpl. Colophon", texture: T("cpl-colophon"), ...DEFAULT_RIG },
  perry: { label: "Perrywinkle Spector", texture: T("perry"), ...DEFAULT_RIG },
  prudence: { label: "Prudence Finch", texture: T("prudence"), ...DEFAULT_RIG },
  "accounting-ops-cfo": { label: "Col. Ledger", texture: T("accounting-ops-cfo"), ...DEFAULT_RIG },
  "center-deep-lead": { label: "Prof. Fathom", texture: T("center-deep-lead"), ...DEFAULT_RIG },
  "contact-ops-lead": { label: "The Registrar", texture: T("contact-ops-lead"), ...DEFAULT_RIG },
  "customer-ops-lead": { label: "The Steward", texture: T("customer-ops-lead"), ...DEFAULT_RIG },
  "meeting-ops-lead": { label: "Capt. Cadence", texture: T("meeting-ops-lead"), ...DEFAULT_RIG },
  // ── 2026-08-07 batch: Brand-Ops generated from the same locked recipe, so
  // DEFAULT_RIG lands within tolerance; recalibrate any outlier that mumbles.
  "claude-code": { label: "Claude Code", texture: T("claude-code"), ...DEFAULT_RIG },
  claude: { label: "Claude", texture: T("claude"), ...DEFAULT_RIG },
  cmo: { label: "CMO", texture: T("cmo"), ...DEFAULT_RIG },
  "code-reviewer": { label: "Code Reviewer", texture: T("code-reviewer"), ...DEFAULT_RIG },
  "col-finance": { label: "Col. Finance", texture: T("col-finance"), ...DEFAULT_RIG },
  harmony: { label: "Hopesnack Harmony", texture: T("harmony"), ...DEFAULT_RIG },
  "maj-recon": { label: "Maj. Recon", texture: T("maj-recon"), ...DEFAULT_RIG },
  "meeting-ops-dev": { label: "Meeting-Ops Dev", texture: T("meeting-ops-dev"), ...DEFAULT_RIG },
  scout: { label: "Scout", texture: T("scout"), ...DEFAULT_RIG },
  // Brigade variant art re-homed for the webhook residents (doc-medresearch
  // alert pose and detective-holmes) — real characters, not initials.
  // ── 2026-08-28 Build In Public cast. Same Brand-Ops recipe and framing as
  // the 08-07 batch, so DEFAULT_RIG lands within tolerance — except Rook,
  // whose mouth is drawn lower and is calibrated below. Rook is keyed on
  // its own name AND aliased from `claude-code` below, because the seat's
  // participant username is `agent-claude-code` — the identity resolves first,
  // so without the alias Rook wears the old generic Claude Code face.
  /**
   * Rook's rig is MEASURED, not inherited — the one member of this batch that
   * DEFAULT_RIG does not fit. His smile is drawn LOW on the muzzle (y
   * 0.629–0.667, against a muzzle whose bottom ink starts at 0.703) where the
   * 08-07 batch sits at 0.590–0.617, so DEFAULT_RIG's mouth line lands ~5%
   * high, on bare muzzle ABOVE the smile, and its 0.048 opening then straddles
   * the drawn line instead of growing from it. That is the "hole in the muzzle
   * instead of a mouth" failure `openDepth` is annotated with, and the reason
   * the note says to measure rather than reuse. Overlay: npm run
   * puppet:calibrate.
   */
  rook: {
    label: "Rook",
    texture: T("rook"),
    mouth: { cx: 0.500, cy: 0.660, rx: 0.055, ry: 0.017 },
    // Only 0.043 of muzzle below the mouth line, so the opening is shallower
    // than Majik's 0.046 — measured to the muzzle's bottom ink, with margin.
    openDepth: 0.034,
    eyeL: { cx: 0.414, cy: 0.445, rx: 0.030, ry: 0.028 },
    eyeR: { cx: 0.585, cy: 0.445, rx: 0.030, ry: 0.028 },
  },
  shox: { label: "ShOX", texture: T("shox"), ...DEFAULT_RIG },
  "corporal-forge": { label: "Corporal Forge", texture: T("corporal-forge"), ...DEFAULT_RIG },
  sprint: { label: "Sprint", texture: T("sprint"), ...DEFAULT_RIG },
  // Build In Public crew, 2026-09-02 puppet set (rook-bin/puppet/manifest.json).
  // Codex and Grok are NOT here any more: the crew set draws external vendor
  // models as their logo tile (see brandAvatars PORTRAITS), and a mouth on a
  // logo is wrong. Zen, Producer and Flow are drawn puppets and get a mouth.
  zen: { label: "Zen", texture: T("zen"), ...DEFAULT_RIG },
  producer: { label: "Producer", texture: T("producer"), ...DEFAULT_RIG },
  "shafen-claude-code": { label: "Flow", texture: T("shafen-claude-code"), ...DEFAULT_RIG },
  // Full roster, 2026-09-03: the show's control room and chat companion, and
  // Shafen's six antelope seats (Brand-Ops renders, brand magic-unicorn).
  "control-room": { label: "Control Room", texture: T("control-room"), ...DEFAULT_RIG },
  "chat-companion": { label: "Chat Companion", texture: T("chat-companion"), ...DEFAULT_RIG },
  dikdik: { label: "Dikdik", texture: T("dikdik"), ...DEFAULT_RIG },
  eland: { label: "Eland", texture: T("eland"), ...DEFAULT_RIG },
  gerenuk: { label: "Gerenuk", texture: T("gerenuk"), ...DEFAULT_RIG },
  kudu: { label: "Kudu", texture: T("kudu"), ...DEFAULT_RIG },
  okapi: { label: "Okapi", texture: T("okapi"), ...DEFAULT_RIG },
  oryx: { label: "Oryx", texture: T("oryx"), ...DEFAULT_RIG },
  // Persephone — Aaron's main assistant seat (agent-persephone), 2026-09-03.
  persephone: { label: "Persephone", texture: T("persephone"), ...DEFAULT_RIG },
  "gm-watchdog": { label: "GM Watchdog", texture: T("gm-watchdog"), ...DEFAULT_RIG },
  "research-monitor": { label: "Research Monitor", texture: T("research-monitor"), ...DEFAULT_RIG },
};

/**
 * Display names and legacy slugs that resolve to a Brigade id.
 *
 * Needed because Stable can address an agent three ways — the LiveKit identity
 * (`agent-<id>`), the roster id, or the display name off a room title — and the
 * Ops leads' display names ("Col. Ledger") share nothing with their ids
 * ("accounting-ops-cfo").
 */
const ALIASES: Record<string, string> = {
  // Aaron's Claude Code seat IS Rook — the participant is `agent-claude-code`
  // and its display name is Rook. Without this the identity resolves to the
  // older generic Claude Code art before the name "Rook" is ever tried.
  // Side effect, accepted: the webhook-dev-* residents that also present as
  // "Claude Code" pick up Rook's face. They are the same underlying agent.
  "claude-code": "rook",
  "qwen-35b": "corporal-forge",
  "corporal-qwen": "corporal-qwen",
  "deepseek-flash": "sprint",
  "prudence-finch": "prudence",
  "perrywinkle-spector": "perry",
  "perrywinkle-spector-general-counsel": "perry",
  "col-ledger": "accounting-ops-cfo",
  "prof-fathom": "center-deep-lead",
  "the-registrar": "contact-ops-lead",
  "the-steward": "customer-ops-lead",
  "capt-cadence": "meeting-ops-lead",
  "sgt-quill": "sgt-quill", // no portrait yet; listed so the miss is deliberate
  general: "the-general",
  // The Claude Code residents. Every dev bot whose display name is plain
  // "Claude Code" already normalizes to the puppet key; these are the
  // possessive display names and per-box usernames that don't.
  "aaron-s-claude-code": "claude-code",
  // Shafen's Claude Code seat is Flow, a character of his own since the
  // 2026-09-02 crew set — no longer the generic Claude Code drawing.
  "shafen-s-claude-code": "shafen-claude-code",
  flow: "shafen-claude-code",
  // Shafen's seats are named <animal>-<model>; the character is the animal.
  "dikdik-haiku": "dikdik",
  "eland-qwen": "eland",
  "gerenuk-codex": "gerenuk",
  "kudu-sonnet": "kudu",
  "okapi-grok": "okapi",
  "oryx-gpt": "oryx",
  "reddit-scout": "scout",
  "dev-shafen-z13": "claude-code",
  // Webhook residents are addressed by username (their display names are
  // generic), so the usernames are the reliable key.
  "webhook-gm-alerts": "gm-watchdog",
  "webhook-research-monitor": "research-monitor",
  "webhook-majiks-research": "maj-recon",
  "webhook-dev-stable": "claude-code",
  "webhook-dev-contact-ops": "claude-code",
  "webhook-dev-customer-ops": "claude-code",
  "webhook-dev-landing-pages": "claude-code",
  "webhook-dev-meeting-ops": "claude-code",
  "webhook-main-conference": "claude-code",
  "claude-orch1": "claude-code", // flagship's orchestrator resident
  // Display-name variants for the 2026-08-07 batch.
  "hopesnack-harmony": "harmony",
  "meeting-ops-ios-engineer": "meeting-ops-dev",
};

/**
 * "agent-Cpl. Colophon" → "cpl-colophon".
 *
 * Brigade ids are not clean slugs — `cpl.-colophon` carries a literal dot — so
 * this has to fold punctuation rather than assume kebab-case.
 */
export function normalizeAgentKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/^chat with\s+/, "")
    .replace(/^agent[-_\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The puppet for an agent, or null when none is authored. */
export function puppetForAgent(
  agentId?: string | null,
  name?: string | null,
): PuppetSpec | null {
  for (const candidate of [agentId, name]) {
    const key = normalizeAgentKey(candidate);
    if (!key) continue;
    const resolved = ALIASES[key] ?? key;
    const spec = PUPPETS[resolved];
    if (spec) return spec;
  }
  return null;
}

/**
 * Superseded art paths — a drawing that ships under one name and is also
 * referenced by another.
 *
 * `rook-v2.png` is the 1024² PNG master of Rook's portrait; `rook.webp` is the
 * same picture re-encoded for the app (verified: mean per-pixel difference
 * 0.5/255 against a 28/255 difference to the earlier, rejected `rook.png`).
 * Participant rows were written against the master before the WebP existed, so
 * without this the roster names real, shipped art that the rig table would call
 * a stranger. Both files stay: neither is safe to delete while a database row
 * or a cached page can still ask for it.
 */
const SUPERSEDED_TEXTURES: Record<string, string> = {
  "/agent-puppets/rook-v2.png": T("rook"),
};

/**
 * The puppet whose artwork IS this URL, or null.
 *
 * The other direction of `puppetForAgent`, and the seam that lets ONE
 * PARTICIPANT wear art its slug does not name. A slug is not always a
 * character: `claude-code` covers Aaron's seat, Shafen's box and six webhook
 * residents, so anything keyed on it is necessarily a decision about all of
 * them at once — which is why the alias that currently points `claude-code` at
 * Rook has to accept giving his face to every bot that presents as "Claude
 * Code". A member row is one participant, and this is how that row's picture
 * becomes a rigged spec instead.
 *
 * Matching is EXACT against our own registered textures, on purpose. The url
 * arrives from a database column an agent can write, and the two things it
 * would otherwise reach are a WebGL texture upload and an `<img src>` — the
 * first fails cross-origin (see the header) and the second is a tracking
 * pixel. An exact match against paths this file already ships can do neither:
 * the value returned is our constant, never the caller's string. A url we do
 * not recognise is simply not a puppet, and the caller falls back to the slug.
 */
export function puppetForTexture(url: string | null | undefined): PuppetSpec | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  // Tolerate a cache-buster or fragment; anything else must match verbatim.
  const path = raw.split(/[?#]/)[0]!;
  if (!path) return null;
  const canonical = SUPERSEDED_TEXTURES[path] ?? path;
  for (const spec of Object.values(PUPPETS)) {
    if (spec.texture === canonical) return spec;
  }
  return null;
}

/** Does this agent have a puppetable face? */
export function hasPuppet(
  agentId?: string | null,
  name?: string | null,
): boolean {
  return puppetForAgent(agentId, name) !== null;
}

/** Top-down spec → the y-up vec4 the shader samples with. */
export function toUv(e: Ellipse): [number, number, number, number] {
  return [e.cx, 1 - e.cy, e.rx, e.ry];
}
