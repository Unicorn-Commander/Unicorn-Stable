import { create } from "zustand";
import type { NewSheetItemId } from "@/lib/conversation";

export interface PendingInviteNotice {
  id: string;
  roomId: string;
  label: string;
  at: number;
}

interface ConversationUiState {
  newSheetOpen: boolean;
  /** Which New-sheet step to land on. Null is the menu. */
  newSheetStep: NewSheetItemId | null;
  openNewSheet: (step?: NewSheetItemId | null) => void;
  closeNewSheet: () => void;
  /** Room whose title field should focus after a thread is created. */
  focusTitleRoomId: string | null;
  armTitleFocus: (roomId: string) => void;
  takeTitleFocus: (roomId: string) => boolean;
  /** Bumped to ask AppShell to open the quick switcher (the rail's Search). */
  quickSwitcherNonce: number;
  requestQuickSwitcher: () => void;
  /** Invites that still need a look. Toast plus a sidebar row until dismissed. */
  pendingInvites: PendingInviteNotice[];
  noteInvite: (notice: PendingInviteNotice) => void;
  dismissInvite: (id: string) => void;
  inviteSheetRoomId: string | null;
  openInviteSheet: (roomId: string) => void;
  closeInviteSheet: () => void;
  /** The phone's Me tab sheet (profile, People, Activity, Saved, Settings, Sign out). */
  meSheetOpen: boolean;
  openMeSheet: () => void;
  closeMeSheet: () => void;
  /** Bumped to put the cursor in Home's composer (the shortcut, "Message …"). */
  homeComposerNonce: number;
  focusHomeComposer: () => void;
  /**
   * Attachments on their way to a room's composer: a message that could not
   * be posted into a conversation Home just created lands there as a draft,
   * and what was attached goes with it. Taken once, by that room's composer.
   */
  handedAttachments: Record<string, HandedAttachment[]>;
  handAttachments: (roomId: string, attachments: HandedAttachment[]) => void;
  takeAttachments: (roomId: string) => HandedAttachment[];
}

export interface HandedAttachment {
  url: string;
  filename: string;
  content_type: string;
  size: number;
}

export const useConversationUi = create<ConversationUiState>((set, get) => ({
  newSheetOpen: false,
  newSheetStep: null,
  openNewSheet: (step = null) => set({ newSheetOpen: true, newSheetStep: step }),
  closeNewSheet: () => set({ newSheetOpen: false, newSheetStep: null }),
  focusTitleRoomId: null,
  armTitleFocus: (roomId) => set({ focusTitleRoomId: roomId }),
  takeTitleFocus: (roomId) => {
    if (get().focusTitleRoomId !== roomId) return false;
    set({ focusTitleRoomId: null });
    return true;
  },
  quickSwitcherNonce: 0,
  requestQuickSwitcher: () =>
    set((s) => ({ quickSwitcherNonce: s.quickSwitcherNonce + 1 })),
  pendingInvites: [],
  noteInvite: (notice) =>
    set((s) => ({
      pendingInvites: [
        notice,
        ...s.pendingInvites.filter((row) => row.id !== notice.id),
      ].slice(0, 8),
    })),
  dismissInvite: (id) =>
    set((s) => ({ pendingInvites: s.pendingInvites.filter((row) => row.id !== id) })),
  inviteSheetRoomId: null,
  openInviteSheet: (roomId) => set({ inviteSheetRoomId: roomId }),
  closeInviteSheet: () => set({ inviteSheetRoomId: null }),
  meSheetOpen: false,
  openMeSheet: () => set({ meSheetOpen: true }),
  closeMeSheet: () => set({ meSheetOpen: false }),
  homeComposerNonce: 0,
  focusHomeComposer: () => set((s) => ({ homeComposerNonce: s.homeComposerNonce + 1 })),
  handedAttachments: {},
  handAttachments: (roomId, attachments) =>
    set((s) => {
      const next = { ...s.handedAttachments };
      if (attachments.length > 0) next[roomId] = attachments;
      else delete next[roomId];
      return { handedAttachments: next };
    }),
  takeAttachments: (roomId) => {
    const handed = get().handedAttachments[roomId];
    if (!handed) return [];
    set((s) => {
      const next = { ...s.handedAttachments };
      delete next[roomId];
      return { handedAttachments: next };
    });
    return handed;
  },
}));
