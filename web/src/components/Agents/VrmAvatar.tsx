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
 *   * `vrmSrc` set  → the real rigged model, mouth driven through the rig's own
 *     viseme/ARKit morph.
 *   * `vrmSrc` null → the PROCEDURAL PLACEHOLDER head. This is the state today:
 *     no brand VRM has been authored, so what you see is a generic unicorn in
 *     the agent's identity hue, not the character. See proceduralUnicornHead.ts.
 *
 * WHAT DRIVES THE MOUTH (phase 1)
 * -------------------------------
 * LiveKit's `RemoteParticipant.audioLevel`, sampled inside the render loop.
 * Nothing in `agents/` ships for this — no viseme stream, no TTS hook, no
 * rebuild of the agent worker. The level is read off a ref and applied to the
 * morph IMPERATIVELY; it never becomes React state, because 60 setState calls a
 * second would re-render the whole tile subtree and cost more than the renderer.
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
import { useVoice } from "@/contexts/VoiceProvider";
import { identityFor } from "@/lib/identity";
import { MAX_VRM_BYTES, VRM_LOAD_TIMEOUT_MS } from "@/lib/resolveVrmSrc";
import {
  blinkAmount,
  idleMouthOpen,
  mouthOpenFromLevel,
  resolveMouthMorph,
  smoothLevel,
} from "@/lib/mouthShape";
import type { PresenceExpression } from "@/lib/presenceFace";
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
  /** "vrm" = a real rigged model. "placeholder" = the procedural head. */
  source: "vrm" | "placeholder";
  /** Which morph/expression the mouth is driving, or "jaw-bone". */
  driver: string;
  /** Raw LiveKit audioLevel this frame. */
  level: number;
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
  /** Model URL, or null → procedural placeholder head. */
  vrmSrc: string | null;
  size: number;
  expression?: PresenceExpression;
  isSpeaking?: boolean;
  debug?: boolean;
  /** Step DOWN the ladder. Called once, with a reason, and never retried. */
  onFail: (reason: string) => void;
}

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

function driverForHead(rig: HeadRig): MouthDriver {
  return {
    label: "procedural-jaw",
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
  onFail,
}: VrmAvatarProps) {
  const { remoteParticipants, version } = useVoice();
  const hostRef = useRef<HTMLDivElement | null>(null);

  /* The participant handle lives in a REF, not in state. The render loop reads
   * `.audioLevel` off it 60 times a second; routing that through React would
   * re-render the tile on every frame. */
  const participantRef = useRef<{ audioLevel: number } | null>(null);
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

    if (vrmSrc) {
      void mountVrm(vrmSrc)
        .catch((e: unknown) => {
          if (disposed) return;
          const why = e instanceof Error ? e.message : String(e);
          console.warn(`[talking-face] model load failed (${vrmSrc}): ${why}`);
          // A configured model that will not load is a real failure, but it is
          // not a reason to show nothing: keep the surface alive on the
          // placeholder and record the error on the probe.
          probeError = why;
          mountPlaceholder();
        })
        .finally(() => hostWindow.clearTimeout(timeout));
    } else {
      hostWindow.clearTimeout(timeout);
      mountPlaceholder();
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

      const raw = participantRef.current?.audioLevel ?? 0;
      smoothed = smoothLevel(smoothed, raw, 0.3);
      const elapsed = now - startedAt;
      const driven = mouthOpenFromLevel(smoothed);
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
        driver: driver?.label ?? "none",
        level: raw,
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
  }, [participantId, slug, name, vrmSrc, debug]);

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
          {`${hud.source}${hud.source === "placeholder" ? " (NOT brand art)" : ""}\n` +
            `${hud.fps.toFixed(0)} fps · ${hud.ticker}\n` +
            `lvl ${hud.level.toFixed(3)} → mouth ${hud.mouthOpen.toFixed(2)}\n` +
            `drv ${hud.driver}${hud.error ? `\nerr ${hud.error}` : ""}`}
        </span>
      )}
    </div>
  );
}

export default VrmAvatar;
