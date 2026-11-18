// Timings on the M2 scale town (issue M2-17): the M1 scale city with every
// cell zoned and grown out by `growScaleCity`, about 57,000 buildings. Run
// with `pnpm bench`, kept out of `pnpm test`. Vitest does the timing;
// nothing here reads the clock (CLAUDE.md rule 3).
//
// scale.bench.ts times the roads and the cells on the bare city, and
// grower.bench.ts the grower on synthetic zoning. This one takes the
// measurements M2's close-out asks for on a city full of buildings:
// - the cell and lot queries the client and the tools make (cellAt,
//   cellsInBox, a chunk's cells and lot marks, findLot, lotOptions,
//   buildingInfo, a chunk's buildings);
// - a step with nothing queued, the grower and the cells' upkeep in it,
//   over the ticks of a game day, and the grower on its own;
// - the step that applies one ZoneCells at the cap over built ground, one
//   BuildRoad through a row of houses, one BulldozeRoad of a built street
//   and one BulldozeBuilding at its cap. Each run takes a fresh place, so
//   nothing has to be taken back; the hooks settle the city between runs.
//   The snapshot and each part of an autosave are timed before these, on
//   the town as it was grown.

import { expect, test } from "vitest";
import {
  BUILDINGS_BALANCE,
  CELL_LEFT,
  CELL_OPEN,
  CELL_RIGHT,
  NO_BUILDING,
  buildingOnSlot,
  cellSlot,
  cellStatuses,
  placesAlong,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildScaleCity,
  buildingCount,
  buildingInfo,
  buildingsInChunk,
  cellAt,
  cellShapesInChunk,
  cellsInBox,
  cellsInChunk,
  cellsSettled,
  findLot,
  growScaleCity,
  lotMarkAt,
  lotMarksInChunk,
  lotOptions,
  planZoneCells,
  prepareDerived,
  previewBuildRoad,
  readBuilding,
  serialize,
  serializeDetached,
  serializeDetachedSteps,
  step,
  type CellInfo,
  type Command,
  type ZoneCellsPayload,
} from "../src/index";
import { grow } from "../src/buildings/grower";
import { buildingsOnSegments } from "../src/buildings/where";
import { nextFloat, seedRng } from "../src/rng";
import { isSegment, segmentIdLimit, SEG_FIXED } from "../src/roads/network";
import { submit } from "./seen-ends";

/** What one tick may spend, in milliseconds. */
const TICK_BUDGET_MS = 20;
const LINE = 96;
const SPAN = 6 * LINE;

const city = buildScaleCity();
const town = growScaleCity(city);
const { state, grids } = city;
prepareDerived(state);
// Let the grower plan its first day and the cells settle, as a loaded city would before a player acts.
while (!cellsSettled(state)) step(state);

let seq = 1_000_000;
const command = (type: string, payload: unknown): Command => ({ seq: ++seq, playerId: "bench", type, payload });

/** Steps until the cells have settled and the buildings caught up, outside the timing. */
function settle(): void {
  step(state);
  while (!cellsSettled(state)) step(state);
  step(state);
}

// Fixed query points, so every run asks the same questions.
const POINTS = 4096;
const xs = new Float64Array(POINTS);
const zs = new Float64Array(POINTS);
const rng = seedRng(17);
// Inside the grids, where the cells and buildings are.
for (let i = 0; i < POINTS; i++) {
  const g = grids[Math.floor(nextFloat(rng) * grids.length)] ?? { x: 0, z: 0 };
  xs[i] = g.x + nextFloat(rng) * SPAN;
  zs[i] = g.z + nextFloat(rng) * SPAN;
}
let next = 0;
const point = (): number => (next = (next + 1) % POINTS);

/**
 * Zoned open cells by the road with no building on them, where the lot
 * queries have to fit a lot: on a built cell they stop at once. The town is
 * full, so these are the cells no lot fits, and every slot is looked at.
 */
const fronts: CellInfo[] = [];
{
  const status = cellStatuses(state);
  const segs = new Set<number>();
  for (let i = 0; i < POINTS; i++) segs.add(cellAt(state, xs[i] ?? 0, zs[i] ?? 0)?.segment ?? -1);
  for (const segment of segs) {
    if (segment < 0) continue;
    for (const side of [CELL_LEFT, CELL_RIGHT]) {
      for (let place = 0; place < placesAlong(state.roads, segment); place++) {
        const ref = { segment, side, place, depth: 0 };
        const slot = cellSlot(state.roads, state.cells, ref);
        if (slot < 0 || (state.cells.zone[slot] ?? 0) === 0 || status[slot] !== CELL_OPEN || buildingOnSlot(state, slot) !== NO_BUILDING) continue;
        fronts.push({ ...ref, index: slot, status: CELL_OPEN });
      }
    }
  }
}
let nextFront = 0;
const front = (): CellInfo => {
  nextFront = (nextFront + 1) % fronts.length;
  const cell = fronts[nextFront];
  if (!cell) throw new Error("no free zoned cells");
  return cell;
};

/** The chunks with the most buildings, for the per-chunk queries. */
const chunks = Array.from({ length: CHUNKS_PER_SIDE * CHUNKS_PER_SIDE }, (_, c) => c)
  .map((c) => ({ c, n: buildingsInChunk(state, c).length }))
  .sort((a, b) => b.n - a.n || a.c - b.c)
  .slice(0, 16)
  .map((e) => e.c);
let nextChunk = 0;
const chunk = (): number => chunks[(nextChunk = (nextChunk + 1) % chunks.length)] ?? 0;
/** Those chunks' cells as the overlay reads them for a mesh, which it hands on to `lotMarksInChunk` (issue #164). */
const chunkShapes = new Map(chunks.map((c) => [c, cellShapesInChunk(state, c)]));

const liveBuildings: number[] = [];
for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id]) liveBuildings.push(id);
let nextBuilding = 0;
const building = (): number => liveBuildings[(nextBuilding = (nextBuilding + 7919) % liveBuildings.length)] ?? 0;

/**
 * A ZoneCells at the cap over the grid square with the most open cells
 * under it: 64 rectangles of 256 m, laid side by side. Each run paints it
 * the other zone of the two, so every open cell under it changes, on
 * ground the grower has built on.
 */
function zoningAtCap(): ZoneCellsPayload {
  const side = ZONING_BALANCE.maxRectSide;
  const count = ZONING_BALANCE.maxRectsPerCommand;
  const perRow = Math.ceil(Math.sqrt(count));
  let best: { payload: ZoneCellsPayload; cells: number } | null = null;
  for (const g of grids) {
    const rects: ZoneCellsPayload["rects"] = [];
    for (let k = 0; k < count; k++) {
      const x = g.x + (k % perRow) * side;
      const z = g.z + Math.floor(k / perRow) * side + side / 2;
      rects.push({ from: { x, z }, to: { x: x + side, z }, width: side });
    }
    const payload: ZoneCellsPayload = { zone: "commercial", density: 2, rects };
    const result = planZoneCells(state, payload);
    if (result.ok && (!best || result.plan.cells.length > best.cells)) best = { payload, cells: result.plan.cells.length };
  }
  if (!best) throw new Error("no ground to zone");
  return best.payload;
}

/** Streets across a grid's seven streets, a quarter of the way into a row of blocks, where the houses stand. */
const crossings: { from: { x: number; z: number }; to: { x: number; z: number }; type: string }[] = [];
for (const g of grids) {
  for (let row = 0; row < 6; row++) {
    const z = g.z + row * LINE + 24;
    crossings.push({ from: { x: g.x - 24, z }, to: { x: g.x + SPAN + 24, z }, type: "street" });
  }
}
let nextCrossing = 0;
/** The next street that plans and has buildings in its way. */
function crossingThroughHouses(): { payload: unknown; clears: number } {
  for (let k = 0; k < crossings.length; k++) {
    // Seven rows apart, so two runs never take the same row or its neighbour.
    nextCrossing = (nextCrossing + 7) % crossings.length;
    const payload = crossings[nextCrossing];
    const preview = previewBuildRoad(state, payload);
    if (preview.ok && preview.clears.ids.length > 0) return { payload, clears: preview.clears.ids.length };
  }
  throw new Error("no street through houses plans");
}

/** Built streets a player may bulldoze, the most buildings first. */
const builtStreets: { seg: number; n: number }[] = [];
for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) {
  if (!isSegment(state.roads, seg) || ((state.roads.segFlags[seg] ?? 0) & SEG_FIXED) !== 0) continue;
  const n = buildingsOnSegments(state, [seg]).length;
  if (n > 0) builtStreets.push({ seg, n });
}
builtStreets.sort((a, b) => b.n - a.n || a.seg - b.seg);
let nextStreet = 0;
function builtStreet(): { seg: number; n: number } {
  while (nextStreet < builtStreets.length) {
    const s = builtStreets[nextStreet++];
    // Counted again: the commands timed before this one split streets and cleared houses.
    const n = s && isSegment(state.roads, s.seg) ? buildingsOnSegments(state, [s.seg]).length : 0;
    if (s && n > 0) return { seg: s.seg, n };
  }
  throw new Error("out of built streets");
}

/** `bulldozeMaxBuildings` buildings in a row of ids, as the player saw them. */
let nextClear = 0;
function buildingsToClear(): unknown {
  const seen: { id: number; segment: number; side: number; place: number; builtAt: number }[] = [];
  while (seen.length < BUILDINGS_BALANCE.bulldozeMaxBuildings && nextClear < liveBuildings.length) {
    const id = liveBuildings[nextClear++] ?? 0;
    if (!state.buildings.flags[id]) continue;
    const row = readBuilding(state.buildings, id);
    seen.push({ id, segment: row.firstSeg, side: row.firstSide, place: row.firstPlace, builtAt: row.builtAt });
  }
  return { buildings: seen };
}

test("the M2 scale town", async ({ bench, annotate }) => {
  const buildingsAtStart = buildingCount(state.buildings);
  expect(buildingsAtStart).toBe(town.buildings);
  expect(buildingsAtStart).toBeGreaterThan(50_000);
  expect(fronts.length, "free zoned cells by the road").toBeGreaterThan(100);

  const meanMs: Record<string, number> = {};
  const p99Ms: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (
    name: string,
    fn: () => void,
    hooks: { beforeEach?: () => void; afterEach?: () => void } = {},
    runs?: { iterations: number; time: number; warmupIterations: number; warmupTime: number },
  ) => {
    const file = `bench-results/town-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    // `async: false` so tinybench does not call the case once outside its hooks to find out.
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run(runs);
    meanMs[name] = r.latency.mean;
    p99Ms[name] = r.latency.p99 ?? 0;
    maxMs[name] = r.latency.max;
  };
  const fixedRuns = (iterations: number) => ({ iterations, time: 0, warmupIterations: 1, warmupTime: 0 });

  // The cell and lot queries. Each reads the city as it stands.
  const queries: Record<string, () => void> = {
    "cellAt, the cell under a point": () => {
      const i = point();
      cellAt(state, xs[i] ?? 0, zs[i] ?? 0);
    },
    "cellsInBox, a 64 m box": () => {
      const i = point();
      cellsInBox(state, xs[i] ?? 0, zs[i] ?? 0, (xs[i] ?? 0) + 64, (zs[i] ?? 0) + 64);
    },
    "cellsInChunk, a built chunk's cells": () => void cellsInChunk(state, chunk()),
    "cellShapesInChunk, a built chunk's cell corners for the overlay": () => void cellShapesInChunk(state, chunk()),
    "lotMarksInChunk, a built chunk's lot marks for the overlay, from the cells read for its mesh": () => {
      const c = chunk();
      lotMarksInChunk(state, c, chunkShapes.get(c));
    },
    "lotMarkAt, why one cell has no building": () => void lotMarkAt(state, front()),
    "findLot, the lot the grower would take at a cell": () => void findLot(state, front()),
    "lotOptions, every lot that fits at a cell": () => void lotOptions(state, front()),
    "buildingInfo, one building": () => void buildingInfo(state, building()),
    "buildingsInChunk, a built chunk's buildings": () => void buildingsInChunk(state, chunk()),
  };
  for (const [name, fn] of Object.entries(queries)) await run(name, fn);

  // A step with nothing queued, over the ticks of a day in turn, so the
  // day's first tick, which counts the free cells and plans the day, is among them.
  const day = TIME_BALANCE.ticksPerDay;
  await run("one step of the town with nothing queued, over two game days", () => void step(state), {}, fixedRuns(2 * day));
  await run("the grower on its own, over two game days", () => {
    grow(state);
    state.tick += 1;
  }, {}, fixedRuns(2 * day));

  // An autosave, written a part at a time between two ticks (issue #83).
  let save: ReturnType<typeof serializeDetachedSteps> | null = null;
  const saveParts = (() => {
    const steps = serializeDetachedSteps(state);
    let n = 1;
    while (!steps.next().done) n++;
    return n;
  })();
  const partNames: string[] = [];
  for (let part = 0; part < saveParts; part++) {
    const name = `part ${part + 1} of ${saveParts} of an autosave, written between two ticks`;
    partNames.push(name);
    await run(
      name,
      () => void save?.next(),
      {
        beforeEach: () => {
          save = serializeDetachedSteps(state);
          for (let i = 0; i < part; i++) save.next();
        },
        afterEach: () => {
          while (save && !save.next().done);
          save = null;
        },
      },
      fixedRuns(20),
    );
  }
  await run("serialize the whole town in one go, for comparison with the parts of an autosave", () => void serializeDetached(state), {}, fixedRuns(10));
  const snapshotBytes = serializeDetached(state).byteLength;
  const cityFileBytes = serialize(state).byteLength;


  // The step that applies each command. The hook queues it; the step
  // applies it, lays out the cells it can in the tick and removes the
  // buildings whose ground went. The next hook settles the rest untimed.
  const zoning = zoningAtCap();
  const zoneCells = planZoneCells(state, { ...zoning, zone: "residential" });
  let zoneRun = 0;
  await run(
    "the step that applies one ZoneCells at the cap over built ground, every open cell under it changing",
    () => void step(state),
    {
      beforeEach: () => {
        const zone = zoneRun++ % 2 === 0 ? "commercial" : "residential";
        expect(submit(state, command("ZoneCells", { ...zoning, zone })).ok).toBe(true);
      },
      afterEach: settle,
    },
    fixedRuns(20),
  );
  const cleared: Record<string, number[]> = { road: [], bulldoze: [], clear: [] };
  await run(
    "the step that applies one BuildRoad across a grid through rows of houses",
    () => void step(state),
    {
      beforeEach: () => {
        const { payload, clears } = crossingThroughHouses();
        cleared["road"]?.push(clears);
        expect(submit(state, command("BuildRoad", payload)).ok).toBe(true);
      },
      afterEach: settle,
    },
    fixedRuns(20),
  );
  await run(
    "the step that applies one BulldozeRoad of a built street",
    () => void step(state),
    {
      beforeEach: () => {
        const { seg, n } = builtStreet();
        cleared["bulldoze"]?.push(n);
        expect(submit(state, command("BulldozeRoad", { segments: [seg] })).ok).toBe(true);
      },
      afterEach: settle,
    },
    fixedRuns(20),
  );
  await run(
    `the step that applies one BulldozeBuilding of ${BUILDINGS_BALANCE.bulldozeMaxBuildings} buildings`,
    () => void step(state),
    {
      beforeEach: () => {
        const payload = buildingsToClear() as { buildings: unknown[] };
        cleared["clear"]?.push(payload.buildings.length);
        const result = submit(state, command("BulldozeBuilding", payload));
        if (!result.ok) throw new Error(result.reason);
      },
      afterEach: settle,
    },
    fixedRuns(5),
  );
  // The grower building again on the ground those commands cleared.
  await run("one step of the town with nothing queued, growing back over two game days", () => void step(state), {}, fixedRuns(2 * day));

  const round = (v: number): number => Math.round(v * 1000) / 1000;
  const mean = (list: readonly number[]) => Math.round(list.reduce((a, b) => a + b, 0) / Math.max(1, list.length));
  const report = {
    town: {
      ...town,
      buildingsAtEnd: buildingCount(state.buildings),
      cells: state.cells.zone.length,
      freeFrontCellsQueried: fronts.length,
      zoneCellsChanged: zoneCells.ok ? zoneCells.plan.cells.length : 0,
      meanBuildingsCleared: { buildRoad: mean(cleared["road"] ?? []), bulldozeRoad: mean(cleared["bulldoze"] ?? []), bulldozeBuilding: mean(cleared["clear"] ?? []) },
      snapshotBytes,
      cityFileBytes,
    },
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
    p99Ms: Object.fromEntries(Object.entries(p99Ms).map(([k, v]) => [k, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([k, v]) => [k, round(v)])),
    budgetMs: TICK_BUDGET_MS,
    chunkSize: CHUNK_SIZE,
  };
  await annotate(JSON.stringify(report, null, 2), "M2 scale town");

  // Every step, and every part of an autosave, inside the tick budget, on the mean.
  for (const name of Object.keys(meanMs)) {
    if (name.includes("for comparison")) continue;
    expect(meanMs[name], name).toBeLessThan(TICK_BUDGET_MS);
  }
  // A query the client makes per chunk or per pointer move: inside a 60 fps frame, with room for a slower runner.
  for (const name of Object.keys(queries)) expect(meanMs[name], name).toBeLessThan(16);
}, 600_000);
