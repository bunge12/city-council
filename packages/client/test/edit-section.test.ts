// Bulldozing and upgrading part of a road (issue 86): the stretch the
// pointer marks, and the bulldozer and upgrade tools sending it, against
// the same SimHost the worker runs with an in-memory transport and a fake
// clock. The tools' state is a plain object standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  NONE,
  SEG_FIXED,
  createState,
  generateTerrain,
  segmentEnds,
  step,
  submit,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import type { RoadNet } from "../src/render/road-geometry";
import { BulldozeToolController, INITIAL_BULLDOZE_TOOL, type BulldozeKind, type BulldozeToolState } from "../src/tools/bulldoze-tool";
import { EDIT_SECTION } from "../src/tools/config";
import { WHOLE, alongSegment, joinSections, sectionAt } from "../src/tools/edit-section";
import { EditToolController, INITIAL_EDIT_TOOL, editShapes, type EditToolState } from "../src/tools/edit-tool";
import { INITIAL_ROAD_TOOL, type RoadToolState } from "../src/tools/road-tool";

const SEED = 2026;
const terrain = generateTerrain(SEED);

function cityWith(roads: { from: [number, number]; to: [number, number]; control?: [number, number] }[]): SimState {
  const state = createState(SEED);
  let seq = 0;
  for (const { from, to, control } of roads) {
    const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street", ...(control ? { control: { x: control[0], z: control[1] } } : {}) };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "BuildRoad", payload });
    if (!result.ok) throw new Error(`fixture road refused: ${result.reason}`);
    step(state);
  }
  return state;
}

/** The live, unfixed segments of `net`. */
function segments(net: RoadNet): number[] {
  const out: number[] = [];
  for (let s = 0; s < net.segFlags.length; s++) {
    const flags = net.segFlags[s] ?? 0;
    if ((flags & 1) !== 0 && (flags & SEG_FIXED) === 0) out.push(s);
  }
  return out;
}

/** Each live, unfixed segment as "ax,az -> bx,bz type", sorted. */
function shapes(net: RoadNet): string[] {
  return segments(net)
    .map((s) => {
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      return `${net.nodeX[a]},${net.nodeZ[a]} -> ${net.nodeX[b]},${net.nodeZ[b]} ${net.segType[s]}`;
    })
    .sort();
}

function hostFor(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  const apply = async () => {
    await new Promise((r) => setTimeout(r, 0));
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const net = (): RoadNet => {
    const roads = mirror.state?.roads;
    if (!roads) throw new Error("no snapshot");
    return roads;
  };
  return { mirror, apply, net };
}

function editSetup(state: SimState) {
  const { mirror, apply, net } = hostFor(state);
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
      return mirror.sendCommandSettled(type, payload);
    },
  });
  return { tool, apply, net, sent, setUi: (p: Partial<RoadToolState & EditToolState>) => (ui = { ...ui, ...p }) };
}

function bulldozeSetup(state: SimState) {
  const { mirror, apply, net } = hostFor(state);
  let ui: RoadToolState & BulldozeToolState = { ...INITIAL_ROAD_TOOL, ...INITIAL_BULLDOZE_TOOL };
  const sent: { type: string; payload: unknown }[] = [];
  const tool = new BulldozeToolController({
    get: () => ui,
    set: (patch) => {
      ui = { ...ui, ...patch };
    },
    world: () => (mirror.state ? { state: mirror.state, terrain, people: (id: number) => mirror.buildingPeople(id), filled: (id: number) => mirror.jobsFilled(id) } : null),
    send: (type, payload) => {
      sent.push({ type, payload });
      return mirror.sendCommandSettled(type, payload);
    },
  });
  return { tool, apply, net, sent };
}

const pickerOf = (under: { [K in BulldozeKind]?: number }) => (kind: BulldozeKind) => under[kind] ?? NONE;

/** One straight street from (4200, 4600) to (4500, 4600). */
const STREET = [{ from: [4200, 4600] as [number, number], to: [4500, 4600] as [number, number] }];

describe("sectionAt", () => {
  it("marks a stretch of the set length centred on the pointer", () => {
    const net = cityWith(STREET).roads;
    const seg = segments(net)[0] ?? NONE;
    const t = alongSegment(net, seg, 4350, 4603);
    expect(t).toBeCloseTo(0.5, 9);
    const [from, to] = sectionAt(net, seg, t);
    expect((to - from) * 300).toBeCloseTo(EDIT_SECTION.metres, 6);
    expect((from + to) / 2).toBeCloseTo(0.5, 9);
  });

  it("is cut short by the segment's end, and whole with Shift, on a short road or on a bridge", () => {
    const state = cityWith([...STREET, { from: [4200, 4700], to: [4212, 4700] }, { from: [3400, 6600], to: [3700, 6600] }]);
    const net = state.roads;
    const [seg, short] = segments(net);
    expect(sectionAt(net, seg ?? NONE, 0.01)[0]).toBe(0);
    expect(sectionAt(net, seg ?? NONE, 0.5, true)).toEqual(WHOLE);
    expect(sectionAt(net, short ?? NONE, 0.5)).toEqual(WHOLE);
    const bridge = segments(net).find((s) => net.segLevelA[s] === LEVEL_BRIDGE) ?? NONE;
    expect(bridge).not.toBe(NONE);
    expect(sectionAt(net, bridge, 0.5)).toEqual(WHOLE);
  });

  it("follows a curve by length, not by parameter", () => {
    const net = cityWith([{ from: [4200, 4600], to: [4500, 4600], control: [4250, 4400] }]).roads;
    const seg = segments(net)[0] ?? NONE;
    const [from, to] = sectionAt(net, seg, 0.5);
    expect(to - from).toBeGreaterThan(0);
    expect(to - from).not.toBeCloseTo(EDIT_SECTION.metres / (net.segLength[seg] ?? 1), 3);
  });

  it("joins two stretches into one that covers both", () => {
    expect(joinSections([0.2, 0.3], [0.5, 0.6])).toEqual([0.2, 0.6]);
  });
});

describe("the upgrade tool on part of a road", () => {
  it("upgrades only the stretch a click marks, and the mark is where the sim cuts", async () => {
    const { tool, apply, net, sent, setUi } = editSetup(cityWith(STREET));
    tool.toggle("upgrade");
    setUi({ roadType: "avenue" });
    const seg = segments(net())[0] ?? NONE;
    const preview = tool.preview(seg, [0.4, 0.6]);
    expect(preview).toMatchObject({ ok: true, length: 60, sections: [[0.4, 0.6]] });
    const marks = preview ? editShapes(net(), preview, "ok") : [];
    expect(marks.map((m) => [m.ax, m.bx])).toEqual([[4320, 4380]]);
    const ends = segmentEnds(net(), seg);
    tool.click(seg, [0.4, 0.6]);
    await apply();
    expect(sent).toEqual([{ type: "UpgradeRoad", payload: { segments: [seg], ends: [ends], types: ["street"], type: "avenue", sections: [[0.4, 0.6]] } }]);
    expect(shapes(net())).toEqual(["4200,4600 -> 4320,4600 0", "4320,4600 -> 4380,4600 1", "4380,4600 -> 4500,4600 0"]);
  });

  it("sends no sections when every segment is taken whole, as before", async () => {
    const { tool, apply, sent, net, setUi } = editSetup(cityWith(STREET));
    tool.toggle("upgrade");
    setUi({ roadType: "avenue" });
    const seg = segments(net())[0] ?? NONE;
    tool.click(seg, WHOLE);
    await apply();
    expect(sent[0]?.payload).not.toHaveProperty("sections");
  });

  it("grows a stretch as a drag runs along the road, and sends it as one command", async () => {
    const { tool, apply, net, sent, setUi } = editSetup(cityWith(STREET));
    tool.toggle("upgrade");
    setUi({ roadType: "avenue" });
    const seg = segments(net())[0] ?? NONE;
    tool.dragStart();
    tool.dragOver(seg, [0.2, 0.3]);
    tool.dragOver(seg, [0.25, 0.35]);
    tool.dragOver(seg, [0.5, 0.6]);
    expect(tool.preview(NONE)).toMatchObject({ ok: true, sections: [[0.2, 0.6]], length: 120 });
    tool.dragEnd();
    await apply();
    expect(sent).toHaveLength(1);
    expect(shapes(net())).toEqual(["4200,4600 -> 4260,4600 0", "4260,4600 -> 4380,4600 1", "4380,4600 -> 4500,4600 0"]);
  });
});

describe("the bulldozer on part of a road", () => {
  it("removes the stretch the pointer marks, and the whole road with Shift", async () => {
    const { tool, apply, net, sent } = bulldozeSetup(cityWith([...STREET, { from: [4200, 4700], to: [4500, 4700] }]));
    tool.toggle();
    const [first, second] = segments(net());
    const target = tool.pick(pickerOf({ road: first ?? NONE }), () => [0.4, 0.6]);
    expect(target).toEqual({ kind: "road", id: first, section: [0.4, 0.6] });
    expect(tool.preview(target)).toMatchObject({ ok: true, length: 60 });
    tool.click(target);
    await apply();
    expect(sent[0]?.payload).toMatchObject({ segments: [first], sections: [[0.4, 0.6]] });
    // Shift: the picker gives no stretch, so the whole segment goes.
    tool.click(tool.pick(pickerOf({ road: second ?? NONE }), () => undefined));
    await apply();
    expect(sent[1]?.payload).not.toHaveProperty("sections");
    expect(shapes(net())).toEqual(["4200,4600 -> 4320,4600 0", "4380,4600 -> 4500,4600 0"]);
  });

  it("grows a road's stretch over a drag, and takes a second road whole when Shift is held over it", async () => {
    const { tool, apply, net, sent } = bulldozeSetup(cityWith([...STREET, { from: [4500, 4600], to: [4500, 4800] }]));
    tool.toggle();
    const [along, across] = segments(net());
    tool.dragStart();
    tool.dragOver(tool.pick(pickerOf({ road: along ?? NONE }), () => [0.7, 0.8]));
    tool.dragOver(tool.pick(pickerOf({ road: along ?? NONE }), () => [0.9, 1]));
    tool.dragOver(tool.pick(pickerOf({ road: across ?? NONE }), () => undefined));
    tool.dragEnd();
    await apply();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ segments: [along, across], sections: [[0.7, 1], [0, 1]] });
    expect(shapes(net())).toEqual(["4200,4600 -> 4410,4600 0"]);
  });
});
