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
  /** Initial page failed to load — the room may not actually be empty. */
  error: boolean;
  /** Re-run the initial page fetch after a failure. */
  retryInitial: () => Promise<void>;  sendMessage: (
    content: string,
    threadId?: string,
    attachments?: { url: string; filename: string; content_type: string; size: number }[],
    extraMetadata?: Record<string, unknown>,
  ) => Promise<void>;
  loadMore: () => Promise<void>;
  /** Resolves true when the server accepted the edit, false on failure (the
   *  bubble keeps its draft so the user's words aren't lost). */
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  /** Force a merge-refetch of the room's latest messages (used as a safety net
   * while waiting on an agent reply, in case a live event was missed). */
  resync: () => Promise<void>;
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

  // Hoisted so ChatPanel's error state can offer a manual retry. No cancelled
  // flag: writes are keyed by roomId, so a late resolution only fills that
  // room's own cache slot.
  const fetchInitialPage = useCallback(async () => {
    if (!roomId) return;
    setMessages(roomId, {
      items: [],
      nextCursor: null,
      hasMore: true,
      loading: true,
    });

    try {
      const response = await api.getMessages(roomId);
      const reversed = [...response.items].reverse();
      setMessages(roomId, {
        items: reversed,
        nextCursor: response.next_cursor,
        hasMore: response.has_more,
        loading: false,
      });
      initialLoadDone.current.add(roomId);
    } catch {
      // NOT stamped in initialLoadDone, so a remount auto-retries; hasMore
      // stays true because the failure says nothing about the room's history.
      setMessages(roomId, {
        items: [],
        nextCursor: null,
        hasMore: true,
        loading: false,
        error: true,
      });
    }
  }, [roomId, setMessages]);

  useEffect(() => {
    if (!roomId || initialLoadDone.current.has(roomId)) return;
    void fetchInitialPage();
  }, [roomId, fetchInitialPage]);

  useEffect(() => {
    if (!roomId) return;

    const unsubMessage = ws.on("message", (data: WsEventPayload) => {
      const event = data as WsMessageEvent;
      if (event.room_id !== roomId) return;
      const incoming = event.message as Message;
      // Skip the redis echo of our OWN just-sent message. A pending optimistic
      // copy is already on screen, and the POST response reconciles it to the
      // server id. If we add the echo too, the user sees a duplicate that then
      // gets removed (the "deleted my reply / made the same reply" flicker).
      // NOTE: incoming.sender_id is the participant UUID; currentUser.id is the
      // Keycloak id — they never match — so match the pending optimistic copy
      // (whose sender_id we set to currentUser.id) by content instead.
      const items = useAppStore.getState().messages[roomId]?.items ?? [];
      const ownPending = items.find(
        (m) =>
          m.id.startsWith("optimistic-") &&
          m.content === incoming.content &&
          m.sender_id === currentUser?.id,
      );
      if (ownPending) {
        console.debug(
          "[chat] ws echo of own message — skipped (optimistic %s pending)",
          ownPending.id,
          incoming.id,
        );
        return;
      }
      console.debug(
        "[chat] ws message in",
        incoming.id,
        incoming.sender_type,
        incoming.sender_name,
      );
      // The agent-reply placeholder arrives flagged streaming:true so the
      // bubble shows Stop / "generating" off the flag alone (a later finalize
      // clears it). Persisted history never carries the flag, so a crashed
      // finalize can't strand a Stop pill on a dead message.
      if (event.streaming === true) incoming.streaming = true;
      addMessage(roomId, incoming);
    });

    const unsubEdit = ws.on("message_edit", (data: WsEventPayload) => {
      const event = data as WsMessageEditEvent;
      if (event.room_id === roomId) {
        // Streaming patches (agent reply mid-flight) carry `streaming: true` and
        // shouldn't flag the message as user-"edited"; the final finalize edit
        // omits the flag, clears `streaming`, and marks it edited as before.
        const streaming = event.streaming === true;
        updateMessage(roomId, event.message_id, {
          content: event.content,
          updated_at: event.updated_at,
          streaming,
          ...(streaming ? {} : { edited: true }),
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
  }, [roomId, currentUser, addMessage, updateMessage, removeMessage]);

  // Re-sync missed messages when the realtime socket (re)connects or the page
  // returns to the foreground. Mobile browsers freeze the WebSocket while a tab
  // is backgrounded, so messages (incl. an agent's reply) that arrived in the
  // meantime never reached the client and the thread looked stale until a
  // manual refresh. On resume we refetch the latest page and merge in anything
  // we don't already have, and finalize any agent reply that completed while
  // we were away.
  const resync = useCallback(async () => {
    if (!roomId) return;
    try {
      const response = await api.getMessages(roomId);
      const serverItems = [...response.items].reverse();
      const existing = useAppStore.getState().messages[roomId]?.items ?? [];
      const byId = new Map(existing.map((m) => [m.id, m] as const));
      for (const m of serverItems) {
        const cur = byId.get(m.id);
        if (!cur) {
          addMessage(roomId, m);
        } else if (cur.content !== m.content || cur.streaming) {
          updateMessage(roomId, m.id, {
            content: m.content,
            updated_at: m.updated_at,
            streaming: false,
          });
        }
      }
    } catch {
      /* best-effort; the next live event or a manual refresh reconciles */
    }
  }, [roomId, addMessage, updateMessage]);

  useEffect(() => {
    if (!roomId) return;
    const unsubConnected = ws.on("connected", () => {
      void resync();
    });
    const unsubResumed = ws.on("resumed", () => {
      void resync();
    });
    return () => {
      unsubConnected();
      unsubResumed();
    };
  }, [roomId, resync]);

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

      console.debug(
        "[chat] send (optimistic %s): %s",
        optimisticId,
        trimmedContent.slice(0, 60),
      );
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
        // The realtime WS echo of this same message can race ahead of this POST
        // response and already be in the list under its server id. If so, drop
        // our optimistic copy rather than renaming it to that id — renaming would
        // produce two items with the same id and render the message twice (the
        // duplicate-own-message bug). If the echo hasn't arrived yet, rename as
        // usual; a later echo is then deduped by addMessage's id check.
        const alreadyEchoed = (
          useAppStore.getState().messages[roomId]?.items ?? []
        ).some((m) => m.id === serverMessage.id);
        console.debug(
          "[chat] POST ok %s -> server %s | echo already present: %s",
          optimisticId,
          serverMessage.id,
          alreadyEchoed,
        );
        if (alreadyEchoed) {
          removeMessage(roomId, optimisticId);
        } else {
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
        }
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
    async (messageId: string, content: string): Promise<boolean> => {
      if (!roomId) return false;
      const original = messages.find((m) => m.id === messageId);
      if (!original) return false;

      updateMessage(roomId, messageId, { content, edited: true });

      try {
        await api.editMessage(roomId, messageId, content);
        return true;
      } catch (err) {
        updateMessage(roomId, messageId, {
          content: original.content,
          edited: original.edited,
        });
        useAppStore.getState().pushToast({
          title: "Edit failed",
          body:
            (err as { detail?: string; message?: string })?.detail ||
            (err as { message?: string })?.message ||
            (err instanceof Error ? err.message : "Request failed"),
          kind: "error",
        });
        return false;
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
      } catch (err) {
        addMessage(roomId, original);
        useAppStore.getState().pushToast({
          title: "Delete failed",
          body:
            (err as { detail?: string; message?: string })?.detail ||
            (err as { message?: string })?.message ||
            (err instanceof Error ? err.message : "Request failed"),
          kind: "error",
        });
      }
    },
    [roomId, messages, addMessage, removeMessage],
  );

  return {
    messages,
    hasMore,
    loading,
    error: messagesState?.error ?? false,
    retryInitial: fetchInitialPage,
    sendMessage,
    loadMore,
    editMessage,
    deleteMessage,
    retryMessage,
    resync,
  };
}
