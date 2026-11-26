// The order windows were opened in, so Escape closes the newest first
// (issue #332). A panel is a window, and so is a tool with its menu: Escape
// on a tool drops what it holds and then leaves it, so a tool stays on top
// until it is off. An overlay the player turned on, such as land value, is
// a window too, so Escape puts it away. Zoning is not: it comes and goes
// with the tools that bring it. Pure, so the order is checked without a page.

/** The panels that open from a button, and the tool on the dock. */
export type PanelId = "settings" | "city" | "stats" | "log" | "debug";
export type WindowId = PanelId | "tool" | "overlay";

/** The element each panel is, by id, for focus and the buttons that control it. */
export const PANEL_ELEMENTS: Record<PanelId, string> = {
  settings: "settings-menu",
  city: "city-menu",
  stats: "stats-panel",
  log: "activity-log",
  debug: "debug-panel",
};

/**
 * Where panel `id` sits in the column under the top bar's buttons: the
 * settings menu first, under its button, then the other panels newest
 * first, so the one just opened is next to the button that opened it.
 * A CSS `order`.
 */
export function columnOrder(windows: readonly WindowId[], id: PanelId): number {
  if (id === "settings") return -1000;
  const at = windows.indexOf(id);
  return at < 0 ? 0 : -at;
}

/** `windows` with `id` on top when it opens, or taken out when it closes. */
export function stacked(windows: readonly WindowId[], id: WindowId, open: boolean): WindowId[] {
  const rest = windows.filter((w) => w !== id);
  return open ? [...rest, id] : rest;
}

/**
 * The stack after the tool changes from `before` to `now`. Picking a tool,
 * or another one, puts the tool on top; leaving the last one takes it out.
 */
export function stackedForTool(windows: readonly WindowId[], now: string | null, before: string | null): readonly WindowId[] {
  if (now === before) return windows;
  return stacked(windows, "tool", now !== null);
}

/**
 * The stack after the overlay changes from `before` to `now`. Turning on
 * one the player chooses, or another one, puts the overlay on top; going
 * to zoning or to none takes it out.
 */
export function stackedForOverlay(windows: readonly WindowId[], now: string | null, before: string | null): readonly WindowId[] {
  if (now === before) return windows;
  return stacked(windows, "overlay", now !== null && now !== "zoning");
}

/** The window Escape closes: the newest, or null with none open. */
export function escapeTarget(windows: readonly WindowId[]): WindowId | null {
  return windows.at(-1) ?? null;
}
