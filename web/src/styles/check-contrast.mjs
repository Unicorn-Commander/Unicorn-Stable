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

let failures = 0;
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
    failures++;
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
            failures++;
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
  }
}

console.log(`checked ${checks} colour pairs across ${PALETTES.length * 2} configurations`);
if (report.length) {
  console.error(`\n${report.length} problem(s):\n`);
  for (const r of report) console.error("  " + r);
  process.exit(1);
}
console.log("PASS: palettes complete, all contrast thresholds met");
