// The order windows were opened in, so Escape closes the newest first
// (issue #332). A panel is a window, and so is a tool with its menu: Escape
// on a tool drops what it holds and then leaves it, so a tool stays on top
// until it is off. Pure, so the order is checked without a page.

/** The panels that open from a button, and the tool on the dock. */
export type PanelId = "settings" | "city" | "stats" | "log" | "debug";
export type WindowId = PanelId | "tool";

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

/** The window Escape closes: the newest, or null with none open. */
export function escapeTarget(windows: readonly WindowId[]): WindowId | null {
  return windows.at(-1) ?? null;
}
