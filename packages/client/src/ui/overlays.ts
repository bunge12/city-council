// The overlays the player can choose (issue M3-18). One list, one entry per
// overlay the dock and the keys offer, so M5 and M8 add theirs as entries.
// Zoning is an overlay too, but it is not in the list: the zone tool turns
// it on and off with itself. Only one overlay shows at a time.

import type { CellColouring } from "../render/cell-geometry";

/** Every overlay: zoning, which comes with the zone tool, and those in `OVERLAYS`. */
export type OverlayId = "zoning" | "landValue";

export interface OverlayEntry {
  id: Exclude<OverlayId, "zoning">;
  /** The dock button's label, and the key that turns it on or off, as `KeyboardEvent.code` and as written. */
  label: string;
  code: string;
  key: string;
  title: string;
  /** What the cell meshes are coloured by while it shows. */
  colouring: CellColouring;
}

export const OVERLAYS: readonly OverlayEntry[] = [
  {
    id: "landValue",
    label: "Land value",
    code: "KeyO",
    key: "O",
    title: "Land value (O): colour the cells along every road by what their land is worth, and point at one to see why",
    colouring: "landValue",
  },
];

/** What the cell meshes are coloured by while `overlay` shows. */
export function colouringOf(overlay: OverlayId | null): CellColouring {
  return OVERLAYS.find((o) => o.id === overlay)?.colouring ?? "zoning";
}

/**
 * The overlay after the player turns `id` on or off, with `current`
 * showing. Turning one on puts any other away; turning it off goes back to
 * zoning while the zone tool is on, and to none otherwise.
 */
export function toggledOverlay(current: OverlayId | null, id: OverlayEntry["id"], zoneToolOn: boolean): OverlayId | null {
  if (current !== id) return id;
  return zoneToolOn ? "zoning" : null;
}

/**
 * The overlay after the tool changes from `before` to `now`. Picking the
 * zone tool brings zoning back, whatever showed; leaving it puts zoning
 * away, and leaves any other overlay as it was.
 */
export function overlayAfterTool(current: OverlayId | null, now: string | null, before: string | null): OverlayId | null {
  if (now === "zone" && before !== "zone") return "zoning";
  if (before === "zone" && now !== "zone" && current === "zoning") return null;
  return current;
}
