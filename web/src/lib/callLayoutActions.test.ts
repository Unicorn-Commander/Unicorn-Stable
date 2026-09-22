import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPanelOpener } from "@/components/Layout/panelOpeners";
import { useCallUiStore } from "@/stores/callUiStore";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import {
  ROOM_PANEL_IDS,
  builtinPreset,
  type RoomPanelId,
} from "@/stores/panelRegistry";
import {
  chatIsVisible,
  openPopped,
  presentChat,
  setMobileCallIntent,
  toggleCallChat,
} from "./callLayoutActions";

function registerAll(
  roomId: string,
  openImpl: (id: RoomPanelId) => boolean,
  isOpen: (id: RoomPanelId) => boolean,
): () => void {
  const stops = ROOM_PANEL_IDS.map((id) =>
    registerPanelOpener(roomId, id, {
      open: () => openImpl(id),
      close: () => {},
      isOpen: () => isOpen(id),
    }),
  );
  return () => {
    for (const stop of stops) stop();
  };
}

describe("presentChat", () => {
  const base = {
    callIsHere: true,
    isDesktop: true,
    mobileCallMode: "split" as const,
    chatMode: "docked" as const,
    textLayout: false,
  };

  it("docks chat when no call is up", () => {
    expect(presentChat({ ...base, callIsHere: false, chatMode: "hidden" })).toBe(
      "docked",
    );
  });

  it("hides phone chat in Video without requiring the registry to say hidden", () => {
    expect(
      presentChat({
        ...base,
        isDesktop: false,
        mobileCallMode: "video",
        chatMode: "docked",
      }),
    ).toBe("hidden");
  });

  it("shows a docked phone chat in Split and keeps a popped chat popped", () => {
    expect(
      presentChat({ ...base, isDesktop: false, mobileCallMode: "split" }),
    ).toBe("docked");
    expect(
      presentChat({
        ...base,
        isDesktop: false,
        mobileCallMode: "split",
        chatMode: "popped",
      }),
    ).toBe("popped");
    expect(
      presentChat({
        ...base,
        isDesktop: false,
        mobileCallMode: "chat",
        chatMode: "hidden",
      }),
    ).toBe("hidden");
  });

  it("keeps a hidden or popped desktop chat, and docks the text layout", () => {
    expect(presentChat({ ...base, chatMode: "hidden" })).toBe("hidden");
    expect(presentChat({ ...base, chatMode: "popped" })).toBe("popped");
    expect(presentChat({ ...base, textLayout: true, chatMode: "floating" })).toBe(
      "floating",
    );
    expect(presentChat({ ...base, textLayout: true, chatMode: "hidden" })).toBe(
      "hidden",
    );
    expect(presentChat({ ...base, textLayout: true })).toBe("docked");
  });
});

describe("chatIsVisible", () => {
  it("follows the registry on desktop and Video on a phone", () => {
    expect(
      chatIsVisible({ mode: "docked", desktop: true, mobileCallMode: "video" }),
    ).toBe(true);
    expect(
      chatIsVisible({ mode: "hidden", desktop: true, mobileCallMode: "split" }),
    ).toBe(false);
    expect(
      chatIsVisible({ mode: "popped", desktop: true, mobileCallMode: "split" }),
    ).toBe(true);
    expect(
      chatIsVisible({ mode: "docked", desktop: false, mobileCallMode: "video" }),
    ).toBe(false);
    expect(
      chatIsVisible({ mode: "docked", desktop: false, mobileCallMode: "split" }),
    ).toBe(true);
    expect(
      chatIsVisible({ mode: "hidden", desktop: false, mobileCallMode: "split" }),
    ).toBe(false);
  });
});

describe("toggleCallChat and phone intent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useCallUiStore.setState({
      mobileCallMode: "split",
      mobileCallModeUserOverride: false,
    });
  });

  it("shows and hides chat on a desktop viewport", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: query.includes("768"),
        media: query,
      }),
    });
    const roomId = "toggle-desktop";
    usePanelChromeStore.getState().setPanelMode(roomId, "chat", "hidden");
    toggleCallChat(roomId);
    expect(usePanelChromeStore.getState().getPanel(roomId, "chat").mode).toBe(
      "docked",
    );
    toggleCallChat(roomId);
    expect(usePanelChromeStore.getState().getPanel(roomId, "chat").mode).toBe(
      "hidden",
    );
  });

  it("does not write the desktop registry when the phone picks Video", () => {
    const roomId = "toggle-phone";
    usePanelChromeStore.getState().ensureRoom(roomId);
    expect(usePanelChromeStore.getState().getPanel(roomId, "chat").mode).toBe(
      "docked",
    );
    setMobileCallIntent("video");
    expect(useCallUiStore.getState().mobileCallMode).toBe("video");
    expect(usePanelChromeStore.getState().getPanel(roomId, "chat").mode).toBe(
      "docked",
    );
    setMobileCallIntent("split");
    expect(useCallUiStore.getState().mobileCallMode).toBe("split");
    expect(usePanelChromeStore.getState().getPanel(roomId, "chat").mode).toBe(
      "docked",
    );
  });
});

describe("openPopped", () => {
  it("opens one window and hides every other popped panel", () => {
    const roomId = "pop-one";
    const opened: RoomPanelId[] = [];
    const stop = registerAll(
      roomId,
      (id) => {
        opened.push(id);
        return true;
      },
      () => false,
    );
    const result = openPopped(roomId, builtinPreset("show"));
    stop();
    expect(opened).toEqual(["stage"]);
    expect(result.opened).toBe("stage");
    expect(result.panels.stage.mode).toBe("popped");
    expect(result.panels.chat.mode).toBe("hidden");
    expect(result.panels.tasks.mode).toBe("hidden");
    expect(result.panels.threads.mode).toBe("hidden");
    expect(result.panels.members.mode).toBe("hidden");
    expect(result.panels.canvas.mode).toBe("hidden");
    for (const id of ROOM_PANEL_IDS) {
      expect(result.panels[id].mode).not.toBe("docked");
    }
  });

  it("hides a blocked pop instead of docking it", () => {
    const roomId = "pop-blocked";
    const opened: RoomPanelId[] = [];
    const stop = registerAll(
      roomId,
      (id) => {
        opened.push(id);
        return false;
      },
      () => false,
    );
    const result = openPopped(roomId, builtinPreset("show"));
    stop();
    expect(opened).toEqual(["stage"]);
    expect(result.opened).toBeNull();
    for (const id of ROOM_PANEL_IDS) {
      expect(result.panels[id].mode).toBe("hidden");
    }
  });

  it("pops the next panel on the next gesture", () => {
    const roomId = "pop-next";
    const opened: RoomPanelId[] = [];
    const stop = registerAll(
      roomId,
      (id) => {
        opened.push(id);
        return true;
      },
      (id) => id === "stage",
    );
    const result = openPopped(roomId, builtinPreset("show"));
    stop();
    expect(opened).toEqual(["chat"]);
    expect(result.panels.stage.mode).toBe("popped");
    expect(result.panels.chat.mode).toBe("popped");
    expect(result.panels.transcript.mode).toBe("hidden");
    expect(result.deferred).toContain("tasks");
  });
});
