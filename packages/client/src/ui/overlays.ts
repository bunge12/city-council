// The overlays the player can choose (issue M3-18). One list, one entry per
// overlay the dock and the keys offer, so M5 and M8 add theirs as entries.
// Zoning is an overlay too, but it is not in the list: the zone tool turns
// it on and off with itself, and so do the road and grid tools, so the
// player sees the cells a road would bring beside the ones already there.
// Only one overlay shows at a time.

import type { CellColouring } from "../render/cell-geometry";

/** Every overlay: zoning, which comes with the zone, road and grid tools, and those in `OVERLAYS`. */
export type OverlayId = "zoning" | "landValue" | "budget";

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
  {
    id: "budget",
    label: "Budget",
    code: "KeyN",
    key: "N",
    title: "Budget (N): colour each block by its net income a year, its buildings' tax less its share of the roads' upkeep, and point at one to see its figures",
    colouring: "budget",
  },
];

/** What the cell meshes are coloured by while `overlay` shows. */
export function colouringOf(overlay: OverlayId | null): CellColouring {
  return OVERLAYS.find((o) => o.id === overlay)?.colouring ?? "zoning";
}

/** The tools that bring the zoning overlay with them. */
const ZONING_TOOLS: readonly (string | null)[] = ["zone", "road", "grid"];

/** Whether tool `tool` brings the zoning overlay with it. */
export function bringsZoning(tool: string | null): boolean {
  return ZONING_TOOLS.includes(tool);
}

/**
 * The overlay after the player turns `id` on or off, with `current`
 * showing and `tool` on. Turning one on puts any other away; turning it
 * off goes back to zoning while a tool that brings it is on, and to none
 * otherwise.
 */
export function toggledOverlay(current: OverlayId | null, id: OverlayEntry["id"], tool: string | null): OverlayId | null {
  if (current !== id) return id;
  return bringsZoning(tool) ? "zoning" : null;
}

/**
 * The overlay after the tool changes from `before` to `now`. Picking the
 * zone tool brings zoning back, whatever showed. Picking the road or grid
 * tool brings it when no overlay shows, and leaves another one, such as
 * land value, as it was. Leaving the last tool that brings zoning puts it
 * away, and leaves any other overlay as it was.
 */
export function overlayAfterTool(current: OverlayId | null, now: string | null, before: string | null): OverlayId | null {
  if (now === "zone" && before !== "zone") return "zoning";
  if (bringsZoning(now) && current === null) return "zoning";
  if (!bringsZoning(now) && current === "zoning") return null;
  return current;
}
