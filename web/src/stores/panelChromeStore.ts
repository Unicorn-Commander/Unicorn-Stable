/**
 * Presentation chrome for resizable / floatable / pop-out panels.
 *
 * Each named panel (people, saved, …) remembers:
 *  - presentation: dock | float | overlay
 *  - float geometry (x/y/w/h) for in-app floating windows
 *
 * True browser pop-outs are ephemeral (browser may block); we only remember
 * that the user prefers popout so reopen can try again.
 */

import { create } from "zustand";

export type PanelPresentation = "dock" | "float" | "overlay";

export type PanelId = "people" | "saved" | "activity";

export interface FloatGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PRES_KEY = (id: string) => `stable.panel.presentation.${id}.v1`;
const FLOAT_KEY = (id: string) => `stable.panel.float.${id}.v1`;

function readPresentation(id: PanelId, fallback: PanelPresentation): PanelPresentation {
  try {
    const raw = localStorage.getItem(PRES_KEY(id));
    if (raw === "dock" || raw === "float" || raw === "overlay") return raw;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writePresentation(id: PanelId, value: PanelPresentation) {
  try {
    localStorage.setItem(PRES_KEY(id), value);
  } catch {
    /* ignore */
  }
}

function readFloat(id: PanelId, fallback: FloatGeometry): FloatGeometry {
  try {
    const raw = localStorage.getItem(FLOAT_KEY(id));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<FloatGeometry>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.w === "number" &&
      typeof parsed.h === "number"
    ) {
      return {
        x: Math.round(parsed.x),
        y: Math.round(parsed.y),
        w: Math.round(parsed.w),
        h: Math.round(parsed.h),
      };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeFloat(id: PanelId, geom: FloatGeometry) {
  try {
    localStorage.setItem(FLOAT_KEY(id), JSON.stringify(geom));
  } catch {
    /* ignore */
  }
}

function defaultFloat(id: PanelId): FloatGeometry {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  if (id === "people") {
    return { x: Math.max(24, vw - 420), y: 72, w: 380, h: Math.min(640, vh - 96) };
  }
  return { x: Math.max(48, vw / 2 - 280), y: 80, w: 520, h: Math.min(560, vh - 120) };
}

interface PanelChromeState {
  presentation: Record<PanelId, PanelPresentation>;
  floatGeom: Record<PanelId, FloatGeometry>;
  /** In-app: prefer browser pop-out when available (desktop). */
  preferPopout: Partial<Record<PanelId, boolean>>;
  setPresentation: (id: PanelId, mode: PanelPresentation) => void;
  setFloatGeom: (id: PanelId, geom: FloatGeometry) => void;
  setPreferPopout: (id: PanelId, prefer: boolean) => void;
}

export const usePanelChromeStore = create<PanelChromeState>((set) => ({
  presentation: {
    people: readPresentation("people", "dock"),
    saved: readPresentation("saved", "float"),
    activity: readPresentation("activity", "float"),
  },
  floatGeom: {
    people: readFloat("people", defaultFloat("people")),
    saved: readFloat("saved", defaultFloat("saved")),
    activity: readFloat("activity", defaultFloat("activity")),
  },
  preferPopout: {},
  setPresentation: (id, mode) => {
    writePresentation(id, mode);
    set((s) => ({
      presentation: { ...s.presentation, [id]: mode },
      preferPopout: { ...s.preferPopout, [id]: false },
    }));
  },
  setFloatGeom: (id, geom) => {
    writeFloat(id, geom);
    set((s) => ({
      floatGeom: { ...s.floatGeom, [id]: geom },
    }));
  },
  setPreferPopout: (id, prefer) =>
    set((s) => ({
      preferPopout: { ...s.preferPopout, [id]: prefer },
    })),
}));
