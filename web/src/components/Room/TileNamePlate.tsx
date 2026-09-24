import type { ReactNode } from "react";
import clsx from "clsx";
import { localTilePlate, type TileNameMode } from "@/lib/tileChrome";

/**
 * The name drawn on a call tile. `off` renders nothing. `hover` stays hidden
 * until the pointer is over the tile (`group` on the tile) or focus is inside
 * it. The guest badge does not belong in here — it has to stay visible when
 * the name is hidden.
 */
export function TileNamePlate({
  mode,
  className,
  children,
}: {
  mode: TileNameMode;
  className?: string;
  children: ReactNode;
}) {
  if (mode === "off") return null;
  return (
    <span
      data-testid="tile-name-plate"
      data-name-mode={mode}
      className={clsx(
        "glass flex min-w-0 items-center gap-1.5 truncate rounded-md px-2 text-xs font-medium text-slate-100",
        mode === "hover" &&
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Local tiles say the display name, with a small "(you)" after it. */
export function CallTileName({
  name,
  isLocal,
  mode,
  className,
}: {
  name: string;
  isLocal: boolean;
  mode: TileNameMode;
  className?: string;
}) {
  return (
    <TileNamePlate mode={mode} className={className}>
      <span className="truncate">{isLocal ? localTilePlate(name) : name}</span>
    </TileNamePlate>
  );
}
