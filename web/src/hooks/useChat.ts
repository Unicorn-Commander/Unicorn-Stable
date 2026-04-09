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
  sendMessage: (content: string, threadId?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
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
    async (content: string, threadId?: string) => {
      if (!roomId || !content.trim()) return;

      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimisticMessage: Message = {
        id: optimisticId,
        room_id: roomId,
        sender_id: currentUser?.id ?? "",
        sender_type: "human",
        sender_name: currentUser?.displayName ?? "You",
        sender_avatar: currentUser?.avatarUrl ?? null,
        content: content.trim(),
        content_type: "text",
        thread_id: threadId ?? null,
        reply_count: 0,
        edited: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      };

      addMessage(roomId, optimisticMessage);

      try {
        const request: SendMessageRequest = {
          content: content.trim(),
          content_type: "text",
        };
        if (threadId) {
          request.thread_id = threadId;
        }
        const serverMessage = await api.sendMessage(roomId, request);
        updateMessage(roomId, optimisticId, {
          id: serverMessage.id,
          created_at: serverMessage.created_at,
          updated_at: serverMessage.updated_at,
        });
      } catch {
        removeMessage(roomId, optimisticId);
      }
    },
    [roomId, currentUser, addMessage, updateMessage, removeMessage],
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
  };
}
