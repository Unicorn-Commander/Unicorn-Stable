import { useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import type { Message, SendMessageRequest } from "@/services/api";
import { ws } from "@/services/websocket";
import type { WsMessageEvent, WsMessageEditEvent, WsMessageDeleteEvent, WsEventPayload } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";

interface UseChatReturn {
  messages: Message[];
  hasMore: boolean;
  loading: boolean;
  sendMessage: (
    content: string,
    threadId?: string,
    attachments?: { url: string; filename: string; content_type: string; size: number }[],
    extraMetadata?: Record<string, unknown>,
  ) => Promise<void>;
  loadMore: () => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
}

export function useChat(roomId: string | null): UseChatReturn {
  const messagesState = useAppStore((s) => (roomId ? s.messages[roomId] : undefined));
  const addMessage = useAppStore((s) => s.addMessage);
  const setMessages = useAppStore((s) => s.setMessages);
  const prependMessages = useAppStore((s) => s.prependMessages);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const removeMessage = useAppStore((s) => s.removeMessage);
  const currentUser = useAppStore((s) => s.currentUser);
  const initialLoadDone = useRef<Set<string>>(new Set());

  const messages = messagesState?.items ?? [];
  const hasMore = messagesState?.hasMore ?? true;
  const loading = messagesState?.loading ?? false;

  useEffect(() => {
    if (!roomId || initialLoadDone.current.has(roomId)) return;

    let cancelled = false;

    async function fetchInitial() {
      if (!roomId) return;
      setMessages(roomId, {
        items: [],
        nextCursor: null,
        hasMore: true,
        loading: true,
      });

      try {
        const response = await api.getMessages(roomId);
        if (cancelled) return;

        const reversed = [...response.items].reverse();
        setMessages(roomId, {
          items: reversed,
          nextCursor: response.next_cursor,
          hasMore: response.has_more,
          loading: false,
        });
        initialLoadDone.current.add(roomId);
      } catch {
        if (cancelled) return;
        setMessages(roomId, {
          items: [],
          nextCursor: null,
          hasMore: false,
          loading: false,
        });
      }
    }

    fetchInitial();
    return () => {
      cancelled = true;
    };
  }, [roomId, setMessages]);

  useEffect(() => {
    if (!roomId) return;

    const unsubMessage = ws.on("message", (data: WsEventPayload) => {
      const event = data as WsMessageEvent;
      if (event.room_id === roomId) {
        addMessage(roomId, event.message as Message);
      }
    });

    const unsubEdit = ws.on("message_edit", (data: WsEventPayload) => {
      const event = data as WsMessageEditEvent;
      if (event.room_id === roomId) {
        updateMessage(roomId, event.message_id, {
          content: event.content,
          updated_at: event.updated_at,
          edited: true,
        });
      }
    });

    const unsubDelete = ws.on("message_delete", (data: WsEventPayload) => {
      const event = data as WsMessageDeleteEvent;
      if (event.room_id === roomId) {
        removeMessage(roomId, event.message_id);
      }
    });

    return () => {
      unsubMessage();
      unsubEdit();
      unsubDelete();
    };
  }, [roomId, addMessage, updateMessage, removeMessage]);

  const loadMore = useCallback(async () => {
    if (!roomId || loading || !hasMore) return;

    const cursor = messagesState?.nextCursor ?? undefined;
    setMessages(roomId, {
      items: messagesState?.items ?? [],
      nextCursor: messagesState?.nextCursor ?? null,
      hasMore: messagesState?.hasMore ?? true,
      loading: true,
    });

    try {
      const response = await api.getMessages(roomId, cursor);
      const reversed = [...response.items].reverse();
      prependMessages(roomId, reversed, response.next_cursor, response.has_more);
    } catch {
      setMessages(roomId, {
        items: messagesState?.items ?? [],
        nextCursor: messagesState?.nextCursor ?? null,
        hasMore: messagesState?.hasMore ?? true,
        loading: false,
      });
    }
  }, [roomId, loading, hasMore, messagesState, setMessages, prependMessages]);

  const sendMessage = useCallback(
    async (
      content: string,
      threadId?: string,
      attachments?: {
        url: string;
        filename: string;
        content_type: string;
        size: number;
      }[],
      extraMetadata?: Record<string, unknown>,
    ) => {
      const trimmedContent = content.trim();
      if (!roomId) return;
      if (!trimmedContent && (!attachments || attachments.length === 0)) return;

      const hasImage = (attachments || []).some((a) =>
        a.content_type.startsWith("image/"),
      );
      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimisticMessage: Message = {
        id: optimisticId,
        room_id: roomId,
        sender_id: currentUser?.id ?? "",
        sender_type: "human",
        sender_name: currentUser?.displayName ?? "You",
        sender_avatar: currentUser?.avatarUrl ?? null,
        content: trimmedContent,
        content_type: hasImage ? "image" : attachments?.length ? "file" : "text",
        thread_id: threadId ?? null,
        reply_count: 0,
        edited: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          ...(attachments?.length ? { attachments } : {}),
          ...(extraMetadata ?? {}),
        },
      };

      addMessage(roomId, optimisticMessage);

      try {
        const request: SendMessageRequest = {
          content: trimmedContent,
          content_type: (optimisticMessage.content_type as SendMessageRequest["content_type"]),
        };
        const meta: Record<string, unknown> = {};
        if (attachments?.length) meta.attachments = attachments;
        if (extraMetadata) Object.assign(meta, extraMetadata);
        if (Object.keys(meta).length > 0) {
          request.metadata = meta;
        }
        if (threadId) {
          request.thread_id = threadId;
        }
        // Per-room LLM override (mid-conversation model switcher). Read from the
        // store at send-time so MessageInput/ChatPanel signatures stay untouched.
        const modelOverride = useAppStore.getState().modelOverrides[roomId];
        if (modelOverride) {
          request.model = modelOverride;
        }
        const serverMessage = await api.sendMessage(roomId, request);
        updateMessage(roomId, optimisticId, {
          id: serverMessage.id,
          created_at: serverMessage.created_at,
          updated_at: serverMessage.updated_at,
          metadata: {
            ...(optimisticMessage.metadata ?? {}),
            ...(serverMessage.metadata ?? {}),
            failed: false,
          },
        });
      } catch (err) {
        // Keep the optimistic message in-place so the user can retry.
        // Stuff the original request into metadata so retryMessage can replay it.
        updateMessage(roomId, optimisticId, {
          metadata: {
            ...(optimisticMessage.metadata ?? {}),
            failed: true,
            failed_error: (err as Error)?.message || "Send failed",
            failed_request: {
              content: trimmedContent,
              thread_id: threadId,
              attachments,
              extraMetadata,
            },
          },
        });
      }
    },
    [roomId, currentUser, addMessage, updateMessage, removeMessage],
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!roomId) return;
      const m = messages.find((x) => x.id === messageId);
      if (!m) return;
      const req = (m.metadata as { failed_request?: { content: string; thread_id?: string; attachments?: Array<{ url: string; filename: string; content_type: string; size: number }>; extraMetadata?: Record<string, unknown> } } | null)?.failed_request;
      if (!req) return;
      // Optimistically clear failed flag so the bubble UI updates.
      updateMessage(roomId, messageId, {
        metadata: { ...(m.metadata ?? {}), failed: false, failed_error: null },
      });
      try {
        const request: SendMessageRequest = {
          content: req.content,
          content_type: m.content_type as SendMessageRequest["content_type"],
        };
        if (req.attachments?.length) request.metadata = { attachments: req.attachments };
        if (req.extraMetadata) request.metadata = { ...(request.metadata ?? {}), ...req.extraMetadata };
        if (req.thread_id) request.thread_id = req.thread_id;
        // Replay the room's currently-selected model on retry too.
        const modelOverride = useAppStore.getState().modelOverrides[roomId];
        if (modelOverride) request.model = modelOverride;
        const serverMessage = await api.sendMessage(roomId, request);
        updateMessage(roomId, messageId, {
          id: serverMessage.id,
          created_at: serverMessage.created_at,
          updated_at: serverMessage.updated_at,
          metadata: { ...(m.metadata ?? {}), failed: false, failed_request: null },
        });
      } catch (err) {
        updateMessage(roomId, messageId, {
          metadata: { ...(m.metadata ?? {}), failed: true, failed_error: (err as Error)?.message || "Send failed" },
        });
      }
    },
    [roomId, messages, updateMessage],
  );

  const editMessage = useCallback(
    async (messageId: string, content: string) => {
      if (!roomId) return;
      const original = messages.find((m) => m.id === messageId);
      if (!original) return;

      updateMessage(roomId, messageId, { content, edited: true });

      try {
        await api.editMessage(roomId, messageId, content);
      } catch {
        updateMessage(roomId, messageId, {
          content: original.content,
          edited: original.edited,
        });
      }
    },
    [roomId, messages, updateMessage],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (!roomId) return;
      const original = messages.find((m) => m.id === messageId);
      if (!original) return;

      removeMessage(roomId, messageId);

      try {
        await api.deleteMessage(roomId, messageId);
      } catch {
        addMessage(roomId, original);
      }
    },
    [roomId, messages, addMessage, removeMessage],
  );

  return {
    messages,
    hasMore,
    loading,
    sendMessage,
    loadMore,
    editMessage,
    deleteMessage,
    retryMessage,
  };
}
