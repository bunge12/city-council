import { describe, expect, it } from "vitest";
import {
  ZONING_BALANCE,
  cellCorners,
  cellStatuses,
  createState,
  deserialize,
  gridEffects,
  hashState,
  planRoad,
  planRoadGrid,
  roadEffects,
  serialize,
  step,
  type Command,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { nextInt, seedRng } from "../src/rng";
import { CELL_OPEN, cellsSettled } from "../src/zoning/cell-index";
import { terrainOf } from "../src/terrain/cache";
import { isSegment, segmentIdLimit } from "../src/roads/network";

// The cells a road or a grid would open, for the road tools' previews: the
// same cells the sim has open on the new roads once they are built.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const DEPTH = ZONING_BALANCE.zoneDepthCells;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
  while (!cellsSettled(state)) step(state);
}
const roadPayload = (from: [number, number], to: [number, number], control?: [number, number]) => ({
  from: { x: from[0], z: from[1] },
  to: { x: to[0], z: to[1] },
  type: "street",
  ...(control ? { control: { x: control[0], z: control[1] } } : {}),
});

/** Each cell's corners as text, sorted, so two lists of cells compare whatever their order. */
function cellsAsText(corners: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < corners.length; i += 8) out.push(Array.from({ length: 8 }, (_, k) => corners[i + k]).join(","));
  return out.sort();
}

/** The open cells of the segments built since build order `firstNew`, or before it with `before`, as `cellsAsText` gives them. */
function openCellsSince(state: SimState, firstNew: number, before = false): string[] {
  const statuses = cellStatuses(state);
  const net = state.roads;
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) {
    if (!isSegment(net, id) || ((net.segOrder[id] ?? 0) < firstNew) !== before) continue;
    const start = state.cells.offset[id] ?? 0;
    const count = (state.cells.offset[id + 1] ?? 0) - start;
    for (let local = 0; local < count; local++) {
      if (statuses[start + local] !== CELL_OPEN) continue;
      const depth = local % DEPTH;
      const rest = (local - depth) / DEPTH;
      out.push(...(cellCorners(state, { segment: id, side: rest & 1, place: rest >> 1, depth }) ?? []));
    }
  }
  return cellsAsText(out);
}

/** How many builds `expectRoadPreview` has seen give an older road's cell its ground back. */
let regained = 0;

function expectRoadPreview(state: SimState, payload: ReturnType<typeof roadPayload>): string[] {
  const plan = planRoad(state.roads, terrainOf(state.seed), payload);
  if (!plan.ok) throw new Error(plan.reason);
  // Statuses first: the first question about cells lays them out.
  const statuses = cellStatuses(state);
  const hash = hashState(state);
  const preview = cellsAsText(roadEffects(state, plan.plan).cells);
  // The preview took its rehearsal back, from state and from the cell index.
  expect(hashState(state)).toBe(hash);
  expect(hashState(deserialize(serialize(state)).state)).toBe(hash);
  expect(cellStatuses(state)).toEqual(statuses);
  const firstNew = state.roads.segOrderNext;
  const oldOpen = new Set(openCellsSince(state, firstNew, true));
  ok(state, command("BuildRoad", payload));
  expect(preview).toEqual(openCellsSince(state, firstNew));
  if (openCellsSince(state, firstNew, true).some((c) => !oldOpen.has(c))) regained++;
  return preview;
}

describe("the cells a new road would open", () => {
  it("are both strips of a lone street, every depth", () => {
    const state = createState(SEED);
    const preview = expectRoadPreview(state, roadPayload([4200, 4600], [4392, 4600]));
    // 24 places, two sides, every depth.
    expect(preview.length).toBe(24 * 2 * DEPTH);
  });

  it("leave out the ground an older street's cells hold and the cells under the older street", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoad", roadPayload([4200, 4600], [4392, 4600])));
    // A street from the north that crosses it, through its strips.
    const preview = expectRoadPreview(state, roadPayload([4296, 4480], [4296, 4720]));
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.length).toBeLessThan(30 * 2 * DEPTH);
  });

  it("follow a curve, folding nothing on the inside of a tight bend", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoad", roadPayload([4200, 4700], [4400, 4700])));
    expectRoadPreview(state, roadPayload([4250, 4500], [4380, 4560], [4250, 4560]));
  });

  it("leave out the ground an older street's strip holds, for a street along its back", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoad", roadPayload([4200, 4600], [4392, 4600])));
    // Along the street's south strip, so the new street's north strip lies on ground the old one holds.
    const preview = expectRoadPreview(state, roadPayload([4200, 4624], [4392, 4624]));
    expect(preview.length).toBeLessThan(24 * 2 * DEPTH);
  });
});

describe("the cells a new grid would open", () => {
  it("are the open cells of its streets once built, across a street already there", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoad", roadPayload([4200, 4600], [4392, 4600])));
    const payload = { origin: { x: 4248, z: 4520 }, along: { x: 4344, z: 4520 }, across: { x: 4248, z: 4680 }, depth: 70, width: 86, type: "street" };
    const plan = planRoadGrid(state.roads, terrainOf(state.seed), payload);
    if (!plan.ok) throw new Error(plan.reason);
    const hash = hashState(state);
    const preview = cellsAsText(gridEffects(state, plan.plan).cells);
    expect(hashState(state)).toBe(hash);
    expect(preview.length).toBeGreaterThan(0);
    const firstNew = state.roads.segOrderNext;
    ok(state, command("BuildRoadGrid", payload));
    expect(preview).toEqual(openCellsSince(state, firstNew));
  });
});

describe("the cells a random road would open", () => {
  it("are the open cells the sim has on it once built, over random streets", () => {
    const rng = seedRng(7);
    const point = (): [number, number] => [4120 + 8 * nextInt(rng, 70), 4420 + 8 * nextInt(rng, 70)];
    const state = createState(SEED);
    let previews = 0;
    for (let i = 0; i < 40; i++) {
      const bend = nextInt(rng, 3) === 0;
      const payload = roadPayload(point(), point(), bend ? point() : undefined);
      const plan = planRoad(state.roads, terrainOf(state.seed), payload);
      if (!plan.ok) continue;
      expectRoadPreview(state, payload);
      previews++;
    }
    expect(previews).toBeGreaterThan(10);
    // Some of them give an older road's cell its ground back, the case the preview walks older cells again for.
    expect(regained).toBeGreaterThan(0);
  });
});
