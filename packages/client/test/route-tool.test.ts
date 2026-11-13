// The debug panel's route tool (issue M1-15) against the same SimHost the
// worker runs, with an in-memory transport and a fake clock. The tool's
// state is a plain object standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  NONE,
  createState,
  findRouteBetween,
  generateTerrain,
  routingGraphOf,
  step,
  submit,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import type { RoadNet } from "../src/render/road-geometry";
import { buildPreviewGeometry } from "../src/render/road-preview-geometry";
import { INITIAL_ROAD_TOOL, type RoadToolState } from "../src/tools/road-tool";
import {
  INITIAL_ROUTE_TOOL,
  RouteToolController,
  formatDistance,
  formatDuration,
  routeReadout,
  routeShapes,
  type RouteToolState,
} from "../src/tools/route-tool";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

/** Two north-south streets joined by one east-west link along z = 4600. */
const LINKED: [[number, number], [number, number]][] = [
  [
    [4150, 4450],
    [4150, 4750],
  ],
  [
    [4550, 4450],
    [4550, 4750],
  ],
  [
    [4150, 4600],
    [4550, 4600],
  ],
];

function city(): SimState {
  const state = createState(SEED);
  let seq = 0;
  for (const [from, to] of LINKED) {
    const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "BuildRoad", payload });
    if (!result.ok) throw new Error(`fixture road refused: ${result.reason}`);
    step(state);
  }
  return state;
}

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let ui: RoadToolState & RouteToolState = { ...INITIAL_ROAD_TOOL, ...INITIAL_ROUTE_TOOL };
  const tool = new RouteToolController({
    get: () => ui,
    set: (patch) => {
      ui = { ...ui, ...patch };
    },
    net: () => mirror.state?.roads ?? null,
  });
  mirror.subscribe(() => tool.refresh());
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const net = (): RoadNet => {
    const roads = mirror.state?.roads;
    if (!roads) throw new Error("no snapshot");
    return roads;
  };
  return { mirror, tool, tick, settle, net, ui: () => ui };
}

/** The link's segment: the one whose middle is nearest (4350, 4600). */
function linkSegment(net: RoadNet): number {
  for (let s = 0; s < net.segFlags.length; s++) {
    if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    if (Math.abs((net.nodeZ[a] ?? 0) - 4600) < 1 && Math.abs((net.nodeZ[b] ?? 0) - 4600) < 1) return s;
  }
  return NONE;
}

describe("route tool", () => {
  it("picks two points, shows the route, and says no route once the only link is bulldozed", async () => {
    const t = setup(city());
    t.tick();
    await t.settle();
    expect(t.mirror.state).not.toBeNull();

    t.tool.toggle();
    expect(t.tool.active()).toBe(true);
    expect(routeReadout(t.ui())).toBe("click the start");
    t.tool.click({ x: 4160, z: 4500 });
    expect(routeReadout(t.ui())).toBe("click the end");
    t.tool.click({ x: 4540, z: 4700 });

    const result = t.ui().routeResult;
    if (!result?.ok) throw new Error("expected a route");
    const link = linkSegment(t.net());
    expect(result.route.segments).toContain(link);
    // 100 m south to the link, 400 m along it, 100 m on to the end.
    expect(result.route.distance).toBeCloseTo(600, 6);
    expect(result.route).toEqual(
      (findRouteBetween(routingGraphOf(t.mirror.state?.roads ?? createState(0).roads), 4160, 4500, 4540, 4700) as { route: unknown }).route,
    );
    expect(routeReadout(t.ui())).toBe(`600 m, ${formatDuration(result.route.time)}, 3 segments`);

    // The highlight cuts the first and last segments where the route joins them.
    const shapes = routeShapes(t.net(), result.route);
    expect(shapes).toHaveLength(3);
    const ends = shapes.map((s) => [s.ax, s.az, s.bx, s.bz].map((v) => Math.round(v * 1e6) / 1e6));
    expect(ends[0]).toEqual([4150, 4500, 4150, 4600]);
    expect(ends[2]).toEqual([4550, 4600, 4550, 4700]);
    expect(shapes.every((s) => s.look === "route")).toBe(true);
    expect(buildPreviewGeometry(terrain, shapes).indices.length).toBeGreaterThan(0);

    // Bulldoze the link: the mirror's routing graph follows the delta.
    const sent = t.mirror.sendCommand("BulldozeRoad", { segments: [link] });
    t.tick();
    expect((await sent).ok).toBe(true);
    t.tick();
    await t.settle();
    expect(linkSegment(t.net())).toBe(NONE);
    expect(t.ui().routeResult).toEqual({ ok: false, reason: "no route" });
    expect(routeReadout(t.ui())).toBe("no route");

    // The points stay after leaving the tool, so the route keeps showing.
    t.tool.toggle();
    expect(t.tool.active()).toBe(false);
    expect(routeReadout(t.ui())).toBe("no route");
  });

  it("starts again on a third click, and Escape clears then leaves", async () => {
    const t = setup(city());
    t.tick();
    await t.settle();
    t.tool.toggle();
    t.tool.click({ x: 4160, z: 4500 });
    t.tool.click({ x: 4540, z: 4700 });
    t.tool.click({ x: 4150, z: 4700 });
    expect(t.ui()).toMatchObject({ routeFrom: { x: 4150, z: 4700 }, routeTo: null, routeResult: null });
    expect(t.tool.escape()).toBe(true);
    expect(t.ui()).toMatchObject({ tool: "route", routeFrom: null });
    expect(t.tool.escape()).toBe(true);
    expect(t.ui().tool).toBeNull();
    expect(t.tool.escape()).toBe(false);
  });

  it("says when a point is too far from any road", async () => {
    const t = setup(city());
    t.tick();
    await t.settle();
    t.tool.toggle();
    t.tool.click({ x: 2000, z: 2000 });
    t.tool.click({ x: 4540, z: 4700 });
    expect(routeReadout(t.ui())).toBe("no road near the start");
  });
});

describe("route readout formats", () => {
  it("formats distances and times", () => {
    expect(formatDistance(849.6)).toBe("850 m");
    expect(formatDistance(2345)).toBe("2.35 km");
    expect(formatDuration(44.6)).toBe("45 s");
    expect(formatDuration(185)).toBe("3 min 05 s");
  });
});
