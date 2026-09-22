import { getToken, refreshToken } from "@/services/auth";
import { useFederationStore } from "@/stores/federationStore";

/**
 * v3 home summary and the section layout prefs.
 *
 * These calls stay in Home so the shared `api.getHomeSummary()` poll (sidebar
 * live-call badges) keeps its v1 shape. Both hit the same participant record
 * the rest of my-preferences uses.
 */

export interface HomeActor {
  participant_id: string;
  kind: string;
  display_name: string;
  avatar_url: string | null;
  agent_id: string | null;
}

export interface HomeRoomRef {
  id: string;
  display_name: string;
  room_type: string;
  parent_room_id: string | null;
}

export interface NeedsYouRow {
  kind: "approval" | "mention" | "dm" | "agent_waiting" | "invite";
  actor: HomeActor;
  room: HomeRoomRef;
  preview: string;
  created_at: string;
  action: "approve" | "reply" | "open" | "join";
  stale: boolean;
  message_id?: string | null;
}

export interface CrewCard {
  agent_id: string;
  participant_id: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  agent_mode: string | null;
  current_task?: string | null;
  last_line?: string | null;
  since?: string | null;
  hub_room_id?: string | null;
}

export interface PoTaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string | null;
  project_number: string | null;
  url: string | null;
}

export interface TodayMeeting {
  kind: "standing" | "recap";
  id: string;
  title: string;
  at: string | null;
  room_id: string | null;
  slug: string | null;
  summary: string | null;
}

export interface TodayBlock {
  po_tasks: PoTaskRow[] | null;
  meetings: TodayMeeting[] | null;
}

export interface LiveCallV3 {
  room_id: string;
  display_name: string;
  room_type: string;
  participant_count: number;
  has_agent: boolean;
  recording?: boolean;
  broadcast?: boolean;
  floor_holder?: HomeActor | null;
}

export interface HomeSummaryV3 {
  generated_at: string;
  live_calls: LiveCallV3[];
  counts: {
    unread_rooms: number;
    mention_rooms: number;
    approvals_pending: number;
    agents_available: number;
    people_online: number;
    worker_last_seen_at: string | null;
  };
  needs_you: NeedsYouRow[];
  crew: CrewCard[];
  today: TodayBlock | null;
}

export interface HomeSectionPrefs {
  order: string[];
  collapsed: Record<string, boolean>;
}

function activeBaseUrl(): string {
  const fed = useFederationStore.getState();
  return (
    fed.accessibleInstances.find((instance) => instance.id === fed.activeInstanceId)
      ?.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    ""
  );
}

export async function homeRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let token = getToken();
  try {
    token = (await refreshToken()) ?? token;
  } catch {
    /* A stale-but-present token is still the server's to reject. */
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${activeBaseUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Home request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reject a payload that is not the v3 contract. Missing blocks must not look like an empty inbox. */
export function parseHomeSummaryV3(raw: unknown): HomeSummaryV3 {
  if (!isRecord(raw)) throw new Error("Home summary was not an object");
  if (!Array.isArray(raw.needs_you) || !Array.isArray(raw.crew) || !("today" in raw)) {
    throw new Error("Home summary is missing v3 fields");
  }
  if (!Array.isArray(raw.live_calls)) throw new Error("Home summary is missing live calls");
  if (raw.today !== null && !isRecord(raw.today)) {
    throw new Error("Home summary today block is malformed");
  }
  return raw as unknown as HomeSummaryV3;
}

export function fetchHomeSummaryV3(): Promise<HomeSummaryV3> {
  return homeRequest<unknown>("GET", "/api/v1/home/summary?v=3").then(parseHomeSummaryV3);
}

export function fetchSectionPrefs(): Promise<HomeSectionPrefs> {
  return homeRequest<HomeSectionPrefs>("GET", "/api/v1/home/section-prefs");
}

export function saveSectionPrefs(prefs: HomeSectionPrefs): Promise<HomeSectionPrefs> {
  return homeRequest<HomeSectionPrefs>("PUT", "/api/v1/home/section-prefs", prefs);
}
