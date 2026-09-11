export function shouldUsePortraitStage(input: {
  desktop: boolean;
  landscape: boolean;
  mode: string;
  remoteCount: number;
  screenCount: number;
  view: string;
  chips: boolean;
}): boolean {
  return (
    !input.desktop &&
    !input.landscape &&
    input.mode === "video" &&
    input.remoteCount === 1 &&
    input.screenCount === 0 &&
    input.view !== "screen" &&
    !input.chips
  );
}
/** 112×160 bubble, 8px side gutter, room for the top switcher and floating call controls. */
export function clampSelfView(
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return {
    x: Math.max(8, Math.min(x, Math.max(8, width - 120))),
    y: Math.max(64, Math.min(y, Math.max(64, height - 292))),
  };
}
