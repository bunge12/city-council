// The bulldoze and upgrade tools (issue M1-13) against the same SimHost the
// worker runs, with an in-memory transport and a fake clock, and segment
// picking against made-up camera projections. The tools' state is a plain
// object standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  NONE,
  SEG_FIXED,
  bridgeDeckLevel,
  createState,
  generateTerrain,
  heightAt,
  planBulldoze,
  planUpgrade,
  step,
  submit,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import type { RoadNet } from "../src/render/road-geometry";
import { buildPreviewGeometry } from "../src/render/road-preview-geometry";
import { EditToolController, INITIAL_EDIT_TOOL, editShapes, previewEdit, type EditToolState } from "../src/tools/edit-tool";
import { dragSamples, pickSegment, type PickView } from "../src/tools/pick-segment";
import { INITIAL_ROAD_TOOL, type RoadToolState } from "../src/tools/road-tool";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000),
// and an inlet with water from x = 3488 to 3600 along z = 6600.
const SEED = 2026;
const terrain = generateTerrain(SEED);

type Road = [from: [number, number], to: [number, number], type: string, control?: [number, number]];

function cityWith(roads: Road[]): SimState {
  const state = createState(SEED);
  let seq = 0;
  for (const [from, to, type, control] of roads) {
    const payload = {
      from: { x: from[0], z: from[1] },
      to: { x: to[0], z: to[1] },
      type,
      ...(control ? { control: { x: control[0], z: control[1] } } : {}),
    };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "BuildRoad", payload });
    if (!result.ok) throw new Error(`fixture road refused: ${result.reason}`);
    step(state);
  }
  return state;
}

/** A street along z = 4600 from x = 4150 to 4550, crossed by three streets: four segments along it. */
const CROSSED: Road[] = [
  [[4150, 4600], [4550, 4600], "street"],
  [[4250, 4500], [4250, 4700], "street"],
  [[4350, 4500], [4350, 4700], "street"],
  [[4450, 4500], [4450, 4700], "street"],
];

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let ui: RoadToolState & EditToolState = { ...INITIAL_ROAD_TOOL, ...INITIAL_EDIT_TOOL };
  const sent: { type: string; payload: unknown }[] = [];
  const tool = new EditToolController({
    get: () => ui,
    set: (patch) => {
      ui = { ...ui, ...patch };
    },
    world: () => (mirror.state ? { net: mirror.state.roads, terrain } : null),
    send: (type, payload) => {
      sent.push({ type, payload });
      return mirror.sendCommand(type, payload);
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
  const net = (): RoadNet => {
    const roads = mirror.state?.roads;
    if (!roads) throw new Error("no snapshot");
    return roads;
  };
  const setUi = (patch: Partial<RoadToolState & EditToolState>) => {
    ui = { ...ui, ...patch };
  };
  return { mirror, tool, tick, settle, sent, net, ui: () => ui, setUi, host };
}

/** The live segment nearest (x, z), by its middle. */
function segmentNear(net: RoadNet, x: number, z: number): number {
  let best = NONE;
  let bestD = Infinity;
  for (let s = 0; s < net.segFlags.length; s++) {
    if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    const mx = ((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0) + 2 * (net.segCX[s] ?? 0)) / 4;
    const mz = ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0) + 2 * (net.segCZ[s] ?? 0)) / 4;
    const d = Math.hypot(mx - x, mz - z);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

function liveSegments(net: RoadNet): number {
  let n = 0;
  for (let s = 0; s < net.segFlags.length; s++) if ((net.segFlags[s] ?? 0) & 1) n++;
  return n;
}

describe("previewEdit", () => {
  it("prices a bulldoze and an upgrade with the sim's planners", () => {
    const state = cityWith(CROSSED);
    const net = state.roads;
    const seg = segmentNear(net, 4300, 4600);
    const bulldoze = previewEdit(net, terrain, "bulldoze", [seg], "avenue");
    const plan = planBulldoze(net, { segments: [seg] });
    if (!plan.ok) throw new Error(plan.reason);
    expect(bulldoze).toMatchObject({ ok: true, kind: "bulldoze", cost: plan.plan.cost, length: plan.plan.length, fixed: false });
    expect(bulldoze.cost).toBeGreaterThan(0);

    const upgrade = previewEdit(net, terrain, "upgrade", [seg], "avenue");
    const uplan = planUpgrade(net, terrain, { segments: [seg], type: "avenue" });
    if (!uplan.ok) throw new Error(uplan.reason);
    expect(upgrade).toMatchObject({ ok: true, kind: "upgrade", cost: uplan.plan.cost });
    expect(upgrade.type?.id).toBe("avenue");
  });

  it("says a fixed segment cannot be removed or changed, and prices nothing", () => {
    const state = cityWith(CROSSED);
    const seg = segmentNear(state.roads, 4300, 4600);
    state.roads.segFlags[seg] = (state.roads.segFlags[seg] ?? 0) | SEG_FIXED;
    const bulldoze = previewEdit(state.roads, terrain, "bulldoze", [seg], "street");
    expect(bulldoze).toMatchObject({ ok: false, fixed: true, cost: 0, reason: "This road is fixed and cannot be removed" });
    const upgrade = previewEdit(state.roads, terrain, "upgrade", [seg], "avenue");
    expect(upgrade).toMatchObject({ ok: false, fixed: true, reason: "This road is fixed and cannot be changed" });
  });

  it("shows the sim's reason for an upgrade it would refuse", () => {
    const state = cityWith(CROSSED);
    const seg = segmentNear(state.roads, 4300, 4600);
    const preview = previewEdit(state.roads, terrain, "upgrade", [seg], "street");
    expect(preview.ok).toBe(false);
    expect(preview.reason).toBe(`Segment ${seg} is already a street`);
  });
});

describe("EditToolController", () => {
  it("bulldozes a segment with a click, in one log entry", async () => {
    const { tool, tick, settle, sent, net, mirror, ui } = setup(cityWith(CROSSED));
    tool.toggle("bulldoze");
    expect(ui().tool).toBe("bulldoze");
    const seg = segmentNear(net(), 4300, 4600);
    const before = liveSegments(net());
    const log = mirror.state?.log.length ?? 0;
    tool.click(seg);
    expect(ui().editPending).toHaveLength(1);
    await settle();
    tick();
    await settle();
    expect(sent).toEqual([{ type: "BulldozeRoad", payload: { segments: [seg] } }]);
    expect(liveSegments(net())).toBe(before - 1);
    expect((net().segFlags[seg] ?? 0) & 1).toBe(0);
    expect((mirror.state?.log.length ?? 0) - log).toBe(1);
    expect(ui().editPending).toHaveLength(0);
  });

  it("upgrades a street to the type in the road type picker with a click", async () => {
    const { tool, tick, settle, sent, net, ui, setUi } = setup(cityWith(CROSSED));
    tool.toggle("upgrade");
    const seg = segmentNear(net(), 4300, 4600);
    // The picker starts on street, which the street already is: the sim's reason, and nothing sent.
    tool.click(seg);
    expect(sent).toEqual([]);
    expect(ui().editNote).toBe(`Segment ${seg} is already a street`);
    setUi({ roadType: "avenue" });
    expect(tool.preview(seg)).toMatchObject({ ok: true, kind: "upgrade" });
    tool.click(seg);
    await settle();
    tick();
    await settle();
    expect(sent).toEqual([{ type: "UpgradeRoad", payload: { segments: [seg], type: "avenue" } }]);
    expect(net().segType[seg]).toBe(1);
  });

  it("sends one command for every segment a drag passes over", async () => {
    const { tool, tick, settle, sent, net, mirror } = setup(cityWith(CROSSED));
    tool.toggle("bulldoze");
    const along = [4200, 4300, 4400, 4500].map((x) => segmentNear(net(), x, 4600));
    expect(new Set(along).size).toBe(4);
    const log = mirror.state?.log.length ?? 0;
    tool.dragStart();
    // Passing over the same segment again, and over nothing, adds nothing.
    for (const seg of [along[0], along[0], NONE, along[1], along[2], along[2], along[3]]) tool.dragOver(seg ?? NONE);
    tool.dragEnd();
    await settle();
    tick();
    await settle();
    expect(sent).toEqual([{ type: "BulldozeRoad", payload: { segments: along } }]);
    expect((mirror.state?.log.length ?? 0) - log).toBe(1);
    for (const seg of along) expect((net().segFlags[seg] ?? 0) & 1).toBe(0);
  });

  it("leaves out of a drag what it could not act on alone", async () => {
    const state = cityWith([...CROSSED, [[4150, 4650], [4240, 4650], "avenue"]]);
    const fixed = segmentNear(state.roads, 4400, 4600);
    state.roads.segFlags[fixed] = (state.roads.segFlags[fixed] ?? 0) | SEG_FIXED;
    const { tool, settle, sent, net, ui, setUi } = setup(state);
    const street = segmentNear(net(), 4200, 4600);
    const avenue = segmentNear(net(), 4200, 4650);
    tool.toggle("upgrade");
    tool.dragStart();
    tool.dragOver(fixed);
    tool.dragOver(street);
    tool.dragEnd();
    await settle();
    // Upgrading to a street: the fixed segment and the street itself are left out, so nothing is sent.
    expect(sent).toEqual([]);
    expect(ui().editDrag).toBeNull();
    // With the avenue the street joins, and the avenue does not.
    setUi({ roadType: "avenue" });
    tool.dragStart();
    tool.dragOver(fixed);
    tool.dragOver(avenue);
    tool.dragOver(street);
    tool.dragEnd();
    await settle();
    expect(sent).toEqual([{ type: "UpgradeRoad", payload: { segments: [street], type: "avenue" } }]);
  });

  it("refuses to bulldoze a fixed segment on hover and click, and sends nothing", () => {
    const state = cityWith(CROSSED);
    const seg = segmentNear(state.roads, 4300, 4600);
    state.roads.segFlags[seg] = (state.roads.segFlags[seg] ?? 0) | SEG_FIXED;
    const { tool, sent, ui } = setup(state);
    tool.toggle("bulldoze");
    expect(tool.preview(seg)).toMatchObject({ ok: false, fixed: true });
    tool.click(seg);
    expect(sent).toEqual([]);
    expect(ui().editNote).toBe("This road is fixed and cannot be removed");
  });

  it("reverses a one-way with a right-click, for free", async () => {
    const { tool, tick, settle, sent, net } = setup(cityWith([[[4200, 4600], [4500, 4600], "oneWay"]]));
    tool.toggle("upgrade");
    const seg = segmentNear(net(), 4350, 4600);
    const a = net().segA[seg];
    const b = net().segB[seg];
    expect(tool.reversePreview(seg)).toMatchObject({ ok: true, kind: "reverse", cost: 0 });
    expect(tool.rightClick(seg)).toBe(true);
    await settle();
    tick();
    await settle();
    expect(sent).toEqual([{ type: "UpgradeRoad", payload: { segments: [seg], type: "oneWay" } }]);
    expect([net().segA[seg], net().segB[seg]]).toEqual([b, a]);
  });

  it("tells a right-click on a two-way road what right-click is for", () => {
    const { tool, sent, net, ui } = setup(cityWith(CROSSED));
    tool.toggle("upgrade");
    expect(tool.rightClick(segmentNear(net(), 4300, 4600))).toBe(true);
    expect(sent).toEqual([]);
    expect(ui().editNote).toBe("A right-click reverses a one-way road");
    // The bulldoze tool leaves right-clicks alone.
    tool.toggle("bulldoze");
    expect(tool.rightClick(segmentNear(net(), 4300, 4600))).toBe(false);
  });

  it("drops a drag on Escape, and leaves the tool on a second", () => {
    const { tool, net, ui, sent } = setup(cityWith(CROSSED));
    tool.toggle("bulldoze");
    tool.dragStart();
    tool.dragOver(segmentNear(net(), 4300, 4600));
    expect(tool.escape()).toBe(true);
    expect(ui().editDrag).toBeNull();
    tool.dragEnd();
    expect(sent).toEqual([]);
    expect(tool.escape()).toBe(true);
    expect(ui().tool).toBeNull();
    expect(tool.escape()).toBe(false);
  });

  it("draws an upgrade at the new type's width", () => {
    const { tool, net } = setup(cityWith(CROSSED));
    tool.toggle("upgrade");
    const seg = segmentNear(net(), 4300, 4600);
    const preview = previewEdit(net(), terrain, "upgrade", [seg], "avenue");
    const [shape] = editShapes(net(), preview, "ok");
    expect(shape?.width).toBe(preview.type?.width);
    const street = editShapes(net(), previewEdit(net(), terrain, "bulldoze", [seg], "avenue"), "bulldoze")[0];
    expect(street?.width).toBeLessThan(shape?.width ?? 0);
  });
});

/** A camera looking straight down, `mpp` metres to a pixel, with (ox, oz) at the screen's top left. */
function topDown(mpp: number, ox: number, oz: number) {
  return (x: number, _y: number, z: number) => ({ x: (x - ox) / mpp, y: (z - oz) / mpp });
}

function viewAt(x: number, z: number, mpp = 0.5): PickView {
  const project = topDown(mpp, x - 500 * mpp, z - 400 * mpp);
  const pointer = project(x, 0, z);
  return { pointer, ground: { x, z }, deck: null, metresPerPixel: mpp, project };
}

describe("pickSegment", () => {
  it("picks the road under the pointer, within a few pixels of its edge, and nothing further", () => {
    const state = cityWith(CROSSED);
    const seg = segmentNear(state.roads, 4300, 4600);
    expect(pickSegment(state.roads, terrain, viewAt(4300, 4600))).toBe(seg);
    // A street is 8 m or so wide: 3 m off the centre line is on it, and 10 px past its edge at 0.5 m a pixel is not.
    expect(pickSegment(state.roads, terrain, viewAt(4300, 4603))).toBe(seg);
    expect(pickSegment(state.roads, terrain, viewAt(4300, 4600 + 30))).toBe(NONE);
    // Zoomed out, the same 30 m is a few pixels and picks it.
    expect(pickSegment(state.roads, terrain, viewAt(4300, 4630, 5))).toBe(seg);
  });

  it("picks the nearer of two roads that run close together", () => {
    const state = cityWith([
      [[4200, 4600], [4500, 4600], "street"],
      [[4200, 4616], [4500, 4616], "street"],
    ]);
    const south = segmentNear(state.roads, 4350, 4600);
    const north = segmentNear(state.roads, 4350, 4616);
    expect(south).not.toBe(north);
    // Zoomed out so both are inside the pick distance, each side still picks its own.
    expect(pickSegment(state.roads, terrain, viewAt(4350, 4603, 2))).toBe(south);
    expect(pickSegment(state.roads, terrain, viewAt(4350, 4613, 2))).toBe(north);
  });

  it("keeps a drag on the road it is following across a junction", () => {
    const state = cityWith(CROSSED);
    const west = segmentNear(state.roads, 4300, 4600);
    const east = segmentNear(state.roads, 4400, 4600);
    // Right on the junction at x = 4350 every road meeting there is under the pointer.
    const at = viewAt(4350, 4600);
    expect(pickSegment(state.roads, terrain, at, undefined, west)).toBe(west);
    // Past it, the next segment along takes over, not the cross street.
    expect(pickSegment(state.roads, terrain, viewAt(4357, 4600), undefined, west)).toBe(east);
  });

  it("measures a curve along the curve, not its chord", () => {
    const state = cityWith([[[4150, 4900], [4350, 4900], "avenue", [4250, 4800]]]);
    const seg = segmentNear(state.roads, 4250, 4850);
    // The apex of the arch is at z = 4850; the chord runs along z = 4900.
    expect(pickSegment(state.roads, terrain, viewAt(4250, 4850))).toBe(seg);
    expect(pickSegment(state.roads, terrain, viewAt(4250, 4900))).toBe(NONE);
  });

  it("picks a bridge where its deck is drawn, above the water the ground pick lands on", () => {
    const state = cityWith([[[3400, 6600], [3700, 6600], "oneWay"]]);
    const net = state.roads;
    const bridge = Array.from(net.segLevelA).indexOf(LEVEL_BRIDGE);
    expect(bridge).toBeGreaterThanOrEqual(0);
    // A camera looking north and down at 45 degrees, close in: a point's screen height falls with its height.
    const mpp = 0.05;
    const project = (x: number, y: number, z: number) => ({ x: (x - 3400) / mpp, y: (z - 6600 - y) / mpp + 400 });
    const deckY = bridgeDeckLevel(terrain.waterLevel);
    const drop = deckY - terrain.waterLevel;
    // The pointer over the deck's middle. Its ray meets the deck level there, and the water as far past it as the deck is high.
    const over: PickView = {
      pointer: project(3545, deckY, 6600),
      ground: { x: 3545, z: 6600 + drop },
      deck: { x: 3545, z: 6600 },
      metresPerPixel: mpp,
      project,
    };
    expect(heightAt(terrain, 3545, 6600 + drop)).toBeLessThanOrEqual(terrain.waterLevel);
    expect(pickSegment(net, terrain, over)).toBe(bridge);
    // Where the middle of an 8 m one-way would be drawn if it lay on the water, 5 m below the deck, is 1 m past
    // the deck's drawn edge, 20 px here: no pick.
    const below = project(3545, terrain.waterLevel, 6600);
    const under: PickView = { ...over, pointer: below, ground: { x: 3545, z: 6600 }, deck: { x: 3545, z: 6600 - drop } };
    expect(pickSegment(net, terrain, under)).toBe(NONE);
  });
});

describe("dragSamples", () => {
  it("covers a fast drag at the step, ends included", () => {
    const points = dragSamples({ x: 0, y: 0 }, { x: 40, y: 0 }, 4);
    expect(points).toHaveLength(11);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[10]).toEqual({ x: 40, y: 0 });
    expect(dragSamples({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toHaveLength(2);
  });
});

describe("edit marks on a bridge", () => {
  it("are drawn at the deck's height, not on the water", () => {
    const state = cityWith([[[3400, 6600], [3700, 6600], "street"]]);
    const net = state.roads;
    const bridge = Array.from(net.segLevelA).indexOf(LEVEL_BRIDGE);
    const preview = previewEdit(net, terrain, "bulldoze", [bridge], "street");
    const shapes = editShapes(net, preview, "bulldoze");
    expect(shapes[0]?.deck).toBeDefined();
    const g = buildPreviewGeometry(terrain, shapes);
    const deckY = bridgeDeckLevel(terrain.waterLevel);
    let top = -Infinity;
    for (let i = 1; i < g.positions.length; i += 3) top = Math.max(top, g.positions[i] ?? 0);
    expect(top).toBeGreaterThan(deckY);
    expect(top).toBeLessThan(deckY + 1);
  });
});
