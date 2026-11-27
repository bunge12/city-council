// Which cue the sim's answer to a command makes (issue M3-02). A cue plays
// when the answer arrives, not on the click, so a command the sim refuses
// only ever sounds like a refusal.

import type { CommandResult } from "@city-council/sim";
import type { Cue } from "./config";

/** The cue each kind of command makes once the sim has applied it. Commands not listed make none. */
export const CUE_FOR_COMMAND: Readonly<Record<string, Cue>> = {
  BuildRoad: "road",
  BuildRoadGrid: "road",
  UpgradeRoad: "road",
  ZoneCells: "zone",
  BulldozeRoad: "bulldoze",
  BulldozeBuilding: "bulldoze",
  Undo: "undo",
};

/** How many stroke ids are remembered, so a stroke's later commands stay quiet. */
const STROKES_KEPT = 64;

/**
 * Turns answers into cues. A zone stroke too big for one command goes out as
 * several that share a `stroke` id. It makes one zone cue for its first
 * applied command and one refusal cue for its first refused one, so a
 * stroke the sim took only in part is heard as both, and never as more.
 */
export class CommandCues {
  /** Stroke ids, newest last, with the cues each has already made. */
  private readonly strokes: { id: number; heard: Set<Cue> }[] = [];

  cueFor(type: string, payload: unknown, result: CommandResult): Cue | null {
    const cue = result.ok ? (CUE_FOR_COMMAND[type] ?? null) : "reject";
    const id = strokeOf(payload);
    if (cue === null || id === null) return cue;
    let stroke = this.strokes.find((s) => s.id === id);
    if (!stroke) {
      stroke = { id, heard: new Set() };
      this.strokes.push(stroke);
      if (this.strokes.length > STROKES_KEPT) this.strokes.shift();
    }
    if (stroke.heard.has(cue)) return null;
    stroke.heard.add(cue);
    return cue;
  }
}

/**
 * The cue for what a settled command did to the treasury (M4-14): "money"
 * when it took money out, and none when it cost nothing or paid in, as a
 * bulldoze with a refund or an undone road does. One per command, so a grid
 * of many streets is heard once.
 */
export function moneyCue(result: { ok: true; spent: number } | { ok: false }): Cue | null {
  return result.ok && result.spent > 0 ? "money" : null;
}

function strokeOf(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const stroke = (payload as { stroke?: unknown }).stroke;
  return typeof stroke === "number" ? stroke : null;
}
