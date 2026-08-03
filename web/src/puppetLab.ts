/**
 * Puppet lab — every character against every mouth/blink state, in one frame.
 *
 * A talking face cannot be reviewed from source. The first calibration pass
 * looked entirely reasonable in the table and put Gunny's mouth on his whistle;
 * the same is true of every constant in the shader. So: render the grid, look
 * at it, change one number, look again.
 *
 * Dev only — vite serves /puppet-lab.html from the project root and this entry
 * is never referenced by the app bundle.
 */
import {
  Group,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
} from "three";

import { buildPortraitPuppet } from "@/components/Agents/portraitPuppet";
import type { HeadRig } from "@/components/Agents/proceduralUnicornHead";
import { PUPPETS } from "@/lib/puppetRig";

/* Every authored puppet, so a new character shows up here the moment it is
 * added to the table rather than when somebody remembers to update the lab. */
const FACES = Object.keys(PUPPETS);

/** mouthOpen / blink pairs, left to right. */
const STATES: Array<{ label: string; mouth: number; blink: number }> = [
  { label: "closed", mouth: 0, blink: 0 },
  { label: "1/3", mouth: 0.34, blink: 0 },
  { label: "2/3", mouth: 0.67, blink: 0 },
  { label: "full", mouth: 1, blink: 0 },
  { label: "blink", mouth: 0, blink: 1 },
];

const COLS = STATES.length;
const ROWS = FACES.length;
const STEP = 1.12;

const host = document.getElementById("lab")!;
const renderer = new WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x14161f, 1);
host.appendChild(renderer.domElement);

const scene = new Scene();
const world = new Group();
scene.add(world);

const halfW = (COLS * STEP) / 2;
const halfH = (ROWS * STEP) / 2;
const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, -10, 10);

function resize() {
  const w = host.clientWidth;
  const h = Math.round((w * (ROWS * STEP)) / (COLS * STEP));
  renderer.setSize(w, h, false);
}
resize();
addEventListener("resize", resize);

const rigs: Array<{ rig: HeadRig; mouth: number; blink: number }> = [];

async function build() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const state = STATES[c]!;
      const rig = await buildPortraitPuppet({ spec: PUPPETS[FACES[r]!]! });
      rig.root.position.set(
        (c - (COLS - 1) / 2) * STEP,
        ((ROWS - 1) / 2 - r) * STEP,
        0,
      );
      rig.setMouthOpen(state.mouth);
      rig.setBlink(state.blink);
      world.add(rig.root);
      rigs.push({ rig, mouth: state.mouth, blink: state.blink });
    }
  }
  document.body.dataset.ready = "1";
}

/**
 * `?animate=1` sweeps every tile through a full open/close and blink cycle,
 * which is the only way to catch the failures that a still frame hides —
 * an outline smearing as the chin band passes over it, a lid that pops.
 */
const animate = new URLSearchParams(location.search).has("animate");
const started = performance.now();

function frame() {
  if (animate) {
    const t = (performance.now() - started) / 1000;
    for (const entry of rigs) {
      entry.rig.setMouthOpen((Math.sin(t * 3.1) * 0.5 + 0.5) * (entry.mouth || 1));
      entry.rig.setBlink(Math.max(0, Math.sin(t * 1.7) * 8 - 7));
      /* The SAME amplitudes VrmAvatar's loop uses. They look almost too small
       * here, and that is the point: a lab that sweeps a range the app never
       * reaches reports problems that cannot happen and hides the ones that
       * can. The shipped idle sway is ~1.4% of the frame, which is what the
       * camera's overscan in `frameSubject(root, 0.92)` is sized against. */
      entry.rig.setHeadTurn(Math.sin(t * 0.9) * 0.16, Math.sin(t * 0.6) * 0.06);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

void build().then(frame);
