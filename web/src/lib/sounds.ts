/**
 * Synthesized UI sound cues — no audio assets, pure WebAudio.
 *
 * Design goals: SHORT (<350ms total), quiet (peak gain <=0.12), and gentle
 * attack/release envelopes so nothing clicks or startles. Three cues:
 *
 *   call-join   rising two-note chime  (sine 520Hz -> 660Hz)
 *   call-leave  falling two-note chime (sine 660Hz -> 520Hz)
 *   notify      single soft "pop"      (triangle 880Hz, fast decay)
 *   ring        phone-like dual-tone     (sine 440+480Hz) — incoming banner
 *   ring-out    soft outgoing pulse       — caller status while still ringing
 *
 * Callers stay dumb: playCue() itself checks the `soundCues` preference in
 * the shared "stable.notification.prefs.v1" localStorage blob (missing key ==
 * enabled, mirroring SettingsModal.loadPrefs' merge-over-defaults pattern),
 * and never throws — a broken AudioContext must never take down a message
 * handler or the call path.
 */

export type CueName =
  | "call-join"
  | "call-leave"
  | "notify"
  | "ring"
  | "ring-out";

// Same key SettingsModal owns; read defensively rather than importing so this
// module stays dependency-free (usable from non-React code paths).
const PREFS_KEY = "stable.notification.prefs.v1";

/** Missing/unparseable prefs mean enabled — only an explicit false disables. */
function soundCuesEnabled(): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return true;
    const prefs = JSON.parse(raw) as { soundCues?: unknown };
    return prefs.soundCues !== false;
  } catch {
    return true;
  }
}

// Lazy singleton — created on the first cue. All triggers stem from user
// gestures or event contexts, so a suspended context can usually be resumed;
// if resume fails the cue silently no-ops (scheduled tones on a suspended
// context simply never render).
let audioCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === "suspended") {
    // Fire-and-forget: a failed resume must silently no-op.
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

interface ToneSpec {
  /** Oscillator waveform. */
  type: OscillatorType;
  /** Frequency in Hz. */
  freq: number;
  /** Offset from "now" at which the tone starts, seconds. */
  at: number;
  /** Time from onset to silence, seconds (attack + decay). */
  dur: number;
  /** Peak gain (linear). Keep <= 0.12. */
  peak: number;
  /** Attack ramp length, seconds. */
  attack: number;
}

/** Schedule one enveloped tone: linear attack, exponential release — no clicks. */
function tone(ctx: AudioContext, spec: ToneSpec): void {
  const t0 = ctx.currentTime + spec.at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.freq, t0);
  // exponentialRamp can't reach 0, so ride down to a floor then stop.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(spec.peak, t0 + spec.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + spec.dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Play a named cue. Never throws. Respects the soundCues preference itself.
 * Call cues only make sense with the tab in use, so they no-op when the
 * document is hidden; `notify` plays regardless (a notification pop while the
 * tab is backgrounded is the point).
 */
/**
 * Why a cue would NOT be heard right now, as a sentence to show a user — or
 * null if sound should work.
 *
 * `playCue` swallows everything by design (sound is decoration and must never
 * take down a message handler). For the RING that guarantee has a sharp edge:
 * a silently-silent ring is a missed call the user never knew arrived. This is
 * the reporting half — the ringing surface asks, and renders the answer.
 * Deliberately side-effect-light: it will not construct an AudioContext before
 * the page has had a user gesture, since that is the case it is detecting.
 */
export function cueBlockedReason(): string | null {
  try {
    if (!soundCuesEnabled()) return "Sound cues are off in Settings";
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return "This browser can't play the ring";
    const activation = (
      navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }
    ).userActivation;
    // `userActivation` is unsupported on some browsers (Safari <16): absent is
    // not the same as false, so only an explicit false blocks.
    if (activation && activation.hasBeenActive === false) {
      return "Ringing silently \u2014 click the page to allow sound";
    }
    if (audioCtx && audioCtx.state === "suspended") {
      return "Ringing silently \u2014 click the page to allow sound";
    }
    return null;
  } catch {
    return null;
  }
}

export function playCue(name: CueName): void {
  try {
    if (!soundCuesEnabled()) return;
    // `ring` joins `notify` in playing while the tab is hidden. The old rule
    // ("call cues only make sense with the tab in use") is right for
    // join/leave chimes and exactly backwards for a ring: a call arriving
    // while you are in another tab is precisely the one you need to hear.
    if (name !== "notify" && name !== "ring" && name !== "ring-out" && document.hidden) return;
    const ctx = getContext();
    if (!ctx) return;

    switch (name) {
      case "call-join":
        // Rising two-note chime, second note overlapping the first's tail.
        // Total ~300ms.
        tone(ctx, { type: "sine", freq: 520, at: 0, dur: 0.16, peak: 0.1, attack: 0.015 });
        tone(ctx, { type: "sine", freq: 660, at: 0.12, dur: 0.18, peak: 0.1, attack: 0.015 });
        break;
      case "call-leave":
        // Mirror of call-join: falling two-note. Total ~300ms.
        tone(ctx, { type: "sine", freq: 660, at: 0, dur: 0.16, peak: 0.1, attack: 0.015 });
        tone(ctx, { type: "sine", freq: 520, at: 0.12, dur: 0.18, peak: 0.1, attack: 0.015 });
        break;
      case "notify":
        // Single soft pop: short triangle blip with a fast decay. ~140ms.
        tone(ctx, { type: "triangle", freq: 880, at: 0, dur: 0.14, peak: 0.09, attack: 0.008 });
        break;
      case "ring":
        // Phone-like dual-tone ring (approx US ring interval, soft). ~450ms.
        // Classic pair ~440+480Hz; we use slightly brighter notes so laptop
        // speakers still carry them.
        tone(ctx, { type: "sine", freq: 440, at: 0, dur: 0.42, peak: 0.1, attack: 0.02 });
        tone(ctx, { type: "sine", freq: 480, at: 0, dur: 0.42, peak: 0.08, attack: 0.02 });
        break;
      case "ring-out":
        // Outgoing "still ringing them" pulse — lower and shorter than the
        // incoming ring so the caller doesn't feel like *they* are being
        // called. Repeated by OutgoingCallStatus while phase === ringing.
        tone(ctx, { type: "sine", freq: 520, at: 0, dur: 0.12, peak: 0.07, attack: 0.01 });
        tone(ctx, { type: "sine", freq: 620, at: 0.14, dur: 0.16, peak: 0.07, attack: 0.01 });
        break;
    }
  } catch {
    // Sound is decoration — swallow everything.
  }
}
