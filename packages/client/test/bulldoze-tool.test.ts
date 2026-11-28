// The bulldozer (issue 116) against the same SimHost the worker runs, with an
// in-memory transport and a fake clock, on a street with houses grown by the
// sim's own grower. The tool's state is a plain object standing in for the
// UI store. Also the ray pick that finds a building by the box it is drawn
// as.
import { describe, expect, it } from "vitest";
import { Scene } from "three/webgpu";
import {
  BUILDINGS_BALANCE,
  BUILDING_CHANGED,
  NONE,
  SEG_FIXED,
  SEGMENT_CHANGED,
  buildingCount,
  buildingInfo,
  buildingsInChunk,
  createState,
  buildingPeople,
  generateTerrain,
  heightAt,
  isBuilding,
  segmentEnds,
  segmentTypeId,
  step,
  submit,
  addPop,
  available,
  costsReason,
  fundCity,
  ECONOMY,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { createBuildingLayer } from "../src/render/building-meshes";
import { rayBoxDistance } from "../src/render/building-pick";
import { BULLDOZE_TARGETS, BulldozeToolController, INITIAL_BULLDOZE_TOOL, type BulldozeKind, type BulldozeToolState } from "../src/tools/bulldoze-tool";
import { INITIAL_ROAD_TOOL, type RoadToolState } from "../src/tools/road-tool";
import { NORTH_AMERICAN } from "../src/theme/north-american";
import { bulldozeLines } from "../src/ui/price-lines";

const SEED = 2026;
const terrain = generateTerrain(SEED);

function run(state: SimState, type: string, payload: unknown, seq: { n: number }): void {
  const result = submit(state, { seq: ++seq.n, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
}

/**
 * A street along z = 4600 from x = 4200 to 4392, crossed at x = 4296 by a
 * street running north to z = 4500, its north side zoned R1 six cells deep,
 * grown until at least eight houses stand.
 */
function houseCity(): SimState {
  const state = createState(SEED);
  const seq = { n: 0 };
  run(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" }, seq);
  run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] }, seq);
  for (let t = 0; t < 6000 && buildingCount(state.buildings) < 8; t++) step(state);
  if (buildingCount(state.buildings) < 8) throw new Error("the houses did not grow");
  // The street reaches no outside connection, so nobody moves in: put a household in every other house.
  for (let id = 0, n = 0; id < state.buildings.flags.length; id++) {
    if (!isBuilding(state.buildings, id) || n++ % 2 === 1) continue;
    addPop(state, { home: id, size: 2, education: 1, wealth: 1, children: 0, satisfaction: 70 });
  }
  return state;
}

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
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
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Sends what the tool queued and waits for the step that applies it. */
  const apply = async () => {
    await settle();
    tick();
    await settle();
  };
  const copy = (): SimState => {
    const s = mirror.state;
    if (!s) throw new Error("no snapshot");
    return s as unknown as SimState;
  };
  const join = (playerId: string) =>
    new SimMirror({ send: (m, t) => client.send(m, t), onMessage: (h) => client.onMessage((m) => h(structuredClone(m))) }, playerId);
  const sim = (host as unknown as { state: SimState }).state;
  return { mirror, tool, apply, tick, settle, sent, copy, join, sim, ui: () => ui, setUi: (p: Partial<BulldozeToolState>) => (ui = { ...ui, ...p }) };
}

/** The people living in building `id`, from the sim's own pops. */
function popsIn(state: SimState, id: number): number {
  return buildingPeople(state, id);
}

function liveBuildings(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id)) out.push(id);
  return out;
}

/** The houses, west to east by where their lot starts. */
function housesWestToEast(state: SimState): number[] {
  return liveBuildings(state).sort((a, b) => (state.buildings.firstPlace[a] ?? 0) - (state.buildings.firstPlace[b] ?? 0));
}

function seen(state: SimState, id: number) {
  return { id, segment: state.buildings.firstSeg[id], side: state.buildings.firstSide[id], place: state.buildings.firstPlace[id], builtAt: state.buildings.builtAt[id] };
}

/** The one live segment of the street. */
function street(state: SimState): number {
  for (let s = 0; s < state.roads.segFlags.length; s++) {
    const flags = state.roads.segFlags[s] ?? 0;
    if ((flags & 1) !== 0 && (flags & SEG_FIXED) === 0 && state.roads.nodeZ[state.roads.segA[s] ?? 0] === 4600 && state.roads.nodeX[state.roads.segA[s] ?? 0] === 4200) return s;
  }
  throw new Error("no street");
}

/** A picker that finds what `under` says is at the pointer, by kind. */
const pickerOf = (under: { [K in BulldozeKind]?: number | undefined }) => (kind: BulldozeKind) => under[kind] ?? NONE;

describe("the target kinds", () => {
  it("pick buildings before roads, and every kind starts on", () => {
    expect(BULLDOZE_TARGETS.map((t) => t.id)).toEqual(["building", "road"]);
    expect(INITIAL_BULLDOZE_TOOL.bulldozeFilters).toEqual({ building: true, road: true });
  });
});

describe("BulldozeToolController", () => {
  it("picks the building when a building and a road are both under the pointer", () => {
    const { tool, copy } = setup(houseCity());
    tool.toggle();
    const house = housesWestToEast(copy())[0] ?? NONE;
    const road = street(copy());
    expect(tool.pick(pickerOf({ building: house, road }))).toEqual({ kind: "building", id: house });
    expect(tool.pick(pickerOf({ road }))).toEqual({ kind: "road", id: road });
    expect(tool.pick(pickerOf({}))).toBeNull();
  });

  it("ignores a kind whose filter is off", () => {
    const { tool, copy, ui } = setup(houseCity());
    tool.toggle();
    const house = housesWestToEast(copy())[0] ?? NONE;
    const road = street(copy());
    tool.toggleFilter("building");
    expect(ui().bulldozeFilters).toEqual({ building: false, road: true });
    expect(tool.pick(pickerOf({ building: house, road }))).toEqual({ kind: "road", id: road });
    tool.toggleFilter("road");
    expect(tool.pick(pickerOf({ building: house, road }))).toBeNull();
  });

  it("prices a road with the buildings on its cells, and removes them with it in one log entry", async () => {
    const { tool, apply, sent, copy, mirror } = setup(houseCity());
    tool.toggle();
    const road = street(copy());
    const houses = liveBuildings(copy());
    // The people living there, as the mirror counts them, not the room the houses hold (M3-12).
    const residents = houses.reduce((n, id) => n + mirror.buildingPeople(id), 0);
    expect(residents).toBe(2 * Math.ceil(houses.length / 2));
    const preview = tool.preview({ kind: "road", id: road });
    expect(preview).toMatchObject({ kind: "road", ok: true, undoable: true, segments: [road], buildings: houses, residents });
    expect(preview?.cost).toBeGreaterThan(0);
    const log = copy().log.length;
    const ends = segmentEnds(copy().roads, road);
    tool.click({ kind: "road", id: road });
    await apply();
    expect(sent).toEqual([{ type: "BulldozeRoad", payload: { segments: [road], ends: [ends], types: ["street"] } }]);
    expect(liveBuildings(copy())).toEqual([]);
    expect(mirror.state?.log.length).toBe(log + 1);
  });

  it("removes a building with a click, at once, with no undo record, in one log entry", async () => {
    const { tool, apply, sent, copy, ui } = setup(houseCity());
    tool.toggle();
    const house = housesWestToEast(copy())[2] ?? NONE;
    const before = liveBuildings(copy());
    const preview = tool.preview({ kind: "building", id: house });
    expect(preview).toMatchObject({ kind: "building", ok: true, undoable: false, split: false, buildings: [house], segments: [] });
    expect(preview?.building?.id).toBe(house);
    // The eminent domain price (M4-09), which the click is charged to the dollar.
    expect(preview?.cost).toBeGreaterThan(0);
    expect(preview?.cost).toBe(preview?.compensation.total);
    const log = copy().log.length;
    const undo = structuredClone(copy().undo);
    const want = seen(copy(), house);
    tool.click({ kind: "building", id: house });
    expect(ui().bulldozePending).toHaveLength(1);
    await apply();
    expect(sent).toEqual([{ type: "BulldozeBuilding", payload: { buildings: [want] } }]);
    expect(liveBuildings(copy())).toEqual(before.filter((id) => id !== house));
    expect(copy().log.length).toBe(log + 1);
    // What the command took from the treasury, as the log keeps it.
    expect(copy().logSpent.at(-1)).toBe(preview?.cost);
    expect(copy().undo).toEqual(undo);
    expect(ui().bulldozePending).toEqual([]);
  });

  it("prices an occupied house as the sim charges it, and the copy keeps the sim's expropriation records (M4-09)", async () => {
    const { tool, apply, copy, sim } = setup(houseCity());
    tool.toggle();
    const houses = housesWestToEast(copy());
    const lived = houses.find((id) => popsIn(sim, id) > 0) ?? NONE;
    const empty = houses.find((id) => popsIn(sim, id) === 0) ?? NONE;
    expect(lived).not.toBe(NONE);
    expect(empty).not.toBe(NONE);
    const occupied = tool.preview({ kind: "building", id: lived });
    const vacant = tool.preview({ kind: "building", id: empty });
    // Nobody lives in it: demolition only, far below a home with people in it.
    expect(vacant?.compensation).toMatchObject({ occupied: 0, empty: 1, value: 0 });
    expect(occupied?.compensation).toMatchObject({ occupied: 1, empty: 0, residents: 2 });
    expect(occupied?.cost).toBeGreaterThan(10 * (vacant?.cost ?? 0));
    tool.click({ kind: "building", id: lived });
    await apply();
    expect(copy().logSpent.at(-1)).toBe(occupied?.cost);
    expect(sim.expropriations).toHaveLength(1);
    expect(copy().expropriations).toEqual(sim.expropriations);
    tool.click({ kind: "building", id: empty });
    await apply();
    expect(copy().logSpent.at(-1)).toBe(vacant?.cost);
    expect(copy().expropriations).toEqual(sim.expropriations);
  });

  it("gives the tag's lines from the plan: an occupied house's value, relocation and premium, then the total (M4-16)", () => {
    const { tool, copy, sim } = setup(houseCity());
    tool.toggle();
    const lived = housesWestToEast(copy()).find((id) => popsIn(sim, id) > 0) ?? NONE;
    const p = tool.preview({ kind: "building", id: lived });
    if (!p) throw new Error("no preview");
    const c = p.compensation;
    expect(bulldozeLines(p)).toEqual([
      { id: "value", label: "Building value", amount: c.value },
      { id: "relocation", label: "Relocation, 2 residents", amount: c.relocation },
      { id: "premium", label: "Premium", amount: c.premium },
      { id: "total", label: "Total", amount: p.cost },
    ]);
    expect(c.value).toBeGreaterThan(0);
    expect(c.relocation).toBe(2 * ECONOMY.eminentDomain.relocationPerResident);
    expect(c.premium).toBeGreaterThan(0);
    // The total is the plan's, which the parts make up.
    expect(p.cost).toBe(c.value + c.relocation + c.premium);
  });

  it("gives a vacant house's tag its demolition only, with no total (M4-16)", () => {
    const { tool, copy, sim } = setup(houseCity());
    tool.toggle();
    const empty = housesWestToEast(copy()).find((id) => popsIn(sim, id) === 0) ?? NONE;
    const p = tool.preview({ kind: "building", id: empty });
    if (!p) throw new Error("no preview");
    expect(bulldozeLines(p)).toEqual([{ id: "demolition", label: "Demolition", amount: p.cost }]);
    expect(p.cost).toBe(p.compensation.demolition);
    expect(p.cost).toBeGreaterThan(0);
  });

  it("gives a road's tag its demolition less its refund, the compensation for the houses it takes, then the total (M4-16)", () => {
    const { tool, copy } = setup(houseCity());
    tool.toggle();
    const p = tool.preview({ kind: "road", id: street(copy()) });
    if (!p) throw new Error("no preview");
    const c = p.compensation;
    expect(c.occupied).toBeGreaterThan(0);
    expect(c.empty).toBeGreaterThan(0);
    const lines = bulldozeLines(p);
    expect(lines.map((l) => l.id)).toEqual(["road", "refund", "value", "relocation", "premium", "demolition", "total"]);
    expect(lines[0]).toEqual({ id: "road", label: `Road demolition, ${p.length.toFixed(0)} m`, amount: p.demolition });
    expect(lines[1]).toEqual({ id: "refund", label: "Refund", amount: p.refund, minus: true });
    expect(lines.find((l) => l.id === "relocation")?.label).toBe(`Relocation, ${c.residents} residents`);
    expect(lines.find((l) => l.id === "demolition")?.label).toBe(`Demolition, ${c.empty} empty buildings`);
    expect(lines.at(-1)).toEqual({ id: "total", label: "Total", amount: p.cost });
    expect(p.cost).toBe(p.demolition - p.refund + c.total);
  });

  it("keeps the price on a refused tag with the sim's reason when the treasury cannot pay, and the click is still sent (M4-16)", async () => {
    const { tool, copy, sim, apply, sent, ui } = setup(houseCity());
    fundCity(sim, -ECONOMY.overdraft);
    await apply();
    tool.toggle();
    const lived = housesWestToEast(copy()).find((id) => popsIn(sim, id) > 0) ?? NONE;
    const p = tool.preview({ kind: "building", id: lived });
    expect(p?.ok).toBe(true);
    expect(p?.cost).toBeGreaterThan(0);
    // What is left as the copy has it: the step that brought the funding also ran the day's taxes.
    expect(p?.refusal).toBe(costsReason(p?.cost ?? 0, available(copy())));
    expect(available(copy())).toBeLessThan(p?.cost ?? 0);
    tool.click({ kind: "building", id: lived });
    await apply();
    // The sim refuses it, so the page plays its "rejected" cue, and the tool shows why.
    expect(sent).toHaveLength(1);
    expect(isBuilding(copy().buildings, lived)).toBe(true);
    expect(ui().bulldozeNote).toBe(p?.refusal);
  });

  it("collects the buildings a drag passes over and leaves the road, in one command", async () => {
    const { tool, apply, sent, copy } = setup(houseCity());
    tool.toggle();
    const [a, b, c] = housesWestToEast(copy());
    const road = street(copy());
    const before = liveBuildings(copy());
    const log = copy().log.length;
    const want = [a, b, c].map((id) => seen(copy(), id ?? NONE));
    tool.dragStart();
    // Over a house, the road, the same house again, then two more houses.
    tool.dragOver(tool.pick(pickerOf({ building: a, road })));
    tool.dragOver(tool.pick(pickerOf({ road })));
    tool.dragOver(tool.pick(pickerOf({ building: a, road })));
    tool.dragOver(tool.pick(pickerOf({ building: b })));
    tool.dragOver(tool.pick(pickerOf({ building: c, road })));
    expect(tool.preview(null)).toMatchObject({ kind: "building", ids: [a, b, c], ok: true });
    tool.dragEnd();
    await apply();
    expect(sent).toEqual([{ type: "BulldozeBuilding", payload: { buildings: want } }]);
    expect(liveBuildings(copy())).toEqual(before.filter((id) => id !== a && id !== b && id !== c));
    expect(((copy().roads.segFlags[road] ?? 0) & 1) !== 0).toBe(true);
    expect(copy().log.length).toBe(log + 1);
  });

  it("checks a split drag's whole price against the treasury, though each part alone would fit (M4-16)", async () => {
    const was = BUILDINGS_BALANCE.bulldozeMaxBuildings;
    BUILDINGS_BALANCE.bulldozeMaxBuildings = 1;
    try {
      const { tool, apply, copy, sim, sent, ui } = setup(houseCity());
      tool.toggle();
      const lived = housesWestToEast(copy()).filter((id) => popsIn(sim, id) > 0);
      const [a, b] = lived;
      if (a === undefined || b === undefined) throw new Error("too few lived-in houses");
      const one = tool.preview({ kind: "building", id: a });
      if (!one) throw new Error("no preview");
      // Enough for either house, not both.
      fundCity(sim, Math.ceil(one.cost * 1.5) - ECONOMY.overdraft);
      await apply();
      tool.dragStart();
      for (const id of [a, b]) tool.dragOver(tool.pick(pickerOf({ building: id })));
      const both = tool.preview(null);
      expect(both?.split).toBe(true);
      expect(both?.ok).toBe(true);
      expect(available(copy())).toBeGreaterThan(one.cost);
      expect(both?.refusal).toBe(costsReason(both?.cost ?? 0, available(copy())));
      // Let go, it sends nothing: each part alone would apply, and the drag would stop part way, its
      // first owners paid (M4 review, #456).
      const standing = liveBuildings(copy());
      const treasury = copy().budget.treasury;
      tool.dragEnd();
      await apply();
      expect(sent).toEqual([]);
      expect(ui().bulldozeNote).toBe(both?.refusal);
      expect(liveBuildings(copy())).toEqual(standing);
      expect(copy().budget.treasury).toBe(treasury);
    } finally {
      BUILDINGS_BALANCE.bulldozeMaxBuildings = was;
    }
  });

  it("splits a drag over more buildings than one command may name, and the sim applies them a step apart (issue #353)", async () => {
    const was = BUILDINGS_BALANCE.bulldozeMaxBuildings;
    BUILDINGS_BALANCE.bulldozeMaxBuildings = 2;
    try {
      const { tool, apply, tick, settle, sent, copy, ui } = setup(houseCity());
      tool.toggle();
      const [a, b, c] = housesWestToEast(copy());
      const before = liveBuildings(copy());
      const log = copy().log.length;
      const want = [a, b, c].map((id) => seen(copy(), id ?? NONE));
      tool.dragStart();
      for (const id of [a, b, c]) tool.dragOver(tool.pick(pickerOf({ building: id })));
      // The tag counts the whole drag, though no one command may name it.
      expect(tool.preview(null)).toMatchObject({ kind: "building", ids: [a, b, c], ok: true, buildings: [a, b, c].sort((p, q) => (p ?? 0) - (q ?? 0)) });
      tool.dragEnd();
      await apply();
      expect(sent).toEqual([
        { type: "BulldozeBuilding", payload: { buildings: want.slice(0, 2) } },
        { type: "BulldozeBuilding", payload: { buildings: want.slice(2) } },
      ]);
      // One a step: the first is in, the second waits, and the drag stays marked until both answer.
      expect(liveBuildings(copy())).toEqual(before.filter((id) => id !== a && id !== b));
      expect(ui().bulldozePending).toHaveLength(1);
      tick();
      await settle();
      expect(liveBuildings(copy())).toEqual(before.filter((id) => id !== a && id !== b && id !== c));
      expect(ui().bulldozePending).toEqual([]);
      expect(ui().bulldozeNote).toBeNull();
      expect(copy().log.length).toBe(log + 2);
    } finally {
      BUILDINGS_BALANCE.bulldozeMaxBuildings = was;
    }
  });

  it("a drag that starts on a road takes roads, and the buildings on them go with it", async () => {
    const state = houseCity();
    const seq = { n: 100 };
    // A second street, east of the first, with nothing on it.
    run(state, "BuildRoad", { from: { x: 4392, z: 4600 }, to: { x: 4500, z: 4600 }, type: "street" }, seq);
    const { tool, apply, sent, copy } = setup(state);
    tool.toggle();
    const west = street(copy());
    let east = NONE;
    for (let s = 0; s < copy().roads.segFlags.length; s++) if (s !== west && ((copy().roads.segFlags[s] ?? 0) & 1) !== 0 && copy().roads.nodeX[copy().roads.segB[s] ?? 0] === 4500) east = s;
    const house = housesWestToEast(copy())[0] ?? NONE;
    tool.dragStart();
    tool.dragOver(tool.pick(pickerOf({ road: west })));
    // Once it has a kind, a building under the pointer is passed over.
    tool.dragOver(tool.pick(pickerOf({ building: house, road: west })));
    tool.dragOver(tool.pick(pickerOf({ road: east })));
    expect(tool.preview(null)).toMatchObject({ kind: "road", ids: [west, east], buildings: housesWestToEast(copy()).sort((p, q) => p - q) });
    tool.dragEnd();
    await apply();
    expect(sent.map((c) => c.type)).toEqual(["BulldozeRoad"]);
    expect(liveBuildings(copy())).toEqual([]);
  });

  it("with Buildings off, a drag along a road passes over the buildings", () => {
    const { tool, copy, ui } = setup(houseCity());
    tool.toggle();
    tool.toggleFilter("building");
    const road = street(copy());
    const house = housesWestToEast(copy())[0] ?? NONE;
    tool.dragStart();
    tool.dragOver(tool.pick(pickerOf({ building: house, road })));
    expect(ui().bulldozeDrag).toEqual({ kind: "road", ids: [road] });
  });

  it("reads a fixed road as one that cannot be removed, and a click sends nothing", () => {
    const state = houseCity();
    // The outside connections' stubs are fixed: take one.
    let stub = NONE;
    for (let s = 0; s < state.roads.segFlags.length; s++) if (((state.roads.segFlags[s] ?? 0) & SEG_FIXED) !== 0) stub = s;
    expect(stub).not.toBe(NONE);
    const { tool, sent, ui } = setup(state);
    tool.toggle();
    expect(tool.preview({ kind: "road", id: stub })).toMatchObject({ ok: false, fixed: true, reason: "This road is fixed and cannot be removed" });
    tool.click({ kind: "road", id: stub });
    expect(sent).toEqual([]);
    expect(ui().bulldozeNote).toBe("This road is fixed and cannot be removed");
    // A drag leaves it out rather than refusing everything.
    tool.dragStart();
    tool.dragOver({ kind: "road", id: stub });
    expect(ui().bulldozeDrag).toEqual({ kind: null, ids: [] });
  });

  it("refuses a building that changed after the player picked it, and removes nothing", async () => {
    const { tool, apply, copy, join, ui } = setup(houseCity());
    const other = join("p2");
    tool.toggle();
    const house = housesWestToEast(copy())[0] ?? NONE;
    const before = liveBuildings(copy());
    // Another player clears it in the same step, first.
    void other.sendCommand("BulldozeBuilding", { buildings: [seen(copy(), house)] });
    tool.click({ kind: "building", id: house });
    // One clear a tick (`cellCommandsPerTick`, M2 review #147): the player's is checked, and dropped, on the next.
    await apply();
    await apply();
    expect(ui().bulldozeNote).toBe(BUILDING_CHANGED);
    expect(liveBuildings(copy())).toEqual(before.filter((id) => id !== house));
  });

  it("refuses a road another player's crossing split first (issue 94)", async () => {
    const { tool, apply, copy, join, ui } = setup(houseCity());
    const other = join("p2");
    tool.toggle();
    const road = street(copy());
    void other.sendCommand("BuildRoad", { from: { x: 4300, z: 4650 }, to: { x: 4300, z: 4700 }, type: "street" });
    void other.sendCommand("BuildRoad", { from: { x: 4300, z: 4600 }, to: { x: 4300, z: 4650 }, type: "street" });
    tool.click({ kind: "road", id: road });
    await apply();
    expect(ui().bulldozeNote).toBe(SEGMENT_CHANGED);
    expect(segmentTypeId(copy().roads, road)).toBe("street");
  });

  it("passes over a building a sent bulldoze takes, so a second click before the step sends nothing", async () => {
    const { tool, apply, sent, copy, ui } = setup(houseCity());
    tool.toggle();
    const house = housesWestToEast(copy())[0] ?? NONE;
    const road = street(copy());
    tool.click({ kind: "building", id: house });
    expect(tool.pick(pickerOf({ building: house, road }))).toEqual({ kind: "road", id: road });
    expect(tool.preview({ kind: "building", id: house })).toBeNull();
    tool.click({ kind: "building", id: house });
    await apply();
    expect(sent).toHaveLength(1);
    expect(ui().bulldozeNote).toBeNull();
  });

  it("drops a drag on Escape, and leaves the tool on a second", () => {
    const { tool, copy, ui, sent } = setup(houseCity());
    tool.toggle();
    expect(ui().tool).toBe("bulldoze");
    tool.dragStart();
    tool.dragOver({ kind: "building", id: housesWestToEast(copy())[0] ?? NONE });
    expect(tool.escape()).toBe(true);
    expect(ui().bulldozeDrag).toBeNull();
    tool.dragEnd();
    expect(sent).toEqual([]);
    expect(tool.escape()).toBe(true);
    expect(ui().tool).toBeNull();
    expect(tool.escape()).toBe(false);
  });
});

describe("building picking", () => {
  const box = { extent: { minX: -5, maxX: 5, minY: 0, maxY: 8, minZ: -10, maxZ: 10 }, x: 100, y: 20, z: 200, angle: Math.PI / 2, sx: 1, sz: 1 };

  it("finds where a ray enters a turned box", () => {
    // Turned a quarter, the box is 20 m along x and 10 m along z.
    expect(rayBoxDistance({ ox: 100, oy: 100, oz: 200, dx: 0, dy: -1, dz: 0 }, box)).toBeCloseTo(72);
    expect(rayBoxDistance({ ox: 109, oy: 100, oz: 200, dx: 0, dy: -1, dz: 0 }, box)).toBeCloseTo(72);
    expect(rayBoxDistance({ ox: 100, oy: 100, oz: 207, dx: 0, dy: -1, dz: 0 }, box)).toBeNull();
    // From the side, low: it meets the wall at x = 90.
    expect(rayBoxDistance({ ox: 50, oy: 24, oz: 200, dx: 1, dy: 0, dz: 0 }, box)).toBeCloseTo(40);
    // Pointing away.
    expect(rayBoxDistance({ ox: 50, oy: 24, oz: 200, dx: -1, dy: 0, dz: 0 }, box)).toBeNull();
  });

  it("picks the house a ray from above lands on, the nearer of two a low ray crosses, and nothing over the road", () => {
    const state = houseCity();
    const layer = createBuildingLayer(new Scene(), { buildingsInChunk: (c) => buildingsInChunk(state, c).flatMap((id) => buildingInfo(state, id) ?? []), buildingChunk: (id) => buildingInfo(state, id)?.chunk ?? -1 }, NORTH_AMERICAN, (x, z) => heightAt(terrain, x, z));
    layer.reset();
    layer.update({ x: 4300, z: 4560 }, 1000);
    for (let k = 0; k < 1000 && (layer.stats().pending > 0 || layer.stats().waiting > 0); k++) layer.update({ x: 4300, z: 4560 }, 1000);
    const [a, b] = housesWestToEast(state);
    const topA = layer.topOf(a ?? NONE);
    const topB = layer.topOf(b ?? NONE);
    if (!topA || !topB) throw new Error("houses not drawn");
    expect(layer.pick({ ox: topA.x, oy: topA.y + 50, oz: topA.z, dx: 0, dy: -1, dz: 0 })).toBe(a);
    // From the west, level through both houses: the western one is in front.
    const y = Math.min(topA.y, topB.y) - 1;
    expect(layer.pick({ ox: topA.x - 200, oy: y, oz: (topA.z + topB.z) / 2, dx: 1, dy: 0, dz: 0 })).toBe(a);
    // Stopped short of the house, as where the ground under the pointer is in front of it, it picks nothing.
    expect(layer.pick({ ox: topA.x, oy: topA.y + 50, oz: topA.z, dx: 0, dy: -1, dz: 0 }, 40)).toBe(-1);
    // Straight down onto the street.
    const g = heightAt(terrain, 4300, 4600);
    expect(layer.pick({ ox: 4300, oy: g + 100, oz: 4600, dx: 0, dy: -1, dz: 0 })).toBe(-1);
  });
});
