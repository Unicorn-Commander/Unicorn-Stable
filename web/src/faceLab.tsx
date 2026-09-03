/**
 * Face lab — proves the CALL-TILE TALKING FACE end to end, headlessly.
 *
 * The static-face report ("in video it was just the static avatar image")
 * survived source review twice, because both halves looked right in
 * isolation: the puppet mounted in the puppet lab, and the level plumbing
 * typechecked. What was never verified was the COMPOSED pipeline —
 * AgentPresenceFace rung selection → lazy VrmAvatar mount → puppet driver →
 * a LIVE level source moving the mouth. This lab mounts exactly that stack
 * under a synthetic VoiceProvider context and asserts, from the
 * `window.__stableTalkingFace` probe, that the mouth actually OPENS AND
 * CLOSES over time.
 *
 * Two modes (?source=):
 *   analyser    — a real WebAudio oscillator, gain-modulated at syllable
 *                 rate, becomes the fake participant's subscribed audio
 *                 track. Exercises the createAudioAnalyser path VrmAvatar
 *                 prefers. Needs a runnable AudioContext (headless: pass
 *                 --autoplay-policy=no-user-gesture-required); reports SKIP
 *                 rather than a false FAIL when the context can't run.
 *   participant — no track; the fake participant's `audioLevel` property is
 *                 driven directly. Exercises the SFU-level fallback with no
 *                 WebAudio dependency at all, so it is deterministic under
 *                 any autoplay policy.
 *
 * Identity split mirrors production exactly: the LiveKit identity is the
 * TYPE-shaped "agent-brigade" (what the worker joins as) while the art
 * persona is "majik" — the two-name situation the persona resolver exists
 * for.
 *
 * Dev only — vite serves /face-lab.html from the project root; this entry is
 * never referenced by the app bundle.
 */
import { createRoot } from "react-dom/client";
// The REAL app stylesheet: the face host sizes itself with Tailwind utilities
// (h-full/w-full), and the MIN_FACE_BOX_PX measurement gate reads the result.
// Without this import the host measures ~0 and the lab "fails" for a reason
// production never has — which is itself what the first lab run proved.
import "./styles/globals.css";
import { AgentPresenceFace } from "@/components/Agents/AgentPresenceFace";
import {
  VoiceContextForLab,
  type VoiceContextValue,
} from "@/contexts/VoiceProvider";
import type { TalkingFaceProbe } from "@/components/Agents/VrmAvatar";

const params = new URLSearchParams(location.search);

/**
 * WHO the lab renders. Defaults reproduce the original run exactly (the
 * type-shaped worker identity + Majik's persona), and the overrides exist
 * because "does the mouth move" is a question per CHARACTER, not once for the
 * codebase: a persona reached through a different seam — Rook, whose art comes
 * from his participant row rather than from his slug — is a different code
 * path with its own way of silently mounting the wrong face.
 *
 *   ?identity= the LiveKit identity (also the probe key)
 *   ?persona=  the art slug            ?name= display name
 *   ?art=      CallTilePersona.artUrl — the participant's own picture
 */
const AGENT_IDENTITY = params.get("identity") || "agent-brigade";
const PERSONA_SLUG = params.get("persona") || "majik";
const PERSONA_NAME = params.get("name") || "Majik";
const PERSONA_ART = params.get("art");

const mode =
  params.get("source") === "participant"
    ? ("participant" as const)
    : ("analyser" as const);

/* ------------------------------------------------------------------ *
 * Synthetic audio + fake participant
 * ------------------------------------------------------------------ */

interface FakeTrack {
  kind: "audio";
  mediaStreamTrack: MediaStreamTrack;
}

const fakeParticipant: {
  identity: string;
  sid: string;
  name: string;
  audioLevel: number;
  isSpeaking: boolean;
  getTrackPublication: (source: unknown) => { track?: FakeTrack } | undefined;
  audioTrackPublications: Map<string, { track?: FakeTrack }>;
} = {
  identity: AGENT_IDENTITY,
  sid: "PA_facelab",
  name: "stable-brigade",
  audioLevel: 0,
  isSpeaking: true,
  getTrackPublication: () => undefined,
  audioTrackPublications: new Map(),
};

let oscContext: AudioContext | null = null;

function startSyntheticVoice(): string {
  if (mode === "participant") {
    // Drive the SFU-style level property directly: speech-shaped bursts —
    // ~300ms on, ~200ms off — at a plausible LiveKit magnitude (0..0.2).
    const started = performance.now();
    const drive = () => {
      const t = (performance.now() - started) / 1000;
      const burst = Math.sin(2 * Math.PI * 2 * t) > -0.2 ? 1 : 0;
      const syllable = Math.abs(Math.sin(2 * Math.PI * 3.4 * t));
      // TRUE silence between bursts — the level must dip under the noise
      // floor so the assertion can see the mouth CLOSE, not just move.
      fakeParticipant.audioLevel = burst ? 0.04 + 0.16 * syllable : 0;
      requestAnimationFrame(drive);
    };
    drive();
    return "participant levels driven";
  }

  // analyser mode: oscillator → syllable-gain → MediaStreamDestination.
  const ctx = new AudioContext();
  oscContext = ctx;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth"; // harmonically rich — spreads energy across bins
  osc.frequency.value = 160;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();

  // Syllable envelope: bursts of voice separated by silence.
  const started = ctx.currentTime;
  const shape = () => {
    const t = ctx.currentTime - started;
    const burst = Math.sin(2 * Math.PI * 1.6 * t) > -0.3 ? 1 : 0;
    const syllable = Math.abs(Math.sin(2 * Math.PI * 3.4 * t));
    gain.gain.value = burst * (0.25 + 0.75 * syllable);
    setTimeout(shape, 40);
  };
  shape();

  const streamTrack = dest.stream.getAudioTracks()[0];
  if (streamTrack) {
    const track: FakeTrack = { kind: "audio", mediaStreamTrack: streamTrack };
    fakeParticipant.getTrackPublication = () => ({ track });
    fakeParticipant.audioTrackPublications = new Map([["pub", { track }]]);
  }
  // Autoplay policy may hold the context suspended; keep nudging, and let a
  // human click grant the gesture when running the lab in a real browser.
  const resume = () => void ctx.resume().catch(() => {});
  resume();
  const nudge = setInterval(() => {
    if (ctx.state === "running") clearInterval(nudge);
    else resume();
  }, 300);
  addEventListener("pointerdown", resume);
  return "oscillator track attached";
}

/* ------------------------------------------------------------------ *
 * Mount the REAL component stack under a synthetic voice context
 * ------------------------------------------------------------------ */

const voiceValue: VoiceContextValue = {
  room: null,
  localParticipant: null,
  // The lab's whole point is driving the real component with a fake — the
  // component contract is documented as duck-typed on exactly these members.
  remoteParticipants: [fakeParticipant as never],
  isConnected: true,
  isConnecting: false,
  error: null,
  audioBlocked: false,
  version: 1,
  connect: async () => true,
  disconnect: () => {},
  startAudio: async () => {},
  claimScreenAudio: () => {},
  releaseScreenAudio: () => {},
  devices: { audioinput: [], videoinput: [], audiooutput: [] },
  selectedDevices: { audioinput: "", videoinput: "", audiooutput: "" },
  refreshDevices: async () => {},
  switchDevice: async () => {},
  deviceSignal: { audioinput: true, videoinput: true },
};

const note = startSyntheticVoice();

createRoot(document.getElementById("stage")!).render(
  <VoiceContextForLab.Provider value={voiceValue}>
    <AgentPresenceFace
      participantId={AGENT_IDENTITY}
      id={PERSONA_SLUG}
      name={PERSONA_NAME}
      artUrl={PERSONA_ART}
      size={96}
      surface="stage"
      isSpeaking
    />
  </VoiceContextForLab.Provider>,
);

/* ------------------------------------------------------------------ *
 * Probe sampling + verdict
 * ------------------------------------------------------------------ */

const WARMUP_MS = 2500; // texture fetch + lazy chunk + analyser spin-up
const SAMPLE_MS = 5000;
const SAMPLE_EVERY_MS = 100;

interface Sample {
  mouthOpen: number;
  level: number;
  levelSource: TalkingFaceProbe["levelSource"];
  source: TalkingFaceProbe["source"];
  texture: TalkingFaceProbe["texture"];
}

const samples: Sample[] = [];
const startedAt = performance.now();

const el = document.getElementById("result")!;

const sampler = setInterval(() => {
  const now = performance.now();
  const probe = window.__stableTalkingFace?.[AGENT_IDENTITY];
  if (probe && now - startedAt > WARMUP_MS) {
    samples.push({
      mouthOpen: probe.mouthOpen,
      level: probe.level,
      levelSource: probe.levelSource,
      source: probe.source,
      texture: probe.texture,
    });
  }
  if (now - startedAt > WARMUP_MS + SAMPLE_MS) {
    clearInterval(sampler);
    finish(probe ?? null);
  }
}, SAMPLE_EVERY_MS);

function finish(lastProbe: TalkingFaceProbe | null) {
  const mouthMin = samples.length ? Math.min(...samples.map((s) => s.mouthOpen)) : NaN;
  const mouthMax = samples.length ? Math.max(...samples.map((s) => s.mouthOpen)) : NaN;
  const faceSource = samples.at(-1)?.source ?? lastProbe?.source ?? "none";
  const levelSource = samples.at(-1)?.levelSource ?? "none";
  const swing = mouthMax - mouthMin;

  // The face must be the branded puppet, and the mouth must clearly open AND
  // close across the window — a frozen mouth (the shipped bug) has ~0 swing.
  const mounted = faceSource === "puppet";
  const talks = Number.isFinite(swing) && swing >= 0.25 && mouthMin <= 0.12;
  const expectedLevel = mode === "analyser" ? "analyser" : "participant";
  const rightSource = levelSource === expectedLevel;

  let verdict: "PASS" | "FAIL" | "SKIP";
  let reason = "";
  if (mode === "analyser" && oscContext && oscContext.state !== "running") {
    verdict = "SKIP";
    reason =
      "AudioContext never ran (autoplay policy) — rerun with " +
      "--autoplay-policy=no-user-gesture-required or click the page";
  } else if (mounted && talks && rightSource) {
    verdict = "PASS";
  } else {
    verdict = "FAIL";
    if (!mounted) reason = `face source is "${faceSource}", wanted "puppet"`;
    else if (!rightSource)
      reason = `level source is "${levelSource}", wanted "${expectedLevel}"`;
    else reason = `mouth swing ${swing.toFixed(3)} too small (min ${mouthMin.toFixed(3)})`;
  }

  const result = {
    verdict,
    mode,
    // Which character actually ran — a lab whose verdict does not name its
    // subject is one copy-pasted URL away from proving the wrong thing.
    identity: AGENT_IDENTITY,
    persona: PERSONA_SLUG,
    art: PERSONA_ART,
    // WHICH picture mounted. `source:"puppet"` only says a rigged portrait
    // won; it cannot tell Rook's drawing from the generic Claude one, which
    // is the exact confusion this run exists to settle.
    texture: samples.at(-1)?.texture ?? lastProbe?.texture ?? null,
    reason,
    faceSource,
    levelSource,
    mouthMin: Number(mouthMin.toFixed(3)),
    mouthMax: Number(mouthMax.toFixed(3)),
    swing: Number(swing.toFixed(3)),
    samples: samples.length,
    note,
    probeError: lastProbe?.error ?? null,
  };

  el.dataset.verdict = verdict;
  el.dataset.mouthMin = String(result.mouthMin);
  el.dataset.mouthMax = String(result.mouthMax);
  el.dataset.faceSource = faceSource;
  el.dataset.levelSource = levelSource;
  el.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.ready = "1";
  console.log("FACELAB_RESULT " + JSON.stringify(result));
}
