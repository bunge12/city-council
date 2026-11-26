// The budget overlay's figures (M4-18, PRD "A budget overlay"): what each
// block pays the city a year, less what the roads around it cost to keep.
//
// A building's tax goes to the block its lot fronts: the block on its first
// cell's side of its first segment (roads/blocks.ts, `blockOnSide`). A
// through-lot fronts two roads of the same block, so the front lot names it.
// The tax is the yearly figure the TAX sweep charges on a visit
// (`yearlyTaxDue`): business tax on the jobs filled, and residential tax
// while people live there.
//
// A segment's upkeep (`segmentUpkeepPerYear`) is split between the blocks
// either side: half each, the odd dollar to the block on its left, so the
// shares stay whole and add up to the segment's figure. A segment with a
// block on one side only gives that block all of it, and a dead end inside
// a block, which has the block on both sides, gives it all to that block.
//
// Buildings and segments with no block, on open ground, are summed per
// 500 m chunk instead: a building by its lot centre's chunk, a segment by
// its middle's. So a cul-de-sac on open ground still shows, as part of its
// chunk's figure. A bridge or a tunnel bounds no block, so its upkeep goes
// to its chunk too.
//
// Every figure is derived on request from the blocks, the tax function and
// the upkeep function. Nothing of it is in state. The blocks' and chunks'
// figures together are the city's yearly tax less its road upkeep, to the
// dollar. Service upkeep joins each block's share in M8.
//
// People and jobs filled come in as arrays by building id, so a client's
// copy of state, which keeps them per building rather than as pop rows,
// gets the same figures as the sim (`blockBudgets` reads the sim's own).

import { BUILDING_TYPES } from "../buildings/balance";
import { buildingChunks } from "../buildings/where";
import { CHUNKS_PER_SIDE } from "../chunks";
import { buildingValues } from "../landvalue/land-value";
import { popIndexOf } from "../pops/where";
import { blockIndexOf, blockOnSide, listBlocks } from "../roads/blocks";
import { quadPoint, segmentQuad } from "../roads/curve";
import { NONE, segmentIdLimit } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { CELL_RIGHT, fromLocal, segmentOfSlot } from "../zoning/cells";
import { chunkAt } from "../zoning/cell-index";
import { mayPay, shopSalesScale, yearlyTaxDue, type BusinessTaxTerms, type TaxByLine } from "./tax";
import { segmentUpkeepPerYear } from "./upkeep";

/** One area's yearly figures, whole dollars. */
export interface AreaBudget {
  /** The yearly tax of the buildings in it. */
  tax: number;
  /** Its share of the yearly upkeep of the roads around it. */
  upkeep: number;
  /** Tax less upkeep. */
  net: number;
}

/** Every block's and chunk's yearly figures. Derived data: not state. */
export interface BlockBudgets {
  /** The ids of the blocks with a figure, ascending: every block. */
  blocks: number[];
  /** By block id: the yearly tax of its buildings, and its share of road upkeep. Zero for an id that is not a block. */
  blockTax: Float64Array;
  blockUpkeep: Float64Array;
  /** By chunk, as `chunkAt` numbers them: the yearly tax and road upkeep on open ground there. */
  chunkTax: Float64Array;
  chunkUpkeep: Float64Array;
  /** The city's yearly tax and road upkeep, which the blocks and chunks share out between them. */
  tax: number;
  upkeep: number;
}

/** Block `id`'s figures, or null when it is not a block. */
export function blockBudget(budgets: BlockBudgets, id: number): AreaBudget | null {
  if (!Number.isInteger(id) || id < 0 || id >= budgets.blockTax.length) return null;
  const tax = budgets.blockTax[id] ?? 0;
  const upkeep = budgets.blockUpkeep[id] ?? 0;
  if (tax === 0 && upkeep === 0 && !budgets.blocks.includes(id)) return null;
  return { tax, upkeep, net: tax - upkeep };
}

/** The figures of open ground in chunk `chunk`, or null for none there. */
export function chunkBudget(budgets: BlockBudgets, chunk: number): AreaBudget | null {
  const tax = budgets.chunkTax[chunk] ?? 0;
  const upkeep = budgets.chunkUpkeep[chunk] ?? 0;
  if (tax === 0 && upkeep === 0) return null;
  return { tax, upkeep, net: tax - upkeep };
}

/** Scratch reused between calls. Derived, never state. */
const homes: number[] = [];
const payers: number[] = [];
const yearly: TaxByLine = [0, 0, 0, 0];

/**
 * Every block's and open chunk's yearly tax and road upkeep, with
 * `people` and `filled` by building id: the people living in each and its
 * jobs filled, as the sim's pop index or a client's copy keeps them.
 */
export function blockBudgetsWith(state: SimState, people: ArrayLike<number>, filled: ArrayLike<number>): BlockBudgets {
  const net = state.roads;
  const index = blockIndexOf(net);
  const segLimit = segmentIdLimit(net);
  const chunkCount = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
  const out: BlockBudgets = {
    blocks: [],
    blockTax: new Float64Array(2 * segLimit),
    blockUpkeep: new Float64Array(2 * segLimit),
    chunkTax: new Float64Array(chunkCount),
    chunkUpkeep: new Float64Array(chunkCount),
    tax: 0,
    upkeep: 0,
  };
  out.blocks = listBlocks(index).map((block) => block.id);

  // ---- Tax, building by building ----
  const b = state.buildings;
  const { flags, residents } = b;
  homes.length = 0;
  payers.length = 0;
  for (let id = 0; id < flags.length; id++) {
    if (!mayPay(flags[id] ?? 0)) continue;
    const home = (residents[id] ?? 0) > 0 && (people[id] ?? 0) > 0;
    if (!home && (filled[id] ?? 0) <= 0) continue;
    payers.push(id);
    if (home) homes.push(id);
  }
  const land = homes.length > 0 ? buildingValues(state, homes) : new Float64Array(0);
  const reach = outsideReachByNode(state);
  const terms: BusinessTaxTerms = { rates: state.budget.taxRates, salesScale: shopSalesScale(state.stats.totals), reachesOutside: false };
  const chunks = buildingChunks(state);
  let h = 0;
  for (const id of payers) {
    const isHome = homes[h] === id;
    const landValue = isHome ? (land[h++] ?? 0) : null;
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    if (!type) continue;
    yearlyTaxDue(state, id, type, filled[id] ?? 0, landValue, terms, reach, yearly);
    const tax = yearly[0] + yearly[1] + yearly[2] + yearly[3];
    if (tax === 0) continue;
    out.tax += tax;
    const block = blockOnSide(index, b.firstSeg[id] ?? NONE, (b.firstSide[id] ?? 0) === CELL_RIGHT);
    if (block !== NONE) out.blockTax[block] = (out.blockTax[block] ?? 0) + tax;
    else {
      const c = chunks[id] ?? 0;
      out.chunkTax[c] = (out.chunkTax[c] ?? 0) + tax;
    }
  }

  // ---- Road upkeep, segment by segment ----
  for (let seg = 0; seg < segLimit; seg++) {
    const upkeep = segmentUpkeepPerYear(net, seg);
    if (upkeep === 0) continue;
    out.upkeep += upkeep;
    const right = blockOnSide(index, seg, true);
    const left = blockOnSide(index, seg, false);
    if (right !== NONE && left !== NONE && right !== left) {
      const half = Math.floor(upkeep / 2);
      out.blockUpkeep[right] = (out.blockUpkeep[right] ?? 0) + half;
      out.blockUpkeep[left] = (out.blockUpkeep[left] ?? 0) + (upkeep - half);
    } else if (right !== NONE || left !== NONE) {
      const block = right !== NONE ? right : left;
      out.blockUpkeep[block] = (out.blockUpkeep[block] ?? 0) + upkeep;
    } else {
      const mid = quadPoint(segmentQuad(net, seg), 0.5);
      const c = chunkAt(mid.x, mid.z);
      out.chunkUpkeep[c] = (out.chunkUpkeep[c] ?? 0) + upkeep;
    }
  }
  return out;
}

/** Every block's and open chunk's yearly figures, from the sim's own pop index. */
export function blockBudgets(state: SimState): BlockBudgets {
  const index = popIndexOf(state);
  return blockBudgetsWith(state, index.people, index.filled);
}

/**
 * By the order of `slots`, slots in `state.cells` as `cellShapesInChunk`
 * gives them for chunk `chunk`: where each cell's figure is read from. A
 * block id for a cell whose side of its road faces a block, or `-1 - chunk`
 * for one on open ground, whose figure is its chunk's. For the overlay.
 */
export function budgetAreasOfSlots(state: SimState, slots: ArrayLike<number>, chunk: number): Int32Array {
  const index = blockIndexOf(state.roads);
  const offset = state.cells.offset;
  const out = new Int32Array(slots.length);
  let seg = -1;
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k] ?? 0;
    seg = segmentOfSlot(offset, slot, seg);
    const side = seg < 0 ? 0 : fromLocal(slot - (offset[seg] ?? 0)).side;
    const block = seg < 0 ? NONE : blockOnSide(index, seg, side === CELL_RIGHT);
    out[k] = block !== NONE ? block : -1 - chunk;
  }
  return out;
}

/** The figures of area `area` as `budgetAreasOfSlots` names it: a block, or open ground in a chunk. Null for none. */
export function areaBudget(budgets: BlockBudgets, area: number): AreaBudget | null {
  return area >= 0 ? blockBudget(budgets, area) : chunkBudget(budgets, -1 - area);
}
