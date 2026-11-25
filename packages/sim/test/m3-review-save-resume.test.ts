// M3 review (#365): save and resume against an uninterrupted run.
//
// One straight run of a growing town with pops: a warm-up of 25 game days,
// then a window of 1,000 steps with road edits, an upgrade, a paused run of
// commands, half the factories bulldozed, R3 rezoning, undos and speed
// changes. At each save point in the window it keeps three saves: a plain
// `serialize`, the client's autosave path (`captureState` into kept buffers,
// `serializeDetachedSteps`, loaded with `prepareDerived` and the host's
// change recorders), and an autosave taken after that step's commands were
// submitted but before the step, with the queue not empty. Each is loaded
// and run to the end, and must hash as the straight run does. Travel
// rebuilds are slowed to 15 to 22 ticks so several save points fall inside
// one, with the last whole table held (#313), and owners redevelop at once.
// Two cities stepped in turn in one process must not touch each other.
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  ROUTING_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  captureState,
  connectionEnd,
  createCaptureBuffers,
  createState,
  deserialize,
  hashState,
  prepareDerived,
  recordBuildingChanges,
  recordCellChanges,
  recordPopChanges,
  recordRoadChanges,
  recountTotals,
  replay,
  seeBuilding,
  serialize,
  serializeDetachedSteps,
  step,
  type BuildingSeen,
  type SimState,
  type SnapshotBuffer,
} from "../src/index";
import { SEG_FIXED, isSegment, segmentIdLimit } from "../src/roads/network";
import { submit } from "./seen-ends";
import { withValue } from "./with-value";

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
/** The step the window starts on. */
const W = 25 * DAY;
const END = W + 1000;
/** Save points, in steps from W: day starts and mid-day, inside rebuilds, while paused with commands queued. */
const POINTS = [0, 1, 37, 50, 51, 52, 53, 60, 200, 201, 300, 303, 305, 306, 307, 308, 309, 310, 311, 312, 313, 321, 400, 401, 450, 500, 520, 521, 525, 531, 537, 538, 700, 800, 801, 999];

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The stub end of the first outside connection, and the way it points. */
function stubEnd(state: SimState): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
}

/** A street at right angles to `s`, from 60 cells along it, into another travel zone. */
const second = (s: Street): Street => ({ x: s.x + s.dx * CELL * 60, z: s.z + s.dz * CELL * 60, dx: -s.dz, dz: s.dx });

/** A ZoneCells payload `depth` cells deep from place `p0` for `width` places along `s`, on one side. */
function zoneRect(s: Street, zone: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): unknown {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  return { zone, density, rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }] };
}

function factories(state: SimState): BuildingSeen[] {
  const b = state.buildings;
  const industrial = ZONING_BALANCE.zones.findIndex((z) => z.id === "industrial") + 1;
  const out: BuildingSeen[] = [];
  for (let id = 0; id < b.flags.length; id++) {
    if (!b.flags[id] || b.zone[id] !== industrial) continue;
    const seen = seeBuilding(b, id);
    if (seen) out.push(seen);
  }
  return out;
}

/** Live segments a player may edit: not an outside connection's. */
function editable(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(state.roads); id++) if (isSegment(state.roads, id) && ((state.roads.segFlags[id] ?? 0) & SEG_FIXED) === 0) out.push(id);
  return out;
}

/** Submits the commands of step `i`, which name what they act on from `state` as it stands. Two players share the city. */
function commands(state: SimState, i: number): void {
  let k = 0;
  const send = (type: string, payload: unknown) => void submit(state, { seq: i * 10 + k++, playerId: i < W + 400 ? "p1" : "p2", type, payload });
  const s = stubEnd(state);
  const t = second(s);
  const along = (from: Street, at: number, turn: number, length: number) => ({
    from: { x: from.x + from.dx * CELL * at, z: from.z + from.dz * CELL * at },
    to: { x: from.x + from.dx * CELL * at - turn * from.dz * CELL * length, z: from.z + from.dz * CELL * at + turn * from.dx * CELL * length },
    type: "street",
  });
  if (i === 0) send("BuildRoad", { from: { x: s.x, z: s.z }, to: { x: t.x, z: t.z }, type: "street" });
  if (i === 1) send("BuildRoad", { from: { x: t.x, z: t.z }, to: { x: t.x + t.dx * CELL * 80, z: t.z + t.dz * CELL * 80 }, type: "street" });
  if (i === 2) send("ZoneCells", zoneRect(s, "residential", 1, 0, 30, 5, 1));
  if (i === 3) send("ZoneCells", zoneRect(s, "residential", 1, 0, 30, 5, -1));
  if (i === 5 * DAY) send("ZoneCells", zoneRect(s, "commercial", 1, 30, 10, 4, 1));
  if (i === 5 * DAY + 1) send("ZoneCells", zoneRect(s, "office", 1, 30, 10, 4, -1));
  if (i === 5 * DAY + 2) {
    send("ZoneCells", zoneRect(t, "industrial", 1, 40, 30, 5, 1));
    send("ZoneCells", zoneRect(t, "residential", 2, 2, 30, 5, -1));
  }
  if (i === 5 * DAY + 3) send("ZoneCells", zoneRect(t, "industrial", 1, 40, 30, 5, -1));
  if (i === W + 50) send("BuildRoad", along(s, 20, 1, 70));
  if (i === W + 51) send("ZoneCells", zoneRect(t, "commercial", 1, 2, 20, 4, 1));
  if (i === W + 200) {
    const g = editable(state);
    if (g.length > 0) send("UpgradeRoad", { segments: [g[0]], type: "avenue" });
  }
  // Paused: several commands on one tick, applied over separate paused steps.
  if (i === W + 300) send("SetSpeed", { speed: 0 });
  if (i === W + 305) {
    send("BuildRoad", along(t, 40, -1, 50));
    send("ZoneCells", zoneRect(s, "office", 1, 45, 10, 4, -1));
  }
  if (i === W + 306) send("ZoneCells", zoneRect(t, "commercial", 1, 22, 6, 4, 1));
  if (i === W + 308) {
    const g = editable(state);
    if (g.length > 0) send("BulldozeRoad", { segments: [g[g.length - 1]] });
  }
  if (i === W + 310) send("Undo", {});
  if (i === W + 312) send("BuildRoad", along(s, 50, 1, 40));
  if (i === W + 320) send("SetSpeed", { speed: 4 });
  if (i === W + 400) {
    const all = factories(state);
    if (all.length > 0) send("BulldozeBuilding", { buildings: all.slice(0, Math.ceil(all.length / 2)) });
  }
  if (i === W + 450) {
    send("ZoneCells", zoneRect(s, "residential", 3, 0, 10, 5, 1));
    send("ZoneCells", zoneRect(s, "residential", 3, 0, 10, 5, -1));
  }
  if (i === W + 520) {
    const g = editable(state);
    if (g.length > 0) send("BulldozeRoad", { segments: [g[g.length - 1]] });
  }
  if (i === W + 531) send("Undo", {});
  if (i === W + 537) send("SetSpeed", { speed: 2 });
  if (i === W + 800) {
    const g = editable(state);
    if (g.length > 2) send("BulldozeRoad", { segments: [g[1]] });
  }
}

/** Slow travel rebuilds, and owners who redevelop as soon as their ground is zoned up. */
function inBalance<T>(body: () => T): T {
  return withValue(ROUTING_BALANCE.travelTimes, "rebuildSettlesPerTick", 3, () =>
    withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () => withValue(DEMAND_BALANCE.redevelopment, "valueFrom", 0, body)),
  );
}

function finish(steps: Generator<undefined, Uint8Array, undefined>): Uint8Array {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

const capture = createCaptureBuffers();
const out: SnapshotBuffer = { buffer: null };
/** The bytes an autosave writes, as the client's host takes them. */
const autosaveBytes = (s: SimState) => finish(serializeDetachedSteps(captureState(s, capture), out)).slice();

/** A city loaded as the client's host loads one. */
function loadAsHost(bytes: Uint8Array): SimState {
  const s = deserialize(bytes).state;
  prepareDerived(s);
  recordRoadChanges(s.roads);
  recordCellChanges(s);
  recordBuildingChanges(s);
  recordPopChanges(s);
  return s;
}

describe("a town saved and resumed at any point ends as the uninterrupted run does (M3 review, #365)", () => {
  const saves = new Map<string, Uint8Array>();
  let straight = createState(SEED);
  let want = "";
  // In a hook, not the describe body, so the test time limit stops a hang here too.
  beforeAll(() => {
    straight = createState(SEED);
    inBalance(() => {
      for (let i = 0; i < END; i++) {
        const at = POINTS.includes(i - W) ? i - W : -1;
        if (at >= 0) {
          saves.set(`plain@${at}`, serialize(straight));
          saves.set(`autosave@${at}`, autosaveBytes(straight));
        }
        commands(straight, i);
        if (at >= 0) saves.set(`queued@${at}`, autosaveBytes(straight));
        step(straight);
      }
    });
    want = hashState(straight);
  });

  it("grows a town with people and keeps its totals", () => {
    expect(straight.stats.totals).toEqual(recountTotals(straight));
    expect(straight.stats.totals["population"] ?? 0).toBeGreaterThan(50);
    expect(straight.log.filter((e) => e.tick >= W).length).toBeGreaterThan(15);
  });

  for (const at of POINTS) {
    for (const kind of ["plain", "autosave", "queued"] as const) {
      it(`resumes a ${kind} save at W + ${at}`, () => {
        const bytes = saves.get(`${kind}@${at}`);
        if (!bytes) throw new Error("no save");
        const s = kind === "plain" ? deserialize(bytes).state : loadAsHost(bytes);
        inBalance(() => {
          for (let i = W + at; i < END; i++) {
            // A queued save holds this step's commands already.
            if (!(kind === "queued" && i === W + at)) commands(s, i);
            step(s);
          }
        });
        expect(hashState(s)).toBe(want);
      });
    }
  }

  it("leaves another city in the same process alone", () => {
    const a = createState(SEED);
    const b = createState(77);
    inBalance(() => {
      for (let i = 0; i < 1234; i++) {
        commands(b, i);
        step(b);
      }
      for (let i = 0; i < END; i++) {
        commands(a, i);
        step(a);
        commands(b, 1234 + i);
        step(b);
      }
    });
    expect(hashState(a)).toBe(want);
  });

  it("replays its log to the same hash", () => {
    expect(hashState(inBalance(() => replay(SEED, straight.log, straight.tick)))).toBe(want);
  });
});
