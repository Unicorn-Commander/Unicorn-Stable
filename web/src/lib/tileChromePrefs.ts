/**
 * Per-user call chrome on this device.
 *
 * The account's `call_prefs` blob only stores the video device-check (the
 * server drops every other key). Until a field exists there, this browser
 * remembers the choice, keyed by user so two people on one machine don't
 * share it.
 */
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import {
  isTileNameMode,
  type TileNameMode,
} from "@/lib/tileChrome";

export interface TileChromePrefs {
  /** Name drawn on call tiles. Default on — a tile should say who it is. */
  tileNames: TileNameMode;
  /** Active-speaker lower third. Default off. */
  lowerThird: boolean;
}

export const DEFAULT_TILE_CHROME_PREFS: TileChromePrefs = {
  tileNames: "always",
  lowerThird: false,
};

const KEY = "stable.tile-chrome.v1";

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTileChrome(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function userKey(userId?: string | null): string {
  return userId || "anonymous";
}

function readAll(): Record<string, Partial<TileChromePrefs>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Partial<TileChromePrefs>>)
      : {};
  } catch {
    return {};
  }
}

export function readTileChromePrefs(userId?: string | null): TileChromePrefs {
  const mine = readAll()[userKey(userId)] || {};
  return {
    tileNames: isTileNameMode(mine.tileNames)
      ? mine.tileNames
      : DEFAULT_TILE_CHROME_PREFS.tileNames,
    lowerThird: mine.lowerThird === true,
  };
}

export function writeTileChromePrefs(
  userId: string | null | undefined,
  patch: Partial<TileChromePrefs>,
): TileChromePrefs {
  const next: TileChromePrefs = {
    ...readTileChromePrefs(userId),
    ...patch,
  };
  if (!isTileNameMode(next.tileNames)) {
    next.tileNames = DEFAULT_TILE_CHROME_PREFS.tileNames;
  }
  next.lowerThird = next.lowerThird === true;
  try {
    const all = readAll();
    all[userKey(userId)] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode — this page still returns `next` to the caller.
  }
  emit();
  return next;
}

export function useTileChromePrefs(): TileChromePrefs {
  const userId = useAppStore((s) => s.currentUser?.id ?? null);
  const [prefs, setPrefs] = useState(() => readTileChromePrefs(userId));
  useEffect(() => {
    setPrefs(readTileChromePrefs(userId));
    return subscribeTileChrome(() => setPrefs(readTileChromePrefs(userId)));
  }, [userId]);
  return prefs;
}

export function useSetTileChromePrefs(): (
  patch: Partial<TileChromePrefs>,
) => void {
  const userId = useAppStore((s) => s.currentUser?.id ?? null);
  return useCallback(
    (patch) => {
      writeTileChromePrefs(userId, patch);
    },
    [userId],
  );
}
