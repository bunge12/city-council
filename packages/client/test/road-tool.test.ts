// The road tool (issue M1-07) against the same SimHost the worker runs, with
// an in-memory transport and a fake clock. The tool's state is a plain object
// standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  ROAD_BALANCE,
  ROAD_TYPES,
  createState,
  generateTerrain,
  heightAt,
  type BuildRoadPayload,
  type CommandResult,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { buildPreviewGeometry, previewKey } from "../src/render/road-preview-geometry";
import { INITIAL_ROAD_TOOL, RoadToolController, previewRoad, type RoadToolState } from "../src/tools/road-tool";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

/** The nearest water due east or west of (4400, 4700), found by walking out from the flat square. */
function waterPoint(): { x: number; z: number } {
  for (let d = 300; d < 6000; d += 25) {
    for (const x of [4400 + d, 4400 - d]) {
      if (heightAt(terrain, x, 4700) <= terrain.waterLevel) return { x, z: 4700 };
    }
  }
  throw new Error("no water near the flat square");
}

function setup(send?: (payload: BuildRoadPayload) => Promise<CommandResult>) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(createState(SEED), hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let state: RoadToolState = { ...INITIAL_ROAD_TOOL };
  const sent: BuildRoadPayload[] = [];
  const tool = new RoadToolController({
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    world: () => (mirror.state ? { net: mirror.state.roads, terrain } : null),
    send: (payload) => {
      sent.push(payload);
      return send ? send(payload) : mirror.sendCommand("BuildRoad", payload);
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

describe("previewRoad", () => {
  it("prices a road at its length times the type's price from the balance file", () => {
    const { mirror } = setup();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    for (const type of ["street", "avenue", "oneWay"]) {
      const preview = previewRoad(net, terrain, { x: 4200, z: 4600 }, { x: 4433.3, z: 4655.55 }, type);
      expect(preview.ok).toBe(true);
      const price = ROAD_TYPES.find((t) => t.id === type)?.buildCostPerMetre ?? NaN;
      expect(preview.cost).toBe(Math.round(preview.length * price));
      // The ends land on the build grid, as the sim builds them.
      expect(preview.to).toEqual({ x: 4433.25, z: 4655.5 });
      expect(preview.length).toBeCloseTo(Math.hypot(233.25, 55.5), 9);
    }
    // The price is the file's, brought to the escalation year.
    const street = ROAD_BALANCE.types.find((t) => t.id === "street");
    if (!street) throw new Error("no street in the balance file");
    let price = street.buildCostPerMetre.amount;
    for (let y = street.buildCostPerMetre.sourceYear; y < ROAD_BALANCE.escalation.toYear; y++) {
      price *= ROAD_BALANCE.escalation.annualFactor;
    }
    expect(ROAD_TYPES.find((t) => t.id === "street")?.buildCostPerMetre).toBe(Math.round(price));
  });

  it("gives the sim's reason for a road it would refuse", () => {
    const { mirror } = setup();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    const water = previewRoad(net, terrain, { x: 4400, z: 4700 }, waterPoint(), "street");
    expect(water).toMatchObject({ ok: false, cost: 0, junctions: [] });
    expect(water.reason).toMatch(/water/);
    const short = previewRoad(net, terrain, { x: 4400, z: 4700 }, { x: 4405, z: 4700 }, "avenue");
    expect(short.reason).toMatch(/Too short/);
    expect(short.length).toBe(5);
  });
});

describe("the preview of a road across water", () => {
  it("shows the bridge, bank to bank, and puts it in the cost", () => {
    const { mirror } = setup();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    // Seed 2026's inlet: water from x = 3488 to 3600 along z = 6600.
    const p = previewRoad(net, terrain, { x: 3400, z: 6600 }, { x: 3700, z: 6600 }, "street");
    expect(p.ok).toBe(true);
    expect(p.bridges).toHaveLength(1);
    const bridge = p.bridges[0];
    expect(bridge?.from.x).toBeLessThan(3488);
    expect(bridge?.to.x).toBeGreaterThan(3600);
    expect(p.bridgeLength).toBe((bridge?.to.x ?? 0) - (bridge?.from.x ?? 0));
    const street = ROAD_TYPES.find((t) => t.id === "street");
    if (!street) throw new Error("no street");
    const price = street.buildCostPerMetre;
    expect(p.cost).toBe(Math.round((p.length - p.bridgeLength) * price + p.bridgeLength * price * street.bridge.costMultiplier));
    // A road on dry ground has none.
    expect(previewRoad(net, terrain, { x: 4200, z: 4600 }, { x: 4400, z: 4600 }, "street")).toMatchObject({ bridges: [], bridgeLength: 0 });
  });

  it("draws the bridge part in its own colour over the strip", () => {
    const shape = { ax: 3400, az: 6600, bx: 3700, bz: 6600, control: null, width: 10, look: "ok" as const, junctions: [] };
    const plain = buildPreviewGeometry(terrain, [{ ...shape, bridges: [] }]);
    const bridged = buildPreviewGeometry(terrain, [{ ...shape, bridges: [{ ax: 3450, az: 6600, bx: 3640, bz: 6600, control: null }] }]);
    expect(bridged.positions.length).toBeGreaterThan(plain.positions.length);
    expect(previewKey([{ ...shape, bridges: [] }])).not.toBe(previewKey([{ ...shape, bridges: [{ ax: 3450, az: 6600, bx: 3640, bz: 6600, control: null }] }]));
  });
});

describe("RoadToolController", () => {
  it("draws a street, then an avenue across it, and marks the crossing", async () => {
    const { mirror, tool, tick, settle, sent, state } = setup();
    tool.toggle();
    expect(state().tool).toBe("road");
    tool.click({ x: 4200, z: 4600 });
    expect(state().roadStart).toEqual({ x: 4200, z: 4600 });
    tool.click({ x: 4500, z: 4600 });
    expect(sent).toEqual([{ from: { x: 4200, z: 4600 }, to: { x: 4500, z: 4600 }, type: "street" }]);
    expect(state().roadStart).toBeNull();
    expect(state().roadPending.map((p) => p.status)).toEqual(["sending"]);
    await settle();
    // Queued, not built: the preview stays until the step that builds it.
    expect(state().roadPending.map((p) => p.status)).toEqual(["accepted"]);
    tick();
    expect(state().roadPending).toEqual([]);

    tool.pickType("avenue");
    tool.click({ x: 4350, z: 4450 });
    const crossing = tool.preview({ x: 4350, z: 4750 });
    expect(crossing).toMatchObject({ ok: true, junctions: [{ x: 4350, z: 4600 }] });
    tool.click({ x: 4350, z: 4750 });
    await settle();
    tick();
    const log = mirror.state?.log ?? [];
    expect(log.map((e) => [e.type, e.playerId])).toEqual([
      ["BuildRoad", "p1"],
      ["BuildRoad", "p1"],
    ]);
    // Four segments now meet at the crossing.
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    const at = [...net.nodeX.keys()].filter((i) => net.nodeX[i] === 4350 && net.nodeZ[i] === 4600);
    expect(at).toHaveLength(1);
    let meeting = 0;
    for (let s = 0; s < net.segFlags.length; s++) {
      if ((net.segFlags[s] ?? 0) & 1 && (net.segA[s] === at[0] || net.segB[s] === at[0])) meeting++;
    }
    expect(meeting).toBe(4);
  });

  it("keeps the start and shows the reason when the preview refuses the click", () => {
    const { tool, sent, state } = setup();
    tool.toggle();
    tool.click({ x: 4400, z: 4700 });
    tool.click(waterPoint());
    expect(sent).toEqual([]);
    expect(state().roadStart).toEqual({ x: 4400, z: 4700 });
    expect(state().roadNote).toMatch(/water/);
  });

  it("removes the preview and shows the reason when the sim refuses", async () => {
    let answer: (r: CommandResult) => void = () => undefined;
    const { tool, state } = setup(() => new Promise((r) => (answer = r)));
    tool.toggle();
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4500, z: 4600 });
    // In flight for as long as the answer takes, as from a server.
    expect(state().roadPending).toHaveLength(1);
    answer({ ok: false, reason: "A road already joins these two points" });
    await Promise.resolve();
    expect(state().roadPending).toEqual([]);
    expect(state().roadNote).toBe("A road already joins these two points");
  });

  it("cancels with Escape or a right-click, and Escape with nothing drawn leaves the tool", () => {
    const { tool, state } = setup();
    expect(tool.escape()).toBe(false);
    tool.toggle();
    tool.click({ x: 4200, z: 4600 });
    tool.cancel();
    expect(state()).toMatchObject({ tool: "road", roadStart: null });
    tool.click({ x: 4200, z: 4600 });
    expect(tool.escape()).toBe(true);
    expect(state()).toMatchObject({ tool: "road", roadStart: null });
    expect(tool.escape()).toBe(true);
    expect(state().tool).toBeNull();
    // Off, a click does nothing.
    tool.click({ x: 4200, z: 4600 });
    expect(state().roadStart).toBeNull();
  });

  it("sends points on the build grid", () => {
    const { tool, sent } = setup();
    tool.toggle();
    tool.click({ x: 4200.0000038, z: 4599.97 });
    tool.click({ x: 4480.06, z: 4600.0000012 });
    expect(sent).toEqual([{ from: { x: 4200, z: 4600 }, to: { x: 4480, z: 4600 }, type: "street" }]);
  });

  it("ignores clicks on the sky", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.click(null);
    expect(state().roadStart).toBeNull();
  });
});

describe("preview geometry", () => {
  it("lays a strip as wide as the road type on the ground, with a marker per junction", () => {
    const width = ROAD_TYPES.find((t) => t.id === "avenue")?.width ?? 0;
    const shape = { ax: 4200, az: 4600, bx: 4280, bz: 4600, control: null, width, look: "ok" as const, junctions: [{ x: 4240, z: 4600 }], bridges: [] };
    const arrays = buildPreviewGeometry(terrain, [shape]);
    const zs: number[] = [];
    for (let i = 0; i < arrays.positions.length; i += 3) {
      const x = arrays.positions[i] ?? 0;
      const y = arrays.positions[i + 1] ?? 0;
      const z = arrays.positions[i + 2] ?? 0;
      expect(y).toBeGreaterThan(heightAt(terrain, x, z));
      zs.push(z);
    }
    expect(Math.min(...zs)).toBeLessThanOrEqual(4600 - width / 2);
    expect(Math.max(...zs)).toBeGreaterThanOrEqual(4600 + width / 2);
    // 80 m in 8 m steps is 11 cross-sections, 10 quads; the marker is a 20-sided fan.
    expect(arrays.indices.length).toBe(10 * 6 + 20 * 3);
    expect(previewKey([shape])).not.toBe(previewKey([{ ...shape, look: "refused" }]));
  });
});

/** The live road segments of the mirror's network. */
function liveSegments(net: { segFlags: ArrayLike<number> }): number[] {
  const out: number[] = [];
  for (let s = 0; s < net.segFlags.length; s++) if ((net.segFlags[s] ?? 0) & 1) out.push(s);
  return out;
}

const FINE = { metresPerPixel: 0.25, free: false };

describe("curved mode (M1-10)", () => {
  it("takes three clicks: the start, a point that sets the direction, the end", async () => {
    const { mirror, tool, tick, settle, sent, state } = setup();
    tool.pickMode("curved");
    expect(state()).toMatchObject({ tool: "road", roadMode: "curved" });
    tool.click({ x: 4200, z: 4700 });
    // No curve until the direction is set.
    expect(tool.preview({ x: 4400, z: 4700 })).toBeNull();
    tool.click({ x: 4300, z: 4600 });
    expect(state().roadControl).toEqual({ x: 4300, z: 4600 });
    expect(sent).toEqual([]);
    const preview = tool.preview({ x: 4400, z: 4700 });
    if (!preview) throw new Error("no preview");
    expect(preview).toMatchObject({ ok: true, control: { x: 4300, z: 4600 } });
    // Length and cost follow the curve, not the chord.
    expect(preview.length).toBeGreaterThan(200 + 20);
    expect(preview.cost).toBe(Math.round(preview.length * preview.type.buildCostPerMetre));
    tool.click({ x: 4400, z: 4700 });
    expect(sent).toEqual([{ from: { x: 4200, z: 4700 }, to: { x: 4400, z: 4700 }, type: "street", control: { x: 4300, z: 4600 } }]);
    expect(state()).toMatchObject({ roadStart: null, roadControl: null });
    await settle();
    tick();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    const [seg] = liveSegments(net);
    if (seg === undefined) throw new Error("no road");
    expect([net.segCX[seg], net.segCZ[seg]]).toEqual([4300, 4600]);
    expect(net.segLength[seg]).toBeCloseTo(preview.length, 9);
  });

  it("shows a curve that is too tight as refused, with the radius in the reason, and sends nothing", () => {
    const { tool, sent, state } = setup();
    tool.pickType("avenue");
    tool.pickMode("curved");
    tool.click({ x: 4200, z: 4700 });
    tool.click({ x: 4230, z: 4600 });
    const preview = tool.preview({ x: 4260, z: 4700 });
    expect(preview).toMatchObject({ ok: false, cost: 0 });
    expect(preview?.reason).toMatch(/too tight: a \d+ m radius/);
    expect(preview?.control).toEqual({ x: 4230, z: 4600 });
    // A refused curve is still measured along the curve.
    expect(preview?.length ?? 0).toBeGreaterThan(60);
    tool.click({ x: 4260, z: 4700 });
    expect(sent).toEqual([]);
    expect(state().roadNote).toMatch(/too tight/);
    expect(state().roadControl).toEqual({ x: 4230, z: 4600 });
  });

  it("leaves the end of a road in line with it, so the join has no kink", async () => {
    const { mirror, tool, tick, settle, state } = setup();
    // A street ending at (4300, 4700), arriving from the west on a curve.
    tool.pickMode("curved");
    tool.click({ x: 4150, z: 4760 });
    tool.click({ x: 4230, z: 4680 });
    tool.click({ x: 4300, z: 4700 });
    await settle();
    tick();
    // A curve from that end: the direction click is held on the line the street carries on along.
    tool.click({ x: 4300, z: 4700 });
    const snap = tool.snap({ x: 4360, z: 4650 }, FINE);
    expect(snap?.kind).toBe("tangent");
    if (!snap?.ray) throw new Error("no ray");
    // The street's tangent at its end points from its control point to the end.
    const tx = 4300 - 4230;
    const tz = 4700 - 4680;
    const tl = Math.hypot(tx, tz);
    expect(snap.ray.dx).toBeCloseTo(tx / tl, 12);
    expect(snap.ray.dz).toBeCloseTo(tz / tl, 12);
    tool.click(snap);
    const control = state().roadControl;
    if (!control) throw new Error("no control point");
    tool.click({ x: 4420, z: 4560 });
    await settle();
    tick();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    const segs = liveSegments(net);
    expect(segs).toHaveLength(2);
    const [first, second] = segs as [number, number];
    const node = net.segB[first];
    expect(net.segA[second]).toBe(node);
    // The angle between the two tangents at the shared node.
    const nx = net.nodeX[node ?? 0] ?? 0;
    const nz = net.nodeZ[node ?? 0] ?? 0;
    const inX = nx - (net.segCX[first] ?? 0);
    const inZ = nz - (net.segCZ[first] ?? 0);
    const outX = (net.segCX[second] ?? 0) - nx;
    const outZ = (net.segCZ[second] ?? 0) - nz;
    const cos = (inX * outX + inZ * outZ) / (Math.hypot(inX, inZ) * Math.hypot(outX, outZ));
    const kinkDegrees = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    expect(kinkDegrees).toBeLessThan(0.2);
  });

  it("lets the direction go free with the free-hand key, and off a junction", async () => {
    const { tool, tick, settle } = setup();
    tool.toggle();
    tool.click({ x: 4200, z: 4700 });
    tool.click({ x: 4300, z: 4700 });
    await settle();
    tick();
    tool.pickMode("curved");
    tool.click({ x: 4300, z: 4700 });
    expect(tool.snap({ x: 4360, z: 4650 }, FINE)?.kind).toBe("tangent");
    expect(tool.snap({ x: 4360, z: 4650 }, { ...FINE, free: true })?.kind).not.toBe("tangent");
    // From the middle of the street, which is not an end, the direction is free.
    tool.escape();
    tool.click({ x: 4250, z: 4700 });
    expect(tool.snap({ x: 4290, z: 4650 }, FINE)?.kind).not.toBe("tangent");
  });
});

describe("continuous mode (M1-10)", () => {
  it("draws a three-segment road, one BuildRoad and one log entry per segment, until Escape", async () => {
    const { mirror, tool, tick, settle, sent, state } = setup();
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4300, z: 4600 });
    // The next segment starts where this one ended.
    expect(state().roadStart).toEqual({ x: 4300, z: 4600 });
    // Clicked before the first is built, the second waits for it.
    tool.click({ x: 4300, z: 4700 });
    expect(state().roadPending.map((p) => p.status)).toEqual(["sending", "queued"]);
    expect(sent).toHaveLength(1);
    await settle();
    tick();
    await settle();
    expect(sent).toHaveLength(2);
    tick();
    tool.click({ x: 4400, z: 4700 });
    await settle();
    tick();
    expect(state().roadStart).toEqual({ x: 4400, z: 4700 });
    expect(tool.escape()).toBe(true);
    expect(state()).toMatchObject({ tool: "road", roadStart: null, roadChain: 0 });
    expect(sent).toEqual([
      { from: { x: 4200, z: 4600 }, to: { x: 4300, z: 4600 }, type: "street" },
      { from: { x: 4300, z: 4600 }, to: { x: 4300, z: 4700 }, type: "street" },
      { from: { x: 4300, z: 4700 }, to: { x: 4400, z: 4700 }, type: "street" },
    ]);
    expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoad", "BuildRoad"]);
    const net = mirror.state?.roads;
    if (!net) throw new Error("no snapshot");
    // Joined end to end: four nodes, three segments.
    expect(liveSegments(net)).toHaveLength(3);
    expect(net.nodeFlags.filter((f) => f & 1)).toHaveLength(4);
    expect(state().roadPending).toEqual([]);
  });

  it("ends on a double click and keeps every segment clicked", async () => {
    const { mirror, tool, tick, settle, state } = setup();
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4300, z: 4600 });
    // A double click's two clicks land on the end just clicked. The second ends the road, with no note.
    // Length snap puts it a cell from the end, still too short to be a road.
    tool.click({ x: 4308, z: 4600 });
    expect(state()).toMatchObject({ roadStart: null, roadNote: null });
    // The double click event after it changes nothing.
    tool.finish();
    expect(state()).toMatchObject({ roadStart: null, roadNote: null });
    await settle();
    tick();
    expect(mirror.state?.log).toHaveLength(1);
  });

  it("stops at a segment the sim would refuse and keeps the ones already built", async () => {
    const { mirror, tool, tick, settle, sent, state } = setup();
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4300, z: 4600 });
    // Doubling back at 10 degrees, clicked before the first segment is built,
    // so only the check after it is built can refuse it. The next one goes too.
    tool.click({ x: 4200, z: 4618 });
    tool.click({ x: 4200, z: 4700 });
    expect(state().roadPending.map((p) => p.status)).toEqual(["sending", "queued", "queued"]);
    await settle();
    tick();
    await settle();
    expect(sent).toHaveLength(1);
    expect(state().roadPending).toEqual([]);
    expect(state().roadNote).toMatch(/too sharp/);
    expect(state().roadStart).toBeNull();
    tick();
    expect(mirror.state?.log).toHaveLength(1);
    expect(liveSegments(mirror.state?.roads ?? { segFlags: [] })).toHaveLength(1);
  });

  it("stops at a click the preview refuses, keeping the segments built", async () => {
    const { mirror, tool, tick, settle, sent, state } = setup();
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4300, z: 4600 });
    await settle();
    tick();
    tool.click({ x: 4200, z: 4618 });
    expect(sent).toHaveLength(1);
    expect(state()).toMatchObject({ roadStart: null, roadChain: 0 });
    expect(state().roadNote).toMatch(/too sharp/);
    tick();
    expect(mirror.state?.log).toHaveLength(1);
  });

  it("stops when the sim itself refuses a segment", async () => {
    let calls = 0;
    const { tool, tick, settle, state, mirror } = setup((payload) => {
      calls++;
      return calls === 2 ? Promise.resolve({ ok: false, reason: "Refused by the sim" }) : mirror.sendCommand("BuildRoad", payload);
    });
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4600 });
    tool.click({ x: 4300, z: 4600 });
    await settle();
    tick();
    tool.click({ x: 4300, z: 4700 });
    await settle();
    expect(state()).toMatchObject({ roadStart: null, roadNote: "Refused by the sim", roadPending: [] });
    tick();
    expect(mirror.state?.log).toHaveLength(1);
  });
});

describe("switching part way through a road", () => {
  it("drops the road being drawn and leaves nothing behind", () => {
    const { tool, sent, state } = setup();
    tool.pickMode("curved");
    tool.click({ x: 4200, z: 4700 });
    tool.click({ x: 4300, z: 4600 });
    tool.pickMode("straight");
    expect(state()).toMatchObject({ roadMode: "straight", roadStart: null, roadControl: null, roadPending: [] });
    tool.pickMode("continuous");
    tool.click({ x: 4200, z: 4700 });
    tool.toggle();
    expect(state()).toMatchObject({ tool: null, roadStart: null, roadChain: 0, roadPending: [] });
    tool.toggle();
    expect(state().roadStart).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("curved preview geometry", () => {
  it("follows the curve, with pieces that each turn at most the surface limit", () => {
    const width = 10;
    const shape = { ax: 4200, az: 4700, bx: 4400, bz: 4700, control: { x: 4300, z: 4600 }, width, look: "ok" as const, junctions: [], bridges: [] };
    const arrays = buildPreviewGeometry(terrain, [shape]);
    const sections = arrays.positions.length / 6;
    // The apex of the curve is at t = 0.5: (4300, 4650).
    let nearest = Infinity;
    for (let i = 0; i < arrays.positions.length; i += 6) {
      const x = ((arrays.positions[i] ?? 0) + (arrays.positions[i + 3] ?? 0)) / 2;
      const z = ((arrays.positions[i + 2] ?? 0) + (arrays.positions[i + 5] ?? 0)) / 2;
      nearest = Math.min(nearest, Math.hypot(x - 4300, z - 4650));
    }
    expect(nearest).toBeLessThan(0.01);
    expect(sections).toBeGreaterThan(20);
    expect(previewKey([shape])).not.toBe(previewKey([{ ...shape, control: { x: 4300, z: 4610 } }]));
  });
});
