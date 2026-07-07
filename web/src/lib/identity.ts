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
 * Hues carry two text tunings — a bright variant readable on the dark violet
 * surface, and a darker variant readable on the light theme's white surface.
 * These are inline-style hex (identity is applied via style props, which never
 * see CSS vars), so identityFor() reads the active theme at call time and hands
 * back the right one. The soft/faint/ring/border washes read on both surfaces.
 */

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
