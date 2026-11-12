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
    const shape = { ax: 4200, az: 4600, bx: 4280, bz: 4600, width, look: "ok" as const, junctions: [{ x: 4240, z: 4600 }] };
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
