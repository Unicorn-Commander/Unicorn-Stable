/**
 * PLACEHOLDER unicorn head — path C of the design's spike-asset contract.
 *
 * ⚠️ THIS IS NOT ANY OF OUR CHARACTERS. It is a generic unicorn bust built out
 * of primitives at runtime, tinted with the agent's identity hue so one agent is
 * at least distinguishable from another. It exists so the whole pipeline —
 * flag, ladder, WebGL surface gate, audio sampling, mouth drive, dispose — is
 * real and testable while the brand rigs are still being authored. When a
 * crafted `.vrm` lands in `agentVrmCatalog`, this stops rendering for that agent
 * with no other change: it exposes the same `setMouthOpen(0..1)` interface the
 * VRM path drives.
 *
 * Cheap on purpose: ~1.5k triangles, no textures, no shadows, four materials.
 * The perf budget for phase 1 is ≥30 fps on a mid-tier phone, and the way you
 * meet that is by not spending anything in the first place.
 */
import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
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

const BODY = "#ece9fe";
const MUZZLE = "#f8f7ff";
const EYE = "#221d3d";
const HORN_TOP = "#fde68a";

export function buildProceduralUnicornHead(hue: string): HeadRig {
  const disposables: Array<BufferGeometry | Material> = [];
  const track = <T extends BufferGeometry | Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const body = track(
    new MeshStandardMaterial({ color: new Color(BODY), roughness: 0.62, metalness: 0.02 }),
  );
  const muzzle = track(
    new MeshStandardMaterial({ color: new Color(MUZZLE), roughness: 0.55 }),
  );
  const maneMat = track(
    new MeshStandardMaterial({ color: new Color(hue), roughness: 0.42, metalness: 0.12 }),
  );
  const hornMat = track(
    new MeshStandardMaterial({
      color: new Color(HORN_TOP),
      roughness: 0.28,
      metalness: 0.42,
      emissive: new Color(hue),
      emissiveIntensity: 0.16,
    }),
  );
  const eyeMat = track(
    new MeshStandardMaterial({ color: new Color(EYE), roughness: 0.25 }),
  );

  const root = new Group();

  // Skull — a squashed sphere reads as a head at this size without a modeller.
  const skullGeo = track(new SphereGeometry(1, 24, 18));
  const skull = new Mesh(skullGeo, body);
  skull.scale.set(1, 0.95, 1.12);
  root.add(skull);

  // Cheeks/jawline mass so the profile is not a bare ball.
  const cheekGeo = track(new SphereGeometry(0.62, 16, 12));
  for (const sx of [-1, 1]) {
    const cheek = new Mesh(cheekGeo, body);
    cheek.position.set(sx * 0.52, -0.24, 0.34);
    cheek.scale.set(0.9, 0.78, 1);
    root.add(cheek);
  }

  /* MUZZLE + JAW.
   *
   * The jaw is its own Group pivoted at the hinge (up and back from the chin),
   * so opening it rotates rather than translates — a mouth that slides open
   * reads as a glitch, a mouth that hinges reads as speech. Everything that
   * should move with the lower jaw is parented here. */
  const jaw = new Group();
  jaw.position.set(0, -0.34, 0.62);
  root.add(jaw);

  const snoutGeo = track(new SphereGeometry(0.52, 18, 14));
  const upperSnout = new Mesh(snoutGeo, muzzle);
  upperSnout.position.set(0, 0.12, 0.42);
  upperSnout.scale.set(0.86, 0.62, 1.02);
  root.add(upperSnout); // upper lip belongs to the SKULL, not the jaw

  const lowerJaw = new Mesh(snoutGeo, muzzle);
  lowerJaw.position.set(0, -0.14, 0.42);
  lowerJaw.scale.set(0.8, 0.44, 0.94);
  jaw.add(lowerJaw);

  // Mouth cavity — a dark plate that is only visible once the jaw parts.
  const cavityGeo = track(new SphereGeometry(0.4, 14, 10));
  const cavityMat = track(
    new MeshStandardMaterial({ color: new Color("#3b2f52"), roughness: 0.9 }),
  );
  const cavity = new Mesh(cavityGeo, cavityMat);
  cavity.position.set(0, -0.02, 0.5);
  cavity.scale.set(0.66, 0.5, 0.6);
  jaw.add(cavity);

  // Nostrils.
  const nostrilGeo = track(new SphereGeometry(0.055, 8, 6));
  for (const sx of [-1, 1]) {
    const n = new Mesh(nostrilGeo, eyeMat);
    n.position.set(sx * 0.17, 0.2, 0.87);
    root.add(n);
  }

  // Eyes — scaled on Y to blink.
  const eyeGeo = track(new SphereGeometry(0.15, 12, 10));
  const eyes: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const e = new Mesh(eyeGeo, eyeMat);
    e.position.set(sx * 0.5, 0.16, 0.78);
    e.scale.set(0.85, 1.15, 0.7);
    root.add(e);
    eyes.push(e);
  }

  // Horn.
  const hornGeo = track(new ConeGeometry(0.16, 0.95, 10));
  const horn = new Mesh(hornGeo, hornMat);
  horn.position.set(0, 1.12, 0.16);
  horn.rotation.x = -0.16;
  root.add(horn);

  // Ears.
  const earGeo = track(new ConeGeometry(0.19, 0.5, 8));
  for (const sx of [-1, 1]) {
    const ear = new Mesh(earGeo, body);
    ear.position.set(sx * 0.66, 0.86, -0.06);
    ear.rotation.z = sx * 0.34;
    root.add(ear);
  }

  // Mane — a partial torus behind the skull plus a forelock, in the identity hue.
  const maneGeo = track(new TorusGeometry(0.86, 0.3, 10, 22, Math.PI * 1.25));
  const mane = new Mesh(maneGeo, maneMat);
  mane.position.set(0, 0.1, -0.34);
  mane.rotation.set(0.24, 0, Math.PI * 0.88);
  root.add(mane);

  const forelockGeo = track(new CapsuleGeometry(0.19, 0.36, 4, 10));
  const forelock = new Mesh(forelockGeo, maneMat);
  forelock.position.set(-0.16, 0.78, 0.5);
  forelock.rotation.set(0.5, 0, 0.42);
  root.add(forelock);
  const forelock2 = new Mesh(forelockGeo, maneMat);
  forelock2.position.set(0.3, 0.7, 0.52);
  forelock2.rotation.set(0.55, 0, -0.3);
  forelock2.scale.setScalar(0.82);
  root.add(forelock2);

  // Neck stub so the bust does not end in mid-air.
  const neckGeo = track(new CapsuleGeometry(0.5, 0.7, 4, 14));
  const neck = new Mesh(neckGeo, body);
  neck.position.set(0, -1.24, -0.24);
  neck.rotation.x = 0.28;
  root.add(neck);

  const MAX_JAW_RAD = 0.42;

  return {
    root,
    setMouthOpen(amount) {
      const a = Math.min(1, Math.max(0, amount));
      jaw.rotation.x = a * MAX_JAW_RAD;
      // The cavity grows with the gape so a wide mouth is not a thin dark line.
      cavity.scale.y = 0.5 + a * 0.5;
    },
    setBlink(amount) {
      const open = 1 - Math.min(1, Math.max(0, amount));
      for (const e of eyes) e.scale.y = 1.15 * Math.max(0.06, open);
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
