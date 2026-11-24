// Which side of its block each zoning strip fronts (#341). Worked out from
// the blocks (blocks.ts) once, by the command that builds a road, and kept
// on its segments as `segTierL` and `segTierR` (network.ts): a later road
// that opens, closes or reshapes the block leaves them alone, so it never
// moves ground between strips that are already there.
//
// A block's boundary is cut into sides wherever it turns by more than 30
// degrees, so a straight run of several segments, such as a long street a
// side street joins from outside, is one side. A dead end inside the block
// turns right round at its tip, so each pass along it is a side of its own.
//
// Each side gets a tier, and a lower tier claims ground first among cells
// of roads of one age (zoning/cell-index.ts, `claimsBefore`). The sides go
// longest first, by whole metres, so the few millimetres a split can add or
// lose do not reorder them; ties go to the side that starts further west,
// then further north. A side that faces one
// already given a tier, its ends running the opposite way within 30 degrees,
// shares that tier; any other takes the next. So in a rectangle the two long
// sides share tier 0 and the two ends share tier 1: the long strips take
// the corners, and the facing strips split the ground between them row by
// row.
//
// Angles are compared through dot and cross products, with
// tan^2(30 degrees) = 1/3, so only multiply, add and compare: every machine
// cuts the same sides (CLAUDE.md rule 6).

import { NONE, NO_TIER, isSegment, setSegmentTiers, type RoadNetwork } from "./network";
import { blockById, blockIndexOf, blockOnSide, type Block, type BlockIndex } from "./blocks";

/** Whether (ux, uz) and (vx, vz) point within 30 degrees of each other, or of opposite ways when `opposite`. */
function within30(ux: number, uz: number, vx: number, vz: number, opposite: boolean): boolean {
  const dot = ux * vx + uz * vz;
  const cross = ux * vz - uz * vx;
  if (opposite ? dot >= 0 : dot <= 0) return false;
  return 3 * cross * cross < dot * dot;
}

/** The tier of each half-edge on one block's boundary. */
type Tiers = Map<number, number>;

/** Tiers by block row. A block walked again is a new row, so a stale entry is never read. */
const cache = new WeakMap<Block, Tiers>();

function tiersOf(net: RoadNetwork, block: Block): Tiers {
  const known = cache.get(block);
  if (known) return known;
  const n = block.segments.length;
  // Where each pass starts and ends, and the way it leaves and arrives.
  const sx = new Float64Array(n);
  const sz = new Float64Array(n);
  const ex = new Float64Array(n);
  const ez = new Float64Array(n);
  const inX = new Float64Array(n);
  const inZ = new Float64Array(n);
  const outX = new Float64Array(n);
  const outZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const seg = block.segments[i] ?? 0;
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const bx = net.nodeX[b] ?? 0;
    const bz = net.nodeZ[b] ?? 0;
    const cx = net.segCX[seg] ?? 0;
    const cz = net.segCZ[seg] ?? 0;
    const fwd = block.forward[i] === true;
    sx[i] = fwd ? ax : bx;
    sz[i] = fwd ? az : bz;
    ex[i] = fwd ? bx : ax;
    ez[i] = fwd ? bz : az;
    // A control point on an end gives no tangent there; the chord does.
    let lx = cx - (sx[i] ?? 0);
    let lz = cz - (sz[i] ?? 0);
    if (lx === 0 && lz === 0) {
      lx = (ex[i] ?? 0) - (sx[i] ?? 0);
      lz = (ez[i] ?? 0) - (sz[i] ?? 0);
    }
    let rx = (ex[i] ?? 0) - cx;
    let rz = (ez[i] ?? 0) - cz;
    if (rx === 0 && rz === 0) {
      rx = (ex[i] ?? 0) - (sx[i] ?? 0);
      rz = (ez[i] ?? 0) - (sz[i] ?? 0);
    }
    outX[i] = lx;
    outZ[i] = lz;
    inX[i] = rx;
    inZ[i] = rz;
  }
  // A side ends after pass i when the boundary turns sharply into pass i + 1.
  const breaks = new Uint8Array(n);
  let first = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const turn =
      block.segments[i] === block.segments[j] ||
      !within30(inX[i] ?? 0, inZ[i] ?? 0, outX[j] ?? 0, outZ[j] ?? 0, false);
    if (turn) {
      breaks[i] = 1;
      if (first < 0) first = i;
    }
  }
  interface Side {
    passes: number[];
    length: number;
    dx: number;
    dz: number;
    /** Whole metres long, for ranking. */
    metres: number;
    /** Where it starts, for ties. */
    x: number;
    z: number;
  }
  const sides: Side[] = [];
  const halfEdge = (i: number) => 2 * (block.segments[i] ?? 0) + (block.forward[i] === true ? 0 : 1);
  // With no sharp turn, as round a ring road, the whole boundary is one side.
  const from = first < 0 ? 0 : (first + 1) % n;
  let side: Side | null = null;
  for (let step = 0; step < n; step++) {
    const i = (from + step) % n;
    if (!side) {
      side = { passes: [], length: 0, dx: 0, dz: 0, metres: 0, x: sx[i] ?? 0, z: sz[i] ?? 0 };
      sides.push(side);
    }
    side.passes.push(i);
    side.length += net.segLength[block.segments[i] ?? 0] ?? 0;
    if (breaks[i] === 1 || step === n - 1) {
      const p0 = side.passes[0] ?? i;
      side.dx = (ex[i] ?? 0) - (sx[p0] ?? 0);
      side.dz = (ez[i] ?? 0) - (sz[p0] ?? 0);
      side.metres = Math.floor(side.length + 0.5);
      side = null;
    }
  }
  const ranked = [...sides].sort((p, q) => (p.metres !== q.metres ? q.metres - p.metres : p.x !== q.x ? p.x - q.x : p.z - q.z));
  const tierOfSide = new Map<Side, number>();
  let next = 0;
  for (let r = 0; r < ranked.length; r++) {
    const s = ranked[r] as Side;
    let tier = -1;
    for (let o = 0; o < r && tier < 0; o++) {
      const t = ranked[o] as Side;
      if (within30(s.dx, s.dz, t.dx, t.dz, true)) tier = tierOfSide.get(t) ?? -1;
    }
    tierOfSide.set(s, tier >= 0 ? tier : next++);
  }
  const tiers: Tiers = new Map();
  for (const s of sides) for (const i of s.passes) tiers.set(halfEdge(i), tierOfSide.get(s) ?? 0);
  cache.set(block, tiers);
  return tiers;
}

/**
 * The block on one side of segment `seg` and the tier of the strip there,
 * or `NONE` and `NO_TIER` where that side faces no block. `right` is
 * CELL_RIGHT's side, as `blockOnSide` takes it.
 */
export function frontage(blocks: BlockIndex, seg: number, right: boolean): { block: number; tier: number } {
  const id = blockOnSide(blocks, seg, right);
  if (id === NONE) return { block: NONE, tier: NO_TIER };
  const block = blockById(blocks, id);
  if (!block) return { block: NONE, tier: NO_TIER };
  // The block on the right of travel from A to B is walked along half-edge 2 * seg.
  return { block: id, tier: tiersOf(blocks.net, block).get(2 * seg + (right ? 0 : 1)) ?? NO_TIER };
}

/**
 * Gives each of segments `ids`, which the command now applying added, the
 * tiers of the strips on its two sides as the blocks stand now.
 */
export function assignTiers(net: RoadNetwork, ids: readonly number[]): void {
  const blocks = blockIndexOf(net);
  for (const id of ids) {
    if (!isSegment(net, id)) continue;
    setSegmentTiers(net, id, frontage(blocks, id, false).tier, frontage(blocks, id, true).tier);
  }
}
