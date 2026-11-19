// The scale city filled with buildings (issue M2-13). Split from
// scale.test.ts (issue #230).

import { describe, expect, it } from "vitest";
import { SCALE_BUILDINGS, buildingCount, growScaleCity, hashState } from "../src/index";
import { loadScaleCity } from "./scale-fixture";

describe("the scale city filled with buildings (issue M2-13)", () => {
  it("zones the map through commands and grows tens of thousands of buildings, the same every time", () => {
    const fill = () => {
      const copy = loadScaleCity();
      return { town: growScaleCity(copy), state: copy.state };
    };
    const { town, state } = fill();
    // The zoning is in the log, as commands.
    expect(state.log.filter((e) => e.type === "ZoneCells").length).toBe(town.zoneCommands);
    expect(town.zonedCells).toBeGreaterThan(600_000);
    // Short of SCALE_BUILDINGS: the network's frontage runs out first (scale.ts).
    expect(town.buildings).toBeGreaterThan(50_000);
    expect(town.buildings).toBeLessThan(SCALE_BUILDINGS);
    expect(buildingCount(state.buildings)).toBe(town.buildings);
    // Every zone and density grew something.
    const types = new Set<number>();
    state.buildings.flags.forEach((f, id) => {
      if (f !== 0) types.add(state.buildings.type[id] ?? -1);
    });
    expect(types.size).toBeGreaterThan(30);
    expect(hashState(fill().state)).toBe(hashState(state));
  }, 120_000);
});

