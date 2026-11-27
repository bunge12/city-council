// Issue M4-16: the road, grid and upgrade tools price what a click would do
// with the sim's own `roadPrice` on the mirror, and when the treasury cannot
// pay they keep the price and give the sim's reason. A click is still sent,
// so the sim refuses it with that reason, as the page's "rejected" cue
// needs. Also the hover readout's money line. Against the same SimHost the
// worker runs, with an in-memory transport and a fake clock.
import { describe, expect, it } from "vitest";
import {
  ECONOMY,
  available,
  costsReason,
  createBareState,
  formatMoneyShort,
  fundCity,
  generateTerrain,
  previewBuildRoad,
  step,
  submit,
  type BuildingInfo,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { DEFAULT_GUIDES } from "../src/tools/config";
import { EditToolController, INITIAL_EDIT_TOOL, type EditToolState } from "../src/tools/edit-tool";
import { GridToolController, INITIAL_GRID_TOOL, type GridToolState } from "../src/tools/grid-tool";
import { INITIAL_ROAD_TOOL, RoadToolController, type RoadToolState } from "../src/tools/road-tool";
import { moneyLine } from "../src/ui/BuildingReadout";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

/** A bare city with a street along z = 4600, and its treasury at `treasury`. */
function city(treasury: number): SimState {
  const state = createBareState(SEED);
  const result = submit(state, { seq: 1, playerId: "fixture", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4500, z: 4600 }, type: "street" } });
  if (!result.ok) throw new Error(result.reason);
  step(state);
  while (state.pending.length > 0) step(state);
  fundCity(state, treasury);
  return state;
}

type Ui = RoadToolState & EditToolState & GridToolState;

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let ui: Ui = { ...INITIAL_ROAD_TOOL, ...INITIAL_EDIT_TOOL, ...INITIAL_GRID_TOOL, guides: DEFAULT_GUIDES };
  const get = () => ui;
  const set = (patch: Partial<Ui>) => {
    ui = { ...ui, ...patch };
  };
  const sent: { type: string; payload: unknown }[] = [];
  const send = (type: string, payload: unknown) => {
    sent.push({ type, payload });
    return mirror.sendCommandSettled(type, payload);
  };
  const price = (cost: number, clears: Parameters<SimMirror["price"]>[1]) => mirror.price(cost, clears);
  const roads = new RoadToolController({
    get,
    set,
    world: () => (mirror.state ? { net: mirror.state.roads, terrain, clears: (plan) => mirror.roadClears(plan), price } : null),
    send: (payload) => send("BuildRoad", payload),
  });
  const grid = new GridToolController({
    get,
    set,
    world: () => (mirror.state ? { net: mirror.state.roads, terrain, clears: (plan) => mirror.gridClears(plan), price } : null),
    send: (payload) => send("BuildRoadGrid", payload),
  });
  mirror.subscribe((u) => grid.mirrorUpdated(u));
  const edit = new EditToolController({
    get,
    set,
    world: () => (mirror.state ? { net: mirror.state.roads, terrain, money: { clears: (plan) => mirror.upgradeClears(plan), price } } : null),
    send: (type, payload) => send(type, payload),
  });
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const apply = async () => {
    await settle();
    tick();
    await settle();
  };
  const copy = (): SimState => {
    if (!mirror.state) throw new Error("no snapshot");
    return mirror.state as unknown as SimState;
  };
  const sim = (host as unknown as { state: SimState }).state;
  return { mirror, roads, grid, edit, sent, apply, copy, sim, ui: () => ui };
}

/** The one live street segment the city was built with. */
function streetSegment(state: SimState): number {
  for (let s = 0; s < state.roads.segFlags.length; s++) if (((state.roads.segFlags[s] ?? 0) & 1) !== 0 && state.roads.nodeZ[state.roads.segA[s] ?? 0] === 4600) return s;
  throw new Error("no street");
}

const A_ROAD = { from: { x: 4200, z: 4800 }, to: { x: 4500, z: 4800 } };

describe("the road tool's price (M4-16)", () => {
  it("is the sim's preview price, with no refusal while the treasury can pay", () => {
    const { roads, copy } = setup(city(10_000_000));
    roads.toggle();
    roads.click(A_ROAD.from);
    const p = roads.preview(A_ROAD.to);
    const sim = previewBuildRoad(copy(), { ...A_ROAD, type: "street" });
    if (!p || !sim.ok) throw new Error("no preview");
    expect(p.ok).toBe(true);
    expect(p.price).toBe(sim.price);
    expect(p.price).toBe(p.cost);
    expect(p.refusal).toBeNull();
  });

  it("keeps the price past the overdraft and gives the sim's reason, and a click is sent and refused with it", async () => {
    const { roads, apply, sent, copy, ui } = setup(city(-ECONOMY.overdraft));
    roads.toggle();
    roads.click(A_ROAD.from);
    const p = roads.preview(A_ROAD.to);
    if (!p) throw new Error("no preview");
    expect(p.ok).toBe(true);
    expect(p.price).toBeGreaterThan(0);
    expect(p.refusal).toBe(costsReason(p.price, available(copy())));
    const roadsBefore = copy().log.length;
    roads.click(A_ROAD.to);
    await apply();
    // Sent, so the sim refuses it and the page's "rejected" cue plays; nothing is built.
    expect(sent.map((c) => c.type)).toEqual(["BuildRoad"]);
    expect(copy().log.length).toBe(roadsBefore);
    expect(ui().roadNote).toMatch(/^Costs \$[\d.]+K, \$\d+ available$/);
  });
});

describe("the grid tool's price (M4-16)", () => {
  it("checks the grid's cost against the treasury as it is, outside the preview's cache", async () => {
    const { grid, apply, copy, sim } = setup(city(-ECONOMY.overdraft));
    grid.toggle();
    // One block, as the grid tool's tests draw it: a side along z = 4700, then the reach and a click.
    grid.dragStart({ x: 4200, z: 4700 });
    grid.dragMove({ x: 4301, z: 4700 });
    grid.dragMove({ x: 4402, z: 4700 });
    grid.dragEnd();
    grid.hover({ x: 4402, z: 4806, kind: "node", lengthSnapped: false, source: null, angle: null, square: false, squareTo: null });
    grid.click();
    const broke = grid.preview();
    if (!broke) throw new Error("no preview");
    expect(broke.reason).toBeNull();
    expect(broke.ok).toBe(true);
    expect(broke.price).toBe(broke.cost);
    expect(broke.refusal).toBe(costsReason(broke.cost, available(copy())));
    // The same object while nothing changed, so the panel is not drawn again for nothing.
    expect(grid.preview()).toBe(broke);
    // Funded, the same grid is affordable once the copy has the treasury, with no change of roads to clear the cache.
    fundCity(sim, 10_000_000);
    await apply();
    expect(available(copy())).toBeGreaterThan(broke.price);
    const paid = grid.preview();
    expect(paid?.refusal).toBeNull();
    expect(paid?.price).toBe(broke.price);
  });
});

describe("the upgrade tool's price (M4-16)", () => {
  it("adds the buildings a wider road takes, and gives the sim's reason past the overdraft", () => {
    const { edit, roads, copy } = setup(city(-ECONOMY.overdraft));
    edit.toggle("upgrade");
    roads.pickType("avenue");
    const seg = streetSegment(copy());
    const p = edit.preview(seg);
    if (!p) throw new Error("no preview");
    expect(p.ok).toBe(true);
    expect(p.clears?.ids).toEqual([]);
    expect(p.price).toBe(p.cost);
    expect(p.refusal).toBe(costsReason(p.price, available(copy())));
  });
});

describe("the hover readout's money line (M4-16)", () => {
  const b = { value: 412_000 } as BuildingInfo;
  it("gives the building's value and its yearly tax", () => {
    expect(moneyLine(b, { people: 2, tax: 3100 })).toBe(`Value ${formatMoneyShort(412_000)} · Tax ${formatMoneyShort(3100)} a year`);
  });
  it("gives the value alone where the tax is not known", () => {
    expect(moneyLine(b, { people: 2 })).toBe(`Value ${formatMoneyShort(412_000)}`);
  });
});
