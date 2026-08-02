/**
 * The house unicorn, built from primitives at runtime.
 *
 * This used to be an apologetic generic bust in PBR. It is now a deliberate 3D
 * translation of the SAME illustration language as the approved portraits
 * (`majik-v5.png`, `corporal-qwen-v2.png`, `ref-general`, `ref-gunny`): white
 * body, thick black outlines, golden ridged horn, bold stern eyes, chibi
 * proportions, legible at 120 px on dark navy.
 *
 * WHY IT LOOKS THE WAY IT DOES
 * ----------------------------
 * Five decisions carry the whole style, and the earlier version had none:
 *
 *  1. **Toon, not PBR.** `MeshToonMaterial` over a 3-step ramp. Our art is flat
 *     vector fill with one shade break — a roughness/metalness surface never
 *     gets there no matter how it is lit, because the thing that makes it wrong
 *     is the smooth falloff itself.
 *
 *  2. **Inverted-hull outlines.** The single most identifying trait of the
 *     brand, and the reason the old head read as "a unicorn" rather than "our
 *     unicorn". Every silhouette mesh gets a black `BackSide` twin, inflated by
 *     a fixed WORLD distance, so the line is the same fraction of the head at
 *     every tile size and does not fatten on the big shapes. The twin is a
 *     CHILD of the mesh it traces, which is what welds the outline to the jaw
 *     when `setMouthOpen` hinges it.
 *
 *  3. **A white sticker halo** outside the black one — a second, larger hull.
 *     Every approved portrait is a die-cut sticker, and on a dark tile a
 *     near-black outline against a near-black background is an outline you
 *     cannot see. Only on the outer silhouette; see `addHalo`.
 *
 *  4. **Face features are placed on the SURFACE, by construction.** Eyes,
 *     brows, nostrils and mouth hang off `anchorOn()`, which solves the
 *     ellipsoid for both the point and the normal. Hand-picked z values are how
 *     the old head ended up with features floating in front of the skull, and
 *     they turn every later proportion tweak into a re-derivation.
 *
 *  5. **Proportions measured off the portraits**, not guessed: muzzle ~64 % of
 *     face width sitting on the chin line, eyes at ±0.45 of face half-width,
 *     brows tapered and slanted ~0.5 rad with the INNER end low. That last
 *     angle is the entire difference between "capable adult" and "plushie".
 *
 * Still procedural, still offline: no textures, no loaders, no asset download.
 * three.js is the only thing on the wire and it was already there. ~10.6 k
 * triangles including every outline and halo twin, which is nothing — the cost
 * of this tile is the fragment shader over a 120–400 px box, not the vertices.
 *
 * The rig interface is unchanged. When a crafted `.vrm` lands in
 * `agentVrmCatalog`, this stops rendering for that agent with no other change.
 */
import {
  BackSide,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
  SphereGeometry,
  Texture,
  TorusGeometry,
  Vector3,
  type BufferAttribute,
} from "three";

export interface HeadRig {
  root: Group;
  /** 0 = shut, 1 = wide. The one degree of freedom phase 1 drives. */
  setMouthOpen(amount: number): void;
  /** 0 = open, 1 = shut. Idle life; not driven by audio. */
  setBlink(amount: number): void;
  /** Gentle listening/idle sway, in radians. */
  setHeadTurn(yaw: number, pitch: number): void;
  dispose(): void;
}

/** Which mane an agent wears. Aaron approved Majik with the full rainbow. */
export type ManeStyle = "identity" | "rainbow";

export interface HeadOptions {
  /** Identity hue — tints the mane (unless rainbow) and the garment. */
  hue: string;
  mane?: ManeStyle;
}

/* ------------------------------------------------------------------ *
 * Palette — sampled off the portraits, not invented.
 * ------------------------------------------------------------------ */

const COAT = "#ffffff"; // body AND muzzle. The old #ece9fe lavender was the tell.
const INK = "#0d0d14"; // outlines, eyes, brows, nostrils.
const HORN_GOLD = "#f2c31f";
const HORN_RIDGE = "#a97208";
const MOUTH_DARK = "#2b1220";

/** The mane Aaron signed off on. Outermost stripe first, as it reads in the art. */
const RAINBOW = ["#e8402a", "#f5871f", "#f7d117", "#33a94a", "#2f7fd4", "#7b3fa0"];

/**
 * Line weight in world units, on a head whose face is ~2.16 units across —
 * about 2.5 % of face width, which is what the portraits use. Because it is a
 * WORLD offset and the camera frames the bust to the tile, the line stays the
 * same fraction of the head at 120 px and at 400 px instead of vanishing at one
 * end and blobbing at the other.
 */
const OUTLINE_W = 0.07;
/** Extra width of the white sticker border outside the black line. */
const HALO_W = 0.075;

/* ---- skull ellipsoid. Everything on the face is solved against this. ---- */
const SKULL = new Vector3(1.04, 0.97, 0.74);
/* ---- muzzle ellipsoid, in root space. ---------------------------------
 * z is the load-bearing number and it is not a matter of taste.
 *
 * The muzzle outline in the portraits is a CLOSED oval. In 3D that ring only
 * closes if the muzzle's EQUATOR — its widest cross-section, the silhouette you
 * actually see head-on — clears the skull's surface everywhere along it. Tuck
 * the muzzle back into the face and the ring survives at the chin, thins at the
 * cheeks and vanishes across the bridge, which is precisely the half-drawn
 * muzzle the first three passes produced. The skull surface is 0.734 deep at
 * the muzzle's top edge, so the equator sits at 0.76: proud all the way round,
 * by construction rather than by luck. The cost is a snout that reads longer in
 * profile than the portraits, and the tile is frontal, so that is the right
 * side of the trade. */
const MUZZLE_C = new Vector3(0, -0.5, 0.76);
const MUZZLE_R = new Vector3(0.66, 0.42, 0.24);

/* ------------------------------------------------------------------ *
 * Agent → mane
 * ------------------------------------------------------------------ */

/** Agents whose approved portrait wears the full rainbow. */
const RAINBOW_MANED = new Set(["majik"]);

function normalizeAgentKey(raw?: string | null): string {
  return (
    (raw ?? "")
      .toLowerCase()
      .replace(/^agent[-_\s]+/, "")
      .replace(/^chat with\s+/, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .split(/\s+/)[0] ?? ""
  );
}

/**
 * Rainbow for Majik, identity hue for everyone else.
 *
 * Deliberately a lookup and not a heuristic: the rainbow mane is an approved
 * character trait for one agent, so giving it to another is an explicit edit
 * here rather than something that happens to a new agent by accident.
 */
export function resolveManeStyle(
  slug?: string | null,
  name?: string | null,
): ManeStyle {
  if (RAINBOW_MANED.has(normalizeAgentKey(slug))) return "rainbow";
  if (RAINBOW_MANED.has(normalizeAgentKey(name))) return "rainbow";
  return "identity";
}

/* ------------------------------------------------------------------ *
 * Builder
 * ------------------------------------------------------------------ */

export function buildProceduralUnicornHead(
  options: string | HeadOptions,
): HeadRig {
  const opts: HeadOptions =
    typeof options === "string" ? { hue: options } : options;
  const hue = opts.hue;
  const maneStyle = opts.mane ?? "identity";

  const disposables: Array<BufferGeometry | Material | Texture> = [];
  const track = <T extends BufferGeometry | Material | Texture>(x: T): T => {
    disposables.push(x);
    return x;
  };

  /* ---- the toon ramp ---------------------------------------------- *
   * NEAREST filtered so lambert falloff quantises to flat plateaus; LINEAR
   * would hand back the gradient we are trying to get rid of. The first step
   * is 0 on purpose: `MeshToonMaterial` samples this ramp for EVERY light,
   * including ones behind the surface, so a non-zero floor means every lamp in
   * the scene tints every pixel. That is exactly how the old head turned a
   * "white" coat pale violet. Shadow tone comes from ambient instead. */
  const ramp = track(makeToonRamp([0, 0.62, 1]));

  const toon = (color: Color) =>
    track(new MeshToonMaterial({ color, gradientMap: ramp }));

  const coatMat = toon(new Color(COAT));
  const hornMat = toon(new Color(HORN_GOLD));
  const ridgeMat = toon(new Color(HORN_RIDGE));
  const garmentMat = toon(new Color(hue).lerp(new Color("#141229"), 0.55));
  // Flat and unlit: eyes and brows are ink in the art, not shaded solids.
  const inkMat = track(new MeshBasicMaterial({ color: new Color(INK) }));
  const outlineMat = track(
    new MeshBasicMaterial({ color: new Color(INK), side: BackSide }),
  );
  const mouthMat = track(new MeshBasicMaterial({ color: new Color(MOUTH_DARK) }));
  const haloMat = track(
    new MeshBasicMaterial({ color: new Color(COAT), side: BackSide }),
  );

  const maneMats: Material[] = [];
  const maneMaterial = (i: number): Material => {
    if (!maneMats[i]) {
      maneMats[i] = toon(
        maneStyle === "rainbow"
          ? new Color(RAINBOW[i % RAINBOW.length])
          : // Identity mane keeps one hue but steps its value across the locks,
            // so the mane still reads as strands and not one slab.
            new Color(hue).lerp(new Color("#191430"), (i % 3) * 0.2),
      );
    }
    return maneMats[i];
  };

  const root = new Group();

  /* ---- outline factory -------------------------------------------- *
   * Push every vertex OUTWARD by `weight` WORLD units. Dividing by the mesh's
   * world scale is what makes the offset world-constant on a non-uniformly
   * squashed primitive — without it the skull's line is fat where it is scaled
   * up and thin where it is scaled down, which is exactly how a drawn line
   * does NOT behave.
   *
   * "Outward" is the vertex's own direction from the geometry origin, NOT its
   * shading normal, and that is not a detail. `ConeGeometry` emits one apex
   * vertex PER SEGMENT, each carrying a different side normal; displacing
   * along those tears the apex into a starburst, and every cone here — horn,
   * ears, brows, every mane lock — grew a crown of white spikes. All these
   * primitives are convex and origin-centred, so the radial direction is a
   * clean, single-valued field that agrees with the normal everywhere it
   * matters and stays continuous where the normal does not. */
  const dir = new Vector3();
  const addHull = (mesh: Mesh, weight: number, mat: Material): Mesh => {
    mesh.updateWorldMatrix(true, false);
    const s = mesh.getWorldScale(new Vector3());
    const geo = track(mesh.geometry.clone());
    const pos = geo.attributes.position as BufferAttribute;
    const nrm = geo.attributes.normal as BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i += 1) {
      dir.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (dir.lengthSq() < 1e-8) {
        if (!nrm) continue;
        dir.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      }
      dir.normalize();
      pos.setXYZ(
        i,
        pos.getX(i) + (dir.x * weight) / (s.x || 1),
        pos.getY(i) + (dir.y * weight) / (s.y || 1),
        pos.getZ(i) + (dir.z * weight) / (s.z || 1),
      );
    }
    pos.needsUpdate = true;
    // The hull is unlit and back-faced; normals and uvs are dead weight.
    geo.deleteAttribute("normal");
    geo.deleteAttribute("uv");
    geo.computeBoundingSphere();
    const hull = new Mesh(geo, mat);
    // Child, not sibling: it inherits the jaw hinge, the blink, the head turn.
    mesh.add(hull);
    return hull;
  };
  const addOutline = (mesh: Mesh, weight = OUTLINE_W) =>
    addHull(mesh, weight, outlineMat);
  /* The white sticker border. Every approved portrait is a die-cut sticker and
   * this is the die cut — without it a near-black outline sits on a near-black
   * tile and the whole silhouette stops reading. A SECOND, larger hull: because
   * it is bigger its back faces are deeper, so the black hull wins wherever the
   * two overlap and you get coat → black → white → background for free.
   * Only ever applied to meshes ON the outer silhouette; putting it on the
   * inner mane locks would print white gaps between the rainbow stripes. */
  const addHalo = (mesh: Mesh) => addHull(mesh, OUTLINE_W + HALO_W, haloMat);

  /* ---- surface anchors --------------------------------------------- *
   * Give a point on an ellipsoid in (x, y) and get a Group sitting on the
   * surface with +Z along the outward normal. Face features are then authored
   * flat in that local frame, which is how an illustrator thinks about them,
   * and they stay welded to the surface when the proportions move. */
  const surfaceZ = (semi: Vector3, x: number, y: number) =>
    semi.z * Math.sqrt(Math.max(0.04, 1 - (x / semi.x) ** 2 - (y / semi.y) ** 2));

  const anchorOn = (
    parent: Object3D,
    center: Vector3,
    semi: Vector3,
    x: number,
    y: number,
    lift = 0,
  ): Group => {
    const z = surfaceZ(semi, x, y);
    const n = new Vector3(
      x / (semi.x * semi.x),
      y / (semi.y * semi.y),
      z / (semi.z * semi.z),
    ).normalize();
    const g = new Group();
    g.position.set(
      center.x + x + n.x * lift,
      center.y + y + n.y * lift,
      center.z + z + n.z * lift,
    );
    g.lookAt(g.position.clone().add(n));
    parent.add(g);
    return g;
  };
  const onSkull = (x: number, y: number, lift = 0) =>
    anchorOn(root, new Vector3(0, 0, 0), SKULL, x, y, lift);
  const onMuzzle = (parent: Object3D, x: number, y: number, lift = 0) =>
    anchorOn(parent, MUZZLE_C, MUZZLE_R, x, y, lift);

  /* ---- skull ------------------------------------------------------- *
   * Slightly wider than tall and flattened on Z. A true sphere reads as a ball
   * under any lighting; the portraits are frontal and their heads are discs. */
  const sphereGeo = track(new SphereGeometry(1, 22, 16));
  const skull = new Mesh(sphereGeo, coatMat);
  skull.scale.copy(SKULL);
  root.add(skull);
  addOutline(skull);
  addHalo(skull);

  /* ---- ears -------------------------------------------------------- *
   * Small, poking past the skull silhouette at the upper corners, tipped
   * outward. Outlined, because in the art they are separate shapes. */
  const earGeo = track(new ConeGeometry(0.23, 0.6, 8));
  for (const sx of [-1, 1]) {
    const ear = new Mesh(earGeo, coatMat);
    ear.position.set(sx * 0.82, 0.72, -0.06);
    ear.scale.set(0.9, 1, 0.5);
    ear.rotation.z = sx * 0.28;
    root.add(ear);
    addOutline(ear);
    addHalo(ear);
  }

  /* ---- horn -------------------------------------------------------- *
   * Golden and prominent — about as tall as half the face, as in the
   * portraits — with ridge banding. The bands are TILTED RINGS, not a swept
   * helix: seen head-on a spiral reads as a stack of parallel diagonals, so
   * that is what we build, for a tenth of the triangles. Their radius tracks
   * the cone so they sit flush and do not chew notches out of the outline. */
  const HORN_H = 1.06;
  const HORN_R = 0.27;
  const hornPivot = new Group();
  hornPivot.position.set(0, 0.6, 0.16);
  hornPivot.rotation.x = -0.07;
  root.add(hornPivot);

  const hornGeo = track(new ConeGeometry(HORN_R, HORN_H, 12));
  const horn = new Mesh(hornGeo, hornMat);
  horn.position.y = HORN_H / 2;
  hornPivot.add(horn);
  addOutline(horn, OUTLINE_W * 0.8);
  addHalo(horn);

  const RIDGES = 6;
  for (let i = 0; i < RIDGES; i += 1) {
    const t = 0.12 + (i / RIDGES) * 0.72; // 0..1 up the cone
    const tube = HORN_R * 0.115;
    const r = Math.max(0.02, HORN_R * (1 - t) - tube * 0.55);
    const ringGeo = track(new TorusGeometry(r, tube, 4, 12));
    const ring = new Mesh(ringGeo, ridgeMat);
    ring.position.y = (t - 0.5) * HORN_H;
    ring.rotation.x = Math.PI / 2; // ring around Y, wrapping the cone
    ring.rotateOnWorldAxis(new Vector3(0, 0, 1), 0.34); // the spiral's slant
    horn.add(ring);
  }

  /* ---- muzzle ------------------------------------------------------ *
   * ~78 % of the face width, sitting on the chin line, standing well proud of
   * the skull so its outline twin cuts the clean black ring across the face
   * that the portraits have. This one proportion is most of what makes a
   * unicorn read as OURS rather than as a pony. */
  const muzzle = new Mesh(sphereGeo, coatMat);
  muzzle.position.copy(MUZZLE_C);
  muzzle.scale.copy(MUZZLE_R);
  root.add(muzzle);
  addOutline(muzzle);

  /* JAW.
   *
   * The chin is its own Group pivoted up and back from the mouth, so opening
   * rotates rather than translates — a mouth that slides open reads as a
   * glitch. Shut, the chin nests entirely inside the muzzle and its outline is
   * invisible, so the muzzle is the single clean oval the art shows; open, it
   * swings clear and becomes the lower jaw. */
  const jaw = new Group();
  jaw.name = "jaw"; // named so a test can assert the hinge without guessing
  jaw.position.set(0, -0.24, 0.3);
  root.add(jaw);

  const chin = new Mesh(sphereGeo, coatMat);
  chin.position.set(0, -0.4, 0.44);
  chin.scale.set(0.42, 0.18, 0.16);
  jaw.add(chin);
  addOutline(chin);

  /* The mouth is TWO shapes cross-faded by setMouthOpen, because the shut and
   * open states are different drawings in this style: shut is a thin ink
   * smirk, open is a dark hole. Trying to serve both with one scaling blob
   * gives you a mouth that is either a fat line or a thin cave. */
  const LIP_R = 0.36;
  const lipGeo = track(new TorusGeometry(LIP_R, 0.03, 5, 16, Math.PI * 0.3));
  const lipAnchor = onMuzzle(root, 0.06, -0.24, 0.008);
  const lip = new Mesh(lipGeo, inkMat);
  // Lift by the arc radius so the CURVE lands on the anchor rather than the
  // torus's centre — otherwise the smirk sits a full radius low and merges
  // into the muzzle's own outline, which is how it went missing twice.
  lip.position.y = LIP_R;
  lip.rotation.z = Math.PI * 1.4;
  lipAnchor.add(lip);

  const gapAnchor = onMuzzle(root, 0, -0.22, 0.012);
  const gap = new Mesh(sphereGeo, mouthMat);
  gap.scale.set(0.3, 0.02, 0.1);
  gapAnchor.add(gap);

  /* ---- nostrils ---------------------------------------------------- */
  for (const sx of [-1, 1]) {
    const a = onMuzzle(root, sx * 0.2, 0.1, 0.006);
    const n = new Mesh(sphereGeo, inkMat);
    n.scale.set(0.042, 0.058, 0.03);
    n.rotation.z = sx * 0.35;
    a.add(n);
  }

  /* ---- eyes + brows ------------------------------------------------ *
   * Big, flat, ink-black, tilted with the inner corner LOW — and a tapered
   * brow above at a steeper slant. This is the stern-capable-adult read the
   * portraits have. Measured off corporal-qwen-v2: eye centres at ±0.45 of
   * face half-width, brow slant ≈ 0.5 rad. */
  const EYE_RY = 0.175;
  const eyes: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const a = onSkull(sx * 0.45, 0.3, 0.01);
    const e = new Mesh(sphereGeo, inkMat);
    e.scale.set(0.22, EYE_RY, 0.08);
    e.rotation.z = sx * 0.45;
    a.add(e);
    eyes.push(e);
  }

  /* Brow: a cone lying on its side is a tapered slash for 22 triangles. Short
   * and inboard on purpose — a brow long enough to reach the face edge in the
   * flat art runs off the SPHERE in 3D and floats past the silhouette. */
  const browGeo = track(new ConeGeometry(0.105, 0.6, 7));
  for (const sx of [-1, 1]) {
    const a = onSkull(sx * 0.44, 0.555, 0.012);
    const b = new Mesh(browGeo, inkMat);
    b.scale.set(1, 1, 0.42);
    // −π/2 about Z lays the cone along +X (tip inward); the extra 0.5 rad is
    // the portraits' slant, inner end low.
    b.rotation.set(0, 0, sx * (Math.PI / 2 + 0.5));
    a.add(b);
  }

  /* ---- mane -------------------------------------------------------- *
   * A sweep of tapered locks hugging the head's left side, as in every
   * portrait, plus a forelock fanning off the horn base across the brow.
   * Rainbow for Majik, stepped identity hue for everyone else.
   *
   * Each lock hangs from a Group rotated about Y, so "which way is out" is the
   * group's job and the lock itself only ever has to point down. */
  /* The locks are a FRONTAL FAN, not a ring around the skull.
   *
   * The obvious construction — locks on an arc swept about Y — is what the
   * first pass did, and from the tile's near-frontal camera it collapses: each
   * lock is seen edge-on and the rainbow reads as five coloured slivers. The
   * portraits lay the stripes side by side ACROSS the face, so that is the
   * construction. Depth still comes from riding the skull's surface, which
   * also puts the inner locks in front of the outer ones for free. */
  const LOCK_H = 1.5;
  const lockGeo = track(new ConeGeometry(0.175, LOCK_H, 7));
  const SIDE_LOCKS = 5;
  for (let i = 0; i < SIDE_LOCKS; i += 1) {
    const t = i / (SIDE_LOCKS - 1);
    /* The band runs from just OUTSIDE the eye to just past the face edge —
     * measured off corporal-qwen-v2, where the rainbow is a narrow ribbon at
     * the silhouette, not a curtain over the cheek. A lock across the eye is
     * the difference between "hair" and "damage", and it is also what makes
     * the gaps between tapered locks show white face instead of background. */
    const bx = -0.7 - i * 0.115;
    const by = 0.56 - t * 0.14;
    const lean = 0.02 + t * 0.07; // tips fan away from the face
    const h = 1 - t * 0.12;
    // Innermost first so RAINBOW ends up violet-nearest-the-face, red
    // outermost, which is the order every portrait uses.
    const lock = new Mesh(lockGeo, maneMaterial(SIDE_LOCKS - 1 - i));
    lock.position.set(
      bx - Math.sin(lean) * LOCK_H * h * 0.5,
      by - Math.cos(lean) * LOCK_H * h * 0.5,
      surfaceZ(SKULL, bx * 0.85, by * 0.5) + 0.06,
    );
    lock.scale.set(1.2, h, 0.55);
    lock.rotation.z = Math.PI + lean; // π = tip down
    /* Lean the TOP of the lock back into the skull. A cone has one flat end,
     * and stood upright that end sits proud of the face as a black-capped
     * rectangle — six of them across the crown, which is what the mane looked
     * like before this line. Tipping it back buries the cap and sweeps the
     * point forward, which is also how the drawn mane falls. */
    lock.rotation.x = -0.5;
    root.add(lock);
    addOutline(lock);
    if (i === SIDE_LOCKS - 1) addHalo(lock);
  }

  // A hint of mane on the far side so the head is not bald in three-quarter.
  // Kept low and outboard: from the front it must not crowd the right cheek.
  const shortLockGeo = track(new ConeGeometry(0.13, 0.86, 7));
  for (let i = 0; i < 2; i += 1) {
    const bx = 0.94 + i * 0.11;
    const lock = new Mesh(shortLockGeo, maneMaterial(i + 3));
    lock.position.set(bx, 0.06 - i * 0.06, 0.24 - i * 0.1);
    lock.scale.set(1, 1, 0.5);
    lock.rotation.z = Math.PI - 0.1;
    lock.rotation.x = -0.5; // same reason as the near-side band
    root.add(lock);
    addOutline(lock);
  }

  /* Forelock — the swoosh crossing the brow under the horn, which in majik-v5
   * is where the rainbow is most legible at small size. Placed in root space
   * rather than on a surface anchor: these are volumes sweeping ACROSS the
   * curvature, so "which way does the tip point" has to stay a plain frontal
   * angle instead of something expressed in a tilted tangent frame. */
  const FORE_H = 0.92;
  const foreGeo = track(new ConeGeometry(0.115, FORE_H, 7));
  for (let i = 0; i < 3; i += 1) {
    const t = i / 2;
    const bx = 0.16 - t * 0.72;
    const by = 0.88 - t * 0.26;
    /* Nearly horizontal, and it gets MORE horizontal outboard. A forelock that
     * hangs steeply lands straight on the brow, and the brow is the whole
     * expression — so the swoosh crosses the crown and exits at the temple,
     * where it meets the top of the side band. */
    const a = 1.2 + t * 0.3;
    const h = 0.62 + t * 0.42;
    const cx = bx - Math.sin(a) * FORE_H * h * 0.5;
    const cy = by - Math.cos(a) * FORE_H * h * 0.5;
    const f = new Mesh(foreGeo, maneMaterial(i));
    f.position.set(cx, cy, surfaceZ(SKULL, cx, cy) + 0.1);
    f.scale.set(1, h, 0.45);
    f.rotation.z = Math.PI - a; // tip down and to the left
    root.add(f);
    addOutline(f);
  }

  /* ---- neck + garment ---------------------------------------------- *
   * Every approved portrait is a BUST in something — a hood, a uniform. A bare
   * floating head reads as a prop; a collar reads as a person. Dark identity
   * hue, which is also where agent-to-agent distinction now lives given every
   * coat is the same white. */
  const neckGeo = track(new CylinderGeometry(0.5, 0.58, 0.5, 12));
  const neck = new Mesh(neckGeo, coatMat);
  neck.position.set(0, -1.14, 0.06);
  root.add(neck);
  addOutline(neck);
  addHalo(neck);

  const collar = new Mesh(sphereGeo, garmentMat);
  collar.position.set(0, -1.52, 0.0);
  collar.scale.set(1.22, 0.4, 0.72);
  root.add(collar);
  addOutline(collar);
  addHalo(collar);

  const MAX_JAW_RAD = 0.34;

  return {
    root,
    setMouthOpen(amount) {
      const a = Math.min(1, Math.max(0, amount));
      jaw.rotation.x = a * MAX_JAW_RAD;
      /* Shut is the ink smirk; anything past a whisper is the dark opening,
       * anchored at the upper lip so it grows DOWNWARD with the jaw rather
       * than ballooning around its own centre. */
      const open = a > 0.14;
      lip.visible = !open;
      gap.visible = open;
      const h = 0.03 + a * 0.2;
      gap.scale.set(0.3 + a * 0.06, h, 0.1);
      gap.position.y = -h + 0.03;
    },
    setBlink(amount) {
      const open = 1 - Math.min(1, Math.max(0, amount));
      for (const e of eyes) e.scale.y = 0.23 * Math.max(0.1, open);
    },
    setHeadTurn(yaw, pitch) {
      root.rotation.y = yaw;
      root.rotation.x = pitch;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * An N-step toon ramp as a 1×N red-channel texture. No file, no download —
 * `MeshToonMaterial` only samples the red channel, so N bytes is the whole
 * asset.
 */
function makeToonRamp(steps: number[]): DataTexture {
  const data = new Uint8Array(steps.map((s) => Math.round(s * 255)));
  const tex = new DataTexture(data, steps.length, 1, RedFormat);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
