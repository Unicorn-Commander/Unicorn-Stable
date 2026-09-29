/**
 * The guest half of the API surface — bare `fetch`, on purpose.
 *
 * WHY NOT `services/api.ts`: that client's `getAuthHeaders()` unconditionally
 * reaches for a Keycloak token, and its `activeBaseUrl()` reads the federation
 * store, which the guest path never initialises (a guest has no instance list
 * and no home instance to resolve). The whole premise of a guest is that there
 * is no session to reach for. Same reasoning as the join call in BroadcastPage.
 *
 * WHAT A GUEST MAY CALL — the complete list, and it is short:
 *   POST /guest/redeem            (unauthenticated; the only invite-token route)
 *   GET  /guest/me                (replaces GET /rooms for a guest)
 *   POST /guest/leave
 *   GET/POST /rooms/{room}/messages   — their room only
 *   GET  /rooms/{room}/members        — their room only
 *   POST /tokens/livekit              — their room only
 *
 * Everything else 401s: `deps.get_current_user` refuses a guest credential BY
 * NAME, and guest-reachable routes opt in one at a time. So there is nothing to
 * "hide" client-side — the routes simply are not open, and this module does not
 * pretend otherwise by wrapping them.
 */
import {
  GUEST_SESSION_PREFIX,
  type GuestRedeemBody,
} from "@/lib/guest";

/** Same-origin by default: nginx serves the SPA and proxies /api from one host. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

/**
 * A guest HTTP failure. `status` 0 means no response arrived at all (network
 * drop / abort), matching the convention services/api.ts already uses.
 */
export class GuestApiError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `guest request failed (${status})`);
    this.name = "GuestApiError";
    this.status = status;
  }
}

/**
 * The credential stopped authenticating: revoked, expired, or its invite was
 * revoked underneath it. The server answers all of those with one 401 and the
 * client must treat them as one terminal state — see `nextGuestState`.
 */
export class GuestSessionEnded extends GuestApiError {
  constructor() {
    super(401, "guest session is not valid");
    this.name = "GuestSessionEnded";
  }
}

async function guestFetch<T>(
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  // fetch has NO default timeout, so a black-holed request never settles and
  // the caller's catch/reconcile never runs. Bound every call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (response.status === 401) {
      throw new GuestSessionEnded();
    }
    if (!response.ok) {
      throw new GuestApiError(response.status, response.statusText);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof GuestApiError) throw error;
    // Status 0 = "no HTTP response", which redeemOutcomeFor reads as `offline`.
    throw new GuestApiError(0, "network");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange an invite link for a room-scoped session.
 *
 * Returns the RAW body; `guestSessionFromRedeem` is the only thing that turns
 * it into a session, so there is one place where a server field becomes a
 * client fact — including any optional field added after this shipped.
 */
export async function redeemGuestInvite(
  body: GuestRedeemBody,
): Promise<unknown> {
  return guestFetch<unknown>("POST", "/api/v1/guest/redeem", {
    body: {
      token: body.token,
      display_name: body.display_name,
      // Send the passphrase only when there is one. An empty string against an
      // invite that HAS a passphrase is a failed check that costs the caller a
      // rate-limit slot for nothing.
      ...(body.passphrase ? { passphrase: body.passphrase } : {}),
    },
    // Redemption runs PBKDF2 (200k iterations) and deliberately burns the same
    // time on the miss path, so it is slower than an ordinary request.
    timeoutMs: 30_000,
  });
}

/** The guest's own record + the one room. Raw, for `mergeGuestMe`. */
export async function getGuestMe(token: string): Promise<unknown> {
  return guestFetch<unknown>("GET", "/api/v1/guest/me", { token });
}

/** End your own session: no credential, no membership row, no LiveKit
 *  participant left behind. Best-effort — the caller tears down regardless. */
export async function leaveGuestSession(token: string): Promise<void> {
  await guestFetch<void>("POST", "/api/v1/guest/leave", { token, timeoutMs: 8_000 });
}

export interface GuestMessage {
  id: string;
  room_id: string;
  sender_id: string;
  /** "guest" for a fellow guest — a value the app's older union never had. */
  sender_type: string;
  sender_name: string;
  sender_avatar: string | null;
  content: string;
  content_type: string;
  created_at: string;
  /**
   * For a guest caller the server strips `gateway`, `on_behalf_of` and
   * `agent_id`; nothing on the guest surface may read them. What stays is
   * what a system line needs (`kind`, `started_by`, `reason`,
   * `thread_title`, `created_by`).
   */
  metadata?: Record<string, unknown> | null;
}

export interface GuestMessagePage {
  messages: GuestMessage[];
  cursor: string | null;
  has_more: boolean;
}

export async function getGuestMessages(
  token: string,
  roomId: string,
  limit = 50,
): Promise<GuestMessagePage> {
  const page = await guestFetch<Partial<GuestMessagePage>>(
    "GET",
    `/api/v1/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`,
    { token },
  );
  return {
    messages: page.messages ?? [],
    cursor: page.cursor ?? null,
    has_more: page.has_more ?? false,
  };
}

export async function sendGuestMessage(
  token: string,
  roomId: string,
  content: string,
  clientMsgId: string,
): Promise<GuestMessage> {
  return guestFetch<GuestMessage>(
    "POST",
    `/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      token,
      body: {
        content,
        content_type: "text",
        // The server dedupes a retried send on (room, sender, client_msg_id),
        // so a resend after a lost response collapses instead of double-posting.
        client_msg_id: clientMsgId,
      },
    },
  );
}

export interface GuestRoomMember {
  participant_id?: string | null;
  user_id?: string | null;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  role?: string;
  /** "human" | "agent" | "guest". The ONLY thing the badge may read. */
  participant_type?: string | null;
  is_online?: boolean;
  is_self?: boolean;
  is_muted?: boolean;
  /** Always null for a guest caller: reachability is a member's fact. */
  availability?: string | null;
  availability_reason?: string | null;
  /** AGENT rows only, and for a guest caller `{kind}` alone. */
  metadata?: { kind?: string | null } | null;
}

export async function getGuestMembers(
  token: string,
  roomId: string,
): Promise<GuestRoomMember[]> {
  const rows = await guestFetch<GuestRoomMember[]>(
    "GET",
    `/api/v1/rooms/${encodeURIComponent(roomId)}/members`,
    { token },
  );
  return Array.isArray(rows) ? rows : [];
}

export interface GuestLiveKitToken {
  token: string;
  ws_url: string;
  room_name: string;
}

/**
 * A LiveKit grant for the guest's own room. The publish half is built
 * server-side from the INVITE's `can_publish`, not from anything sent here, and
 * the token is clamped to the guest session's own expiry — so a revoked guest
 * cannot outlive their credential on the call.
 */
export async function getGuestLiveKitToken(
  token: string,
  roomId: string,
  participantName?: string,
): Promise<GuestLiveKitToken> {
  return guestFetch<GuestLiveKitToken>("POST", "/api/v1/tokens/livekit", {
    token,
    body: {
      room_name: roomId,
      ...(participantName ? { participant_name: participantName } : {}),
    },
  });
}

/** The WebSocket URL a guest connects to. Same-origin `/ws`, because a guest
 *  has no federated instance list to resolve one from. */
export function guestWebSocketUrl(): string {
  const base = API_BASE.trim();
  if (base) {
    return `${base.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
  }
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

export { GUEST_SESSION_PREFIX };
