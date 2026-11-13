// The grid tool (issue M1-21) against the same SimHost the worker runs, with
// an in-memory transport and a fake clock. The tool's state is a plain object
// standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  ROAD_BUILD,
  createBareState,
  generateTerrain,
  type BuildRoadGridPayload,
  type CommandResult,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { liveRoadSegment, type RoadNet } from "../src/render/road-geometry";
import {
  GridToolController,
  INITIAL_GRID_TOOL,
  gridCorners,
  gridMarks,
  gridShapes,
  previewGrid,
  roadDirAt,
  type GridPreview,
  type GridToolState,
} from "../src/tools/grid-tool";
import type { RoadToolState } from "../src/tools/road-tool";

// Places on the map of seed 2026, as the sim's grid tests use them.
const SEED = 2026;
const terrain = generateTerrain(SEED);
/** Dry land north of an inlet that widens to the south-west. */
const INLET = { x0: 3300, z0: 6400, x1: 3800, z1: 6800 };

type State = GridToolState & Pick<RoadToolState, "tool" | "roadType" | "roadNote" | "roadStart" | "roadControl" | "roadChain">;

function setup(send?: (payload: BuildRoadGridPayload) => Promise<CommandResult>) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(createBareState(SEED), hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let state: State = { ...INITIAL_GRID_TOOL, tool: null, roadType: "street", roadNote: null, roadStart: null, roadControl: null, roadChain: 0 };
  const sent: BuildRoadGridPayload[] = [];
  const tool = new GridToolController({
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    world: () => (mirror.state ? { net: mirror.state.roads, terrain } : null),
    send: (payload) => {
      sent.push(payload);
      return send ? send(payload) : mirror.sendCommand("BuildRoadGrid", payload);
    },
  });
  mirror.subscribe((u) => tool.mirrorUpdated(u));
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { mirror, tool, tick, settle, sent, state: () => state };
}

/** Draws the rectangle from `a` to `b` as a drag would. */
function drag(tool: GridToolController, a: { x: number; z: number }, b: { x: number; z: number }): void {
  tool.dragStart(a);
  tool.dragMove({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, false);
  tool.dragMove(b, false);
  tool.dragEnd();
}

const key = (ax: number, az: number, bx: number, bz: number): string =>
  ax < bx || (ax === bx && az < bz) ? `${ax},${az}-${bx},${bz}` : `${bx},${bz}-${ax},${az}`;

function previewLinks(p: GridPreview): string[] {
  return p.streets.flatMap((s) => s.points.slice(1).map((b, k) => key(s.points[k]?.x ?? 0, s.points[k]?.z ?? 0, b.x, b.z))).sort();
}

function builtLinks(net: RoadNet): string[] {
  const out: string[] = [];
  for (let s = 0; s < net.segA.length; s++) {
    if (!liveRoadSegment(net, s)) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    out.push(key(net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0, net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0));
  }
  return out.sort();
}

describe("gridCorners", () => {
  it("projects the pointer onto the two sides, so the far corner is the pointer", () => {
    expect(gridCorners({ x: 4200, z: 4500 }, { x: 4400, z: 4300 }, { dx: 1, dz: 0 })).toEqual({
      origin: { x: 4200, z: 4500 },
      along: { x: 4400, z: 4500 },
      across: { x: 4200, z: 4300 },
    });
  });

  it("turns with the direction and puts the corners on the build grid", () => {
    const d = { dx: Math.cos(0.3), dz: Math.sin(0.3) };
    const c = gridCorners({ x: 4200, z: 4500 }, { x: 4200 + 300 * d.dx - 200 * d.dz, z: 4500 + 300 * d.dz + 200 * d.dx }, d);
    for (const p of [c.along, c.across]) {
      expect(p.x * 8).toBe(Math.round(p.x * 8));
      expect(p.z * 8).toBe(Math.round(p.z * 8));
    }
    expect(Math.hypot(c.along.x - 4200, c.along.z - 4500)).toBeCloseTo(300, 0);
    expect(Math.hypot(c.across.x - 4200, c.across.z - 4500)).toBeCloseTo(200, 0);
  });
});

describe("the grid tool", () => {
  it("lays a grid square to the map on open ground, with the default block depth of twelve cells", async () => {
    const { tool, tick, settle, sent, state, mirror } = setup();
    tool.toggle();
    expect(state().tool).toBe("grid");
    drag(tool, { x: 4200, z: 4500 }, { x: 4200 + 2 * 202, z: 4500 + 2 * 106 });
    const preview = tool.preview();
    expect(preview?.ok).toBe(true);
    expect(preview?.payload.depth).toBe(96);
    expect(state().gridDir).toEqual({ dx: 1, dz: 0 });
    // Depth 96 m and width 192 m between road edges: 2 by 2 blocks.
    expect(preview?.streets).toHaveLength(6);
    expect(preview?.cost).toBe(Math.round((preview?.length ?? 0) * (preview?.type.buildCostPerMetre ?? 0)));

    tool.confirm();
    expect(sent).toHaveLength(1);
    expect(state().gridOrigin).toBeNull();
    expect(state().gridPending).toHaveLength(1);
    await settle();
    expect(state().gridPending[0]?.status).toBe("accepted");
    tick();
    expect(state().gridPending).toHaveLength(0);
    const net = mirror.state?.roads;
    if (!net || !preview) throw new Error("no state");
    expect(builtLinks(net)).toEqual(previewLinks(preview));
    expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoadGrid"]);
  });

  it("takes the angle of the road a drag starts on, and joins that road", async () => {
    const { tool, tick, settle, mirror, state } = setup();
    const d = { dx: 0.8, dz: 0.6 };
    await mirror.sendCommand("BuildRoad", { from: { x: 4150, z: 4450 }, to: { x: 4150 + 500 * d.dx, z: 4450 + 500 * d.dz }, type: "street" });
    tick();
    await settle();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    const origin = { x: 4150 + 100 * d.dx, z: 4450 + 100 * d.dz };
    const dir = roadDirAt(net, origin);
    expect(dir?.dx).toBeCloseTo(0.8, 9);
    expect(dir?.dz).toBeCloseTo(0.6, 9);

    tool.toggle();
    // Off the road, to the left of it, two blocks each way.
    drag(tool, origin, { x: origin.x + 300 * d.dx - 220 * d.dz, z: origin.z + 300 * d.dz + 220 * d.dx });
    expect(state().gridOnRoad).toBe(true);
    // Alt does not turn a rectangle started on a road.
    tool.dragStart(origin);
    tool.dragMove({ x: origin.x, z: origin.z + 300 }, true);
    expect(state().gridDir.dx).toBeCloseTo(0.8, 9);
    tool.dragMove({ x: origin.x + 300 * d.dx - 220 * d.dz, z: origin.z + 300 * d.dz + 220 * d.dx }, false);
    tool.dragEnd();

    const preview = tool.preview();
    expect(preview?.ok, preview?.reason ?? "").toBe(true);
    // The first line lies along the road, so it is left out, and each street across it joins it.
    const across = preview?.streets.filter((s) => s.axis === 1) ?? [];
    expect(preview?.streets.filter((s) => s.axis === 0)).toHaveLength(across.length === 0 ? 0 : 2);
    expect(across.length).toBeGreaterThanOrEqual(2);
    expect(preview?.junctions).toHaveLength(across.length);
    const before = builtLinks(net).length;
    tool.confirm();
    await settle();
    tick();
    expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoadGrid"]);
    expect(builtLinks(net).length).toBeGreaterThan(before);
  });

  it("turns a rectangle on open ground while Alt is held, keeping its size", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4500, z: 4700 }, false);
    // Turn it so the far corner points straight south of the origin.
    tool.dragMove({ x: 4200, z: 4900 }, true);
    const dir = state().gridDir;
    const corner = state().gridCorner;
    if (!corner) throw new Error("no corner");
    expect(Math.hypot(dir.dx, dir.dz)).toBeCloseTo(1, 9);
    expect(dir.dx).not.toBeCloseTo(1, 3);
    expect(Math.hypot(corner.x - 4200, corner.z - 4500)).toBeCloseTo(Math.hypot(300, 200), 0);
    expect(Math.abs(corner.x - 4200)).toBeLessThan(10);
    // Let go of Alt and the drag sizes the turned rectangle.
    tool.dragMove({ x: 4300, z: 4900 }, false);
    expect(state().gridDir).toEqual(dir);
    tool.dragEnd();
    expect(tool.preview()?.ok).toBe(true);
  });

  it("shows where water cuts the streets and builds what it showed", async () => {
    const { tool, tick, settle, mirror } = setup();
    tool.toggle();
    drag(tool, { x: INLET.x0, z: INLET.z0 }, { x: INLET.x1, z: INLET.z1 });
    const preview = tool.preview();
    if (!preview) throw new Error("no preview");
    expect(preview.ok, preview.reason ?? "").toBe(true);
    expect(preview.cuts.length).toBeGreaterThan(0);
    expect(gridMarks(preview.payload, preview.cuts).filter((m) => m.shape === "cross" && m.look === "cut")).toHaveLength(preview.cuts.length);
    tool.confirm();
    await settle();
    tick();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    expect(builtLinks(net)).toEqual(previewLinks(preview));
  });

  it("shows a grid over the cap in red with the reason and sends nothing", () => {
    const { tool, sent, state } = setup();
    tool.toggle();
    tool.setBlock("depth", 2);
    tool.setBlock("width", 2);
    drag(tool, { x: 4100, z: 4400 }, { x: 4500, z: 4800 });
    const preview = tool.preview();
    expect(preview?.ok).toBe(false);
    expect(preview?.reason).toMatch(new RegExp(`^Too many streets: the grid has \\d+, and the most one grid can lay is ${ROAD_BUILD.gridMaxStreets}$`));
    if (preview) expect(gridShapes(preview, "refused")).toHaveLength(0);
    tool.confirm();
    expect(sent).toHaveLength(0);
    expect(state().gridNote).toBe(preview?.reason);
    expect(state().gridOrigin).not.toBeNull();
  });

  it("shows the sim's reason when it refuses a grid the preview passed", async () => {
    const { tool, settle, state } = setup(() => Promise.resolve({ ok: false, reason: "Street 1 of 6 in the grid: no" }));
    tool.toggle();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    tool.confirm();
    await settle();
    expect(state().gridPending).toHaveLength(0);
    expect(state().gridNote).toBe("Street 1 of 6 in the grid: no");
  });

  it("drops the rectangle on Escape or a right-click, and leaves on Escape with none", () => {
    const { tool, state } = setup();
    tool.toggle();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    tool.cancel();
    expect(state().gridOrigin).toBeNull();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    expect(tool.escape()).toBe(true);
    expect(state().gridOrigin).toBeNull();
    expect(state().tool).toBe("grid");
    expect(tool.escape()).toBe(true);
    expect(state().tool).toBeNull();
  });

  it("keeps block sizes in whole cells within limits", () => {
    const { tool, state } = setup();
    tool.setBlock("depth", 7.6);
    tool.setBlock("width", 0);
    tool.setBlock("width", Number.NaN);
    expect(state().gridDepthCells).toBe(8);
    expect(state().gridWidthCells).toBe(2);
  });

  it("previews a grid at the cap well inside a frame", () => {
    const { mirror } = setup();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    // 7 by 7 lines over the flat square: the most one grid can lay.
    const payload = { origin: { x: 4100, z: 4400 }, along: { x: 4100 + 6 * 82, z: 4400 }, across: { x: 4100, z: 4400 + 6 * 82 }, depth: 72, width: 72, type: "street" };
    const first = previewGrid(net, terrain, payload);
    expect(first.ok, first.reason ?? "").toBe(true);
    expect(first.streets).toHaveLength(ROAD_BUILD.gridMaxStreets);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) previewGrid(net, terrain, payload);
    // Generous for a slow CI runner; on the development container it is about a millisecond.
    expect((performance.now() - t0) / 10).toBeLessThan(16);
  });
});
