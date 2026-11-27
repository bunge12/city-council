// The towns of M4's two economy scenario tests (M4.md, exit test; M4-19).
// No vitest here, so the balance check could build them too.
//
// Each is a fixed list of commands on seed 2026, on the plain south of its
// north outside connection, as the balance check's standard cities are
// (test/balance/cities.ts): a street in from the connection's stub, then
// streets on open ground. Cells are 8 m and a zoning strip 6 cells deep.
//
// - `compactTown`: a grid of 4 by 4 street blocks 96 m apart, houses on
//   most blocks, shops and offices on the rest. No factory, whose
//   pollution would lower the homes' land value and so their tax.
// - `culDeSacTown`: the same jobs on a row of five blocks by the street in,
//   and the homes along dead-end streets off an avenue instead, with
//   nothing zoned on the avenue, so each home has more road to keep.
// - `firstTown`: what a new city on its starting grant lays first: the
//   street in and one quarter of 4 by 4 blocks of houses with shops and
//   offices, at density 1, the only density a new city has.

import { createState, step, submit, type SimState } from "../src/index";

/** Seed 2026: its north connection's stub ends at (5592, 200), above a plain of flat, dry ground. */
export const TOWN_SEED = 2026;
const STUB = { x: 5592, z: 200 };
/** Where the street in meets the town. */
const GATE = { x: 5592, z: 960 };
/** Street centre lines 96 m apart leave blocks 86 m between road edges. */
const SPACING = 96;

let seq = 0;

/** Submits a command, steps until it has applied, and throws if the sim refused it. */
export function send(state: SimState, type: string, payload: unknown): void {
  const command = { seq: ++seq, playerId: "p1", type, payload };
  const result = submit(state, command);
  if (!result.ok) throw new Error(`${type} refused: ${result.reason}`);
  step(state);
  while (state.pending.length > 0) step(state);
  if (state.log.at(-1)?.seq !== command.seq) throw new Error(`${type} did not apply`);
}

function streetIn(state: SimState): void {
  send(state, "BuildRoad", { from: STUB, to: GATE, type: "street" });
}

/** A grid of `cols` by `rows` blocks with its north-west corner at (x, z). */
function grid(state: SimState, x: number, z: number, cols: number, rows: number): void {
  send(state, "BuildRoadGrid", {
    origin: { x, z },
    along: { x: x + cols * SPACING, z },
    across: { x, z: z + rows * SPACING },
    depth: SPACING - 10,
    width: SPACING - 10,
    type: "street",
  });
}

/** Zones the block whose north-west corner is (x, z), every cell inside its four streets' centre lines. */
function zoneBlock(state: SimState, x: number, z: number, zone: string, density = 1): void {
  const mid = z + SPACING / 2;
  send(state, "ZoneCells", { zone, density, rects: [{ from: { x: x + 3, z: mid }, to: { x: x + SPACING - 3, z: mid }, width: SPACING - 6 }] });
}

/**
 * The blocks of a 4 by 4 quarter by letter, rows north to south: r houses,
 * c shops, o offices, i factories. Mostly homes, with work for about half
 * the residents, as a small town has.
 */
const QUARTER = ["rcrr", "rorr", "rrcr", "orro"];

const LETTER: Readonly<Record<string, string>> = { r: "residential", c: "commercial", o: "office", i: "industrial" };

/** Lays a quarter of 4 by 4 blocks with its north-west corner at (x, z) and zones it from `map`, letters left out of `only` skipped. */
function quarter(state: SimState, x: number, z: number, map: readonly string[], only = "rcoi"): void {
  grid(state, x, z, map[0]?.length ?? 0, map.length);
  map.forEach((line, row) =>
    [...line].forEach((letter, col) => {
      const zone = LETTER[letter];
      if (zone && only.includes(letter)) zoneBlock(state, x + col * SPACING, z + row * SPACING, zone);
    }),
  );
}

/** A new city on seed 2026 with the starting grant and nothing else. */
export function newCity(): SimState {
  return createState(TOWN_SEED);
}

/** The compact town on `state`: the street in and one quarter, its north edge on the gate. */
export function compactTown(state: SimState): SimState {
  streetIn(state);
  quarter(state, GATE.x - 2 * SPACING, GATE.z, QUARTER);
  return state;
}

/** The first town a new city lays on its grant: the compact town. */
export const firstTown = compactTown;

/** The compact town's job blocks as one row of blocks. */
const JOBS_ROW = ["ccooo"];

/** How many cul-de-sacs the spread-out town has a side, how far apart they leave the spine and how long each is. */
const CUL_DE_SACS = 3;
const CUL_SPACING = 360;
const CUL_LENGTH = 275;

/**
 * The cul-de-sac town on `state`: the compact town's job blocks on a row of
 * their own by the gate, an avenue running south from it as the spine, and
 * dead ends off both sides of the spine with houses on both sides of each.
 * Nothing is zoned along the spine. About as many people as the compact
 * town, with the same jobs and no factory near either town's homes, so the
 * two differ in the road each home has to keep.
 */
export function culDeSacTown(state: SimState): SimState {
  streetIn(state);
  // The compact town's job blocks, two of shops and three of offices, in a row of five by the gate.
  quarter(state, GATE.x - 2 * SPACING, GATE.z, JOBS_ROW);
  const top = GATE.z + SPACING;
  const spineEnd = top + CUL_SPACING * (CUL_DE_SACS + 1);
  send(state, "BuildRoad", { from: { x: GATE.x, z: top }, to: { x: GATE.x, z: spineEnd }, type: "avenue" });
  for (let k = 1; k <= CUL_DE_SACS; k++) {
    const z = top + k * CUL_SPACING;
    for (const dir of [-1, 1]) {
      const end = { x: GATE.x + dir * CUL_LENGTH, z };
      send(state, "BuildRoad", { from: { x: GATE.x, z }, to: end, type: "street" });
      // Both sides of the dead end, from a strip's depth off the spine to its end, in two halves since a rectangle's side is at most 256 m.
      const start = GATE.x + dir * 56;
      const mid = (start + end.x) / 2;
      const rects = [
        { from: { x: start, z }, to: { x: mid, z }, width: 100 },
        { from: { x: mid, z }, to: end, width: 100 },
      ];
      send(state, "ZoneCells", { zone: "residential", density: 1, rects });
    }
  }
  return state;
}
