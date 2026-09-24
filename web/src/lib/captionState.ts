/**
 * Caption lane for a live call. One answer — off, browser, agent, or server —
 * plus a sentence when nothing is captioning, so a pinned studio mic never
 * looks like a dead transcript panel.
 *
 * Browser speech recognition opens its own microphone and cannot follow a
 * chosen device. An elected agent captioner hears the LiveKit track. Server
 * captions are an explicit opt-in that uploads short mic clips to the existing
 * STT proxy. That is transcription, not a recording.
 */

export type CaptionLane = "off" | "browser" | "agent" | "server";

export type CaptionOffReason =
  | "mic-pinned"
  | "remote-dominant"
  | "speech-unavailable"
  | "mic-muted"
  | "server-unavailable"
  | "not-in-call";

export type CaptionAction = "use-default-mic" | "invite-agent";

export interface CaptionFacts {
  inCall: boolean;
  /** Selected audioinput id. Empty or "default" means the browser default. */
  audioInputId: string;
  audioInputLabel: string | null;
  speechRecognitionAvailable: boolean;
  micEnabled: boolean;
  /** Web Speech is paused so a remote human is not labelled as the local user. */
  remoteDominant: boolean;
  /** Display name of the elected agent captioner. Null when no agent is in the call. */
  agentName: string | null;
  /** Per-user "Caption my microphone (server)". Default off. */
  serverCaptionEnabled: boolean;
  serverCaptureAvailable: boolean;
  serverLastError: boolean;
}

export interface CaptionState {
  lane: CaptionLane;
  reason: CaptionOffReason | null;
  summary: string;
  actions: CaptionAction[];
  deviceLabel: string | null;
  agentName: string | null;
}

export interface CaptionRosterEntry {
  identity: string;
  name?: string | null;
  agent: boolean;
  /** Voice-relay cast puppet. It wears an agent identity and does not caption. */
  cast?: boolean;
}

export interface CaptionVoiceMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAtMs: number;
  viaVoice: boolean;
}

export interface CaptionLine {
  id: string;
  participantId: string;
  name: string;
  text: string;
  isFinal: boolean;
  ts: number;
  source?: string;
}

const SERVER_CAPTION_KEY = "stable.caption.server-mic.v1";

const IN_CALL_DEFAULT: CaptionFacts = {
  inCall: true,
  audioInputId: "default",
  audioInputLabel: null,
  speechRecognitionAvailable: true,
  micEnabled: true,
  remoteDominant: false,
  agentName: null,
  serverCaptionEnabled: false,
  serverCaptureAvailable: true,
  serverLastError: false,
};

export const CAPTION_IDLE_FACTS: CaptionFacts = {
  inCall: false,
  audioInputId: "",
  audioInputLabel: null,
  speechRecognitionAvailable: false,
  micEnabled: false,
  remoteDominant: false,
  agentName: null,
  serverCaptionEnabled: false,
  serverCaptureAvailable: false,
  serverLastError: false,
};

export function captionFacts(over: Partial<CaptionFacts> = {}): CaptionFacts {
  return { ...IN_CALL_DEFAULT, ...over };
}

/** Web Speech cannot take a deviceId. Only the OS default mic is honest. */
export function browserCanFollowInput(
  audioInputId: string | null | undefined,
): boolean {
  return !audioInputId || audioInputId === "default";
}

/**
 * Whether THIS browser should run Web Speech. An elected agent captioner
 * stands that lane down: the agent hears the LiveKit mic, including a pinned
 * studio device Web Speech cannot follow.
 */
export function browserLaneWouldRun(facts: CaptionFacts): boolean {
  return (
    facts.inCall &&
    facts.speechRecognitionAvailable &&
    browserCanFollowInput(facts.audioInputId) &&
    facts.micEnabled &&
    !facts.remoteDominant &&
    !agentOnTheCall(facts)
  );
}

/**
 * Server captions are the fallback for a mic this browser cannot follow, or
 * a browser with no speech recognition. They stay off during the remote-speaker
 * pause: that pause only protects Web Speech, and the LiveKit track is the
 * selected device either way. An agent captioner already covers the call.
 */
export function serverLaneWanted(facts: CaptionFacts): boolean {
  if (!facts.inCall || !facts.micEnabled || !facts.serverCaptionEnabled) {
    return false;
  }
  if (agentOnTheCall(facts)) return false;
  if (browserLaneWouldRun(facts)) return false;
  return (
    !browserCanFollowInput(facts.audioInputId) ||
    !facts.speechRecognitionAvailable
  );
}

export function electedCaptionerName(
  roster: CaptionRosterEntry[],
): string | null {
  const agents = roster.filter((entry) => entry.agent && !entry.cast);
  const prefixed = agents.filter((entry) => entry.identity.startsWith("agent-"));
  const pool = prefixed.length > 0 ? prefixed : agents;
  if (pool.length === 0) return null;
  const winner = [...pool].sort((a, b) =>
    a.identity.localeCompare(b.identity),
  )[0];
  if (!winner) return null;
  return presentAgentName(winner.name, winner.identity);
}

export function readServerCaptionEnabled(userId?: string | null): boolean {
  try {
    const raw = localStorage.getItem(SERVER_CAPTION_KEY);
    if (!raw) return false;
    const all = JSON.parse(raw) as Record<string, unknown>;
    return all[userId || "anonymous"] === true;
  } catch {
    return false;
  }
}

export function writeServerCaptionEnabled(
  userId: string | null | undefined,
  on: boolean,
): void {
  try {
    const raw = localStorage.getItem(SERVER_CAPTION_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    all[userId || "anonymous"] = on;
    localStorage.setItem(SERVER_CAPTION_KEY, JSON.stringify(all));
  } catch {
    // Private mode — the in-memory switch still applies to this call.
  }
}

/**
 * Meeting-Ops export still speaks the older source set. Captioner lines are
 * the agent's room STT. Server clips are not a browser caption, so they go
 * out as unknown rather than claiming the Web Speech provenance.
 */
export function exportCaptionSource(
  source: string | undefined,
): "local_mic" | "agent_stt" | "agent" | "unknown" {
  if (source === "local_mic") return "local_mic";
  if (source === "agent_stt" || source === "captioner") return "agent_stt";
  if (source === "agent") return "agent";
  return "unknown";
}

export function captionToggleTitle(open: boolean, summary: string): string {
  const verb = open ? "Hide live transcript" : "Show live transcript";
  const extra = summary.trim();
  return extra ? `${verb} — ${extra}` : verb;
}

/**
 * Fold persisted voice turns into the live buffer. The captioner already
 * stores them as chat messages (`metadata.via = voice`) with the speaker's
 * name. When the browser lane is off, those messages are the lines the local
 * human would otherwise never see.
 */
export function linesWithVoiceHistory(
  live: CaptionLine[],
  messages: CaptionVoiceMessage[],
  callStartedAt: number | null,
): CaptionLine[] {
  if (callStartedAt == null) return live;
  const extras: CaptionLine[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!message.viaVoice || !text) continue;
    if (!Number.isFinite(message.createdAtMs)) continue;
    if (message.createdAtMs + 2_000 < callStartedAt) continue;
    const duplicate =
      live.some(
        (line) => line.isFinal && utterancesOverlap(line.text, text),
      ) || extras.some((line) => utterancesOverlap(line.text, text));
    if (duplicate) continue;
    extras.push({
      id: `voice:${message.id}`,
      participantId: message.senderId,
      name: message.senderName || "Someone",
      text,
      isFinal: true,
      ts: message.createdAtMs,
      source: "captioner",
    });
  }
  if (extras.length === 0) return live;
  return [...live, ...extras].sort((a, b) => a.ts - b.ts);
}

export function reduceCaptionState(facts: CaptionFacts): CaptionState {
  const deviceLabel = devicePhrase(facts);
  const agentName = agentOnTheCall(facts) ? presentStoredAgent(facts.agentName) : null;

  if (!facts.inCall) {
    return finish("off", "not-in-call", "Captions start when a call starts.", [], facts);
  }
  if (agentName) {
    return finish(
      "agent",
      null,
      `Captions are coming from ${agentName}'s mic feed`,
      [],
      facts,
      agentName,
    );
  }
  if (browserLaneWouldRun(facts)) {
    return finish(
      "browser",
      null,
      "Captions are coming from this browser's microphone",
      [],
      facts,
    );
  }
  if (serverLaneWanted(facts)) {
    if (!facts.serverCaptureAvailable) {
      return finish(
        "off",
        "server-unavailable",
        "This browser can't send microphone audio for server captions. Invite an agent, or use the default mic.",
        offActions("server-unavailable", facts),
        facts,
      );
    }
    const base = deviceLabel
      ? `Captions are coming from the server, using ${deviceLabel}. This is transcription, not a recording.`
      : "Captions are coming from the server. This is transcription, not a recording.";
    const summary = facts.serverLastError
      ? `${base} The last clip didn't come back; still trying.`
      : base;
    return finish("server", null, summary, [], facts);
  }
  if (!browserCanFollowInput(facts.audioInputId)) {
    const picked = deviceLabel || "a selected microphone";
    return finish(
      "off",
      "mic-pinned",
      `Captions need the default mic or an agent in the call — you picked ${picked}`,
      offActions("mic-pinned", facts),
      facts,
    );
  }
  if (!facts.speechRecognitionAvailable) {
    return finish(
      "off",
      "speech-unavailable",
      "This browser has no speech recognition. Invite an agent, or turn on Caption my microphone (server).",
      offActions("speech-unavailable", facts),
      facts,
    );
  }
  if (!facts.micEnabled) {
    return finish(
      "off",
      "mic-muted",
      "Your microphone is muted, so there is nothing to caption.",
      [],
      facts,
    );
  }
  if (facts.remoteDominant) {
    return finish(
      "off",
      "remote-dominant",
      "Captions are paused while someone else is speaking, so their words are not labelled as yours.",
      [],
      facts,
    );
  }
  return finish(
    "off",
    "speech-unavailable",
    "This browser has no speech recognition. Invite an agent, or turn on Caption my microphone (server).",
    offActions("speech-unavailable", facts),
    facts,
  );
}

function finish(
  lane: CaptionLane,
  reason: CaptionOffReason | null,
  summary: string,
  actions: CaptionAction[],
  facts: CaptionFacts,
  agentName: string | null = null,
): CaptionState {
  return {
    lane,
    reason,
    summary,
    actions,
    deviceLabel: devicePhrase(facts),
    agentName,
  };
}

function agentOnTheCall(facts: CaptionFacts): boolean {
  return !!facts.agentName && facts.agentName.trim().length > 0;
}

function presentStoredAgent(name: string | null): string {
  return presentAgentName(name, name || "");
}

function devicePhrase(facts: CaptionFacts): string | null {
  const label = (facts.audioInputLabel || "").trim();
  if (label && label.toLowerCase() !== "default") return label;
  if (!browserCanFollowInput(facts.audioInputId)) return "a selected microphone";
  return null;
}

function offActions(
  reason: CaptionOffReason,
  facts: CaptionFacts,
): CaptionAction[] {
  if (reason === "mic-pinned") return ["use-default-mic", "invite-agent"];
  if (reason === "server-unavailable") {
    return browserCanFollowInput(facts.audioInputId)
      ? ["invite-agent"]
      : ["use-default-mic", "invite-agent"];
  }
  if (reason === "speech-unavailable") return ["invite-agent"];
  return [];
}

function presentAgentName(
  name: string | null | undefined,
  identity: string,
): string {
  const display = (name || "").trim();
  if (display && !display.startsWith("agent-")) return display;
  const bare = (display || identity).replace(/^agent-/, "").replace(/[-_]+/g, " ").trim();
  if (!bare) return "the agent";
  return bare.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function utteranceWords(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function utterancesOverlap(a: string, b: string): boolean {
  const left = Array.from(utteranceWords(a)).join(" ");
  const right = Array.from(utteranceWords(b)).join(" ");
  if (!left || !right) return false;
  if (left === right) return true;
  if (
    Math.min(left.length, right.length) >= 8 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  const aw = utteranceWords(a);
  const bw = utteranceWords(b);
  const shorter = Math.min(aw.size, bw.size);
  if (shorter === 0) return false;
  let overlap = 0;
  aw.forEach((word) => {
    if (bw.has(word)) overlap += 1;
  });
  return overlap / shorter >= 0.72;
}
