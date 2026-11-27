// The budget overlay's test town (M4-18), for the unit tests and the
// Playwright spec alike, so no vitest here.
//
// From the stub end of seed 2026's second outside connection, on flat
// ground, a street runs 60 places. On one side of it stand two blocks 12
// places square that share a side: a compact one zoned R2 all through, and
// one of C1 shops beside it. On the other side a large block, 36 places
// square, has a cul-de-sac 30 places long into it from its far side, and
// only the last few places on one side of the cul-de-sac are zoned, R1, so
// a house or two carry a long road. A spur on open ground past the large
// block holds a few houses outside any block.
//
// Since M4-19 a street costs about $95 a metre a year to keep and a house
// pays a few thousand, so the cul-de-sac's few houses do not pay for its
// road. The overlay leaves out the other city spending, which is the same
// for each resident wherever they live (PRD, "Other city spending").

import { CONNECTION_BALANCE, NONE, TIME_BALANCE, ZONING_BALANCE, connectionEnd, createState, step, submit, type SimState } from "../src/index";
import { FULL_DEMAND, holdDemand } from "./demand-helper";
import { funded } from "./funds";
import { credited } from "./credited";

const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;

/** A frame on the ground: `u` places along the way the stub points from (x, z), `v` places to one side of it. */
export interface Frame {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The point at place (u, v) of frame `f`, in world metres. */
export const at = (f: Frame, u: number, v: number): { x: number; z: number } => ({ x: f.x + CELL * (u * f.dx - v * f.dz), z: f.z + CELL * (u * f.dz + v * f.dx) });

/** Places in the frame to point at: inside the compact R2 block, the shops' block, the large block well away from its roads, and the spur's open ground. */
export const SPOTS = {
  compact: [14, 6],
  shops: [26, 6],
  large: [33, -20],
  spur: [70, 2],
} as const satisfies Record<string, readonly [number, number]>;

let seq = 0;

function ok(state: SimState, type: string, payload: unknown): void {
  const command = { seq: ++seq, playerId: "p1", type, payload };
  const result = submit(state, command);
  if (!result.ok) throw new Error(`${type} refused: ${result.reason}`);
  step(state);
  while (state.pending.length > 0) step(state);
  if (state.log.at(-1)?.seq !== command.seq) throw new Error(`${type} did not apply`);
}

function frameOf(state: SimState): Frame {
  const r = state.roads;
  const edge = state.connections[1] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
}

/** Builds the budget town and grows it for `days` game days with every bar held at 100. */
export function budgetTown(days = 40): { state: SimState; f: Frame } {
  const state = credited(funded(createState(2026)));
  const f = frameOf(state);
  const road = (from: [number, number], to: [number, number]) => ok(state, "BuildRoad", { from: at(f, ...from), to: at(f, ...to), type: "street" });
  const zone = (zoneId: string, density: number, from: [number, number], to: [number, number], width: number) =>
    ok(state, "ZoneCells", { zone: zoneId, density, rects: [{ from: at(f, ...from), to: at(f, ...to), width: CELL * width }] });
  road([0, 0], [60, 0]);
  // The compact block, and the shops' block beside it.
  road([8, 0], [8, 12]);
  road([8, 12], [32, 12]);
  road([20, 12], [20, 0]);
  road([32, 12], [32, 0]);
  zone("residential", 2, [9, 6], [19, 6], 10);
  zone("commercial", 1, [21, 6], [31, 6], 10);
  // The large block and its cul-de-sac.
  road([24, 0], [24, -36]);
  road([24, -36], [60, -36]);
  road([60, -36], [60, 0]);
  road([42, -36], [42, -6]);
  zone("residential", 1, [43, -10], [43, -7], 3);
  // A spur on open ground, with houses.
  road([60, 0], [76, 0]);
  zone("residential", 1, [61, 2], [75, 2], 3);
  holdDemand(FULL_DEMAND, () => {
    for (let i = 0; i < days * DAY; i++) step(state);
  });
  return { state, f };
}
