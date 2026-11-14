import { describe, expect, it } from "vitest";
import { ZONING_BALANCE, checkZoningBalance } from "../src/index";
import zoning from "../balance/zoning.json" with { type: "json" };

// M2-01: the zoning numbers live in sim balance data.

const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(zoning)) as Record<string, unknown>;

describe("zoning balance", () => {
  it("holds the cell size, the depth, five zones and three densities", () => {
    expect(checkZoningBalance(zoning)).toEqual([]);
    expect(ZONING_BALANCE.cellSize).toBe(8);
    expect(ZONING_BALANCE.zoneDepthCells).toBe(6);
    expect(ZONING_BALANCE.zones.map((z) => z.letter)).toEqual(["R", "C", "O", "I", "M"]);
    expect(ZONING_BALANCE.densities.map((d) => d.level)).toEqual([1, 2, 3]);
  });

  it("fails when any field is missing", () => {
    for (const field of ["cellSize", "zoneDepthCells", "zones", "densities"]) {
      const data = Object.fromEntries(Object.entries(copy()).filter(([key]) => key !== field));
      expect(checkZoningBalance(data).join("; "), field).toMatch(field);
    }
    for (const field of ["id", "name", "letter"]) {
      const data = copy();
      const zones = data["zones"] as Record<string, unknown>[];
      zones[2] = Object.fromEntries(Object.entries(zones[2] ?? {}).filter(([key]) => key !== field));
      expect(checkZoningBalance(data), field).toEqual([expect.stringMatching(`zones\\[2\\]\\.${field}`)]);
    }
    for (const field of ["level", "name"]) {
      const data = copy();
      const densities = data["densities"] as Record<string, unknown>[];
      densities[1] = Object.fromEntries(Object.entries(densities[1] ?? {}).filter(([key]) => key !== field));
      expect(checkZoningBalance(data), field).toEqual([expect.stringMatching(`densities\\[1\\]\\.${field}`)]);
    }
  });

  it("fails on numbers that cannot be a cell grid", () => {
    expect(checkZoningBalance({ ...copy(), cellSize: 0 })).toEqual([expect.stringMatching(/cellSize/)]);
    expect(checkZoningBalance({ ...copy(), zoneDepthCells: 2.5 })).toEqual([expect.stringMatching(/zoneDepthCells/)]);
    const twice = copy();
    (twice["zones"] as Record<string, unknown>[])[1] = { id: "residential", name: "Again", letter: "R" };
    expect(checkZoningBalance(twice)).toHaveLength(2);
    const skipped = copy();
    (skipped["densities"] as Record<string, unknown>[]).splice(1, 1);
    expect(checkZoningBalance(skipped)).toEqual([expect.stringMatching(/densities\[1\]\.level must be 2/)]);
  });
});
