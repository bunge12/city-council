import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CELL_OPEN,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  ZONING_BALANCE,
  buildScaleCity,
  cellAt,
  cellsInChunk,
  cellsSettled,
  createState,
  findLot,
  hashState,
  lotMarkAt,
  lotMarksInChunk,
  step,
  submit,
  type CellRef,
  type Command,
  type SimState,
} from "../src/index";
import { addBuilding } from "../src/buildings/buildings";
import { growOne } from "../src/buildings/grower";
import { plainLotFits } from "../src/buildings/lots";
import { nextFloat, seedRng } from "../src/rng";
import { credited } from "./credited";

// M2-15: the zoning overlay's marks on free zoned ground where no building
// type fits, with the lot finder's reason.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${type} should apply`).toBe(c.seq);
}

/** A street running east from (4200, 4600) for 24 cells. Its left strip is north of it. */
function street(): SimState {
  const state = credited(createState(SEED));
  ok(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
  return state;
}

/** The centre of the cell at place `p` along x from 4200 and `k` deep in the north strip. */
const north = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

/** Zones `w` places of the north strip from place `p0`, `d` cells deep. */
function zoneNorth(state: SimState, zone: string, density: number, p0: number, w: number, d: number): void {
  const [x0, zMid0] = north(p0, 0);
  const [x1] = north(p0 + w - 1, 0);
  const z = zMid0 - (CELL * (d - 1)) / 2;
  ok(state, "ZoneCells", { zone, density, rects: [{ from: { x: x0 - 2, z }, to: { x: x1 + 2, z }, width: CELL * (d - 1) + 4 }] });
}

function refAt(state: SimState, [x, z]: [number, number]): CellRef {
  const cell = cellAt(state, x, z);
  if (!cell) throw new Error(`no cell at ${x}, ${z}`);
  return { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth };
}

/** Every marked cell of the street's chunk, as "place,depth" in the north strip. */
function marked(state: SimState): string[] {
  const chunk = Math.floor(4570 / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(4300 / CHUNK_SIZE);
  const cells = cellsInChunk(state, chunk);
  const flags = lotMarksInChunk(state, chunk);
  const out: string[] = [];
  cells.forEach((cell, k) => {
    if (flags[k]) out.push(`${cell.place},${cell.depth}`);
  });
  return out.sort();
}

const all = (p0: number, w: number, d: number): string[] => {
  const out: string[] = [];
  for (let p = p0; p < p0 + w; p++) for (let k = 0; k < d; k++) out.push(`${p},${k}`);
  return out.sort();
};

describe("lot marks", () => {
  it("marks an R3 lot of 3 x 6, every cell, with the reason from the road", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 3, 6);
    const hash = hashState(state);
    expect(marked(state)).toEqual(all(4, 3, 6));
    const reason = "R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 wide";
    expect(lotMarkAt(state, refAt(state, north(4, 0)))).toBe(reason);
    expect(lotMarkAt(state, refAt(state, north(6, 5)))).toBe(reason);
    // Read only.
    expect(hashState(state)).toBe(hash);
  });

  it("does not mark R3 ground where a low tower fits", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 4, 4);
    expect(findLot(state, refAt(state, north(4, 0))).ok).toBe(true);
    expect(marked(state)).toEqual([]);
  });

  it("marks R3 ground too shallow for any tower", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 8, 3);
    expect(marked(state)).toEqual(all(4, 8, 3));
    expect(lotMarkAt(state, refAt(state, north(6, 2)))).toBe("R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 deep");
  });

  it("leaves the back rows no type reaches unmarked, and the ground behind a building", () => {
    const state = street();
    zoneNorth(state, "commercial", 1, 0, 24, 6);
    // No C1 type reaches the 5th and 6th rows, but the front of each column takes a lot.
    expect(findLot(state, refAt(state, north(8, 5)))).toMatchObject({ ok: false, problem: "too-deep" });
    expect(marked(state)).toEqual([]);

    const houses = street();
    zoneNorth(houses, "residential", 1, 0, 2, 6);
    const lot = findLot(houses, refAt(houses, north(0, 0)));
    if (!lot.ok) throw new Error(lot.reason);
    const type = BUILDING_TYPES[lot.lot.type];
    addBuilding(houses, { ...lot.lot, residents: type?.residents[0] ?? 0, variant: 0 });
    expect(findLot(houses, refAt(houses, north(0, 5)))).toMatchObject({ ok: false });
    expect(marked(houses)).toEqual([]);
    expect(lotMarkAt(houses, refAt(houses, north(0, 5)))).toBeNull();
  });

  it("marks only the free run of the front cell's zone and density", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 3, 3);
    // R1 behind the R3, three deep: off the road for a lot of its own.
    const [x0] = north(4, 3);
    const [x1] = north(6, 3);
    const [, z3] = north(4, 3);
    const [, z5] = north(4, 5);
    ok(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: x0 - 2, z: (z3 + z5) / 2 }, to: { x: x1 + 2, z: (z3 + z5) / 2 }, width: CELL * 2 + 4 }] });
    expect(marked(state)).toEqual(all(4, 3, 3));
  });

  // Issue #164: the overlay settles most columns with `plainLotFits` and asks
  // the finder only of the rest. Zoning that changes every few cells along a
  // strip and now and then within a column, on a city of curves, junctions
  // and bridges, part built, must mark exactly as `lotMarkAt` does.
  it("marks as lotMarkAt does on zoning that changes every few cells", () => {
    const state = buildScaleCity(8_000).state;
    while (!cellsSettled(state)) step(state);
    const rng = seedRng(164);
    const { zone, density } = state.cells;
    const depth = ZONING_BALANCE.zoneDepthCells;
    const zones = ZONING_BALANCE.zones.length;
    let z = 1;
    let d = 1;
    for (let i = 0; i < zone.length; i++) {
      if (nextFloat(rng) < 0.08) {
        z = nextFloat(rng) < 0.15 ? 0 : 1 + Math.floor(nextFloat(rng) * zones);
        d = z ? 1 + Math.floor(nextFloat(rng) * 3) : 0;
      }
      const inColumn = i % depth > 0 && nextFloat(rng) < 0.06;
      zone[i] = inColumn ? 1 + Math.floor(nextFloat(rng) * zones) : z;
      density[i] = inColumn ? 1 + Math.floor(nextFloat(rng) * 3) : d;
    }
    for (let i = 0; i < 6_000; i++) growOne(state);
    let fits = 0;
    let marked = 0;
    const known = new Map<number, number>();
    for (let chunk = 0; chunk < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; chunk++) {
      const cells = cellsInChunk(state, chunk);
      const flags = lotMarksInChunk(state, chunk);
      cells.forEach((cell, k) => {
        // The quick check says yes only where the finder finds a lot.
        if (cell.depth === 0 && plainLotFits(state, cell, known)) {
          fits++;
          if (!findLot(state, cell).ok) throw new Error(`plainLotFits says a type fits at ${JSON.stringify(cell)}, the finder says none does`);
        }
        const want = cell.status === CELL_OPEN && (zone[cell.index] ?? 0) > 0 && lotMarkAt(state, cell) !== null ? 1 : 0;
        if (flags[k] !== want) throw new Error(`chunk ${chunk}, cell ${JSON.stringify(cell)}: marked ${flags[k]}, lotMarkAt says ${want}`);
        marked += want;
      });
    }
    expect(fits).toBeGreaterThan(1000);
    expect(marked).toBeGreaterThan(1000);
  }, 120_000);
});
