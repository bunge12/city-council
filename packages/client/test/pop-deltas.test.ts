// M3-05: people and statistics in the protocol and the mirror. The same
// SimHost the worker runs, over an in-memory transport, on a street the
// grower has built. Most tests change pops on the host's state between
// steps, as a system would; the last lets newcomers arrive in play (M3-08).
import { describe, expect, it } from "vitest";
import {
  CONNECTION_BALANCE,
  NONE,
  NO_WORK,
  connectionEnd,
  PROTOCOL_VERSION,
  STAT_TOTALS,
  addPop,
  buildingCount,
  buildingIdLimit,
  buildingJobs,
  buildingPeople,
  createState,
  hashMirrored,
  hashState,
  isBuilding,
  isPop,
  jobsFilled,
  nextInt,
  popIdLimit,
  popSizeCap,
  popWorkers,
  recountTotals,
  removePop,
  seedRng,
  setPopProfile,
  setPopSize,
  setPopWork,
  step,
  submit,
  type FromSimMessage,
  type SimState,
} from "@city-council/sim";
import { holdDemandBars } from "../src/protocol/held-demand";
import { SimHost } from "../src/protocol/host";
import { SimMirror, type MirrorUpdate } from "../src/protocol/mirror";
import { memoryTransportPair, type ClientTransport } from "../src/protocol/transport";

const SEED = 2026;

function run(state: SimState, type: string, payload: unknown, seq: { n: number }): void {
  const result = submit(state, { seq: ++seq.n, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
}

/** A street zoned R1 on its north side and C1 on its south, grown until homes and shops both stand. */
function city(): SimState {
  const state = createState(SEED);
  const seq = { n: 0 };
  run(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" }, seq);
  run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] }, seq);
  run(state, "ZoneCells", { zone: "commercial", density: 1, rects: [{ from: { x: 4202, z: 4629 }, to: { x: 4390, z: 4629 }, width: 44 }] }, seq);
  // Shops need commercial demand, which a city with no residents lacks (M3-07).
  const release = holdDemandBars(100);
  try {
    for (let t = 0; t < 6000 && (homes(state).length < 4 || workplaces(state).length < 2); t++) step(state);
  } finally {
    release();
  }
  if (homes(state).length < 4 || workplaces(state).length < 2) throw new Error("the buildings did not grow");
  return state;
}

function liveBuildings(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < buildingIdLimit(state.buildings); id++) if (isBuilding(state.buildings, id)) out.push(id);
  return out;
}

const homes = (state: SimState) => liveBuildings(state).filter((id) => (state.buildings.residents[id] ?? 0) > 0);
const workplaces = (state: SimState) => liveBuildings(state).filter((id) => buildingJobs(state.buildings, id) > 0);

function livePops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < popIdLimit(state.pops); id++) if (isPop(state.pops, id)) out.push(id);
  return out;
}

function setup(state: SimState) {
  const pair = memoryTransportPair();
  // Sits between the host and the mirror so a test can lose a message.
  let drop: (m: FromSimMessage) => boolean = () => false;
  const client: ClientTransport = { send: (m) => pair.client.send(m), onMessage: (handler) => pair.client.onMessage((m) => void (drop(m) || handler(m))) };
  const received: FromSimMessage[] = [];
  pair.client.onMessage((m) => void received.push(m));
  const host = new SimHost(state, pair.host, () => 0);
  host.hold();
  const mirror = new SimMirror(client, "p1");
  const updates: MirrorUpdate[] = [];
  mirror.subscribe((u) => updates.push(u));
  return { host, hostEnd: pair.host, mirror, received, updates, setDrop: (f: typeof drop) => (drop = f) };
}

/** The mirror's totals and every building's numbers against the host's. */
function expectLevel(mirror: SimMirror, state: SimState, label: string): void {
  const copy = mirror.state;
  if (!copy) throw new Error("no snapshot");
  expect(copy.stats.totals, label).toEqual(state.stats.totals);
  expect(Object.keys(copy.stats.totals), label).toEqual(STAT_TOTALS);
  expect(copy.stats.highestPopulation, label).toBe(state.stats.highestPopulation);
  const limit = Math.max(buildingIdLimit(state.buildings), buildingIdLimit(copy.buildings as SimState["buildings"]));
  for (let id = 0; id < limit; id++) {
    expect(mirror.buildingPeople(id), `${label}: people in ${id}`).toBe(buildingPeople(state, id));
    expect(mirror.jobsFilled(id), `${label}: jobs filled at ${id}`).toBe(jobsFilled(state, id));
  }
  expect(hashMirrored(copy), label).toBe(hashMirrored(state));
}

/** One change of a pop, picked by `rng`, as a system would make it. Returns false if the sim refused it, changing nothing. */
function changeOne(state: SimState, rng: Uint32Array): boolean {
  const pops = livePops(state);
  const roll = nextInt(rng, 10);
  try {
    if (roll < 3 || pops.length === 0) {
      const home = homes(state)[nextInt(rng, homes(state).length)] ?? 0;
      const room = (state.buildings.residents[home] ?? 0) - buildingPeople(state, home);
      const cap = Math.min(popSizeCap(state.buildings.density[home] ?? 1), room);
      if (cap < 1) return false;
      addPop(state, { home, size: 1 + nextInt(rng, cap), education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2), satisfaction: 50 });
      return true;
    }
    const pop = pops[nextInt(rng, pops.length)] ?? 0;
    if (roll < 6) {
      const work = nextInt(rng, 4) === 0 ? NO_WORK : (workplaces(state)[nextInt(rng, workplaces(state).length)] ?? NO_WORK);
      if (work !== NO_WORK && popWorkers(state.pops, pop) === 0) return false;
      setPopWork(state, pop, work);
    } else if (roll < 7) setPopSize(state, pop, 1 + nextInt(rng, 4));
    else if (roll < 8) setPopProfile(state, pop, { education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2) });
    else removePop(state, pop);
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

describe("people and statistics in deltas", () => {
  it("keeps the mirror's totals and every building's people and jobs filled level with the sim's after every delta", () => {
    const state = city();
    const { host, mirror, received, updates } = setup(state);
    expect(mirror.state && hashState(mirror.state)).toBe(hashState(state));
    const rng = seedRng(172);
    let added = 0;
    let removed = 0;
    let moved = 0;
    for (let round = 0; round < 400; round++) {
      const before = livePops(state).length;
      const jobsBefore = state.stats.totals["workersEmployed"];
      const changes = nextInt(rng, 4);
      for (let c = 0; c < changes; c++) changeOne(state, rng);
      const after = livePops(state).length;
      if (after > before) added++;
      if (after < before) removed++;
      if (state.stats.totals["workersEmployed"] !== jobsBefore) moved++;
      const deltas = received.length;
      host.advance(1);
      // One delta a step, and the mirror took it.
      expect(received.length).toBe(deltas + 1);
      const update = updates.at(-1);
      expect(update?.kind).toBe("delta");
      expectLevel(mirror, state, `round ${round}`);
    }
    expect(buildingCount(state.buildings)).toBeGreaterThan(0);
    expect(livePops(state).length).toBeGreaterThan(0);
    expect([added, removed, moved].every((n) => n > 20), `added ${added}, removed ${removed}, moved ${moved}`).toBe(true);
    // The running totals the mirror holds are the sim's, and those are the pops' own.
    expect(mirror.state?.stats.totals).toEqual(recountTotals(state));
    // Pop rows never travelled: the copy's table is the first snapshot's, which had none.
    expect(mirror.state?.pops.flags.length).toBe(0);
    expect(received.some((m) => m.type === "delta" && "pops" in m)).toBe(false);
  });

  it("names the buildings and totals a delta changed, and sends only the totals that changed", () => {
    const state = city();
    // Every bar below zero from here, so no building grows and only the pops move the totals.
    const release = holdDemandBars(-100);
    try {
      namesWhatChanged(state);
    } finally {
      release();
    }
  });

  function namesWhatChanged(state: SimState): void {
    const { host, mirror, received, updates } = setup(state);
    const [home] = homes(state);
    const [shop] = workplaces(state);
    if (home === undefined || shop === undefined) throw new Error("no buildings");
    host.advance(1);
    const pop = addPop(state, { home, size: 1, education: 1, wealth: 2, children: 0, satisfaction: 50 });
    host.advance(1);
    let delta = received.at(-1);
    let update = updates.at(-1);
    expect(delta?.type === "delta" && [...(delta.people?.ids ?? [])]).toEqual([home]);
    expect(update?.kind === "delta" && update.peopleIds).toEqual([home]);
    const moved = ["population", "pops", "residentsDensity1", "residentsEducationMedium", "residentsWealthHigh", "residentSatisfaction", "workersUnemployed"];
    expect(update?.kind === "delta" && [...update.statTotals].sort()).toEqual(moved.sort());
    expect(delta?.type === "delta" && Object.keys(delta.stats.totals).sort()).toEqual(moved.sort());
    expect(mirror.buildingPeople(home)).toBe(1);

    setPopWork(state, pop, shop);
    host.advance(1);
    update = updates.at(-1);
    expect(update?.kind === "delta" && update.peopleIds).toEqual([shop]);
    expect(mirror.jobsFilled(shop)).toBe(jobsFilled(state, shop));

    // A pop that leaves a home another then takes, the same size and the
    // same profile, leaves every number where it was: nothing to send.
    setPopWork(state, pop, NO_WORK);
    removePop(state, pop);
    addPop(state, { home, size: 1, education: 1, wealth: 2, children: 0, satisfaction: 50 });
    host.advance(1);
    delta = received.at(-1);
    expect(delta?.type === "delta" && delta.people && [...delta.people.ids]).toEqual([shop]);
    expect(delta?.type === "delta" && Object.keys(delta.stats.totals).sort()).toEqual(["filledCommercial", "workersEmployed", "workersUnemployed"].sort());
    expectLevel(mirror, state, "after the swap");

    // A step that touches no pop sends no people and no totals.
    host.advance(1);
    delta = received.at(-1);
    expect(delta?.type === "delta" && delta.people).toBeUndefined();
    expect(delta?.type === "delta" && delta.stats.totals).toEqual({});
  }

  it("asks for a snapshot when a delta goes missing, and comes back equal, people and all", () => {
    const state = city();
    const { host, mirror, received, updates, setDrop } = setup(state);
    const rng = seedRng(5);
    for (let i = 0; i < 40; i++) changeOne(state, rng);
    host.advance(1);
    expectLevel(mirror, state, "before the loss");

    // The next delta is lost on the way, with pops changed in it.
    setDrop((m) => m.type === "delta");
    for (let i = 0; i < 20; i++) changeOne(state, rng);
    host.advance(1);
    setDrop(() => false);
    for (let i = 0; i < 20; i++) changeOne(state, rng);
    const asked = received.length;
    host.advance(1);
    // The mirror saw the gap and asked, and the host answered with a snapshot.
    expect(received.slice(asked).map((m) => m.type)).toEqual(["delta", "snapshot"]);
    expect(updates.at(-1)).toEqual({ kind: "snapshot" });
    // Straight after a snapshot the copy is the sim's in full, pop table included.
    expect(mirror.state && hashState(mirror.state)).toBe(hashState(state));
    expectLevel(mirror, state, "after the snapshot");
    // And deltas carry on from it.
    for (let i = 0; i < 20; i++) changeOne(state, rng);
    host.advance(1);
    expect(updates.at(-1)?.kind).toBe("delta");
    expectLevel(mirror, state, "after the snapshot's first delta");
  });

  it("asks for a snapshot when a delta's people do not fit", () => {
    const state = city();
    const { host, hostEnd, mirror, received } = setup(state);
    host.advance(1);
    const last = received.at(-1);
    if (last?.type !== "delta" || !mirror.state) throw new Error("no delta");
    const asked = received.length;
    const bad: FromSimMessage = {
      ...last,
      seq: last.seq + 1,
      logFrom: last.logFrom + last.log.length,
      log: [],
      people: { ids: Int32Array.of(3, 1), people: Int32Array.of(1, 1), filled: Int32Array.of(0, 0) },
    };
    hostEnd.send(bad);
    // The bad delta itself, then the snapshot the mirror asked for.
    expect(received.slice(asked).map((m) => m.type)).toEqual(["delta", "snapshot"]);
    expect(bad.v).toBe(PROTOCOL_VERSION);
  });
});

describe("newcomers in play (M3-08)", () => {
  /** A street from the first outside connection's stub and one joined to nothing, both zoned R1 on one side. */
  function twoStreets(): SimState {
    const state = createState(SEED);
    const seq = { n: 0 };
    const r = state.roads;
    const edge = state.connections[0] ?? NONE;
    const inner = connectionEnd(r, edge);
    const x = r.nodeX[inner] ?? 0;
    const z = r.nodeZ[inner] ?? 0;
    const dx = (x - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
    const dz = (z - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
    run(state, "BuildRoad", { from: { x, z }, to: { x: x + dx * 128, z: z + dz * 128 }, type: "street" }, seq);
    const off = 5 + 24;
    run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: x + dx * 2 - dz * off, z: z + dz * 2 + dx * off }, to: { x: x + dx * 126 - dz * off, z: z + dz * 126 + dx * off }, width: 44 }] }, seq);
    run(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" }, seq);
    run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] }, seq);
    return state;
  }

  it("brings newcomers' people to the mirror, and the mirror says why homes on a street joined to nothing stay empty", () => {
    const state = twoStreets();
    const { host, mirror } = setup(state);
    for (let round = 0; round < 60; round++) {
      host.advance(25);
      expectLevel(mirror, state, `round ${round}`);
    }
    expect(livePops(state).length).toBeGreaterThan(5);
    const empty = homes(state).filter((id) => buildingPeople(state, id) === 0);
    const full = homes(state).filter((id) => buildingPeople(state, id) > 0);
    expect(full.length).toBeGreaterThan(3);
    // Homes on the street joined to nothing stand empty, and say why.
    const cutOff = empty.filter((id) => mirror.whyNoNewcomers(id) === "noRoute");
    expect(cutOff.length).toBeGreaterThan(3);
    for (const id of cutOff) expect(mirror.buildingPeople(id)).toBe(0);
    for (const id of full) expect(mirror.whyNoNewcomers(id)).toBeNull();
    // Held below zero, every joined home waits for demand.
    const release = holdDemandBars(-50);
    try {
      host.advance(1);
    } finally {
      release();
    }
    for (const id of full) expect(mirror.whyNoNewcomers(id)).toBe("noDemand");
    expect(mirror.state?.stats.year.arrivals).toBe(state.stats.totals["population"]);
  });
});
