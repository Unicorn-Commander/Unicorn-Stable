/**
 * The 2D portrait puppet — a talking face built from the APPROVED ARTWORK
 * rather than from geometry.
 *
 * Why this exists next to a perfectly good 3D head: nothing we model will ever
 * look more like the character than the picture of the character. The
 * procedural head is ours but generic — same skull for everyone, a collar
 * standing in for a costume. These portraits already carry Majik's hood,
 * Sidekick's plate carrier, Gunny's campaign hat, which is the whole of what
 * makes an agent recognisable at call-tile size.
 *
 * It implements `HeadRig` exactly, so it is a THIRD driver beside the VRM and
 * the procedural head, not a replacement for either. A commissioned rig drops
 * in on top of this without touching a line of it.
 *
 * ── How the mouth is drawn ──────────────────────────────────────────────────
 * By COMPOSITING, not by warping the source.
 *
 * That is a deliberate constraint of the sticker style. Every shape here is
 * bounded by a hard black ink line, and a displacement warp dragged across one
 * of those lines smears it — the outline goes wobbly and the whole thing stops
 * reading as a sticker. So the opening is a drawn ellipse with its own ink rim,
 * composited over untouched pixels, which is exactly how the artwork would draw
 * an open mouth. Only the chin gets a small displacement, over a band that
 * fades out well before the muzzle's outline.
 *
 * The eyelid follows the same rule — a flat fill behind a hard ink edge. What
 * it borrows from sampling is only its COLOUR, read from the character's own
 * forehead, so the lid is right on a white coat, a rainbow mane or a hood
 * without anybody writing down a per-character lid colour.
 */
import {
  Group,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  NoColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  Vector4,
} from "three";

import { toUv, type PuppetSpec } from "@/lib/puppetRig";
import type { HeadRig } from "./proceduralUnicornHead";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * All feature coordinates arrive as vec4(cx, cy, rx, ry) in Y-UP uv space —
 * `toUv` in puppetRig.ts is the single place the top-down authoring convention
 * is flipped.
 */
const FRAG = /* glsl */ `
precision mediump float;

uniform sampler2D uMap;
uniform float uMouthOpen;
uniform float uBlink;
uniform vec4  uMouth;      // cx, cy, rx, ry — the CLOSED mouth line
uniform float uOpenDepth;  // how far the mouth drops at full open
uniform vec4  uEyeL;
uniform vec4  uEyeR;
uniform vec3  uCavity;
uniform vec3  uInk;

varying vec2 vUv;

/**
 * An eyelid is a FILLED REGION with a hard edge, not a distortion.
 *
 * The first version displaced the sample point by a radial falloff, on the
 * theory that pulling the brow down would cover the eye. It does not: a radial
 * shift moves the middle of the eye further than its edges, so the pupil gets
 * squeezed rather than covered and a blink renders as a black RING with a
 * light centre. Every shape in this artwork is a flat fill inside an ink line,
 * and the lid has to be built the same way.
 */
float lidCover(vec2 uv, vec4 e, float blink) {
  /* Clip to the eye's own ellipse, slightly enlarged so the lid covers the
   * eye's ink outline too. Bounding the lid with straight lines instead —
   * which the previous version did — renders a literal black RECTANGLE over
   * the face, because nothing on this artwork is rectangular. */
  float inEye = 1.0 - smoothstep(0.88, 1.06, length((uv - e.xy) / (e.zw * 1.12)));
  float lidY = e.y + e.w - 2.0 * e.w * blink;    // descends as blink → 1
  float overLid = smoothstep(lidY - 0.004, lidY + 0.004, uv.y);
  return inEye * overLid;
}

/** The lash line at the lid's edge — the ink that makes it read as a lid. */
float lidEdge(vec2 uv, vec4 e, float blink) {
  float lidY = e.y + e.w - 2.0 * e.w * blink;
  float inX = 1.0 - smoothstep(0.55, 0.95, abs(uv.x - e.x) / e.z);
  return inX * (1.0 - smoothstep(0.0, 0.009, abs(uv.y - lidY)));
}

/**
 * Coat colour for the eyelids, sampled from the MUZZLE — just above the mouth
 * line, on the face's centre.
 *
 * Two wrong answers preceded this one, and both were wrong the same way: they
 * assumed a direction from the eye was safe. Straight UP is the brow, solid
 * black ink in this style, which filled the socket with a black slab. INBOARD
 * is the bridge of the nose, which works on Sidekick and fails on Majik,
 * because Majik's forelock hangs down the centre of his face — so a blink put
 * two navy patches where his eyes were.
 *
 * The muzzle is the only large region that is coat on every character in the
 * house style: outboard is mane or a hood, above is brow, below is a jawline.
 * If a future portrait ever gives a character a muzzle that differs from the
 * coat around the eyes, this is the assumption that breaks.
 */
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 lighterOf(vec3 a, vec3 b) { return luma(a) >= luma(b) ? a : b; }

vec3 coatTone(sampler2D map, vec4 mouth, float openDepth) {
  /* THREE samples, keeping the lightest.
   *
   * A single point on the muzzle is not safe: Corporal Qwen's landed on a
   * NOSTRIL and his blink came out charcoal. The muzzle's dark features —
   * nostrils, the mouth line — are small and scattered, so any one probe can
   * hit one, but they are always darker than the coat around them. Taking the
   * lightest of a spread reliably lands on coat without needing to know where
   * this particular artist put the nostrils. */
  float y = mouth.y + openDepth * 1.6;
  vec3 a = texture2D(map, vec2(mouth.x - mouth.z * 1.6, y)).rgb;
  vec3 b = texture2D(map, vec2(mouth.x + mouth.z * 1.6, y)).rgb;
  vec3 c = texture2D(map, vec2(mouth.x, y + openDepth * 1.1)).rgb;
  return lighterOf(a, lighterOf(b, c));
}

void main() {
  vec2 uv = vUv;

  /* ---- chin ------------------------------------------------------------
   * A band that switches on just below the mouth and is gone before the
   * muzzle's ink line, so the warp never crosses an outline. Amplitude is
   * deliberately small: this is a hint of jaw movement under a drawn mouth,
   * not the mechanism that opens it. */
  float d = uMouth.y - uv.y;                       // > 0 below the mouth line
  float band = 1.0 - smoothstep(0.0, 1.0, abs(uv.x - uMouth.x) / (uMouth.z * 2.4));
  float chin = smoothstep(0.0, uOpenDepth * 0.5, d)
             * (1.0 - smoothstep(uOpenDepth * 0.8, uOpenDepth * 1.4, d));
  uv.y += band * chin * uMouthOpen * uOpenDepth * 0.30;

  vec4 col = texture2D(uMap, uv);

  /* ---- the opening -----------------------------------------------------
   * Anchored at the mouth LINE and growing downward, so the upper lip stays
   * put and the jaw appears to drop — an ellipse centred on the mouth would
   * eat the top lip and read as a hole punched through the face. */
  float openHalf = uOpenDepth * 0.5 * uMouthOpen;
  /* A mouth WIDENS as it opens. Growing only in height is what made the first
   * pass read as a puncture instead of a mouth: the corners have to travel. */
  float openWide = uMouth.z * (0.90 + 0.30 * uMouthOpen);
  /* Lifted by the closed line's own half-height so the opening SWALLOWS the
   * drawn mouth instead of appearing beneath it. Without this, Gunny keeps his
   * inked frown while a second dark oval opens below it, and he reads as
   * having two mouths. The smiles get away with it; a heavy line does not. */
  vec2 center = vec2(uMouth.x, uMouth.y - openHalf + uMouth.w * 0.9);
  float r = length((vUv - center) / vec2(openWide, max(openHalf, 1e-5)));
  float gate = step(0.004, uMouthOpen);

  float cavity = (1.0 - smoothstep(0.82, 1.0, r)) * gate;
  // The ink rim: a band just outside the cavity, matching the weight of every
  // other line in the artwork. Without it the mouth reads as a smudge.
  float rim = (smoothstep(0.82, 0.95, r) - smoothstep(1.0, 1.16, r)) * gate;

  col.rgb = mix(col.rgb, uCavity, cavity);
  col.rgb = mix(col.rgb, uInk, clamp(rim, 0.0, 1.0) * 0.9);

  /* ---- eyelids ---------------------------------------------------------
   * Lid colour is SAMPLED from just above the eye, so it is the character's
   * own coat — right on white, on a rainbow mane and under a hood, with no
   * per-character constant to keep in sync with the artwork. */
  if (uBlink > 0.002) {
    vec3 lid = coatTone(uMap, uMouth, uOpenDepth);
    col.rgb = mix(col.rgb, lid, lidCover(vUv, uEyeL, uBlink));
    col.rgb = mix(col.rgb, lid, lidCover(vUv, uEyeR, uBlink));
    float lash = max(lidEdge(vUv, uEyeL, uBlink), lidEdge(vUv, uEyeR, uBlink));
    col.rgb = mix(col.rgb, uInk, lash * uBlink * 0.95);
  }

  gl_FragColor = col;
}
`;

export interface PortraitPuppetOptions {
  /** The agent's puppet — artwork path plus its mouth/eye rig. */
  spec: PuppetSpec;
  /** Abort a load that is no longer wanted. */
  signal?: AbortSignal;
}

/** The muzzle interior. Near-black rather than red: the style inks eyes solid
 *  black, and a red mouth on a flat sticker reads as a wound. */
const CAVITY: [number, number, number] = [0.086, 0.063, 0.086];
const INK: [number, number, number] = [0.04, 0.04, 0.05];

function loadTexture(url: string, signal?: AbortSignal): Promise<Texture> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    new TextureLoader().load(
      url,
      (tex) => {
        if (signal?.aborted) {
          tex.dispose();
          reject(new Error("aborted"));
          return;
        }
        /* NoColorSpace — a deliberate pass-through, not an oversight.
         *
         * Tagging this SRGBColorSpace makes three decode sRGB→linear on
         * sample. That is correct for a texture about to be LIT, and wrong
         * here: a raw ShaderMaterial gets no output-encoding chunk appended,
         * so the linear value is written straight to the framebuffer and
         * displayed as though it were sRGB. Majik's purple hood came out
         * near-black. The artwork is finished, already-shaded sRGB pixels and
         * the only correct thing to do is hand them through untouched. */
        tex.colorSpace = NoColorSpace;
        tex.minFilter = LinearFilter;
        tex.magFilter = LinearFilter;
        tex.generateMipmaps = false;
        resolve(tex);
      },
      undefined,
      () => reject(new Error(`portrait failed to load: ${url}`)),
    );
  });
}

type FrameState = "idle" | "talk" | "talk2" | "blink" | "smile";
let frameManifest: Promise<Record<string, { frames?: Partial<Record<FrameState, string>>; version?: string; frames_version?: string }>> | undefined;
async function frameUrls(texture: string) {
  frameManifest ??= fetch("/agent-puppets/manifest.json", { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error("manifest unavailable"); return r.json(); })
    .catch(() => ({}));
  const slug = texture.split("/").pop()?.split(".")[0] ?? "";
  const entry = (await frameManifest)[slug];
  return Object.entries(entry?.frames ?? {}).filter(([, path]) =>
    typeof path === "string" && /^frames\/[a-z0-9-]+\.webp$/.test(path)
  ).map(([state, path]) => [state as FrameState, `/agent-puppets/${path}?v=${encodeURIComponent(entry?.frames_version ?? entry?.version ?? "")}`] as const);
}

export async function buildPortraitPuppet(
  opts: PortraitPuppetOptions,
): Promise<HeadRig> {
  const rig = opts.spec;
  const texture = await loadTexture(rig.texture, opts.signal);

  const frames = new Map<FrameState, Texture>();
  await Promise.all((await frameUrls(rig.texture)).map(async ([state, url]) => {
    try { frames.set(state, await loadTexture(url, opts.signal)); } catch { /* optional: synthetic fallback */ }
  }));
  if (opts.signal?.aborted) {
    texture.dispose(); frames.forEach(t => t.dispose()); throw new Error("aborted");
  }
  const image = texture.image as { width?: number; height?: number };
  const aspect = (image?.width ?? 1) / (image?.height ?? 1) || 1;

  const geometry = new PlaneGeometry(aspect, 1, 1, 1);
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    // The artwork is already lit and shaded. Anything this scene's lights do
    // to it is damage, so it never participates in lighting.
    lights: false,
    transparent: true,
    uniforms: {
      uMap: { value: texture },
      uMouthOpen: { value: 0 },
      uBlink: { value: 0 },
      uMouth: { value: new Vector4(...toUv(rig.mouth)) },
      uOpenDepth: { value: rig.openDepth },
      uEyeL: { value: new Vector4(...toUv(rig.eyeL)) },
      uEyeR: { value: new Vector4(...toUv(rig.eyeR)) },
      uCavity: { value: new Vector3(...(rig.cavity ?? CAVITY)) },
      uInk: { value: new Vector3(...INK) },
    },
  });

  const mesh = new Mesh(geometry, material);
  /* Head-turn moves a PIVOT inside the root, never the root itself.
   *
   * `root` belongs to the caller — it is what gets added to a scene and
   * positioned. Writing `root.position` from setHeadTurn silently overwrites
   * whatever layout the caller established: the state-grid lab positions each
   * face on a grid, and the first version collapsed all twenty-five onto the
   * same spot the moment the sweep started. */
  const pivot = new Group();
  pivot.add(mesh);
  const root = new Group();
  root.add(pivot);

  // Hold the uniform objects directly rather than indexing `uniforms` on every
  // frame: these setters run 60×/s per tile, and the map lookup is typed as
  // possibly-absent so each call would need a guard for a key we just wrote.
  const mouthU = material.uniforms.uMouthOpen as { value: number };
  const blinkU = material.uniforms.uBlink as { value: number };

  const mapU = material.uniforms.uMap as { value: Texture };
  let mouth = 0, blink = 0, lastSpeech = -Infinity;
  function updateFrame() {
    const now = performance.now();
    if (mouth > 0.03) lastSpeech = now;
    const state: FrameState = blink > 0.5 && frames.has("blink") ? "blink" :
      mouth > 0.55 ? "talk" : mouth > 0.03 ? "talk2" : now - lastSpeech < 700 && frames.has("smile") ? "smile" : "idle";
    const real = frames.get(state);
    mapU.value = real ?? texture;
    mouthU.value = real ? 0 : mouth;
    blinkU.value = real ? 0 : blink;
  }
  return {
    root,
    setMouthOpen(amount) {
      mouth = Math.min(1, Math.max(0, amount)); updateFrame();
    },
    setBlink(amount) {
      blink = Math.min(1, Math.max(0, amount)); updateFrame();
    },
    /**
     * Parallax, not rotation. Rotating a flat quad reads as a spinning card —
     * far worse than no movement at all. A small translate plus a touch of
     * roll reads as a head shifting its weight, which is all this needs to
     * stop looking like a frozen frame. The caller frames the plane slightly
     * larger than the viewport so this never exposes an edge.
     */
    setHeadTurn(yaw, pitch) {
      pivot.position.x = yaw * 0.085;
      pivot.position.y = -pitch * 0.07;
      pivot.rotation.z = -yaw * 0.05;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
      frames.forEach(t => t.dispose());
    },
  };
}
