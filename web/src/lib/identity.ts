/**
 * Identity color system — every resident of the Stable (human or agent) gets a
 * stable, curated hue. Deterministic: the same id always resolves to the same
 * hue, on every device, with no server round-trip.
 *
 * Usage:
 *   const id = identityFor(message.sender_id, message.sender_name);
 *   <span style={{ color: id.text }}>{name}</span>
 *   <div style={{ background: id.soft, borderColor: id.border }} />
 *
 * All hues are tuned for the dark violet-cast theme: text variants pass AA on
 * surface-1 (#121220), soft washes stay under 14% alpha so content wins.
 */

export interface Identity {
  /** Hue family name, e.g. "iris" — handy for debugging/keys. */
  name: string;
  /** Solid anchor — avatar fills, orb cores, progress. */
  color: string;
  /** Bright variant — sender names, icons, small text on dark. */
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
  rgb: [number, number, number];
  to: string; // gradient partner
}

/** Curated 12-hue wheel, ordered for maximum adjacent contrast. */
const WHEEL: HueDef[] = [
  { name: "iris",    base: "#8b5cf6", text: "#b5a0fc", rgb: [139, 92, 246],  to: "#6d28d9" },
  { name: "aqua",    base: "#22d3ee", text: "#67e8f9", rgb: [34, 211, 238],  to: "#0891b2" },
  { name: "mint",    base: "#34d399", text: "#6ee7b7", rgb: [52, 211, 153],  to: "#059669" },
  { name: "gold",    base: "#fbbf24", text: "#fcd34d", rgb: [251, 191, 36],  to: "#d97706" },
  { name: "coral",   base: "#fb7185", text: "#fda4af", rgb: [251, 113, 133], to: "#e11d48" },
  { name: "sky",     base: "#38bdf8", text: "#7dd3fc", rgb: [56, 189, 248],  to: "#0284c7" },
  { name: "orchid",  base: "#e879f9", text: "#f0abfc", rgb: [232, 121, 249], to: "#a21caf" },
  { name: "lime",    base: "#a3e635", text: "#bef264", rgb: [163, 230, 53],  to: "#65a30d" },
  { name: "indigo",  base: "#818cf8", text: "#a5b4fc", rgb: [129, 140, 248], to: "#4f46e5" },
  { name: "ember",   base: "#fb923c", text: "#fdba74", rgb: [251, 146, 60],  to: "#ea580c" },
  { name: "teal",    base: "#2dd4bf", text: "#5eead4", rgb: [45, 212, 191],  to: "#0d9488" },
  { name: "rose",    base: "#f472b6", text: "#f9a8d4", rgb: [244, 114, 182], to: "#be185d" },
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

function build(def: HueDef): Identity {
  const [r, g, b] = def.rgb;
  const a = (alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  return {
    name: def.name,
    color: def.base,
    text: def.text,
    soft: a(0.12),
    faint: a(0.06),
    ring: a(0.45),
    border: a(0.25),
    gradient: `linear-gradient(135deg, ${def.base}, ${def.to})`,
  };
}

const CACHE = new Map<string, Identity>();

/**
 * Resolve the identity hue for a resident. Pass whatever ids you have — the
 * first non-empty one wins; pinned names beat the hash.
 */
export function identityFor(
  id?: string | null,
  name?: string | null,
): Identity {
  const key = (id || name || "unknown").toLowerCase();
  const cached = CACHE.get(key);
  if (cached) return cached;

  let idx = PINNED[key];
  if (idx === undefined && name) {
    const byName = PINNED[name.toLowerCase()];
    if (byName !== undefined) idx = byName;
  }
  if (idx === undefined) idx = hash(key) % WHEEL.length;

  const identity = build(WHEEL[idx % WHEEL.length] ?? (WHEEL[0] as HueDef));
  CACHE.set(key, identity);
  return identity;
}

/** The full wheel, for legends/pickers. */
export function identityWheel(): Identity[] {
  return WHEEL.map(build);
}
