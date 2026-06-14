/**
 * Stable empty references for Zustand selectors.
 *
 * React 19's useSyncExternalStore requires that getSnapshot returns
 * a cached (referentially stable) value. Selectors like
 *   `s.participants[roomId] ?? []`
 * create a NEW empty array on every call, which React interprets as
 * "state changed" and re-renders infinitely.
 *
 * Use these module-level constants instead of inline `[]` or `{}`.
 */

import type { RoomMember, Agent, Message } from "@/services/api";
import type { TypingUser } from "@/stores/appStore";

export const EMPTY_MEMBERS: RoomMember[] = [];
export const EMPTY_AGENTS: Agent[] = [];
export const EMPTY_MESSAGES: Message[] = [];
export const EMPTY_TYPING: TypingUser[] = [];
export const EMPTY_STRINGS: string[] = [];
export const EMPTY_READ_RECEIPTS: Record<string, string> = {};
