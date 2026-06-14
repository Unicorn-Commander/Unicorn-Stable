import { getToken, refreshToken } from "./auth";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

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
  unread_count: number;
  last_message: Message | null;
  members: RoomMember[];
  agents: Agent[];
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
  is_muted?: boolean;
  joined_at: string;
  last_read_at?: string | null;
  status?: string;
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
}

export interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  status: "active" | "idle" | "working" | "offline";
  capabilities: string[];
  model: string;
}

export interface BrigadeAgent {
  id: string;
  name: string;
  description: string;
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
}

class StableApiClient {
  private async getAuthHeaders(): Promise<Record<string, string>> {
    let token = getToken();
    if (!token) {
      token = await refreshToken();
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

    const response = await fetch(`${BASE_URL}${path}`, {
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
      { room_id: roomId },
    );
  }

  async getRooms(): Promise<Room[]> {
    // Backend returns { rooms: [{ ..., room_type, display_name, ... }] }
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
    };
    const resp = await this.request<{ rooms: Raw[] }>("GET", "/api/v1/rooms");
    return (resp.rooms ?? []).map((r) => ({
      id: r.id,
      name: r.display_name || r.name,
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

  async updateRoom(
    roomId: string,
    patch: { display_name?: string; description?: string },
  ): Promise<Room> {
    return this.request<Room>("PATCH", `/api/v1/rooms/${roomId}`, patch);
  }

  async bootstrapDefaultRooms(): Promise<Room[]> {
    return this.request<Room[]>("POST", "/api/v1/rooms/bootstrap-defaults");
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
    return this.request<RoomMember>(
      "POST",
      `/api/v1/rooms/${roomId}/join`,
      {},
    );
  }

  async leaveRoom(roomId: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/api/v1/rooms/${roomId}/leave`,
      {},
    );
  }

  async searchUsers(q: string): Promise<UserSearchResult[]> {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.request<UserSearchResult[]>("GET", `/api/v1/users/search${query}`);
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
    return this.request<RoomMember[]>(
      "GET",
      `/api/v1/rooms/${roomId}/members`,
    );
  }

  async uploadFile(file: File): Promise<UploadedAttachment> {
    const headers = await this.getAuthHeaders();
    delete headers["Content-Type"];
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch(`${BASE_URL}/api/v1/uploads`, {
      method: "POST",
      headers,
      body: fd,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Upload failed (${resp.status}): ${body}`);
    }
    return resp.json();
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
    };
    const r = await this.request<Raw>("GET", `/api/v1/rooms/${roomId}`);
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

  async getMessages(
    roomId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<PaginatedResponse<Message>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return this.request<PaginatedResponse<Message>>(
      "GET",
      `/api/v1/rooms/${roomId}/messages?${params.toString()}`,
    );
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
    return this.request<Agent[]>("GET", "/api/v1/agents");
  }

  async getBrigadeAgents(): Promise<BrigadeAgent[]> {
    return this.request<BrigadeAgent[]>("GET", "/api/v1/brigade/agents");
  }

  async removeBrigadeAgent(roomName: string, brigadeAgentId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/rooms/${encodeURIComponent(roomName)}/brigade-agents/${encodeURIComponent(brigadeAgentId)}`,
    );
  }

  async inviteBrigadeAgent(
    roomName: string,
    brigadeAgentId: string,
  ): Promise<InviteBrigadeAgentResponse> {
    return this.request<InviteBrigadeAgentResponse>(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomName)}/invite-brigade-agent`,
      { brigade_agent_id: brigadeAgentId },
    );
  }

  async togglePin(roomId: string, messageId: string): Promise<string[]> {
    return this.request<string[]>(
      "POST",
      `/api/v1/rooms/${roomId}/pins`,
      { message_id: messageId },
    );
  }

  async getPins(roomId: string): Promise<Message[]> {
    return this.request<Message[]>(
      "GET",
      `/api/v1/rooms/${roomId}/pins`,
    );
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
    return this.request<Message>(
      "PATCH",
      `/api/v1/messages/${messageId}`,
      { content },
    );
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    void roomId;
    return this.request<void>(
      "DELETE",
      `/api/v1/messages/${messageId}`,
    );
  }
}

export const api = new StableApiClient();
