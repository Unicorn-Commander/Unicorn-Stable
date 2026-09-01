#!/usr/bin/env node
/**
 * Theme contrast + palette-completeness checker.
 *
 *   node src/styles/check-contrast.mjs [path/to/globals.css]
 *
 * Two jobs, both of which have to pass for a palette to be shippable:
 *
 *  1. COMPLETENESS. A palette's dark block and its light block tie on
 *     specificity, and the dark block comes later in the file — so any token a
 *     palette sets in dark but forgets in light LEAKS into light mode. This
 *     simulates the real cascade and fails on any leak.
 *
 *  2. CONTRAST. Computes WCAG 2.1 contrast for every plausible text-on-surface
 *     pairing in all 10 shipped configurations (5 palettes x light/dark).
 *     Thresholds: 4.5:1 for anything used as small text, 3:1 for non-text UI
 *     (borders, section edges) per WCAG 1.4.11.
 *
 *  3. STATE SEPARATION. Contrast-against-the-background is necessary but NOT
 *     sufficient for a token that encodes a STATE. Two status colours can each
 *     clear 3:1 on every surface and still be indistinguishable from EACH
 *     OTHER — which is a worse bug, because a dot that renders as colour with
 *     no adjacent text is then carrying no information at all. This check
 *     existed nowhere until an "optimise every token against the floor" pass
 *     walked agent idle and offline from 3.04:1 apart to 1.54:1 and the
 *     harness reported PASS. See STATE_GROUPS below.
 *
 * Not imported by the app — it is a build-time check, run by hand or in CI.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? new URL("./globals.css", import.meta.url).pathname;
const css = readFileSync(file, "utf8");

/* ---------------------------------------------------------------- parsing -- */

/** Pull `--token: value;` pairs out of the block that follows `header`. */
function blockAfter(header) {
  const i = css.indexOf(header + " {");
  if (i === -1) return null;
  let depth = 0;
  let start = -1;
  for (let j = i; j < css.length; j++) {
    if (css[j] === "{") {
      if (depth === 0) start = j + 1;
      depth++;
    } else if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, j);
    }
  }
  return null;
}

function tokens(body) {
  const out = {};
  if (!body) return out;
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const PALETTES = ["aurora", "prism", "ember", "grove", "beacon"];

const base = tokens(blockAfter("@theme"));
const lightBase = tokens(blockAfter(':root[data-theme="light"]'));
const paletteDark = {};
const paletteLight = {};
for (const p of PALETTES) {
  paletteDark[p] = tokens(blockAfter(`:root[data-palette="${p}"]`));
  paletteLight[p] = tokens(blockAfter(`:root[data-theme="light"][data-palette="${p}"]`));
}

if (!Object.keys(base).length) fail("could not parse @theme block");
if (!Object.keys(lightBase).length) fail("could not parse light base block");

/** Resolve the token map exactly as the browser cascade would. */
function resolve(mode, palette) {
  const m = { ...base };
  if (mode === "light") Object.assign(m, lightBase);
  // Palette dark block: same specificity as light base, later in source.
  Object.assign(m, paletteDark[palette] ?? {});
  // Palette light block: higher specificity, always wins.
  if (mode === "light") Object.assign(m, paletteLight[palette] ?? {});
  return m;
}

/* ------------------------------------------------------------------ colour -- */

function parseColor(v) {
  v = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return [r, g, b, 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return null;
}

/** Composite a possibly-translucent colour over an opaque background. */
function over(fg, bg) {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ------------------------------------------------- perceptual separation -- */
/*
 * WCAG contrast is a LUMINANCE ratio, so it is blind to hue: emerald and amber
 * at the same lightness score ~1.1:1 against each other and are still trivially
 * telling-apart. Requiring 3:1 between every pair of state colours would
 * therefore condemn correct designs, while requiring nothing lets two greys
 * collapse. So separation is satisfied by EITHER channel:
 *
 *   - luminance: >=3:1 WCAG contrast between the two (the only channel two
 *     neutrals have), or
 *   - hue/chroma: CIEDE2000 distance that still holds up under dichromat
 *     simulation. Simulating matters: #4ade80 vs #fb923c is dE 53 to normal
 *     vision and dE 11 to a protanope, i.e. it would sail through a naive dE
 *     check while being invisible to roughly 1 in 12 men.
 */

function rgbToLab([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const g3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = g3(X), fy = g3(Y), fz = g3(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 — perceptual colour difference. */
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = (Math.atan2(b, a) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hp(ap1, b1);
  const hp2 = hp(ap2, b2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp * Math.PI) / 360);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hpb;
  if (Cp1 * Cp2 === 0) hpb = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) > 180) hpb = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  else hpb = (hp1 + hp2) / 2;
  const T =
    1 -
    0.17 * Math.cos(((hpb - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hpb * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hpb + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hpb - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hpb - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lb - 50, 2)) / Math.sqrt(20 + Math.pow(Lb - 50, 2));
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    Math.pow(dL / Sl, 2) +
      Math.pow(dC / Sc, 2) +
      Math.pow(dH / Sh, 2) +
      Rt * (dC / Sc) * (dH / Sh),
  );
}

/** Dichromat simulation (Vienot/Brettel/Mollon LMS projection). */
function simulateCVD([r, g, b], type) {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  const L = 0.31399022 * R + 0.63951294 * G + 0.04649755 * B;
  const M = 0.15537241 * R + 0.75789446 * G + 0.08670142 * B;
  const S = 0.01775239 * R + 0.10944209 * G + 0.87256922 * B;
  let L2, M2, S2;
  if (type === "protan") {
    L2 = 1.05118294 * M - 0.05116099 * S;
    M2 = M;
    S2 = S;
  } else if (type === "deutan") {
    L2 = L;
    M2 = 0.9513092 * L + 0.04866992 * S;
    S2 = S;
  } else {
    L2 = L;
    M2 = M;
    S2 = -0.86744736 * L + 1.86727089 * M;
  }
  const lr = 5.47221206 * L2 - 4.6419601 * M2 + 0.16963708 * S2;
  const lg = -1.1252419 * L2 + 2.29317094 * M2 - 0.1678952 * S2;
  const lb = 0.02980165 * L2 - 0.19318073 * M2 + 1.16364789 * S2;
  const enc = (c) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(
      255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055),
    );
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/**
 * Worst-case perceptual distance between two colours, across normal vision and
 * all three dichromacies. A pair is only as distinguishable as its worst
 * viewer, so the minimum is the honest number.
 */
function separationDeltaE(a, b) {
  const views = [
    [a, b],
    [simulateCVD(a, "protan"), simulateCVD(b, "protan")],
    [simulateCVD(a, "deutan"), simulateCVD(b, "deutan")],
    [simulateCVD(a, "tritan"), simulateCVD(b, "tritan")],
  ];
  return Math.min(...views.map(([x, y]) => deltaE2000(rgbToLab(x), rgbToLab(y))));
}

/* ------------------------------------------------------------------ checks -- */

const BACKGROUNDS = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-slate-950",
  "--color-slate-900",
  "--color-slate-850",
  "--color-slate-800",
];

// Small text: must clear WCAG AA 4.5:1.
const TEXT_AA = [
  "--color-slate-100",
  "--color-slate-200",
  "--color-slate-300",
  "--color-slate-400",
  "--color-slate-500",
  "--color-stable-purple-light",
  "--color-stable-cyan",
  "--color-stable-mint",
  "--color-stable-gold",
  "--color-stable-coral",
  "--color-item-channel",
  "--color-item-dm",
  "--color-item-group",
  "--color-item-agent",
  "--color-item-mention",
  "--color-item-unread",
  "--color-item-system",
  // slate-600 looks decorative but carries real copy — "No one online",
  // "(optional)", italic empty-states — so it is held to the text bar, not 3:1.
  "--color-slate-600",
];

// Non-text UI: WCAG 1.4.11, 3:1.
//
// DELIBERATELY EXCLUDED: --color-line / --color-line-strong. 1.4.11 covers
// visual information required to *identify* a component or its state. These are
// decorative panel separators — no control depends on one to be identifiable
// (buttons carry their own fill and focus ring), and SC 1.4.11 exempts pure
// decoration. Forcing 3:1 on them would mean heavy black rules between every
// panel. If a line ever becomes the sole affordance for a control, that control
// is the bug, not this exemption.
const UI_3 = [
  "--color-edge-nav",
  "--color-edge-conv",
  "--color-edge-agents",
  "--color-edge-composer",
  "--color-edge-call",
  "--color-edge-canvas",
];

// Non-text UI that identifies a STATE. Same 3:1-on-background bar as UI_3, but
// these are also cross-checked against each other by STATE_GROUPS below.
const STATE_UI_3 = [
  "--color-status-active",
  "--color-status-working",
  "--color-status-idle",
  "--color-status-offline",
];

/*
 * Sets of tokens that encode MUTUALLY EXCLUSIVE states of the same component.
 * Within a set, every pair must be tellable apart — see separationDeltaE.
 *
 * Why this exists: agent status renders as a bare 6-12px dot with no adjacent
 * text (AgentList, AgentOrgChart, AgentChatModal, HomeDashboard). If two of
 * these colours converge, the dot stops carrying information entirely, and
 * nothing in a background-only contrast check notices — every token still
 * clears its floor. That is not hypothetical: idle and offline were tuned to
 * 1.54:1 of each other while this file printed PASS.
 */
const STATE_GROUPS = [
  {
    name: "agent status",
    tokens: STATE_UI_3,
  },
];

/** Luminance channel alone is enough at this ratio (WCAG 1.4.11 non-text). */
const STATE_MIN_CONTRAST = 3.0;
/**
 * Otherwise hue/chroma must carry it. 15 is set from measurement, not taste:
 * the shipped separations sit at 20.9-31.0, and the idle/offline collapse this
 * check was written to catch measures 10.8. Anything in between is a pair
 * nobody should be shipping without looking at it.
 */
const STATE_MIN_DELTA_E = 15;

let checks = 0;
const report = [];

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

// -- 1. completeness -------------------------------------------------------
for (const p of PALETTES) {
  const dark = Object.keys(paletteDark[p] ?? {});
  if (!dark.length) continue; // aurora is the base pair by design
  const light = new Set(Object.keys(paletteLight[p] ?? {}));
  const missing = dark.filter((t) => !light.has(t));
  if (missing.length) {
    report.push(
      `LEAK  ${p}: ${missing.length} token(s) set in dark but not light — ` +
        `they will leak into light mode: ${missing.join(", ")}`,
    );
  }
}

// -- 2. contrast -----------------------------------------------------------
for (const palette of PALETTES) {
  for (const mode of ["dark", "light"]) {
    const map = resolve(mode, palette);
    const bgs = {};
    for (const b of BACKGROUNDS) {
      const c = parseColor(map[b] ?? "");
      if (c) bgs[b] = c;
    }
    const test = (tokenList, threshold, kind) => {
      for (const t of tokenList) {
        const raw = map[t];
        if (!raw) continue;
        const fgRaw = parseColor(raw);
        if (!fgRaw) continue;
        for (const [bname, bg] of Object.entries(bgs)) {
          const fg = fgRaw[3] < 1 ? over(fgRaw, bg) : fgRaw;
          const ratio = contrast(fg, bg);
          checks++;
          if (ratio < threshold) {
            report.push(
              `${kind}  ${palette}/${mode}: ${t} on ${bname} = ` +
                `${ratio.toFixed(2)}:1 (needs ${threshold}:1)`,
            );
          }
        }
      }
    };
    test(TEXT_AA, 4.5, "TEXT");
    test(UI_3, 3.0, "UI  ");
    test(STATE_UI_3, 3.0, "UI  ");

    // -- 3. state separation ---------------------------------------------
    for (const group of STATE_GROUPS) {
      const present = group.tokens
        .map((t) => ({ t, c: parseColor(map[t] ?? "") }))
        .filter((x) => x.c);
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          const a = present[i];
          const b = present[j];
          checks++;
          const ratio = contrast(a.c, b.c);
          if (ratio >= STATE_MIN_CONTRAST) continue;
          const dE = separationDeltaE(a.c, b.c);
          if (dE >= STATE_MIN_DELTA_E) continue;
          report.push(
            `STATE ${palette}/${mode}: ${group.name} — ${a.t} vs ${b.t} are ` +
              `not tellable apart: ${ratio.toFixed(2)}:1 luminance ` +
              `(needs ${STATE_MIN_CONTRAST}:1) and worst-case dE ` +
              `${dE.toFixed(1)} (needs ${STATE_MIN_DELTA_E}). Two different ` +
              `states must not look the same.`,
          );
        }
      }
    }
  }
}

console.log(`checked ${checks} colour pairs across ${PALETTES.length * 2} configurations`);
if (report.length) {
  console.error(`\n${report.length} problem(s):\n`);
  for (const r of report) console.error("  " + r);
  process.exit(1);
}
console.log("PASS: palettes complete, all contrast thresholds met");
