// What the loading screen shows while a saved city opens (issue #327,
// "Loading" under the graphics presets in the PRD): the stages of opening
// it, in order, and how far along the bar each starts. A new city opens
// with no screen. The screen reads progress from the worker and the page;
// it changes nothing in the sim.

import type { DerivedStage } from "@city-council/sim";

/**
 * A stage of opening a saved city. `reading` is the worker reading the
 * save, the derived stages are `prepareDerived`'s in the worker, `map` is
 * the page drawing the terrain and `view` the page building the meshes of
 * the start view, its buildings out to where they are simplified, and
 * drawing its first frame.
 */
export type LoadStage = "reading" | DerivedStage | "map" | "view";

export interface LoadStageInfo {
  stage: LoadStage;
  /** What the screen says while the stage runs. */
  label: string;
  /** The stage's share of the bar, against the others. */
  weight: number;
}

/**
 * Every stage in the order they run. Each weight is the milliseconds the
 * stage took opening the 500,000 resident scale city from its file in
 * Chromium with software WebGL 2 at Low in the development container, as
 * `e2e/scale-cities-load.spec.ts` reports them (#327), so the bar moves
 * about evenly in time on that city. Only their ratios matter. Reading
 * starts as the page does, so it takes in the worker starting and the file
 * being stored.
 */
export const LOAD_STAGES: readonly LoadStageInfo[] = [
  { stage: "reading", label: "Reading the save", weight: 1000 },
  { stage: "terrain", label: "Shaping the terrain", weight: 35 },
  { stage: "roads", label: "Indexing the roads", weight: 60 },
  { stage: "cells", label: "Laying out the zoning cells", weight: 1900 },
  { stage: "buildings", label: "Finding every building and household", weight: 280 },
  { stage: "travel", label: "Working out travel times", weight: 610 },
  { stage: "openings", label: "Finding room to build", weight: 140 },
  { stage: "map", label: "Drawing the terrain", weight: 420 },
  { stage: "view", label: "Drawing the start view", weight: 5300 },
];

const TOTAL_WEIGHT = LOAD_STAGES.reduce((sum, s) => sum + s.weight, 0);

function indexOf(stage: LoadStage): number {
  return LOAD_STAGES.findIndex((s) => s.stage === stage);
}

/** How far along the bar, from 0 to 1, `stage` starts. */
export function progressAt(stage: LoadStage): number {
  let before = 0;
  for (const s of LOAD_STAGES) {
    if (s.stage === stage) return before / TOTAL_WEIGHT;
    before += s.weight;
  }
  return 0;
}

/** What the screen shows, or null while it is down. */
export interface LoadingShown {
  stage: LoadStage;
  label: string;
  /** From 0 to 1. */
  progress: number;
}

/** When a stage began, by the page's clock. */
export interface LoadStageTime {
  stage: LoadStage;
  at: number;
}

/**
 * Where the screen is. It goes up once, moves only forward through
 * `LOAD_STAGES`, since the worker's messages and the page's own stages can
 * come in either order at the seams, and comes down for good.
 */
export class LoadingProgress {
  private readonly now: () => number;
  private index = -1;
  private finished = false;
  /** When each stage the screen showed began, in order. */
  readonly times: LoadStageTime[] = [];
  /** When the screen came down, or null while it is up or was never up. */
  doneAt: number | null = null;

  constructor(now: () => number) {
    this.now = now;
  }

  get visible(): boolean {
    return this.index >= 0 && !this.finished;
  }

  get shown(): LoadingShown | null {
    const info = this.visible ? LOAD_STAGES[this.index] : undefined;
    return info ? { stage: info.stage, label: info.label, progress: progressAt(info.stage) } : null;
  }

  /** Puts the screen up at `stage`, or moves it on to `stage`. False when nothing changed. */
  show(stage: LoadStage): boolean {
    const i = indexOf(stage);
    if (this.finished || i <= this.index) return false;
    this.index = i;
    this.times.push({ stage, at: this.now() });
    return true;
  }

  /** Moves the screen on to `stage` while it is up. False when nothing changed. */
  advance(stage: LoadStage): boolean {
    return this.visible && this.show(stage);
  }

  /** Takes the screen down, and keeps it down. True when it was up. */
  done(): boolean {
    const was = this.visible;
    this.finished = true;
    if (was) this.doneAt = this.now();
    return was;
  }
}
