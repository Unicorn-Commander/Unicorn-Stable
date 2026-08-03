/**
 * Draw each portrait's puppet rig on top of the portrait, so mouth/eye
 * placement is VERIFIED BY EYE rather than guessed from memory of the artwork.
 *
 * The rig table is four numbers per feature with no way to derive them, which
 * makes it exactly the kind of data that looks plausible while being wrong —
 * and a mouth 3% too high opens a hole in the muzzle instead of a mouth. Render
 * the overlay, look at it, adjust, repeat.
 *
 *   node scripts/calibrate-puppet.ts [outDir]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUPPETS, type Ellipse, type PuppetRigSpec } from "../src/lib/puppetRig.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(here, "../public");
const outDir = process.argv[2] ?? "/tmp/puppet-calibration";

/** Feature ellipse → an ImageMagick draw op in PIXEL space. */
function drawOp(e: Ellipse, w: number, h: number): string {
  const cx = (e.cx * w).toFixed(1);
  const cy = (e.cy * h).toFixed(1);
  const rx = (e.rx * w).toFixed(1);
  const ry = (e.ry * h).toFixed(1);
  return `ellipse ${cx},${cy} ${rx},${ry} 0,360`;
}

/** Where the mouth CAVITY reaches at full open — the thing that actually has
 *  to land inside the muzzle. Drawing only the closed line hides the error:
 *  the first pass looked correct on every face and still punched through the
 *  chin, because the closed line is 2% of the image and the opening is 6%. */
function cavityAtFullOpen(spec: PuppetRigSpec): Ellipse {
  const half = spec.openDepth / 2;
  return {
    cx: spec.mouth.cx,
    cy: spec.mouth.cy + half,
    rx: spec.mouth.rx * 0.94,
    ry: half,
  };
}

function sizeOf(file: string): { w: number; h: number } {
  const out = execFileSync("magick", ["identify", "-format", "%w %h", file], {
    encoding: "utf8",
  });
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return { w, h };
}

function render(key: string, spec: { texture: string } & PuppetRigSpec): string | null {
  const src = path.join(ART, spec.texture);
  if (!existsSync(src)) return null;

  const { w, h } = sizeOf(src);
  const dst = path.join(outDir, `${key}.calib.png`);

  execFileSync("magick", [
    src,
    "-resize", "512x512",
    // Cavity at full open, filled — this is the region that must stay on muzzle.
    "-fill", "rgba(255,32,64,0.30)", "-stroke", "none",
    "-draw", drawOp(cavityAtFullOpen(spec), 512, 512),
    // Closed-mouth line.
    "-fill", "none", "-stroke", "red", "-strokewidth", "2",
    "-draw", drawOp(spec.mouth, 512, 512),
    // Eyes.
    "-stroke", "lime",
    "-draw", drawOp(spec.eyeL, 512, 512),
    "-draw", drawOp(spec.eyeR, 512, 512),
    // Crosshair on the mouth center, so a few-pixel offset is visible.
    "-stroke", "yellow", "-strokewidth", "1",
    "-draw", `line ${(spec.mouth.cx * 512).toFixed(1)},0 ${(spec.mouth.cx * 512).toFixed(1)},512`,
    "-draw", `line 0,${(spec.mouth.cy * 512).toFixed(1)} 512,${(spec.mouth.cy * 512).toFixed(1)}`,
    dst,
  ]);
  return dst;
}

mkdirSync(outDir, { recursive: true });

const made: string[] = [];
for (const [key, spec] of Object.entries(PUPPETS)) {
  const out = render(key, spec);
  if (out) made.push(out);
  else console.warn(`no artwork for puppet "${key}" — skipped`);
}

// The contact sheet is a convenience, not the artifact — montage stamps a
// filename label and dies without a usable font, which must not throw away the
// overlays that were already written.
if (made.length) {
  try {
    execFileSync("magick", [
      "montage", ...made,
      "-label", "",
      "-tile", `${Math.min(3, made.length)}x`,
      "-geometry", "+6+6", "-background", "#111",
      path.join(outDir, "contact-sheet.png"),
    ]);
  } catch {
    console.warn("contact sheet skipped (no font); per-face overlays are written");
  }
}
console.log(`${made.length} overlay(s) → ${outDir}`);
