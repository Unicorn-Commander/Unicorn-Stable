/**
 * VrmAvatar — the WebGL rung of the presence-face ladder, and the ONLY module in
 * the app that touches three.js.
 *
 * It is reached exclusively through `lazy(() => import(...))` in
 * AgentPresenceFace, which is what keeps three.js out of every bundle a user who
 * has not opted in will ever download. Do not static-import this file from
 * anywhere.
 *
 * WHAT IT RENDERS
 * ---------------
 * The caller's `mountOrder` (AgentPresenceFace's `faceMountPlan` — the user's
 * face-style preference × asset availability × the flag), walked best first in
 * `mountBest`. Under the default "auto" style that is the shipped ladder:
 *
 *   1. an AUTHORED puppet rig      → the BRANDED 2D portrait puppet. Aaron's
 *      call (2026-08-08): the branded talking puppet IS the call face — the
 *      approved portraits carry the costume (Majik's hood, Gunny's campaign
 *      hat), which is what identifies an agent at call-tile size. It outranks
 *      a VRM: a generic rigged model must never replace our own character.
 *      See portraitPuppet.ts.
 *   2. `vrmSrc` set                → a rigged model, mouth driven through the
 *      rig's own viseme/ARKit morph — the fallback for agents with no puppet.
 *      (No brand VRM has been authored yet; the pack is empty.)
 *   3. otherwise                   → the PROCEDURAL head, built from primitives
 *      at runtime. Ours, and on-style, but one skull for everybody. In the
 *      order only under the talking-face flag — never on preference alone —
 *      so a tile that reached this rung on its branded assets falls back to
 *      the 2D branded portrait instead (via `onFail`).
 *
 * A "vrm" style preference moves rung 2 to the front; "puppet" drops the 3D
 * rungs entirely. The probe's `preferred` + `source` pair records what was
 * asked for vs. what actually mounted.
 *
 * Rung 1 is gated on an AUTHORED rig, not on merely having a portrait: most
 * agents' art is a neon logo emblem, and the default mouth position against a
 * crest opens a black hole in the middle of a logo.
 *
 * WHAT DRIVES THE MOUTH (phase 1)
 * -------------------------------
 * A WebAudio analyser over the participant's SUBSCRIBED audio track
 * (livekit-client `createAudioAnalyser`), sampled inside the render loop, with
 * `RemoteParticipant.audioLevel` as the fallback when no track/AudioContext is
 * available. The fallback alone was the shipped v1 and it is why a mounted
 * puppet could still read as a still image: `audioLevel` is only written when
 * the SFU's active-speaker ORDERING changes (see Room.handleActiveSpeakersUpdate
 * — "updates are sent only when there's a change to speaker ordering"), so one
 * long agent TTS utterance in a 1:1 call freezes the level — and the mouth —
 * for the whole sentence. The analyser reads the audio itself at frame rate.
 *
 * The level is read off refs and applied to the morph IMPERATIVELY; it never
 * becomes React state, because 60 setState calls a second would re-render the
 * whole tile subtree and cost more than the renderer.
 *
 * Phase 2 swaps the INPUT for a phoneme-timed schedule off the data channel. The
 * output half (alias resolution, curve, smoothing — lib/mouthShape.ts) does not
 * change.
 */
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LoadingManager } from "three";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { createAudioAnalyser, Track } from "livekit-client";
import type { RemoteAudioTrack } from "livekit-client";
import { useVoice } from "@/contexts/VoiceProvider";
import { identityFor } from "@/lib/identity";
import { MAX_VRM_BYTES, VRM_LOAD_TIMEOUT_MS } from "@/lib/resolveVrmSrc";
import {
  blinkAmount,
  idleMouthOpen,
  mouthOpenFromAnalyserVolume,
  mouthOpenFromLevel,
  resolveMouthMorph,
  smoothLevel,
} from "@/lib/mouthShape";
import type { FaceSource, PresenceExpression } from "@/lib/presenceFace";
import type { FaceStyle } from "@/lib/facePreference";
import { puppetForAgent } from "@/lib/puppetRig";
import { buildPortraitPuppet } from "./portraitPuppet";
import {
  buildProceduralUnicornHead,
  resolveManeStyle,
  type HeadRig,
} from "@/components/Agents/proceduralUnicornHead";

/**
 * Verification seam. Populated whenever a face is mounted, keyed by LiveKit
 * identity, so "does the mouth actually move" is a question you can ANSWER —
 * sample it twice a second from the console or a browser driver and watch
 * `mouthOpen` change — rather than a question you answer with a screenshot of a
 * face that might be a still image.
 */
export interface TalkingFaceProbe {
  /** "vrm" = a real rigged model. "puppet" = a rigged 2D portrait.
   *  "placeholder" = the procedural head. */
  source: "vrm" | "puppet" | "placeholder";
  /**
   * The user's face-style preference this tile mounted under. Read next to
   * `source`: `preferred:"vrm", source:"puppet"` is a tile that COULD NOT
   * honor the choice and fell down the ladder (with `error` saying why when a
   * load actually failed, vs. simply no asset).
   */
  preferred: FaceStyle;
  /** Which morph/expression the mouth is driving, or "jaw-bone". */
  driver: string;
  /** Raw level this frame (analyser volume, or LiveKit audioLevel). */
  level: number;
  /**
   * Where `level` comes from. "analyser" = WebAudio over the subscribed audio
   * track (frame-rate, per-syllable). "participant" = the SFU-fed
   * `audioLevel` fallback, which freezes between speaker-ordering changes —
   * if a live call reports "participant" while the agent is audibly talking,
   * the track/AudioContext hookup is what to investigate.
   */
  levelSource: "analyser" | "participant";
  /** 0..1 applied to the mouth this frame. */
  mouthOpen: number;
  /** Rolling average over the last second. */
  fps: number;
  frames: number;
  /** rAF or the hidden-tab / throttled-rAF fallback. */
  ticker: "raf" | "interval";
  vrmSrc: string | null;
  error: string | null;
}

declare global {
  interface Window {
    __stableTalkingFace?: Record<string, TalkingFaceProbe>;
  }
}

export interface VrmAvatarProps {
  /** Full LiveKit identity — how we find the audio level. */
  participantId: string;
  slug: string;
  name: string;
  /** Model URL, or null → the branded puppet, then the procedural head. */
  vrmSrc: string | null;
  size: number;
  expression?: PresenceExpression;
  isSpeaking?: boolean;
  debug?: boolean;
  /**
   * WHAT to mount, in order — `faceMountPlan(style × availability × flag)`,
   * computed by AgentPresenceFace. Sources whose asset turns out to be missing
   * here (no puppet spec, no vrmSrc) are skipped; "placeholder" appears only
   * when the talking-face flag allows the generic head. Defaults to the
   * pre-preference auto ladder so a caller that has no styling opinion (the
   * face lab) keeps the shipped behavior.
   */
  mountOrder?: readonly FaceSource[];
  /** The user's face-style preference, surfaced through the probe so a live
   *  tile answers "what did you ask for vs. what did you get" in one read. */
  preferred?: FaceStyle;
  /** Step DOWN the ladder. Called once, with a reason, and never retried. */
  onFail: (reason: string) => void;
}

/** The pre-preference ladder: puppet → vrm → procedural. */
const DEFAULT_MOUNT_ORDER: readonly FaceSource[] = [
  "puppet",
  "vrm",
  "placeholder",
];

/* ------------------------------------------------------------------ *
 * Model fetch — hardened, because a glTF is a request generator.
 * ------------------------------------------------------------------ */

async function fetchModelBytes(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const resp = await fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  // Content-Length is a hint from the server, not a promise, so the real guard
  // counts bytes off the stream. The cheap check first only saves a download.
  const declared = Number(resp.headers.get("content-length") ?? "0");
  if (declared > MAX_VRM_BYTES) {
    throw new Error(`model declares ${declared} bytes (max ${MAX_VRM_BYTES})`);
  }
  if (!resp.body) return await resp.arrayBuffer();

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_VRM_BYTES) {
      await reader.cancel();
      throw new Error(`model exceeded ${MAX_VRM_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Refuse any in-file resource URI that leaves our origin.
 *
 * A glTF can point its buffers and textures anywhere. Self-contained models are
 * the policy, but policy is not enforcement: this modifier is what turns a
 * hostile `"uri": "https://tracker.example/pixel.png"` into a dead request
 * instead of a callback to whoever authored the model.
 */
function makeStrictLoadingManager(baseHref: string): LoadingManager {
  const manager = new LoadingManager();
  const base = new URL(baseHref, window.location.origin);
  manager.setURLModifier((raw) => {
    if (!raw) return raw;
    // Data / blob URIs are already inline — that is the self-contained case.
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      return "";
    }
    if (resolved.origin !== window.location.origin) {
      console.warn(
        `[talking-face] refused external glTF resource: ${resolved.origin}`,
      );
      return ""; // an empty URL fails the sub-load; the model still renders
    }
    return resolved.href;
  });
  return manager;
}

/* ------------------------------------------------------------------ *
 * Mouth driver — the one interface both rigs implement.
 * ------------------------------------------------------------------ */

interface MouthDriver {
  label: string;
  setMouthOpen(v: number): void;
  setBlink(v: number): void;
  update(deltaSeconds: number): void;
}

function driverForVrm(vrm: VRM): MouthDriver {
  const em = vrm.expressionManager;
  const names = em?.expressions?.map((e) => e.expressionName) ?? [];
  const mouth = resolveMouthMorph(names);
  const blink = names.find((n) => n.toLowerCase() === "blink") ?? null;
  // Last resort when a rig has no expressions at all: hinge the jaw bone.
  const jawBone = mouth
    ? null
    : (vrm.humanoid?.getNormalizedBoneNode("jaw") ?? null);

  return {
    label: mouth ?? (jawBone ? "jaw-bone" : "none"),
    setMouthOpen(v) {
      if (mouth && em) em.setValue(mouth, v);
      else if (jawBone) jawBone.rotation.x = v * 0.4;
    },
    setBlink(v) {
      if (blink && em) em.setValue(blink, v);
    },
    update(delta) {
      vrm.update(delta);
    },
  };
}

function driverForHead(rig: HeadRig, label = "procedural-jaw"): MouthDriver {
  return {
    label,
    setMouthOpen: (v) => rig.setMouthOpen(v),
    setBlink: (v) => rig.setBlink(v),
    update: () => {},
  };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function VrmAvatar({
  participantId,
  slug,
  name,
  vrmSrc,
  size,
  expression = "idle",
  isSpeaking = false,
  debug = false,
  mountOrder = DEFAULT_MOUNT_ORDER,
  preferred = "auto",
  onFail,
}: VrmAvatarProps) {
  const { remoteParticipants, version } = useVoice();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Value key for the effect deps: the ORDER is what matters, not the array's
  // identity (AgentPresenceFace memoizes it, but the contract should not
  // depend on that).
  const mountOrderKey = mountOrder.join(">");

  /* The participant handle lives in a REF, not in state. The render loop reads
   * levels off it 60 times a second; routing that through React would
   * re-render the tile on every frame. Duck-typed (not RemoteParticipant) so
   * the face lab can drive it with a fake — the loop only ever touches these
   * members. */
  const participantRef = useRef<{
    audioLevel: number;
    getTrackPublication?: (
      source: Track.Source,
    ) => { track?: unknown } | undefined;
    audioTrackPublications?: Map<string, { track?: unknown }>;
  } | null>(null);
  useEffect(() => {
    /* `version` is in the deps on purpose and is otherwise unused: the LiveKit
     * SDK hands back the SAME participant object across joins/leaves, so an
     * array whose contents changed can still be reference-equal and the lookup
     * would never re-run. VoiceProvider bumps `version` on every sync for
     * exactly this. */
    void version;
    participantRef.current =
      remoteParticipants.find((p) => p.identity === participantId) ?? null;
  }, [remoteParticipants, participantId, version]);

  const speakingRef = useRef(isSpeaking);
  speakingRef.current = isSpeaking;
  const expressionRef = useRef(expression);
  expressionRef.current = expression;

  // Throttled (≤10 Hz) mirror of the probe, for the HUD only. The morphs are
  // never driven from this.
  const [hud, setHud] = useState<TalkingFaceProbe | null>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let probeError: string | null = null;
    const hue = identityFor(slug, name).color;
    /* A pop-out tile lives in a DETACHED DOCUMENT with its OWN window. Every
     * listener and timer below must be bound to and torn down from THAT window,
     * not from the main one — a pagehide handler added to the popup and removed
     * from the opener is a leak that survives every open/close cycle. */
    const hostDocument = host.ownerDocument;
    const hostWindow = hostDocument.defaultView ?? window;

    /* ---- renderer -------------------------------------------------- */
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
    } catch (e) {
      onFailRef.current(`WebGLRenderer: ${(e as Error).message}`);
      return;
    }
    // Cap the pixel ratio: a 3x phone screen would otherwise render 9x the
    // pixels for a 96px bust, which is where the frame budget goes to die.
    renderer.setPixelRatio(Math.min(hostWindow.devicePixelRatio || 1, 1.5));
    renderer.setClearAlpha(0);
    const canvas = renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(28, 1, 0.1, 40);
    camera.position.set(0, 0, 5.4);

    /* TOON LIGHTING, not studio lighting.
     *
     * The old rig (2.1 key + 1.15 lavender ambient) was tuned for a PBR bust
     * and it is exactly what made a "white" body render pale violet. Both rigs
     * we ship are toon-shaded — the procedural head via MeshToonMaterial, a VRM
     * via MToon — so what matters is landing the lit and unlit sides on
     * DIFFERENT plateaus of the ramp: enough ambient that the shadow side is
     * light grey rather than a hole, low enough that the ramp's steps survive.
     * White ambient, not lavender: the coat has to read as white paper. */
    /* These intensities look enormous and are not: three's diffuse BRDF carries
     * a 1/π, so a surface fully lit by intensity I settles at I/π. Landing a
     * WHITE coat on white takes ambient + key ≈ 3.6, and the shade step is
     * ambient/π alone. Read them as "shade tone 0.62, lit tone clipped". */
    const key = new DirectionalLight(new Color("#ffffff"), 1.65);
    key.position.set(1.3, 1.8, 2.4);
    scene.add(key);
    // A whisper of identity on the shadow side — agents stay distinguishable
    // now that every coat is the same white. Deliberately weak: an identity
    // rim at the old 1.25 is precisely what made the last head read lavender.
    const rim = new DirectionalLight(new Color(hue), 0.45);
    rim.position.set(-2.2, 0.4, -1.4);
    scene.add(rim);
    // Ambient IS the shade tone: with a toon ramp that starts at 0, a surface
    // turned away from the key gets ambient and nothing else, so this number
    // is literally "how light is the grey side of a white coat".
    scene.add(new AmbientLight(new Color("#ffffff"), 1.95));

    const holder = new Group();
    scene.add(holder);

    let driver: MouthDriver | null = null;
    let headRig: HeadRig | null = null;
    let loadedVrm: VRM | null = null;
    let probeSource: TalkingFaceProbe["source"] = "placeholder";

    /* ---- frame the subject ----------------------------------------- *
     * `margin` is how much empty room to leave around the fitted extent. An
     * unknown VRM may be a full body, so it keeps the loose 1.55; the
     * procedural head is a BUST we authored and whose extents we know, and at
     * 1.55 it sat marooned in the middle of the tile at a size where the
     * outlines stopped resolving. 1.16 fills the tile the way the portraits
     * fill their frame. */
    const frameSubject = (root: Group, margin = 1.55) => {
      const box = new Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const sizeV = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      // Fit the WIDER of height/width so a bust and a full body both frame.
      const extent = Math.max(sizeV.y, sizeV.x) || 1;
      const dist = (extent / 2) / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(center.x, center.y + sizeV.y * 0.06, center.z + dist * margin);
      camera.lookAt(center.x, center.y + sizeV.y * 0.04, center.z);
    };

    /* ---- placeholder (default today) -------------------------------- */
    const mountPlaceholder = () => {
      headRig = buildProceduralUnicornHead({
        hue,
        mane: resolveManeStyle(slug, name),
      });
      holder.add(headRig.root);
      driver = driverForHead(headRig);
      probeSource = "placeholder";
      frameSubject(headRig.root, 1.16);
    };

    /* ---- real model ------------------------------------------------- */
    const abort = new AbortController();
    const timeout = hostWindow.setTimeout(
      () => abort.abort(new Error("timeout")),
      VRM_LOAD_TIMEOUT_MS,
    );

    const mountVrm = async (url: string) => {
      const bytes = await fetchModelBytes(url, abort.signal);
      if (disposed) return;
      const basePath = url.slice(0, url.lastIndexOf("/") + 1);
      const loader = new GLTFLoader(makeStrictLoadingManager(basePath));
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.parseAsync(bytes, basePath);
      if (disposed) return;

      const vrm = (gltf.userData as { vrm?: VRM }).vrm ?? null;
      if (vrm) {
        // Version-tolerant: these helpers have moved between three-vrm majors,
        // and a missing optimisation must not cost us the whole face.
        try {
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.combineSkeletons(gltf.scene);
          VRMUtils.rotateVRM0(vrm);
        } catch {
          /* cosmetic/perf helpers only */
        }
        loadedVrm = vrm;
        holder.add(vrm.scene);
        driver = driverForVrm(vrm);
        probeSource = "vrm";
        frameSubject(vrm.scene as unknown as Group);
        return;
      }

      // A plain glTF/GLB with no VRM extension still counts: drive the first
      // jaw/mouth morph we can find. This is what lets Brand-Ops hand us a head
      // export before the full VRM rig exists.
      const morphNames: string[] = [];
      gltf.scene.traverse((o) => {
        const dict = (o as unknown as { morphTargetDictionary?: Record<string, number> })
          .morphTargetDictionary;
        if (dict) morphNames.push(...Object.keys(dict));
      });
      const morph = resolveMouthMorph(morphNames);
      if (!morph) throw new Error("model has no VRM extension and no mouth morph");
      holder.add(gltf.scene);
      probeSource = "vrm";
      driver = {
        label: morph,
        setMouthOpen(v) {
          gltf.scene.traverse((o) => {
            const m = o as unknown as {
              morphTargetDictionary?: Record<string, number>;
              morphTargetInfluences?: number[];
            };
            const idx = m.morphTargetDictionary?.[morph];
            if (idx !== undefined && m.morphTargetInfluences) {
              m.morphTargetInfluences[idx] = v;
            }
          });
        },
        setBlink: () => {},
        update: () => {},
      };
      frameSubject(gltf.scene as unknown as Group);
    };

    /* ---- rigged 2D portrait ----------------------------------------- */
    const mountPuppet = async (spec: NonNullable<ReturnType<typeof puppetForAgent>>) => {
      const rig = await buildPortraitPuppet({ spec, signal: abort.signal });
      if (disposed) {
        rig.dispose();
        return;
      }
      headRig = rig;
      holder.add(rig.root);
      driver = driverForHead(rig, "puppet-composite");
      probeSource = "puppet";
      /* Framed TIGHTER than 1 so the quad overflows the viewport. setHeadTurn
       * translates the plane, and at a margin of 1 that slide would expose the
       * empty space past the artwork's edge. */
      frameSubject(rig.root, 0.92);
    };

    /* Resolved from the AGENT, not from `portraitSrc`. The roster URL is
     * cross-origin (Brigade's UI, not ours) so it cannot become a WebGL
     * texture, and 41 of Brigade's 53 avatar bindings name files that do not
     * exist — neither fact is visible until the load fails. `portraitSrc`
     * stays the source of truth for the flat portrait rung, where a 404 only
     * costs an image. */
    const puppetSpec = puppetForAgent(slug, name);

    /**
     * The ladder is the caller's `mountOrder` — `faceMountPlan(preference ×
     * availability × flag)` — walked best first. Under "auto" that is the
     * shipped BRANDED PUPPET → VRM → procedural order (the branded puppet
     * outranks a VRM by direction, 2026-08-08: our characters' approved
     * artwork is the call face; a generic model is the stand-in, never the
     * other way around). A style preference reorders or shortens it — "vrm"
     * tries the model first; "puppet" has no 3D fallback at all. Each rung
     * records why it failed and falls to the next; a ladder that runs out
     * calls `onFail`, which steps the tile down to the 2D portrait rung.
     * The procedural head appears in the order only when the talking-face
     * flag allows generic faces, so it can never mount on preference alone.
     */
    const effectiveOrder = mountOrder.filter(
      (source) =>
        (source === "puppet" && !!puppetSpec) ||
        (source === "vrm" && !!vrmSrc) ||
        source === "placeholder",
    );

    const mountBest = async () => {
      for (const source of effectiveOrder) {
        if (disposed) return;
        if (source === "puppet" && puppetSpec) {
          try {
            await mountPuppet(puppetSpec);
            return;
          } catch (e) {
            if (disposed) return;
            const why = e instanceof Error ? e.message : String(e);
            console.warn(`[talking-face] puppet failed (${puppetSpec.texture}): ${why}`);
            probeError ??= why;
          }
        } else if (source === "vrm" && vrmSrc) {
          try {
            await mountVrm(vrmSrc);
            return;
          } catch (e) {
            if (disposed) return;
            const why = e instanceof Error ? e.message : String(e);
            console.warn(`[talking-face] model load failed (${vrmSrc}): ${why}`);
            probeError ??= why;
          }
        } else if (source === "placeholder") {
          mountPlaceholder();
          return;
        }
      }
      if (disposed) return;
      onFailRef.current(
        probeError
          ? `face mount failed (${probeError}) and no further fallback is enabled`
          : "no mountable face for this style (no assets, generic faces not enabled)",
      );
    };

    if (effectiveOrder[0] === "placeholder") {
      // Nothing to load — mount synchronously so the tile is never briefly bare.
      hostWindow.clearTimeout(timeout);
      mountPlaceholder();
    } else if (effectiveOrder.length > 0) {
      void mountBest().finally(() => hostWindow.clearTimeout(timeout));
    } else {
      // Shouldn't be reachable (AgentPresenceFace refuses the face rung when
      // the plan is empty) — but if it is, step down rather than render
      // an empty canvas.
      hostWindow.clearTimeout(timeout);
      onFailRef.current("no mountable face for this style");
    }

    /* ---- sizing ----------------------------------------------------- */
    let boxW = 0;
    let boxH = 0;
    const resize = () => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w === boxW && h === boxH) return;
      boxW = w;
      boxH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    /* ---- level source: analyser over the subscribed track ----------- *
     * Rebuilt whenever the participant's audio track changes (subscribe
     * churn, device handoff). The per-frame check is property reads; the
     * expensive create runs only on an actual change. If no track is
     * available — or the AudioContext is suspended (autoplay policy) — the
     * loop falls back to `participant.audioLevel` and keeps trying. */
    let levelAnalyser: ReturnType<typeof createAudioAnalyser> | null = null;
    let analysedTrackId: string | null = null;
    let lastResumeAttempt = 0;

    const audioTrackOf = (
      participant: typeof participantRef.current,
    ): { mediaStreamTrack: MediaStreamTrack; kind?: string } | null => {
      if (!participant) return null;
      try {
        const micPub = participant.getTrackPublication?.(
          Track.Source.Microphone,
        );
        const firstAudioPub = participant.audioTrackPublications
          ?.values()
          .next().value;
        const track = (micPub?.track ?? firstAudioPub?.track) as
          | { mediaStreamTrack?: unknown; kind?: string }
          | undefined;
        if (
          track &&
          track.mediaStreamTrack instanceof MediaStreamTrack &&
          (track.kind === undefined || track.kind === "audio")
        ) {
          return track as { mediaStreamTrack: MediaStreamTrack; kind?: string };
        }
      } catch {
        /* duck-typed access — a shape we don't know is just "no track" */
      }
      return null;
    };

    const teardownAnalyser = () => {
      const current = levelAnalyser;
      levelAnalyser = null;
      analysedTrackId = null;
      if (current) {
        void current.cleanup().catch(() => {});
      }
    };

    const ensureAnalyser = (now: number) => {
      const track = audioTrackOf(participantRef.current);
      const trackId = track?.mediaStreamTrack.id ?? null;
      if (trackId !== analysedTrackId) {
        teardownAnalyser();
        analysedTrackId = trackId;
        if (track) {
          try {
            /* createAudioAnalyser only touches `.mediaStreamTrack` when not
             * cloning, so the structural check above is the real contract.
             * Window widened from the library's -100..-80 default: that
             * window saturates on any speech and the mouth would pin open. */
            levelAnalyser = createAudioAnalyser(track as RemoteAudioTrack, {
              cloneTrack: false,
              fftSize: 256,
              smoothingTimeConstant: 0.6,
              minDecibels: -90,
              maxDecibels: -20,
            });
          } catch (e) {
            levelAnalyser = null;
            console.warn(
              `[talking-face] audio analyser unavailable for ${participantId}:`,
              e,
            );
          }
        }
      }
      // Autoplay policy can leave a fresh AudioContext suspended; a suspended
      // graph reports all-zero bins. Nudge it, at most once a second.
      const ctx = levelAnalyser?.analyser.context;
      if (ctx && ctx.state === "suspended" && now - lastResumeAttempt > 1000) {
        lastResumeAttempt = now;
        void (ctx as AudioContext).resume().catch(() => {});
      }
    };

    /* ---- the loop --------------------------------------------------- */
    let smoothed = 0;
    let frames = 0;
    let fps = 0;
    let fpsWindowStart = performance.now();
    let fpsWindowFrames = 0;
    let lastTick = performance.now();
    let lastHud = 0;
    let onScreen = true;
    let ticker: "raf" | "interval" = "raf";
    let rafId = 0;
    let intervalId = 0;

    const startedAt = performance.now();

    const tick = () => {
      const now = performance.now();
      const delta = Math.min(0.1, (now - lastTick) / 1000);
      lastTick = now;
      frames += 1;
      fpsWindowFrames += 1;
      if (now - fpsWindowStart >= 1000) {
        fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
        fpsWindowStart = now;
        fpsWindowFrames = 0;
      }

      ensureAnalyser(now);
      const analyserLive =
        levelAnalyser !== null &&
        levelAnalyser.analyser.context.state === "running";
      let raw: number;
      let levelSource: TalkingFaceProbe["levelSource"];
      if (analyserLive && levelAnalyser) {
        raw = levelAnalyser.calculateVolume();
        levelSource = "analyser";
      } else {
        raw = participantRef.current?.audioLevel ?? 0;
        levelSource = "participant";
      }
      smoothed = smoothLevel(smoothed, raw, 0.3);
      const elapsed = now - startedAt;
      const driven =
        levelSource === "analyser"
          ? mouthOpenFromAnalyserVolume(smoothed)
          : mouthOpenFromLevel(smoothed);
      const mouth = driven > 0 ? driven : idleMouthOpen(elapsed);

      if (driver) {
        driver.setMouthOpen(mouth);
        driver.setBlink(blinkAmount(elapsed));
        driver.update(delta);
      }
      if (headRig) {
        // A little life so an idle agent does not read as a frozen frame.
        headRig.setHeadTurn(
          Math.sin(elapsed / 2600) * 0.16,
          Math.sin(elapsed / 3700) * 0.06 - (speakingRef.current ? 0.03 : 0),
        );
      }

      if (onScreen) {
        resize();
        renderer.render(scene, camera);
      }

      const probe: TalkingFaceProbe = {
        source: probeSource,
        preferred,
        driver: driver?.label ?? "none",
        level: raw,
        levelSource,
        mouthOpen: mouth,
        fps,
        frames,
        ticker,
        vrmSrc,
        error: probeError,
      };
      const registry = (window.__stableTalkingFace ??= {});
      registry[participantId] = probe;

      // HUD state at ≤10 Hz. Never the morph source — see the file header.
      if (debug && now - lastHud > 100) {
        lastHud = now;
        setHud(probe);
      }
    };

    const stopLoop = () => {
      if (rafId) hostWindow.cancelAnimationFrame(rafId);
      if (intervalId) hostWindow.clearInterval(intervalId);
      rafId = 0;
      intervalId = 0;
    };

    const rafLoop = () => {
      tick();
      rafId = hostWindow.requestAnimationFrame(rafLoop);
    };

    const startLoop = () => {
      stopLoop();
      /* ⚠️ requestAnimationFrame DOES NOT FIRE IN A HIDDEN TAB, and every
       * automated / background tab is hidden. A face that only animates under
       * rAF is a face that is provably dead to any driver, any screenshot
       * harness, and any second monitor the user has tabbed away from. So:
       * rAF when we can see, a timer when we cannot. */
      if (hostDocument.visibilityState === "hidden") {
        ticker = "interval";
        intervalId = hostWindow.setInterval(tick, 66); // ~15 Hz
      } else {
        ticker = "raf";
        rafId = hostWindow.requestAnimationFrame(rafLoop);
      }
    };

    const onVisibility = () => startLoop();
    hostDocument.addEventListener("visibilitychange", onVisibility);

    /* Watchdog. `visibilityState === "visible"` is a signal we do not own, and
     * it lies: a composited-out tab, an occluded window and some automation
     * harnesses all report visible while rAF never fires. Poll something we DO
     * own — our own frame counter — and fall back to a timer if it stops. */
    const watchdog = hostWindow.setInterval(() => {
      if (ticker === "interval") return;
      if (performance.now() - lastTick < 500) return;
      ticker = "interval";
      stopLoop();
      intervalId = hostWindow.setInterval(tick, 66);
    }, 700);

    // Pause rendering (not the loop) when the tile scrolls out of view.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) onScreen = e.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(host);

    startLoop();

    /* ---- teardown --------------------------------------------------- */
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stopLoop();
      teardownAnalyser();
      hostWindow.clearInterval(watchdog);
      hostWindow.clearTimeout(timeout);
      abort.abort();
      hostDocument.removeEventListener("visibilitychange", onVisibility);
      hostWindow.removeEventListener("pagehide", dispose);
      io.disconnect();
      ro.disconnect();
      headRig?.dispose();
      if (loadedVrm) {
        try {
          VRMUtils.deepDispose(loadedVrm.scene);
        } catch {
          /* older three-vrm — the renderer teardown below still frees the GPU */
        }
      }
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      delete window.__stableTalkingFace?.[participantId];
    };

    hostWindow.addEventListener("pagehide", dispose);

    return dispose;
    // `mountOrder` (the array) is represented by `mountOrderKey` — the order's
    // VALUE is the dependency, not the array identity, so a parent that
    // rebuilds an identical plan does not tear down a live WebGL scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId, slug, name, vrmSrc, debug, mountOrderKey, preferred]);

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full"
      style={{ minWidth: size, minHeight: size }}
      data-talking-face={participantId}
      data-talking-face-source={hud?.source ?? undefined}
      aria-label={`${name}${isSpeaking ? " is speaking" : ""}`}
      role="img"
    >
      {debug && hud && (
        <span className="pointer-events-none absolute left-1 top-1 whitespace-pre rounded bg-black/75 px-1.5 py-1 font-mono text-[10px] leading-tight text-amber-300">
          {`${hud.source}${hud.source === "placeholder" ? " (procedural, no VRM)" : ""} · pref ${hud.preferred}\n` +
            `${hud.fps.toFixed(0)} fps · ${hud.ticker}\n` +
            `lvl ${hud.level.toFixed(3)} (${hud.levelSource}) → mouth ${hud.mouthOpen.toFixed(2)}\n` +
            `drv ${hud.driver}${hud.error ? `\nerr ${hud.error}` : ""}`}
        </span>
      )}
    </div>
  );
}

export default VrmAvatar;
