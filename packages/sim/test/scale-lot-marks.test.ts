// Lot marks on the scale city (issue #164). Split from scale.test.ts
// (issue #230).

import { describe, expect, it } from "vitest";
import { CELL_OPEN, CHUNKS_PER_SIDE, buildingCount, cellsInChunk, growScaleCity, lotMarkAt, lotMarksInChunk } from "../src/index";
import { loadScaleCity } from "./scale-fixture";

describe("lot marks on the scale city (issue #164)", () => {
  // The overlay settles most columns with a quick walk of the strip and asks
  // the lot finder only of the rest. Every cell must come out as `lotMarkAt`,
  // which asks the finder, says: on the city zoned and bare, and part grown.
  it("marks every chunk's cells as lotMarkAt does, before and while it grows", () => {
    const copy = loadScaleCity();
    growScaleCity(copy, 0);
    const state = copy.state;
    const check = (): number => {
      let marked = 0;
      for (let chunk = 0; chunk < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; chunk++) {
        const flags = lotMarksInChunk(state, chunk);
        cellsInChunk(state, chunk).forEach((cell, k) => {
          const want = cell.status === CELL_OPEN && (state.cells.zone[cell.index] ?? 0) > 0 && lotMarkAt(state, cell) !== null ? 1 : 0;
          if (flags[k] !== want) throw new Error(`chunk ${chunk}, cell ${JSON.stringify(cell)}: marked ${flags[k]}, lotMarkAt says ${want}`);
          marked += want;
        });
      }
      return marked;
    };
    expect(check(), "marked cells on the bare zoning").toBeGreaterThan(1000);
    growScaleCity(copy, 20_000);
    expect(buildingCount(state.buildings)).toBeGreaterThanOrEqual(20_000);
    expect(check(), "marked cells part grown").toBeGreaterThan(1000);
  }, 240_000);
});

