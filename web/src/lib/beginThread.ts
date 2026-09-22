import { api, type Room } from "@/services/api";

/** Talk to an agent: one hub, never a freshly minted room. */
export async function openAgentHub(
  agentId: string,
  navigate?: (to: string) => void,
): Promise<Room | null> {
  try {
    const hub = await api.ensureAgentHub(agentId);
    const state = useAppStore.getState();
    if (state.rooms.some((r) => r.id === hub.id)) state.updateRoom(hub.id, hub);
    else state.upsertRoom(hub);
    navigate?.(`/c/${hub.id}`);
    return hub;
  } catch (err) {
    const detail =
      (err as { detail?: string; message?: string }).detail ||
      (err as Error).message ||
      "Request failed";
    useAppStore.getState().pushToast({
      title: "Couldn't open that agent",
      body: typeof detail === "string" ? detail : "Request failed",
      kind: "error",
    });
    return null;
  }
}

import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { noteThreadOnParent, threadParentId } from "@/lib/conversation";

export interface BeginThreadInput {
  /** Room the thread hangs under. A thread room redirects to its parent. */
  roomId: string;
  title?: string | null;
  seedMessageId?: string | null;
  navigate?: (to: string) => void;
}

/**
 * POST /rooms/{id}/threads, put the child in the list immediately, and open
 * it with the title field armed. Blank title stays blank on the wire so the
 * server can auto-title after the first exchange.
 */
export async function beginThread(input: BeginThreadInput): Promise<Room | null> {
  const state = useAppStore.getState();
  const known = state.rooms.find((r) => r.id === input.roomId) ?? null;
  const parentId = known ? threadParentId(known, state.rooms) : input.roomId;
  if (!parentId) return null;
  try {
    const thread = await api.createThread(parentId, {
      title: input.title,
      seed_message_id: input.seedMessageId,
    });
    const parent = useAppStore.getState().rooms.find((r) => r.id === parentId);
    const next = noteThreadOnParent(
      useAppStore.getState().rooms,
      parentId,
      { ...thread, parent_room_id: thread.parent_room_id ?? parentId },
    );
    useAppStore.getState().setRooms(next);
    // setRooms merges with previous; the child is new so it is inserted.
    // Re-assert in case a concurrent setRooms dropped it.
    if (!useAppStore.getState().rooms.some((r) => r.id === thread.id)) {
      useAppStore.getState().upsertRoom({
        ...thread,
        parent_room_id: thread.parent_room_id ?? parentId,
        brigade_agent_id: thread.brigade_agent_id ?? parent?.brigade_agent_id ?? null,
      });
    }
    useConversationUi.getState().armTitleFocus(thread.id);
    input.navigate?.(`/c/${thread.id}`);
    return thread;
  } catch (err) {
    const detail =
      (err as { detail?: string; message?: string }).detail ||
      (err as Error).message ||
      "Request failed";
    useAppStore.getState().pushToast({
      title: "Couldn't start a thread",
      body: typeof detail === "string" ? detail : "Request failed",
      kind: "error",
    });
    return null;
  }
}
