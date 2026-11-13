// Keyboard shortcuts for the UI shell. One table drives both the key handler
// and the list in the debug panel, so the list cannot drift from the keys.

import type { Speed } from "@city-council/sim";
import type { DrawMode, ToolRoadType } from "../tools/road-tool";

export type ShortcutAction =
  | { kind: "speed"; speed: Speed }
  | { kind: "togglePause" }
  | { kind: "toggleDebug" }
  | { kind: "toggleLog" }
  | { kind: "roadTool" }
  | { kind: "roadType"; type: ToolRoadType }
  | { kind: "drawMode"; mode: DrawMode }
  | { kind: "escape" };

export interface Shortcut {
  /** `KeyboardEvent.code` values that trigger it. */
  codes: readonly string[];
  /** How the key is written in the list. */
  label: string;
  description: string;
  action: ShortcutAction;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { codes: ["Space"], label: "Space", description: "pause or resume", action: { kind: "togglePause" } },
  { codes: ["Digit1", "Numpad1"], label: "1", description: "speed 1x", action: { kind: "speed", speed: 1 } },
  { codes: ["Digit2", "Numpad2"], label: "2", description: "speed 2x", action: { kind: "speed", speed: 2 } },
  { codes: ["Digit3", "Numpad3"], label: "3", description: "speed 4x", action: { kind: "speed", speed: 4 } },
  { codes: ["Backquote"], label: "`", description: "show or hide this panel", action: { kind: "toggleDebug" } },
  { codes: ["KeyL"], label: "L", description: "show or hide the activity log", action: { kind: "toggleLog" } },
  { codes: ["KeyB"], label: "B", description: "road tool on or off", action: { kind: "roadTool" } },
  { codes: ["KeyZ"], label: "Z", description: "draw streets", action: { kind: "roadType", type: "street" } },
  { codes: ["KeyX"], label: "X", description: "draw avenues", action: { kind: "roadType", type: "avenue" } },
  { codes: ["KeyC"], label: "C", description: "draw one-way roads", action: { kind: "roadType", type: "oneWay" } },
  { codes: ["KeyT"], label: "T", description: "draw straight roads", action: { kind: "drawMode", mode: "straight" } },
  { codes: ["KeyY"], label: "Y", description: "draw curved roads", action: { kind: "drawMode", mode: "curved" } },
  { codes: ["KeyU"], label: "U", description: "draw continuous roads", action: { kind: "drawMode", mode: "continuous" } },
  {
    codes: ["Escape"],
    label: "Esc",
    description: "drop the road being drawn, or leave the tool",
    action: { kind: "escape" },
  },
];

/** Camera keys, handled by the camera controls. Listed so the panel shows every key. */
export const CAMERA_KEYS: readonly { label: string; description: string }[] = [
  { label: "W A S D, arrows", description: "pan" },
  { label: "Q E", description: "turn" },
  { label: "R F", description: "tilt" },
  { label: "+ -", description: "zoom" },
  { label: "Drag, right-drag, wheel", description: "pan, orbit, zoom" },
  { label: "Click, right-click", description: "with the road tool: start or end a road, drop it" },
  { label: "Double click", description: "with the road tool: end a continuous road" },
  { label: "Hold Alt", description: "with the road tool: draw free-hand, without guides" },
];

/** The parts of a key event the shortcut handler looks at. */
export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** Tag name of the focused element, upper case as the DOM gives it. */
  targetTag: string;
  targetEditable: boolean;
}

/**
 * The shortcut a key press triggers, or null. Keys typed into a field are
 * left alone, and so is Space on a button, which presses the button.
 */
export function shortcutFor(press: KeyPress): ShortcutAction | null {
  if (press.ctrlKey || press.metaKey || press.altKey || press.repeat) return null;
  const tag = press.targetTag;
  if (press.targetEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  if (press.code === "Space" && (tag === "BUTTON" || tag === "SUMMARY" || tag === "A" || tag === "LABEL")) return null;
  return SHORTCUTS.find((s) => s.codes.includes(press.code))?.action ?? null;
}

/**
 * The speed a pause-or-resume sends: pause when running, otherwise go back
 * to the last speed the city ran at.
 */
export function toggledSpeed(current: Speed, lastRunning: Speed): Speed {
  if (current !== 0) return 0;
  return lastRunning === 0 ? 1 : lastRunning;
}
