import { describe, expect, it } from "vitest";
import { cloneState, createBareState } from "../src/state";
import { hashState } from "../src/index";
import {
  LEVEL_BRIDGE,
  NETWORK_RAIL,
  NODE_FIXED,
  NONE,
  addNode,
  addSegment,
  capacityOf,
  checkRoadNetwork,
  createRoadNetwork,
  curveLength,
  isNode,
  isSegment,
  nodeCount,
  otherEnd,
  removeNode,
  removeSegment,
  segmentCount,
  segmentsAt,
  type RoadNetwork,
} from "../src/roads/network";
import { ROAD_BALANCE, ROAD_TYPES, checkRoadBalance, escalate, resolveRoadTypes, roadTypeIndex } from "../src/roads/balance";

/** Three nodes in an L, joined by two segments. */
function lShape(): { net: RoadNetwork; a: number; b: number; c: number; ab: number; bc: number } {
  const net = createRoadNetwork();
  const a = addNode(net, 0, 0, 10);
  const b = addNode(net, 300, 0, 12);
  const c = addNode(net, 300, 400, 15);
  const ab = addSegment(net, a, b, { type: 0 });
  const bc = addSegment(net, b, c, { type: 1 });
  return { net, a, b, c, ab, bc };
}

describe("road network nodes", () => {
  it("adds nodes with their position, height and fixed flag", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 12.5, -3, 40.25);
    const b = addNode(net, 100, 200, 0, true);
    expect([a, b]).toEqual([0, 1]);
    expect([net.nodeX[a], net.nodeZ[a], net.nodeHeight[a]]).toEqual([12.5, -3, 40.25]);
    expect((net.nodeFlags[a] ?? 0) & NODE_FIXED).toBe(0);
    expect((net.nodeFlags[b] ?? 0) & NODE_FIXED).toBe(NODE_FIXED);
    expect(nodeCount(net)).toBe(2);
    expect(segmentsAt(net, a)).toEqual([]);
  });

  it("removes a node and zeroes its fields", () => {
    const net = createRoadNetwork();
    addNode(net, 1, 2, 3);
    const b = addNode(net, 4, 5, 6);
    removeNode(net, b);
    expect(isNode(net, b)).toBe(false);
    expect(nodeCount(net)).toBe(1);
    expect([net.nodeX[b], net.nodeZ[b], net.nodeHeight[b], net.nodeFlags[b], net.nodeFirstSeg[b]]).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses to remove a fixed node, a node with segments or a missing one", () => {
    const { net, a } = lShape();
    const fixed = addNode(net, 0, 0, 0, true);
    expect(() => removeNode(net, fixed)).toThrow(/fixed/);
    expect(() => removeNode(net, a)).toThrow(/still has segments/);
    expect(() => removeNode(net, 99)).toThrow(/does not exist/);
    removeNode(net, addNode(net, 0, 0, 0));
    expect(() => removeNode(net, 4)).toThrow(/does not exist/);
  });

  it("refuses positions that are not finite", () => {
    const net = createRoadNetwork();
    expect(() => addNode(net, NaN, 0, 0)).toThrow(RangeError);
    expect(() => addNode(net, 0, Infinity, 0)).toThrow(RangeError);
    expect(nodeCount(net)).toBe(0);
  });
});

describe("road network segments", () => {
  it("adds a segment with its nodes, type, network, level and length", () => {
    const { net, a, b, ab } = lShape();
    expect([net.segA[ab], net.segB[ab]]).toEqual([a, b]);
    expect(net.segType[ab]).toBe(0);
    expect(net.segLength[ab]).toBe(300);
    expect([net.segCX[ab], net.segCZ[ab]]).toEqual([150, 0]);
    const rail = addSegment(net, a, b, { type: 0, network: NETWORK_RAIL, level: LEVEL_BRIDGE });
    expect([net.segNetwork[rail], net.segLevelA[rail]]).toEqual([NETWORK_RAIL, LEVEL_BRIDGE]);
  });

  it("measures a curve longer than the straight line between its ends", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 0, 0, 0);
    const b = addNode(net, 200, 0, 0);
    const s = addSegment(net, a, b, { type: 0, cx: 100, cz: 100 });
    // The true arc length is about 229.6 m; a 16-piece polyline is within half a metre.
    expect(net.segLength[s]).toBeGreaterThan(229);
    expect(net.segLength[s]).toBeLessThan(229.6);
    expect(curveLength(0, 0, 50, 0, 100, 0)).toBe(100);
  });

  it("lists the segments at a node, newest first", () => {
    const { net, a, b, c, ab, bc } = lShape();
    expect(segmentsAt(net, b)).toEqual([bc, ab]);
    expect(segmentsAt(net, a)).toEqual([ab]);
    expect(segmentsAt(net, c)).toEqual([bc]);
    expect(otherEnd(net, ab, b)).toBe(a);
    expect(otherEnd(net, bc, b)).toBe(c);
  });

  it("removes a segment from both of its nodes' lists and keeps the nodes", () => {
    const { net, a, b, c, ab, bc } = lShape();
    const ac = addSegment(net, a, c, { type: 2 });
    removeSegment(net, ab);
    expect(isSegment(net, ab)).toBe(false);
    expect(segmentsAt(net, a)).toEqual([ac]);
    expect(segmentsAt(net, b)).toEqual([bc]);
    expect(isNode(net, a) && isNode(net, b)).toBe(true);
    expect(segmentCount(net)).toBe(2);
    removeSegment(net, bc);
    removeNode(net, b);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("refuses a segment to a missing node, a loop, or an unknown type, network or level", () => {
    const { net, a, b } = lShape();
    expect(() => addSegment(net, a, 9, { type: 0 })).toThrow(/does not exist/);
    expect(() => addSegment(net, a, a, { type: 0 })).toThrow(/start and end/);
    expect(() => addSegment(net, a, b, { type: ROAD_TYPES.length })).toThrow(/road type/);
    expect(() => addSegment(net, a, b, { type: 0, network: 3 })).toThrow(/network/);
    expect(() => addSegment(net, a, b, { type: 0, level: 5 })).toThrow(/level/);
    expect(() => addSegment(net, a, b, { type: 0, cx: 1 })).toThrow(/cx and cz/);
    expect(segmentCount(net)).toBe(2);
  });
});

describe("road network id reuse", () => {
  it("reuses removed node ids last removed, first reused", () => {
    const net = createRoadNetwork();
    for (let i = 0; i < 5; i++) addNode(net, i, 0, 0);
    removeNode(net, 1);
    removeNode(net, 3);
    removeNode(net, 2);
    expect(addNode(net, 0, 0, 0)).toBe(2);
    expect(addNode(net, 0, 0, 0)).toBe(3);
    expect(addNode(net, 0, 0, 0)).toBe(1);
    expect(addNode(net, 0, 0, 0)).toBe(5);
  });

  it("reuses removed segment ids last removed, first reused", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 0, 0, 0);
    const b = addNode(net, 1, 0, 0);
    const ids = Array.from({ length: 4 }, () => addSegment(net, a, b, { type: 0 }));
    expect(ids).toEqual([0, 1, 2, 3]);
    removeSegment(net, 0);
    removeSegment(net, 2);
    expect(addSegment(net, a, b, { type: 0 })).toBe(2);
    expect(addSegment(net, a, b, { type: 0 })).toBe(0);
    expect(addSegment(net, a, b, { type: 0 })).toBe(4);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("gives the same ids and hash for the same calls, whatever happened to the arrays in between", () => {
    const build = (roundTrip: boolean): RoadNetwork => {
      let net = createRoadNetwork();
      for (let i = 0; i < 40; i++) addNode(net, i, i, i);
      for (let i = 0; i < 40; i += 3) removeNode(net, i);
      if (roundTrip) net = cloneState({ ...createBareState(1), roads: net }).roads;
      for (let i = 0; i < 10; i++) addNode(net, -i, -i, 0);
      return net;
    };
    const plain = build(false);
    const cloned = build(true);
    expect(cloned).toEqual(plain);
    expect(hashState(cloned)).toBe(hashState(plain));
  });
});

describe("road network array growth", () => {
  it("doubles capacity when full and keeps every value", () => {
    const net = createRoadNetwork();
    const capacities = new Set<number>();
    for (let i = 0; i < 100; i++) {
      addNode(net, i * 2, i * 3, i / 4);
      capacities.add(capacityOf(net.nodeX));
    }
    expect([...capacities]).toEqual([16, 32, 64, 128]);
    expect(net.nodeX.length).toBe(100);
    for (let i = 0; i < 100; i++) expect([net.nodeX[i], net.nodeZ[i], net.nodeHeight[i]]).toEqual([i * 2, i * 3, i / 4]);
  });

  it("does not change the hash of the data the arrays hold", () => {
    // Same 16 nodes: one network is exactly full, the other has grown to 32
    // and then given the extra node back.
    const full = createRoadNetwork();
    const grown = createRoadNetwork();
    for (let i = 0; i < 16; i++) {
      addNode(full, i, 0, 0);
      addNode(grown, i, 0, 0);
    }
    const before = hashState(full);
    const extra = addNode(grown, 99, 99, 99);
    expect(capacityOf(grown.nodeX)).toBe(32);
    removeNode(grown, extra);
    // The removed id stays on the free list, so compare against a full
    // network that also has one free id.
    removeNode(full, addNode(full, 99, 99, 99));
    expect(capacityOf(full.nodeX)).toBe(32);
    expect(hashState(grown)).toBe(hashState(full));

    // And a grown network hashes like a fresh copy with no spare room.
    const copy = cloneState({ ...createBareState(1), roads: grown }).roads;
    expect(capacityOf(copy.nodeX)).toBe(copy.nodeX.length);
    expect(hashState(copy)).toBe(hashState(grown));
    expect(before).not.toBe(hashState(grown));
  });

  it("hashes a network built to a size the same as one built past it and trimmed by a copy", () => {
    const net = createRoadNetwork();
    for (let i = 0; i < 17; i++) addNode(net, i, 0, 0);
    const trimmed = cloneState({ ...createBareState(1), roads: net }).roads;
    expect(capacityOf(net.nodeX)).toBe(32);
    expect(capacityOf(trimmed.nodeX)).toBe(17);
    expect(hashState(trimmed)).toBe(hashState(net));
  });
});

describe("road network shape", () => {
  it("holds only typed arrays and the build order counter", () => {
    const { net } = lShape();
    for (const [key, value] of Object.entries(net)) {
      if (key === "segOrderNext") expect(Number.isSafeInteger(value)).toBe(true);
      else expect(ArrayBuffer.isView(value), key).toBe(true);
    }
    expect(() => hashState(net)).not.toThrow();
  });

  it("is checked: a broken list, a dangling node or a bad free list is caught", () => {
    const { net, ab } = lShape();
    expect(checkRoadNetwork(net)).toBeNull();
    expect(checkRoadNetwork({ ...net, segB: net.segB.slice() })).toBeNull();

    const dangling = { ...net, segB: net.segB.slice() };
    dangling.segB[ab] = 7;
    expect(checkRoadNetwork(dangling)).toMatch(/list is malformed|bad nodes/);

    const loop = { ...net, segNextA: net.segNextA.slice() };
    loop.segNextA[ab] = ab;
    expect(checkRoadNetwork(loop)).not.toBeNull();

    const free = { ...net, nodeFree: Int32Array.of(0) };
    expect(checkRoadNetwork(free)).toMatch(/free list/);

    const orphan = { ...net, nodeFlags: net.nodeFlags.slice() };
    orphan.nodeFlags[2] = 0;
    expect(checkRoadNetwork(orphan)).not.toBeNull();

    expect(checkRoadNetwork({ ...net, extra: new Uint8Array(0) })).toMatch(/unknown field/);
    expect(checkRoadNetwork({ ...net, nodeX: [0, 1, 2] })).toMatch(/Float64Array/);
    expect(net.nodeFirstSeg[0]).not.toBe(NONE);
  });
});

/** A deep copy of the balance file to break. */
function copyBalance(): typeof ROAD_BALANCE {
  return JSON.parse(JSON.stringify(ROAD_BALANCE)) as typeof ROAD_BALANCE;
}

describe("road balance", () => {
  it("has street, avenue, one-way and highway", () => {
    expect(ROAD_TYPES.map((t) => t.id)).toEqual(["street", "avenue", "oneWay", "highway"]);
    expect(roadTypeIndex("avenue")).toBe(1);
    expect(() => roadTypeIndex("canal")).toThrow();
    const byId = Object.fromEntries(ROAD_TYPES.map((t) => [t.id, t]));
    expect(byId["street"]?.lanes).toBe(2);
    expect(byId["avenue"]?.lanes).toBe(4);
    expect(byId["oneWay"]?.oneWay).toBe(true);
    expect(byId["highway"]?.zonable).toBe(false);
  });

  it("passes its own check", () => {
    expect(checkRoadBalance(ROAD_BALANCE)).toEqual([]);
  });

  it("brings every price to whole 2026 dollars", () => {
    for (const type of ROAD_TYPES) {
      expect(Number.isSafeInteger(type.buildCostPerMetre), type.id).toBe(true);
      expect(Number.isSafeInteger(type.upkeepPerMetrePerYear), type.id).toBe(true);
    }
    const esc = { ...ROAD_BALANCE.escalation, toYear: 2026, annualFactor: 1.5 };
    expect(escalate({ amount: 100, sourceYear: 2024, source: "x" }, esc)).toBe(225);
    expect(escalate({ amount: 100, sourceYear: 2026, source: "x" }, esc)).toBe(100);
    // The avenue starts from Phoenix's 2023 arterial figure.
    const avenue = ROAD_BALANCE.types[1];
    expect(avenue?.buildCostPerMetre.sourceYear).toBe(2023);
    expect(ROAD_TYPES[1]?.buildCostPerMetre).toBeGreaterThan(avenue?.buildCostPerMetre.amount ?? 0);
  });

  it("marks the street price as a placeholder", () => {
    expect(ROAD_BALANCE.types[0]?.buildCostPerMetre.placeholder).toBe(true);
  });

  it("fails when a road type is missing a field", () => {
    const fields = Object.keys(ROAD_BALANCE.types[0] ?? {});
    expect(fields.length).toBeGreaterThan(10);
    for (const field of fields) {
      const copy = copyBalance() as unknown as { types: Record<string, unknown>[] };
      delete copy.types[2]?.[field];
      expect(checkRoadBalance(copy).join(), field).toContain(`types[2].${field}`);
      expect(() => resolveRoadTypes(copy), field).toThrow(/balance\/roads.json/);
    }
  });

  it("fails when a price has no source year or no source", () => {
    for (const price of ["buildCostPerMetre", "upkeepPerMetrePerYear", "demolitionCostPerMetre"] as const) {
      for (const field of ["sourceYear", "source", "amount"]) {
        const copy = copyBalance() as unknown as { types: Record<string, Record<string, unknown>>[] };
        delete copy.types[1]?.[price]?.[field];
        expect(checkRoadBalance(copy).join()).toContain(`types[1].${price}.${field}`);
      }
    }
    const fractional = copyBalance();
    (fractional.types[0] as { buildCostPerMetre: { amount: number } }).buildCostPerMetre.amount = 1.5;
    expect(checkRoadBalance(fractional).join()).toMatch(/whole number of dollars/);
    const noEscalation = copyBalance() as unknown as Record<string, unknown>;
    delete noEscalation["escalation"];
    expect(checkRoadBalance(noEscalation)).toContain("escalation is missing");
  });
});
