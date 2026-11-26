import { describe, expect, it } from "vitest";
import {
  NONE,
  blockBudget,
  blockBudgets,
  blockBudgetsWith,
  budgetAreasOfSlots,
  cellShapesInChunk,
  areaBudget,
  blockIndexOf,
  blockOnSide,
  chunkBudget,
  roadUpkeepPerYear,
  segmentUpkeepPerYear,
  type SimState,
} from "../src/index";
import { BUILDING_TYPES } from "../src/buildings/balance";
import { buildingIdLimit } from "../src/buildings/buildings";
import { mayPay, shopSalesScale, yearlyTaxDue, type TaxByLine } from "../src/economy/tax";
import { buildingValues } from "../src/landvalue/land-value";
import { popIndexOf } from "../src/pops/where";
import { outsideReachByNode } from "../src/roads/outside";
import { segmentIdLimit } from "../src/roads/network";
import { CELL_RIGHT } from "../src/zoning/cells";
import { SPOTS, at, budgetTown, type Frame } from "./budget-town";

// Issue M4-18: each block's yearly tax less its share of the upkeep of the
// roads around it, and the same per chunk for open ground.


/** The smallest block round place (u, v) of the frame, or NONE. */
function blockNear(state: SimState, f: Frame, u: number, v: number): number {
  const p = at(f, u, v);
  const index = blockIndexOf(state.roads);
  let best = NONE;
  let bestArea = Infinity;
  for (const block of index.blocks.values()) {
    if (pointInBlock(state, block.segments, block.forward, p) && block.area < bestArea) {
      best = block.id;
      bestArea = block.area;
    }
  }
  return best;
}

function pointInBlock(state: SimState, segments: number[], forward: boolean[], p: { x: number; z: number }): boolean {
  const r = state.roads;
  let inside = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? 0;
    const a = forward[i] ? r.segA[seg] : r.segB[seg];
    const b = forward[i] ? r.segB[seg] : r.segA[seg];
    const ax = r.nodeX[a ?? 0] ?? 0;
    const az = r.nodeZ[a ?? 0] ?? 0;
    const bx = r.nodeX[b ?? 0] ?? 0;
    const bz = r.nodeZ[b ?? 0] ?? 0;
    if (az > p.z !== bz > p.z && p.x < ax + ((p.z - az) * (bx - ax)) / (bz - az)) inside = !inside;
  }
  return inside;
}

/** Every payer's yearly tax, summed, as the sweep would charge it on a visit today. */
function cityTax(state: SimState): number {
  const b = state.buildings;
  const index = popIndexOf(state);
  const reach = outsideReachByNode(state);
  const terms = { rates: state.budget.taxRates, salesScale: shopSalesScale(state.stats.totals), reachesOutside: false };
  const out: TaxByLine = [0, 0, 0, 0];
  let total = 0;
  for (let id = 0; id < buildingIdLimit(b); id++) {
    if (!mayPay(b.flags[id] ?? 0)) continue;
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    if (!type) continue;
    const home = (b.residents[id] ?? 0) > 0 && (index.people[id] ?? 0) > 0;
    const land = home ? (buildingValues(state, [id])[0] ?? 0) : null;
    yearlyTaxDue(state, id, type, index.filled[id] ?? 0, land, terms, reach, out);
    total += out[0] + out[1] + out[2] + out[3];
  }
  return total;
}

describe("the budget overlay's figures", () => {
  const { state, f } = budgetTown();
  const budgets = blockBudgets(state);

  it("gives a compact block of density 2 a net above zero and a block on a long cul-de-sac one below it", () => {
    const compact = blockNear(state, f, ...SPOTS.compact);
    const large = blockNear(state, f, ...SPOTS.large);
    expect(compact).not.toBe(NONE);
    expect(large).not.toBe(NONE);
    const c = blockBudget(budgets, compact);
    const l = blockBudget(budgets, large);
    expect(c?.tax).toBeGreaterThan(0);
    expect(c?.net).toBeGreaterThan(0);
    // The cul-de-sac's houses pay tax, and not enough for the roads round them.
    expect(l?.tax).toBeGreaterThan(0);
    expect(l?.net).toBeLessThan(0);
  });

  it("shows the spur on open ground in its chunk", () => {
    const end = at(f, ...SPOTS.spur);
    const chunk = Math.floor(end.z / 500) * 24 + Math.floor(end.x / 500);
    const open = chunkBudget(budgets, chunk);
    expect(open).not.toBeNull();
    expect(open?.upkeep).toBeGreaterThan(0);
    expect(open?.tax).toBeGreaterThan(0);
  });

  it("shares out the city's yearly tax less its road upkeep among the blocks and chunks, to the dollar", () => {
    let tax = 0;
    let upkeep = 0;
    for (let i = 0; i < budgets.blockTax.length; i++) {
      tax += budgets.blockTax[i] ?? 0;
      upkeep += budgets.blockUpkeep[i] ?? 0;
    }
    for (let i = 0; i < budgets.chunkTax.length; i++) {
      tax += budgets.chunkTax[i] ?? 0;
      upkeep += budgets.chunkUpkeep[i] ?? 0;
    }
    expect(tax).toBeGreaterThan(0);
    expect(tax).toBe(cityTax(state));
    expect(upkeep).toBe(roadUpkeepPerYear(state.roads));
    expect(budgets.tax).toBe(tax);
    expect(budgets.upkeep).toBe(upkeep);
    expect(tax - upkeep).toBe(cityTax(state) - roadUpkeepPerYear(state.roads));
  });

  it("splits a segment between two blocks half and half, and gives a one-sided segment all of it to its block", () => {
    const index = blockIndexOf(state.roads);
    let shared = 0;
    let oneSided = 0;
    for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) {
      const u = segmentUpkeepPerYear(state.roads, seg);
      if (u === 0) continue;
      const right = blockOnSide(index, seg, true);
      const left = blockOnSide(index, seg, false);
      if (right !== NONE && left !== NONE && right !== left) shared++;
      else if (right !== NONE || left !== NONE) oneSided++;
    }
    // The compact block and the shops' block share a side; the outer roads have a block on one side.
    expect(oneSided).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(0);
    const compactBlock = blockNear(state, f, ...SPOTS.compact);
    const shops = blockNear(state, f, ...SPOTS.shops);
    expect(shops).not.toBe(NONE);
    expect(shops).not.toBe(compactBlock);
    expect(blockBudget(budgets, shops)?.tax).toBeGreaterThan(0);
    // A building's tax goes to the block on the side its lot fronts.
    const b = state.buildings;
    const compact = blockNear(state, f, ...SPOTS.compact);
    let inCompact = 0;
    for (let id = 0; id < buildingIdLimit(b); id++) {
      if (!b.flags[id]) continue;
      if (blockOnSide(index, b.firstSeg[id] ?? NONE, b.firstSide[id] === CELL_RIGHT) === compact) inCompact++;
    }
    expect(inCompact).toBeGreaterThan(0);
  });

  it("gives the same figures from people and jobs filled passed in as from the sim's own", () => {
    const index = popIndexOf(state);
    const again = blockBudgetsWith(state, Array.from(index.people), Array.from(index.filled));
    expect(again.blocks).toEqual(budgets.blocks);
    expect(Array.from(again.blockTax)).toEqual(Array.from(budgets.blockTax));
    expect(Array.from(again.chunkUpkeep)).toEqual(Array.from(budgets.chunkUpkeep));
  });

  it("names each cell's area: the block its side of the road faces, or its chunk's open ground", () => {
    const compact = blockNear(state, f, ...SPOTS.compact);
    const inside = at(f, 14, 1);
    const chunk = Math.floor(inside.z / 500) * 24 + Math.floor(inside.x / 500);
    const shapes = cellShapesInChunk(state, chunk);
    const areas = budgetAreasOfSlots(state, shapes.slots, chunk);
    expect(areas.length).toBe(shapes.slots.length);
    expect([...areas]).toContain(compact);
    // Cells on open ground, such as those along the spur, name the chunk.
    expect([...areas]).toContain(-1 - chunk);
    expect(areaBudget(budgets, compact)).toEqual(blockBudget(budgets, compact));
    expect(areaBudget(budgets, -1 - chunk)).toEqual(chunkBudget(budgets, chunk));
  });
});
