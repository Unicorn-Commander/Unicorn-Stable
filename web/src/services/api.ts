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
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: "owner" | "admin" | "member";
  is_online: boolean;
  joined_at: string;
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
    return this.request<Room[]>("GET", "/api/v1/rooms");
  }

  async createRoom(data: CreateRoomRequest): Promise<Room> {
    return this.request<Room>("POST", "/api/v1/rooms", data);
  }

  async getRoom(roomId: string): Promise<Room> {
    return this.request<Room>("GET", `/api/v1/rooms/${roomId}`);
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

  async editMessage(
    roomId: string,
    messageId: string,
    content: string,
  ): Promise<Message> {
    return this.request<Message>(
      "PATCH",
      `/api/v1/rooms/${roomId}/messages/${messageId}`,
      { content },
    );
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/rooms/${roomId}/messages/${messageId}`,
    );
  }
}

export const api = new StableApiClient();
