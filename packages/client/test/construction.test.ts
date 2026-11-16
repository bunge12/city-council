// Issue 136: construction on screen. The stages a building goes through,
// the attribute a merged chunk rises by, the scaffolding's geometry and the
// clock that says which tick is on screen. construction.ts.

import { describe, expect, it } from "vitest";
import { TICK_MS } from "@city-council/sim";
import { mergeBoxes, mergeFlats, mergeModels, mergedRise, modelExtent, type MergedItem } from "../src/render/building-lod";
import { CONSTRUCTION } from "../src/render/config";
import { createGameClock, finishedAt, scaffoldGeometry, stagesAt, underConstruction } from "../src/render/construction";
import { SURFACE, simplify } from "../src/theme/model";
import { NORTH_AMERICAN } from "../src/theme/north-american";

const T = CONSTRUCTION.ticks;
const UP = CONSTRUCTION.scaffoldUp;
const DOWN = CONSTRUCTION.scaffoldDown;

describe("the stages of construction", () => {
  it("puts the scaffolding up, raises the building inside it, and takes the scaffolding down", () => {
    expect(stagesAt(0)).toEqual({ scaffold: 0, rise: 0 });
    // Scaffolding going up, the building not yet started.
    expect(stagesAt((T * UP) / 2)).toEqual({ scaffold: 0.5, rise: 0 });
    // Scaffolding up, the building half way.
    const mid = stagesAt(T * (UP + (1 - UP - DOWN) / 2));
    expect(mid.scaffold).toBe(1);
    expect(mid.rise).toBeCloseTo(0.5, 10);
    // The building up, the scaffolding half down.
    const down = stagesAt(T * (1 - DOWN / 2));
    expect(down.rise).toBe(1);
    expect(down.scaffold).toBeCloseTo(0.5, 10);
    expect(stagesAt(T)).toEqual({ scaffold: 0, rise: 1 });
    expect(stagesAt(T * 10)).toEqual({ scaffold: 0, rise: 1 });
  });

  it("only ever raises the building and never takes it back down", () => {
    let last = 0;
    for (let age = 0; age <= T; age++) {
      const { rise } = stagesAt(age);
      expect(rise).toBeGreaterThanOrEqual(last);
      last = rise;
    }
  });

  it("counts a building under construction for the animation's length from the tick it was built", () => {
    expect(underConstruction(500, 500)).toBe(true);
    expect(underConstruction(500, 500 + T - 1)).toBe(true);
    expect(underConstruction(500, 500 + T)).toBe(false);
    expect(finishedAt(500)).toBe(500 + T);
  });
});

describe("a merged chunk under construction", () => {
  const model = NORTH_AMERICAN.model("single-family-home", 0, 2, NORTH_AMERICAN.modelDepth("single-family-home"));
  const simple = simplify(model, { minSpan: 1.5, minSize: 3, keepHeight: 6 });
  const extent = modelExtent(model.positions, model.surfaces, SURFACE.paving);
  const item = (x: number, y: number, built: number): MergedItem => ({ model: simple, extent, x, y, z: 100, angle: 0.4, sx: 1, sz: 1, wall: 0, roof: 0, trim: 0, flat: 0, built, height: extent.maxY });
  const items = [item(10, 20, 5), item(40, 30, 900)];

  it("gives every vertex its building's built tick and height, and its own height over its building's ground", () => {
    for (const [form, arrays] of [
      ["simple", mergeModels(items, { glass: 0, paving: 0 })],
      ["box", mergeBoxes(items)],
      ["flat", mergeFlats(items)],
    ] as const) {
      const rise = mergedRise(items, arrays.positions, form);
      const n = arrays.positions.length / 3;
      expect(rise.length, form).toBe(n * 3);
      // The first item's vertices come first, then the second's.
      const half = n / 2;
      for (let v = 0; v < n; v++) {
        const it = items[v < half ? 0 : 1];
        expect(rise[v * 3], form).toBe(it?.built);
        expect(rise[v * 3 + 1], form).toBeCloseTo(extent.maxY, 4);
        expect(rise[v * 3 + 2], form).toBeCloseTo((arrays.positions[v * 3 + 1] ?? 0) - (it?.y ?? 0), 3);
      }
    }
  });
});

describe("the scaffolding", () => {
  it("is the four walls of a unit box standing on the ground, each saying which way it runs", () => {
    const g = scaffoldGeometry();
    const p = g.getAttribute("position");
    const axis = g.getAttribute("scaffoldAxis");
    expect(p.count).toBe(16);
    expect(g.getIndex()?.count).toBe(24);
    for (let v = 0; v < p.count; v++) {
      expect(Math.abs(p.getX(v))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(p.getZ(v))).toBeLessThanOrEqual(0.5);
      expect([0, 1]).toContain(p.getY(v));
      // A wall across x runs along z, and the other way round.
      expect(Math.abs(axis.getX(v) === 1 ? p.getX(v) : p.getZ(v))).toBe(0.5);
    }
  });
});

describe("the tick on screen", () => {
  it("runs on between deltas at the city's speed, by at most a tick", () => {
    const clock = createGameClock();
    clock.reset(100, 1, 0);
    expect(clock.at(0)).toBe(100);
    expect(clock.at(TICK_MS / 2)).toBe(100.5);
    expect(clock.at(TICK_MS * 5)).toBe(101);
    clock.observe(101, 4, 1000);
    expect(clock.at(1000 + TICK_MS / 8)).toBe(101.5);
  });

  it("stops when the city is paused and never runs back, except to a snapshot", () => {
    const clock = createGameClock();
    clock.reset(100, 1, 0);
    expect(clock.at(TICK_MS * 0.8)).toBeCloseTo(100.8, 10);
    // Paused at the tick it was on: the screen holds where it was rather than jump back.
    clock.observe(100, 0, TICK_MS * 0.8);
    expect(clock.at(TICK_MS * 0.8)).toBeCloseTo(100.8, 10);
    expect(clock.at(TICK_MS * 100)).toBeCloseTo(100.8, 10);
    clock.reset(20, 0, TICK_MS * 100);
    expect(clock.at(TICK_MS * 200)).toBe(20);
  });
});
