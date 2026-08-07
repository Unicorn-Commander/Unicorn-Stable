import { getToken, refreshToken } from "./auth";
import type {
  ArtifactResponse,
  VersionResponse,
  CreateArtifactRequest,
  RewriteArtifactRequest,
  EditArtifactRequest,
} from "@/types/artifact";
import type {
  Collection,
  CollectionUsage,
  CreateCollectionRequest,
  DocumentContent,
  KbDocument,
  KnowledgeSearchHit,
} from "@/types/knowledge";
import { useFederationStore } from "@/stores/federationStore";

/**
 * The API origin of the ACTIVE federated instance. Falls back to the build-time
 * base, then same-origin. Every request/upload/TTS/KB-doc URL routes through
 * this so switching servers retargets them ALL at once — never a stale home URL.
 */
function activeBaseUrl(): string {
  const fed = useFederationStore.getState();
  return (
    fed.accessibleInstances.find((i) => i.id === fed.activeInstanceId)
      ?.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    ""
  );
}

export interface ApiError {
  status: number;
  message: string;
  detail: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface Room {
  id: string;
  name: string;
  display_name?: string;
  description: string;
  type: "channel" | "group_dm" | "dm";
  created_at: string;
  updated_at: string;
  member_count: number;
  /** How many members are online right now (server presence). The list
   * endpoint has always sent this; the mapper used to drop it. */
  online_count?: number;
  unread_count: number;
  last_message: Message | null;
  members: RoomMember[];
  agents: Agent[];
  /**
   * Brigade persona id of the room's resident agent, if any. Populated by
   * getRoom() from the server's room metadata; used to dispatch the agent
   * into a voice call. null for human-only rooms.
   */
  brigade_agent_id?: string | null;
  /**
   * Standing conference / always-on call room (metadata.conference). Used by
   * the Meetings nav view; plain channels leave this false/undefined.
   */
  is_conference?: boolean;
}

export interface RoomMember {
  id?: string;
  participant_id?: string;
  user_id?: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  role: "owner" | "admin" | "member";
  participant_type?: "human" | "agent";
  is_online?: boolean;
  /**
   * AGENTS ONLY (null for humans). "Can this agent be invoked right now" —
   * a different fact from `is_online`, which is "is a client connected". Most
   * agents are invoked on demand and hold no socket, so they are routinely
   * available while not connected; an agent that joined a call is both. See
   * lib/agentStatus.ts.
   */
  availability?: "available" | "unavailable" | "unknown" | null;
  /** Short server tag explaining `availability`, rendered as a tooltip. */
  availability_reason?: string | null;
  is_muted?: boolean;
  // Server-set: true for the row that belongs to the requesting user. The
  // Keycloak id never equals the participant UUID, so this is the only
  // reliable "this is me" marker for the moderation UI.
  is_self?: boolean;
  joined_at: string;
  last_read_at?: string | null;
  status?: string;
}

/** Per-callee reachability, as the server determined it at ring time. */
export interface RingTarget {
  id: string;
  display_name: string;
  /** ringing | offline | busy | unknown */
  state: string;
}

export interface RingResponse {
  /** null when nobody was rung (everyone offline/busy) — there is no call. */
  call_id: string | null;
  room_id: string;
  /** ringing | unreachable */
  state: string;
  started_at: string | null;
  expires_at: string | null;
  ring_timeout_seconds: number;
  targets: RingTarget[];
}

export interface CallActionResponse {
  call_id: string;
  room_id: string;
  state: string;
}

export interface RoomPresenceResponse {
  /** Participant IDs (Participant.id) currently online in the room. */
  online: string[];
}

export interface UploadedAttachment {
  url: string;
  filename: string;
  size: number;
  content_type: string;
}

export interface UserSearchResult {
  id: string | null;
  keycloak_sub: string;
  username: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  signed_in: boolean;
}

export interface PeopleDirectoryEntry {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  is_online: boolean;
  last_seen_at: string | null;
}

export interface UserPreferences {
  default_agent_id: string | null;
  favorite_people_ids: string[];
}

export interface Message {
  id: string;
  room_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  sender_name: string;
  sender_avatar: string | null;
  content: string;
  content_type: "text" | "action" | "system" | "image" | "file";
  thread_id: string | null;
  reply_count: number;
  edited: boolean;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  /** Client-only: an agent reply currently streaming in (set from the ws
   * `message_edit` streaming flag; never sent on the REST shape). Drives the
   * Stop control and the live "generating" affordance. */
  streaming?: boolean;
}

export interface PendingApproval {
  message: Message;
  room_id: string;
  room_name: string;
}

export interface PendingApprovalsResponse {
  items: PendingApproval[];
  has_more: boolean;
}

/** Shape of GET /api/v1/health — service states vary (strings or objects). */
export interface InstanceHealth {
  status: string;
  services: Record<string, unknown>;
}

export interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  status: "active" | "idle" | "working" | "offline";
  /**
   * Server-computed reachability, carried on the roster so the sidebar can be
   * honest about agents whose room is not open (`/members` is only polled for
   * the ACTIVE room). Distinct from `status`, which is Brigade's registration
   * state alone and cannot see bridge sessions.
   */
  availability?: "available" | "unavailable" | "unknown";
  availability_reason?: string;
  capabilities: string[];
  model: string;
  // Org-chart fields (from Brigade's rich roster). Optional so older callers and
  // the empty-state stay valid.
  emoji?: string | null;
  rank?: string | null;
  title?: string | null;
  domain?: string | null;
  /**
   * Who this agent reports to, as STATED by Brigade — the registry that owns
   * agent identity owns the chain of command with it. The org chart renders
   * this rather than inferring a reporting line from rank + domain. Null/absent
   * means the apex, or a Brigade that has not stated one; see buildOrgTree for
   * the fallback that covers the second case.
   */
  reports_to?: string | null;
  affiliation?: string | null;
  tools?: string[];
  // Per-tool cost/permission detail + rollup (from Brigade's tool_catalog).
  tool_details?: {
    name: string;
    displayName?: string | null;
    costTier?: "free" | "paid" | "subscription";
    permissionLevel?: number;
    provider?: string | null;
    external?: boolean;
  }[];
  tool_cost_summary?: {
    total: number;
    paid: number;
    external: number;
    maxPermissionLevel: number;
  };
}

export interface BrigadeAgent {
  id: string;
  name: string;
  description: string;
}

/**
 * A selectable LLM for the mid-conversation model switcher. Returned by
 * GET /api/v1/models. `family` groups related models in the picker (e.g.
 * "qwen", "claude") and `label` is the human-readable name shown in the UI.
 */
export interface ChatModel {
  id: string;
  label: string;
  family: string;
  /** Curated-menu metadata (optional — served by the governed picker). */
  badge?: string; // "Local" | "Cloud"
  desc?: string; // one-line human description of what the lane is for
  cost?: string; // "included" | "$"
}

export interface InviteBrigadeAgentResponse {
  room_name: string;
  brigade_agent_id: string;
  dispatched: boolean;
  dispatch_id: string | null;
  reason: string | null;
}

export interface ProjectOpsProject {
  id: string;
  projectNumber: string;
  title: string;
  status: string | null;
}

export interface PromoteToProjectOpsTaskRequest {
  project_number: string;
  title?: string;
  description?: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
}

export interface PromoteToProjectOpsTaskResponse {
  task_id: string;
  project_number: string;
  task_url: string;
  task_number: string | null;
}

export interface LiveKitTokenResponse {
  token: string;
  ws_url: string;
  room_name: string;
}

export interface CreateRoomRequest {
  name: string;
  description: string;
  type: "channel" | "group_dm" | "dm";
  member_ids: string[];
  agent_ids: string[];
}

export interface SendMessageRequest {
  content: string;
  content_type: "text" | "action" | "image" | "file";
  thread_id?: string;
  metadata?: Record<string, unknown>;
  /**
   * Per-conversation LLM override (the mid-conversation model switcher). When
   * present, the backend uses this model id instead of the room agent's
   * default. Resolved from the client-side modelOverrides store in useChat.
   */
  model?: string;
}

class StableApiClient {
  private async getAuthHeaders(): Promise<Record<string, string>> {
    let token = getToken();
    try {
      // updateToken() is a cheap local no-op while the token is healthy. Doing
      // this before every request closes the same stale-token hole the
      // WebSocket path already guards: background tabs suspend refresh timers.
      token = (await refreshToken()) ?? token;
    } catch {
      // A transient IdP failure should not block a request whose cached token
      // is still valid. The API response remains the source of truth.
    }
    if (!token) {
      return {};
    }
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await this.getAuthHeaders()),
    };

    const response = await fetch(`${activeBaseUrl()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let detail: string | null = null;
      try {
        const errorBody = (await response.json()) as { detail?: string };
        detail = errorBody.detail ?? null;
      } catch {
        /* empty */
      }

      const error: ApiError = {
        status: response.status,
        message: response.statusText,
        detail,
      };
      throw error;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  async getLiveKitToken(roomId: string): Promise<LiveKitTokenResponse> {
    return this.request<LiveKitTokenResponse>(
      "POST",
      "/api/v1/tokens/livekit",
      { room_name: roomId },
    );
  }

  /**
   * Ring the other member(s) of a DM. 400 on a channel (ringing a channel is
   * refused by the server, not merely avoided by the client), 403 if you are
   * not a member of the room.
   */
  async ringRoom(roomId: string): Promise<RingResponse> {
    return this.request<RingResponse>(
      "POST",
      `/api/v1/rooms/${roomId}/call/ring`,
    );
  }

  /** Callee answers. 410 if the call already ended. */
  async acceptCall(callId: string): Promise<CallActionResponse> {
    return this.request<CallActionResponse>(
      "POST",
      `/api/v1/calls/${callId}/accept`,
    );
  }

  /** Callee declines — the caller is told by name. 410 if already ended. */
  async declineCall(callId: string): Promise<CallActionResponse> {
    return this.request<CallActionResponse>(
      "POST",
      `/api/v1/calls/${callId}/decline`,
    );
  }

  /** Caller gives up. 410 if already ended, 403 if you are not the caller. */
  async cancelCall(callId: string): Promise<CallActionResponse> {
    return this.request<CallActionResponse>(
      "POST",
      `/api/v1/calls/${callId}/cancel`,
    );
  }

  async getRooms(): Promise<Room[]> {
    // Backend returns { rooms: [{ ..., room_type, display_name, ... }] }
    // ordered by updated_at DESC (most-recent conversation first — see
    // room_service.list_rooms_for_user). We preserve that order.
    // Map to the client's Room shape (type, name, description, …).
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
      online_count: number;
      // RoomResponse serializes the column as `metadata_` (alias). The list
      // endpoint shares _room_to_response with getRoom(), so the resident
      // Brigade agent's id rides along here too — used to group a persona's
      // conversations (e.g. Majik) in the sidebar.
      metadata_?: Record<string, unknown> | null;
      // Conversation-list extras. The backend MessageResponse already matches
      // the client Message shape (getMessages passes it through unmapped), so
      // last_message rides through directly. Both are optional for forward-
      // compat: older backends omit them and the store merges a live value.
      last_message?: Message | null;
      unread_count?: number;
    };
    // Follow the cursor to the END. The endpoint pages at 100 max and the
    // old single-request version silently showed only the 50 most recently
    // updated rooms — a member of 82 rooms had 32 (old channels, old agent
    // DMs) permanently invisible in the sidebar. "My history isn't there."
    const all: Raw[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const qs: string = cursor
        ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
        : "?limit=100";
      const resp: { rooms: Raw[]; cursor?: string | null } = await this.request<{
        rooms: Raw[];
        cursor?: string | null;
      }>("GET", `/api/v1/rooms${qs}`);
      all.push(...(resp.rooms ?? []));
      cursor = resp.cursor ?? null;
      if (!cursor) break;
    }
    return all.map((r) => ({
      id: r.id,
      name: r.display_name || r.name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      online_count: r.online_count ?? 0,
      unread_count: r.unread_count ?? 0,
      last_message: r.last_message ?? null,
      members: [],
      agents: [],
      brigade_agent_id:
        typeof r.metadata_?.brigade_agent_id === "string"
          ? (r.metadata_.brigade_agent_id as string)
          : null,
      is_conference: r.metadata_?.conference === true,
    }));
  }

  async createRoom(data: CreateRoomRequest): Promise<Room> {
    // Translate the client shape to the backend's RoomCreate schema.
    // Slug-name max length ~80, generated from display_name if not provided.
    const display_name = data.name.trim();
    const slug =
      display_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || `room-${Date.now()}`;
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
    };
    const r = await this.request<Raw>("POST", "/api/v1/rooms", {
      name: slug,
      display_name,
      description: data.description || null,
      room_type: data.type,
    });
    return {
      id: r.id,
      name: r.display_name || r.name,
      display_name: r.display_name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
    };
  }

  /**
   * Idempotent 1:1 human DM: get-or-create the room for (me, participantId).
   * Concurrent double-clicks return the same room. Prefer this over
   * createRoom + inviteUserToRoom for single-human DMs.
   */
  async ensureHumanDm(participantId: string): Promise<Room> {
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
      created?: boolean;
    };
    const r = await this.request<Raw>("POST", "/api/v1/dms/ensure", {
      participant_id: participantId,
    });
    return {
      id: r.id,
      name: r.display_name || r.name,
      display_name: r.display_name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
    };
  }

  async updateRoom(
    roomId: string,
    patch: { display_name?: string; description?: string },
  ): Promise<Room> {
    return this.request<Room>("PATCH", `/api/v1/rooms/${roomId}`, patch);
  }

  /**
   * Start a fresh 1:1 conversation with a Brigade agent (the ChatGPT-style
   * "New chat"). Creates a new DM room then binds the agent to it via the
   * invite-brigade-agent path (which persists `metadata.brigade_agent_id` so
   * the text + voice responders both know who lives in the room). Mirrors the
   * create→invite sequence in CreateDmModal; returns the new room so the
   * caller can navigate to it. The agent invite is best-effort — the room is
   * still usable (and the agent re-invitable from within it) if it fails.
   */
  async createAgentDm(
    brigadeAgentId: string,
    displayName: string,
  ): Promise<Room> {
    const room = await this.createRoom({
      name: displayName,
      description: "",
      type: "dm",
      member_ids: [],
      agent_ids: [],
    });
    try {
      // Text-context bind only — the voice worker is dispatched at call time.
      await this.inviteBrigadeAgent(room.id, brigadeAgentId, undefined, {
        dispatch: false,
      });
    } catch (err) {
      console.warn("agent-invite failed for new chat", brigadeAgentId, err);
    }
    return { ...room, brigade_agent_id: brigadeAgentId };
  }

  /** The caller's server-side preferences, shared across devices. */
  async getMyPreferences(): Promise<UserPreferences> {
    return this.request<UserPreferences>("GET", "/api/v1/users/me/preferences");
  }

  /** Set (or clear, with null) the user's default "New chat" agent. */
  async setDefaultAgent(agentId: string | null): Promise<UserPreferences> {
    return this.request<UserPreferences>(
      "PUT",
      "/api/v1/users/me/preferences",
      { default_agent_id: agentId },
    );
  }

  /** Replace the caller's durable people favorites (validated server-side). */
  async setFavoritePeople(participantIds: string[]): Promise<UserPreferences> {
    return this.request<UserPreferences>(
      "PUT",
      "/api/v1/users/me/preferences",
      { favorite_people_ids: participantIds },
    );
  }

  async bootstrapDefaultRooms(): Promise<Room[]> {
    return this.request<Room[]>("POST", "/api/v1/rooms/bootstrap-defaults");
  }

  /** The fixed set of standing conference rooms (always available to enter). */
  async getConferenceCatalog(): Promise<
    { slug: string; display_name: string; description: string }[]
  > {
    return this.request("GET", "/api/v1/rooms/conference/catalog");
  }

  /** Enter (create-or-get + join) a standing conference room by slug. */
  async enterConferenceRoom(slug: string): Promise<Room> {
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
    };
    const r = await this.request<Raw>(
      "POST",
      `/api/v1/rooms/conference/${encodeURIComponent(slug)}/enter`,
      {},
    );
    return {
      id: r.id,
      name: r.display_name || r.name,
      display_name: r.display_name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
      is_conference: true,
    };
  }

  async browseChannels(q = ""): Promise<Room[]> {
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
    };
    const url = `/api/v1/rooms/browse${q ? `?q=${encodeURIComponent(q)}` : ""}`;
    const rows = await this.request<Raw[]>("GET", url);
    return (rows ?? []).map((r) => ({
      id: r.id,
      name: r.display_name || r.name,
      display_name: r.display_name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
    }));
  }

  async joinRoom(roomId: string): Promise<RoomMember> {
    return this.request<RoomMember>("POST", `/api/v1/rooms/${roomId}/join`, {});
  }

  async leaveRoom(roomId: string): Promise<void> {
    return this.request<void>("POST", `/api/v1/rooms/${roomId}/leave`, {});
  }

  async searchUsers(q: string): Promise<UserSearchResult[]> {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.request<UserSearchResult[]>(
      "GET",
      `/api/v1/users/search${query}`,
    );
  }

  async getPeopleDirectory(q = ""): Promise<PeopleDirectoryEntry[]> {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.request<PeopleDirectoryEntry[]>(
      "GET",
      `/api/v1/users/directory${query}`,
    );
  }

  async inviteUserToRoom(
    roomId: string,
    target: { participant_id?: string; keycloak_sub?: string },
  ): Promise<RoomMember> {
    return this.request<RoomMember>(
      "POST",
      `/api/v1/rooms/${roomId}/invite`,
      target,
    );
  }

  async getRoomMembers(roomId: string): Promise<RoomMember[]> {
    return this.request<RoomMember[]>("GET", `/api/v1/rooms/${roomId}/members`);
  }

  /**
   * Snapshot the participant IDs currently online in a room. Seeds the roster's
   * presence on room open so peers who were already connected before you opened
   * the room show online immediately (live WS presence deltas only cover changes
   * AFTER you connect). Returns Participant IDs — the identity the roster matches
   * its online dot on.
   */
  async getRoomPresence(roomId: string): Promise<RoomPresenceResponse> {
    return this.request<RoomPresenceResponse>(
      "GET",
      `/api/v1/rooms/${roomId}/presence`,
    );
  }

  /** Moderation (owner/admin): remove a member from a room (kick). */
  async removeMember(roomId: string, participantId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/rooms/${roomId}/members/${participantId}`,
    );
  }

  /** Moderation (owner): change a member's role. */
  async setMemberRole(
    roomId: string,
    participantId: string,
    role: "owner" | "admin" | "member" | "guest",
  ): Promise<RoomMember> {
    return this.request<RoomMember>(
      "PATCH",
      `/api/v1/rooms/${roomId}/members/${participantId}/role`,
      { role },
    );
  }

  /** Moderation (owner/admin): mute or unmute a member (blocks posting). */
  async setMemberMute(
    roomId: string,
    participantId: string,
    isMuted: boolean,
  ): Promise<RoomMember> {
    return this.request<RoomMember>(
      "PATCH",
      `/api/v1/rooms/${roomId}/members/${participantId}/mute`,
      { is_muted: isMuted },
    );
  }

  /**
   * Upload a composer attachment (multipart, field name `file`).
   *
   * Implemented with XMLHttpRequest (not fetch) solely because fetch exposes
   * no upload progress; the request shape (URL, method, FormData field, auth
   * header) and error semantics are identical to the previous fetch version.
   * `onProgress` receives a 0–1 fraction from xhr.upload; `signal` aborts the
   * in-flight request and rejects with a DOMException "AbortError" (matching
   * fetch's abort semantics).
   */
  async uploadFile(
    file: File,
    opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ): Promise<UploadedAttachment> {
    const headers = await this.getAuthHeaders();
    // Multipart: must NOT set Content-Type (the browser adds the boundary).
    delete headers["Content-Type"];
    const fd = new FormData();
    fd.append("file", file);
    return new Promise<UploadedAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abortError = () =>
        new DOMException("The operation was aborted.", "AbortError");
      if (opts?.signal?.aborted) {
        reject(abortError());
        return;
      }
      xhr.open("POST", `${activeBaseUrl()}/api/v1/uploads`);
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }
      opts?.signal?.addEventListener("abort", () => xhr.abort(), {
        once: true,
      });
      const onProgress = opts?.onProgress;
      if (onProgress) {
        xhr.upload.onprogress = (e: ProgressEvent) => {
          if (e.total > 0) {
            onProgress(e.loaded / e.total);
          }
        };
      }
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(
            new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      // Network failure — fetch would reject with TypeError("Failed to fetch").
      xhr.onerror = () => reject(new TypeError("Failed to fetch"));
      xhr.onabort = () => reject(abortError());
      xhr.send(fd);
    });
  }

  async getRoom(roomId: string): Promise<Room> {
    type Raw = {
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      room_type: "channel" | "group_dm" | "dm";
      created_at: string;
      updated_at: string;
      member_count: number;
      // RoomResponse serializes the column as `metadata_` (alias). The
      // resident Brigade agent's id is persisted here by the invite path
      // (server: brigade.py writes room.metadata_.brigade_agent_id).
      metadata_?: Record<string, unknown> | null;
    };
    const r = await this.request<Raw>("GET", `/api/v1/rooms/${roomId}`);
    const brigadeAgentId =
      typeof r.metadata_?.brigade_agent_id === "string"
        ? (r.metadata_.brigade_agent_id as string)
        : null;
    return {
      id: r.id,
      name: r.display_name || r.name,
      display_name: r.display_name,
      description: r.description ?? "",
      type: r.room_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      member_count: r.member_count,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
      brigade_agent_id: brigadeAgentId,
      is_conference: r.metadata_?.conference === true,
    };
  }

  async getMessages(
    roomId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<PaginatedResponse<Message>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    // Backend returns MessageListResponse = { messages, cursor, has_more }.
    // Map it to the PaginatedResponse shape the chat hook reads (items /
    // next_cursor) — same pattern getThread uses. Without this, response.items
    // is undefined and the initial history load throws + renders empty.
    const resp = await this.request<{
      messages: Message[];
      cursor: string | null;
      has_more: boolean;
    }>("GET", `/api/v1/rooms/${roomId}/messages?${params.toString()}`);
    return {
      items: resp.messages ?? [],
      next_cursor: resp.cursor ?? null,
      has_more: resp.has_more ?? false,
    };
  }

  async sendMessage(
    roomId: string,
    data: SendMessageRequest,
  ): Promise<Message> {
    return this.request<Message>(
      "POST",
      `/api/v1/rooms/${roomId}/messages`,
      data,
    );
  }

  async getAgents(): Promise<Agent[]> {
    // The rich roster from Brigade (the source of truth) — rank/title/model/
    // tools/emoji. Stable's own /api/v1/agents table is empty in practice, so
    // this is what populates the agents store, the home rail, and the org chart.
    return this.request<Agent[]>("GET", "/api/v1/brigade/roster");
  }

  /** Backend health/build summary — powers the Settings → Instance pane and
   * the home dashboard's health strip.
   *
   * Not routed through request(): the readiness endpoint returns 503 WITH the
   * same `{status, services}` body when any service is down (health.py) — the
   * 503 is a valid answer naming what broke, not a transport failure, and
   * request() would throw it away and keep only statusText. Only a response
   * with no parseable readiness body (network down, proxy 5xx) throws. */
  async getInstanceHealth(): Promise<InstanceHealth> {
    const response = await fetch(`${activeBaseUrl()}/api/v1/health`, {
      headers: await this.getAuthHeaders(),
    });
    if (response.ok || response.status === 503) {
      try {
        return (await response.json()) as InstanceHealth;
      } catch {
        /* a 503 from a proxy in front of a dead app — fall through */
      }
    }
    const error: ApiError = {
      status: response.status,
      message: response.statusText,
      detail: null,
    };
    throw error;
  }

  async getBrigadeAgents(): Promise<BrigadeAgent[]> {
    return this.request<BrigadeAgent[]>("GET", "/api/v1/brigade/agents");
  }

  /** Selectable LLMs for the mid-conversation model switcher. */
  async getModels(): Promise<ChatModel[]> {
    return this.request<ChatModel[]>("GET", "/api/v1/models");
  }

  async removeBrigadeAgent(
    roomName: string,
    brigadeAgentId: string,
  ): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/rooms/${encodeURIComponent(roomName)}/brigade-agents/${encodeURIComponent(brigadeAgentId)}`,
    );
  }

  async inviteBrigadeAgent(
    roomName: string,
    brigadeAgentId: string,
    model?: string,
    opts?: { dispatch?: boolean },
  ): Promise<InviteBrigadeAgentResponse> {
    const body: {
      brigade_agent_id: string;
      model?: string;
      dispatch?: boolean;
    } = {
      brigade_agent_id: brigadeAgentId,
    };
    // Only send the override when the room has one set; absent = agent default.
    if (model) body.model = model;
    // dispatch: false binds the agent to the room (text responder + member
    // strip) WITHOUT spawning a LiveKit voice worker. Text contexts must use
    // it — a worker dispatched with no call to join collides with the real
    // call-time dispatch (both share the "agent-brigade" identity) and the
    // room ends up agentless.
    if (opts?.dispatch === false) body.dispatch = false;
    return this.request<InviteBrigadeAgentResponse>(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomName)}/invite-brigade-agent`,
      body,
    );
  }

  async togglePin(roomId: string, messageId: string): Promise<string[]> {
    return this.request<string[]>("POST", `/api/v1/rooms/${roomId}/pins`, {
      message_id: messageId,
    });
  }

  async getPins(roomId: string): Promise<Message[]> {
    return this.request<Message[]>("GET", `/api/v1/rooms/${roomId}/pins`);
  }

  async toggleSave(messageId: string): Promise<Message> {
    return this.request<Message>("POST", `/api/v1/messages/${messageId}/save`);
  }

  async decideAction(
    messageId: string,
    decision: "approved" | "rejected",
  ): Promise<Message> {
    return this.request<Message>(
      "POST",
      `/api/v1/messages/${messageId}/decide`,
      { decision },
    );
  }

  async getPendingApprovals(
    roomId?: string,
  ): Promise<PendingApprovalsResponse> {
    const query = roomId ? `?room_id=${encodeURIComponent(roomId)}` : "";
    return this.request<PendingApprovalsResponse>(
      "GET",
      `/api/v1/approvals/pending${query}`,
    );
  }

  async getSaved(): Promise<Message[]> {
    return this.request<Message[]>("GET", "/api/v1/saved");
  }

  async getProjectOpsProjects(): Promise<ProjectOpsProject[]> {
    return this.request<ProjectOpsProject[]>("GET", "/api/v1/po/projects");
  }

  async promoteToProjectOpsTask(
    messageId: string,
    data: PromoteToProjectOpsTaskRequest,
  ): Promise<PromoteToProjectOpsTaskResponse> {
    return this.request<PromoteToProjectOpsTaskResponse>(
      "POST",
      `/api/v1/messages/${messageId}/promote-to-po-task`,
      data,
    );
  }

  async toggleReaction(messageId: string, emoji: string): Promise<Message> {
    return this.request<Message>(
      "POST",
      `/api/v1/messages/${messageId}/reactions`,
      { emoji },
    );
  }

  async searchMessages(roomId: string, q: string): Promise<Message[]> {
    return this.request<Message[]>(
      "GET",
      `/api/v1/rooms/${roomId}/messages/search?q=${encodeURIComponent(q)}`,
    );
  }

  /** Global search across every room the caller belongs to (server-scoped). */
  async searchAllMessages(q: string): Promise<Message[]> {
    return this.request<Message[]>(
      "GET",
      `/api/v1/search/messages?q=${encodeURIComponent(q)}`,
    );
  }

  async getVapidPublicKey(): Promise<string> {
    const r = await this.request<{ key: string }>(
      "GET",
      "/api/v1/push/vapid-public-key",
    );
    return r.key;
  }

  async subscribePush(sub: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    user_agent?: string;
  }): Promise<void> {
    await this.request<void>("POST", "/api/v1/push/subscribe", sub);
  }

  async unsubscribePush(endpoint: string): Promise<void> {
    await this.request<void>("POST", "/api/v1/push/unsubscribe", { endpoint });
  }

  async getThread(messageId: string): Promise<Message[]> {
    const resp = await this.request<{ messages: Message[] }>(
      "GET",
      `/api/v1/messages/${messageId}/thread`,
    );
    return resp.messages ?? [];
  }

  async editMessage(
    roomId: string,
    messageId: string,
    content: string,
  ): Promise<Message> {
    // Backend route is message-scoped (membership/authorship enforced
    // server-side); the roomId arg is kept for the optimistic-UI caller.
    void roomId;
    return this.request<Message>("PATCH", `/api/v1/messages/${messageId}`, {
      content,
    });
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    void roomId;
    return this.request<void>("DELETE", `/api/v1/messages/${messageId}`);
  }

  /** Ask an in-flight agent reply to stop streaming. `messageId` is the agent
   * reply (placeholder) message that is currently generating. The backend
   * signals the responder (cross-worker via Redis) and finalizes whatever has
   * been produced so far. */
  async stopGenerating(messageId: string): Promise<void> {
    return this.request<void>("POST", `/api/v1/messages/${messageId}/stop`);
  }

  /** Regenerate an agent reply: the backend soft-deletes this reply and re-runs
   * the responder on the user turn that prompted it (a fresh reply streams in
   * over the ws plane). Optionally override the model for the new attempt. */
  async regenerateReply(messageId: string, model?: string): Promise<Message> {
    return this.request<Message>(
      "POST",
      `/api/v1/messages/${messageId}/regenerate`,
      model ? { model } : {},
    );
  }

  /** Synthesize speech for a message (read-aloud). Returns an audio blob
   * from the platform TTS (kokoro) via the backend proxy — the browser
   * cannot reach the GPU TTS host directly. Pass `agent` (the sender's
   * brigade agent id or display name) so the backend picks that agent's
   * voice-call preset; explicit `voice` overrides; otherwise the suite
   * default (af_heart, Majik's voice). */
  async ttsSpeech(
    text: string,
    opts?: { voice?: string; agent?: string },
  ): Promise<Blob> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await this.getAuthHeaders()),
    };
    const response = await fetch(`${activeBaseUrl()}/api/v1/tts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        ...(opts?.voice ? { voice: opts.voice } : {}),
        ...(opts?.agent ? { agent: opts.agent } : {}),
      }),
    });
    if (!response.ok) {
      // Surface FastAPI `detail` when present so the UI can toast something
      // more useful than a bare "Bad Gateway".
      let detail: string | null = null;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body?.detail === "string") detail = body.detail;
        else if (body?.detail != null) detail = JSON.stringify(body.detail);
      } catch {
        /* non-JSON body */
      }
      const error: ApiError = {
        status: response.status,
        message: response.statusText,
        detail,
      };
      throw error;
    }
    return response.blob();
  }

  /* ----------------------- Call transcripts / Meeting-Ops ----------------------- */

  /**
   * Finalize a call transcript and optionally forward it to Meeting-Ops.
   * Backend durably queues the payload even when Meeting-Ops is not configured
   * and reports blocked/pending/delivered/failed truthfully.
   */
  async exportCallTranscript(
    roomId: string,
    body: {
      lines: Array<{
        participant_id: string;
        name: string;
        text: string;
        ts: number;
        is_final: boolean;
        segment_id?: string;
        source?: "local_mic" | "agent_stt" | "agent" | "unknown";
      }>;
      include_interim?: boolean;
      room_name?: string | null;
      call_started_at?: string | null;
      call_ended_at?: string | null;
      meeting_ops_session_id?: string | null;
      label?: string | null;
      send_to_meeting_ops?: boolean;
      idempotency_key?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{
    ok: boolean;
    export_id: string;
    room_id: string;
    line_count: number;
    meeting_ops_configured: boolean;
    meeting_ops: {
      forwarded: boolean;
      status: string;
      detail?: string;
      http_status?: number;
      remote_session_id?: string | null;
      remote_session_url?: string | null;
      attempt_count?: number;
      next_attempt_at?: string | null;
    };
    exported_at: string;
    status_url: string;
  }> {
    return this.request(
      "POST",
      `/api/v1/rooms/${roomId}/transcripts/export`,
      body,
    );
  }

  async getCallTranscriptExport(
    roomId: string,
    exportId: string,
  ): ReturnType<StableApiClient["exportCallTranscript"]> {
    return this.request(
      "GET",
      `/api/v1/rooms/${roomId}/transcripts/exports/${exportId}`,
    );
  }

  /** Whether Meeting-Ops is wired on this instance (no secrets exposed). */
  async getMeetingOpsStatus(): Promise<{
    configured: boolean;
    enabled: boolean;
    has_url: boolean;
    has_api_key: boolean;
    has_org_slug: boolean;
  }> {
    return this.request("GET", "/api/v1/transcripts/meeting-ops/status");
  }

  /* ----------------------------- Artifacts ----------------------------- *
   * The co-working canvas. Artifacts are room-scoped, versioned documents
   * (markdown/code/html/svg/mermaid/react/sheet). See @/types/artifact.ts for
   * the response shapes and the backend contract.
   */

  /** Create a new artifact (draft) in a room. */
  async createArtifact(
    roomId: string,
    data: CreateArtifactRequest,
  ): Promise<ArtifactResponse> {
    return this.request<ArtifactResponse>(
      "POST",
      `/api/v1/rooms/${roomId}/artifacts`,
      data,
    );
  }

  /** List a room's artifacts (metadata; content may be null in the listing). */
  async getRoomArtifacts(roomId: string): Promise<ArtifactResponse[]> {
    return this.request<ArtifactResponse[]>(
      "GET",
      `/api/v1/rooms/${roomId}/artifacts`,
    );
  }

  /** Fetch a single artifact, including its current `content` + `current_seq`. */
  async getArtifact(artifactId: string): Promise<ArtifactResponse> {
    return this.request<ArtifactResponse>(
      "GET",
      `/api/v1/artifacts/${artifactId}`,
    );
  }

  /** Full version history of an artifact, oldest → newest by `seq`. */
  async getArtifactVersions(artifactId: string): Promise<VersionResponse[]> {
    return this.request<VersionResponse[]>(
      "GET",
      `/api/v1/artifacts/${artifactId}/versions`,
    );
  }

  /** Replace the whole buffer → produces a new version. */
  async rewriteArtifact(
    artifactId: string,
    data: RewriteArtifactRequest,
  ): Promise<VersionResponse> {
    return this.request<VersionResponse>(
      "POST",
      `/api/v1/artifacts/${artifactId}/rewrite`,
      data,
    );
  }

  /**
   * Apply search/replace edit blocks → a new version. The server returns
   * HTTP 422 with a per-block error body when a block doesn't match; that
   * surfaces here as a thrown {@link ApiError} (status 422) — callers should
   * catch and present `detail` rather than treat it as a hard failure.
   */
  async editArtifact(
    artifactId: string,
    data: EditArtifactRequest,
  ): Promise<VersionResponse> {
    return this.request<VersionResponse>(
      "POST",
      `/api/v1/artifacts/${artifactId}/edit`,
      data,
    );
  }

  /** Restore a previous version → appends it as a new current version. */
  async restoreArtifactVersion(
    artifactId: string,
    versionId: string,
  ): Promise<VersionResponse> {
    return this.request<VersionResponse>(
      "POST",
      `/api/v1/artifacts/${artifactId}/restore`,
      { version_id: versionId },
    );
  }

  /* ---------------------------- Knowledge Bases ---------------------------- *
   * Collections are named buckets of uploaded documents (chunked + embedded).
   * A room can have collections ATTACHED; the room's agent (Majik) searches the
   * attached collections for context. See @/types/knowledge.ts for the shapes.
   */

  /** Create a new (empty) knowledge collection. */
  async createCollection(data: CreateCollectionRequest): Promise<Collection> {
    return this.request<Collection>(
      "POST",
      "/api/v1/knowledge/collections",
      data,
    );
  }

  /** List all knowledge collections the user can see. */
  async listCollections(): Promise<Collection[]> {
    return this.request<Collection[]>("GET", "/api/v1/knowledge/collections");
  }

  /** Fetch a single collection by id. */
  async getCollection(collectionId: string): Promise<Collection> {
    return this.request<Collection>(
      "GET",
      `/api/v1/knowledge/collections/${collectionId}`,
    );
  }

  /**
   * Upload a document into a collection (multipart, field name `file`). The
   * returned document begins life `indexing`; poll {@link listKbDocuments} (or
   * re-fetch) to watch it transition to `ready`/`failed`.
   */
  async uploadKbDocument(
    collectionId: string,
    file: File,
  ): Promise<KbDocument> {
    // Multipart: must NOT set Content-Type (the browser adds the boundary).
    // Mirrors uploadFile() above.
    const headers = await this.getAuthHeaders();
    delete headers["Content-Type"];
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch(
      `${activeBaseUrl()}/api/v1/knowledge/collections/${collectionId}/documents`,
      { method: "POST", headers, body: fd },
    );
    if (!resp.ok) {
      let detail: string | null = null;
      try {
        const body = (await resp.json()) as { detail?: string };
        detail = body.detail ?? null;
      } catch {
        /* empty */
      }
      const error: ApiError = {
        status: resp.status,
        message: resp.statusText,
        detail,
      };
      throw error;
    }
    return resp.json() as Promise<KbDocument>;
  }

  /** List the documents in a collection (with their indexing status). */
  async listKbDocuments(collectionId: string): Promise<KbDocument[]> {
    return this.request<KbDocument[]>(
      "GET",
      `/api/v1/knowledge/collections/${collectionId}/documents`,
    );
  }

  /**
   * Delete a document, its indexed vectors, and its stored file. Irreversible.
   *
   * The server purges the vectors FIRST and refuses (503) if it cannot confirm
   * they are gone — so a rejection here means nothing was deleted and retrying
   * is safe, never that the row vanished while its text stayed searchable.
   */
  async deleteKbDocument(
    collectionId: string,
    documentId: string,
  ): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/knowledge/collections/${collectionId}/documents/${documentId}`,
    );
  }

  /**
   * Re-run indexing for a document that ended up `failed` or stranded in
   * `indexing`. Returns the document back in `indexing`.
   */
  async reindexKbDocument(
    collectionId: string,
    documentId: string,
  ): Promise<KbDocument> {
    return this.request<KbDocument>(
      "POST",
      `/api/v1/knowledge/collections/${collectionId}/documents/${documentId}/reindex`,
    );
  }

  /**
   * What deleting this collection would break — the rooms still using it and
   * how many documents go with it. Read-only; call it before confirming.
   */
  async getCollectionUsage(collectionId: string): Promise<CollectionUsage> {
    return this.request<CollectionUsage>(
      "GET",
      `/api/v1/knowledge/collections/${collectionId}/usage`,
    );
  }

  /**
   * Delete a collection, every document in it, and all of their vectors.
   * Irreversible.
   *
   * Without `force` the server returns 409 when rooms are still using the
   * collection, with a message naming them — surface that instead of retrying
   * blindly. Pass `force` only after the user has been shown what breaks.
   */
  async deleteCollection(collectionId: string, force = false): Promise<void> {
    const qs = force ? "?force=true" : "";
    return this.request<void>(
      "DELETE",
      `/api/v1/knowledge/collections/${collectionId}${qs}`,
    );
  }

  /** Attach a collection to a room so the room's agent can search it. */
  async attachRoomKnowledge(
    roomId: string,
    collectionId: string,
  ): Promise<void> {
    return this.request<void>("POST", `/api/v1/rooms/${roomId}/knowledge`, {
      collection_id: collectionId,
    });
  }

  /** Detach a collection from a room. */
  async detachRoomKnowledge(
    roomId: string,
    collectionId: string,
  ): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/rooms/${roomId}/knowledge/${collectionId}`,
    );
  }

  /** List the collections currently attached to a room. */
  async listRoomKnowledge(roomId: string): Promise<Collection[]> {
    return this.request<Collection[]>(
      "GET",
      `/api/v1/rooms/${roomId}/knowledge`,
    );
  }

  /**
   * Read a document's extracted text as its indexed chunks (human-viewable).
   * These are the SAME chunks the agent retrieves over. `chunks` is empty when
   * nothing is indexed (a `failed` doc, or one still `indexing`).
   */
  async getKbDocumentContent(
    collectionId: string,
    documentId: string,
  ): Promise<DocumentContent> {
    return this.request<DocumentContent>(
      "GET",
      `/api/v1/knowledge/collections/${collectionId}/documents/${documentId}/chunks`,
    );
  }

  /**
   * Run — as a human — the SAME KB search the room's agent runs: the top
   * excerpts across every collection attached to the room. Returns [] when the
   * room has no attached knowledge (or nothing matches).
   */
  async searchRoomKnowledge(
    roomId: string,
    query: string,
    k?: number,
  ): Promise<KnowledgeSearchHit[]> {
    const res = await this.request<{ results: KnowledgeSearchHit[] }>(
      "POST",
      `/api/v1/rooms/${roomId}/knowledge/search`,
      { query, ...(k ? { k } : {}) },
    );
    return res.results;
  }
}

export const api = new StableApiClient();
