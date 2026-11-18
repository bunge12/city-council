// BulldozeRoad and UpgradeRoad (issue 12): removing segments, and changing
// a segment's road type or direction in place.
//
// Bulldozing removes the segments named and then every end node they leave
// with no segments, unless the node is fixed. A node left joining exactly
// two segments stays where it is, so a bulldoze never moves or merges
// anything the player did not name. Fixed segments, such as an outside
// connection's, cannot be bulldozed.
//
// An upgrade keeps the segment's id, shape, level and nodes and changes only
// its type, which in M1 changes only its width on screen. It is refused when
// the new type breaks a limit the old type met on that segment: the slope of
// the ground, the curve radius, a bridge's length or its ramps. A limit the
// old type already broke, as a piece split off a longer road can by a hair,
// does not count against the new one.
//
// A one-way runs from its node A to its node B. Upgrading to a one-way runs
// it from A unless `from` names node B. Upgrading a one-way to the type it
// already is reverses it, by swapping its ends.
//
// Both report a price from the balance file, which is not charged until the
// treasury arrives in M4. A command that names a segment that is not there
// is refused whole, so a command is applied completely or not at all.
//
// Both name segments by id and carry where each one's ends were and its
// road type when the player picked it (`ends` and `types`, issue 94). An id can name another road by the
// time the command applies: another player's crossing road splits the
// segment and leaves its id on one piece, or the road goes and its id is
// handed to the next one built. A segment whose ends have moved, or whose
// type has changed, refuses the whole command, so it never acts on a road
// the player did not see.
//
// Either command can take part of a segment instead of the whole (issue
// 86): `sections` gives each segment named a stretch, as curve parameters
// from node A (0) to node B (1), and [0, 1] is the whole. The sim cuts the
// segment at the stretch's ends the way a crossing road splits it, along a
// curve and onto the build grid on a straight, then removes or changes the
// middle piece. A cut that would leave a piece under the minimum road length
// moves to that end of the segment instead, so no stub is left, and a
// stretch itself under that length is refused. Bridges and ramps are only
// ever taken whole, as nothing else splits them either. The cuts, the edit
// and the nodes they add are one command, so one undo takes them all back.
//
// Checks feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Lint enforces it in this folder.

import { ROAD_BUILD, ROAD_TYPES, type RoadType } from "./balance";
import { bridgeDeckLevel } from "./bridge";
import { TIGHT, bridgeTooLong, groundProblem, rampProblem, sampleGround, snapToGrid, splitSegment, type Sample } from "./build";
import { isStraight, minRadius, quadPoint, segmentQuad, subControl, type Quad } from "./curve";
import {
  LEVEL_BRIDGE,
  addNode,
  curveLength,
  NETWORK_ROAD,
  NODE_FIXED,
  NONE,
  SEG_FIXED,
  isSegment,
  nextSegmentAt,
  removeNode,
  removeSegment,
  restyleSegment,
  type RoadNetwork,
} from "./network";
import { heightAt, type Terrain } from "../terrain/terrain";

/** What a BulldozeRoad command carries besides the player id. */
export interface BulldozeRoadPayload {
  /** Segment ids to remove. At least one, none twice. */
  segments: number[];
  /** Where each segment's ends were when the player picked it, in the same order (`SegmentEnds`). */
  ends: SegmentEnds[];
  /** Each segment's road type id when the player picked it, in the same order. */
  types: string[];
  /** Optional: the stretch of each segment to remove, in the same order (`Section`). Left out, every segment goes whole. */
  sections?: Section[];
}

/**
 * Part of a segment, as `[from, to]` curve parameters along it from node A
 * (0) to node B (1), `from` below `to`. `[0, 1]` is the whole segment.
 */
export type Section = [number, number];

/** A cut a section makes in its segment: a new node at (x, z), curve parameter `u` along the segment. */
export interface SectionCut {
  u: number;
  x: number;
  z: number;
}

/**
 * Where an edit of part of a segment cuts it, and the piece it acts on. The
 * cuts are ascending along the segment from node A, none for the whole.
 */
export interface SectionPlan {
  seg: number;
  /** The stretch after the ends moved to keep the pieces at least the minimum length. */
  from: number;
  to: number;
  cuts: SectionCut[];
  /** Which of the pieces the cuts leave, counted from node A, is the one edited. */
  piece: number;
  /** That piece's shape. */
  shape: Quad;
  /** Its plan length, metres. */
  length: number;
}

/**
 * Where a segment's ends stand, as `[ax, az, bx, bz]` in metres: node A
 * then node B. A bulldoze or upgrade carries one per segment it names, as
 * the sender saw the segment, and the sim refuses the command when a
 * segment's ends are anywhere else now. An id outlives its road: a split
 * leaves it on one piece, and a removed road's id is handed to the next
 * one built. Node ids are reused the same way, so the check is on where
 * the ends are, not which nodes they are.
 */
export type SegmentEnds = [number, number, number, number];

/** Where segment `seg`'s ends are now. */
export function segmentEnds(net: SegmentEndsNetwork, seg: number): SegmentEnds {
  const a = net.segA[seg] ?? 0;
  const b = net.segB[seg] ?? 0;
  return [net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0, net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0];
}

/** Segment `seg`'s road type id now. */
export function segmentTypeId(net: SegmentEndsNetwork, seg: number): string {
  return ROAD_TYPES[net.segType[seg] ?? 0]?.id ?? "";
}

/** The rows `segmentEnds` and `segmentTypeId` read, so a read-only copy of the network can be passed. */
export interface SegmentEndsNetwork {
  readonly segType: ArrayLike<number>;
  readonly segA: ArrayLike<number>;
  readonly segB: ArrayLike<number>;
  readonly nodeX: ArrayLike<number>;
  readonly nodeZ: ArrayLike<number>;
}

/** A bulldoze that passed every check, ready to apply. */
export interface BulldozePlan {
  /** The segments named, ascending. Those in `sections` lose only part of themselves. */
  segments: number[];
  /** The segments cut to remove only part of each, ascending by segment. */
  sections: SectionPlan[];
  /** The nodes of today's network they leave with no segments, which go too, ascending. */
  nodes: number[];
  /** Plan length removed, metres. */
  length: number;
  /** Whole 2026 dollars. Not charged until the treasury arrives in M4. */
  cost: number;
}

export type BulldozePlanResult = { ok: true; plan: BulldozePlan } | { ok: false; reason: string };

/** What an UpgradeRoad command carries besides the player id. */
export interface UpgradeRoadPayload {
  /** Segment ids to change. At least one, none twice. */
  segments: number[];
  /** Where each segment's ends were when the player picked it, in the same order (`SegmentEnds`). */
  ends: SegmentEnds[];
  /**
   * Each segment's road type id when the player picked it, in the same
   * order. Upgrading a one-way to its own type reverses it, so without this
   * a second "make it one-way" sent before the first applied would reverse
   * the road the first made.
   */
  types: string[];
  /** A buildable road type id from the balance file, such as "avenue". */
  type: string;
  /**
   * Only when the new type is a one-way and a segment is not one already:
   * the node each segment leaves from, one per segment, in the same order.
   * Leave it out to run every segment from its node A. For part of a
   * segment it is still one of that segment's ends: the piece runs from
   * that side.
   */
  from?: number[];
  /** Optional: the stretch of each segment to change, in the same order (`Section`). Left out, every segment changes whole. */
  sections?: Section[];
}

/** An upgrade that passed every check, ready to apply. */
export interface UpgradePlan {
  type: RoadType;
  /** The segments to change, in the order the command named them. */
  segments: number[];
  /** Whether each segment's ends swap, in the same order. */
  reverse: boolean[];
  /** For each segment, in the same order, where it is cut to change only part of it, or null to change it whole. */
  sections: (SectionPlan | null)[];
  /** Plan length changed, metres. */
  length: number;
  /** Whole 2026 dollars. Not charged until the treasury arrives in M4. */
  cost: number;
}

export type UpgradePlanResult = { ok: true; plan: UpgradePlan } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The segment list in a payload, or the reason it is not one. */
function readSegments(command: string, value: unknown): number[] | string {
  if (!Array.isArray(value) || value.length === 0) return `${command} needs a list of one or more segment ids`;
  if (value.length > ROAD_BUILD.editMaxSegments) {
    return `${command} takes at most ${ROAD_BUILD.editMaxSegments} segments at once, and this names ${value.length}`;
  }
  const seen = new Set<number>();
  for (const id of value) {
    if (!Number.isSafeInteger(id)) return `${command} needs whole-number segment ids`;
    if (seen.has(id as number)) return `Segment ${id} is named twice`;
    seen.add(id as number);
  }
  return value as number[];
}

/** The `ends` list in a payload, one per segment, or the reason it is not one. */
function readEnds(command: string, value: unknown, count: number): SegmentEnds[] | string {
  const need = `${command} needs the ends of each segment it names, as [ax, az, bx, bz]`;
  if (!Array.isArray(value) || value.length !== count) return need;
  for (const ends of value) {
    if (!Array.isArray(ends) || ends.length !== 4 || !ends.every((v) => Number.isFinite(v))) return need;
  }
  return value as SegmentEnds[];
}

/**
 * Words for a segment whose ends are not where the sender saw them: another
 * command, perhaps another player's, split, moved or replaced it first.
 */
export const SEGMENT_CHANGED = "This road changed after you picked it, so nothing was done";

/** The `types` list in a payload, one per segment, or the reason it is not one. */
function readTypes(command: string, value: unknown, count: number): string[] | string {
  const need = `${command} needs the road type of each segment it names`;
  if (!Array.isArray(value) || value.length !== count || !value.every((t) => typeof t === "string")) return need;
  return value as string[];
}

/** Whether segment `seg` is still as the sender saw it: its ends where `ends` says, and of type `type`. */
function asSeen(net: RoadNetwork, seg: number, ends: SegmentEnds, type: string): boolean {
  const now = segmentEnds(net, seg);
  return (
    now[0] === ends[0] && now[1] === ends[1] && now[2] === ends[2] && now[3] === ends[3] && segmentTypeId(net, seg) === type
  );
}

/** The road type at segment `seg`, which must be a road. */
function typeAt(net: RoadNetwork, seg: number): RoadType {
  return ROAD_TYPES[net.segType[seg] ?? 0] as RoadType;
}

/** `price` per metre of segment `seg` as type `type`: on a bridge, times its type's bridge multiplier. */
function perMetre(net: RoadNetwork, seg: number, type: RoadType, price: number): number {
  return net.segLevelA[seg] === LEVEL_BRIDGE ? price * type.bridge.costMultiplier : price;
}

function isFixedSegment(net: RoadNetwork, seg: number): boolean {
  return ((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0;
}

/** Words for a stretch too short to be a road of its own. */
export const SHORT_SECTION = `That stretch is under ${ROAD_BUILD.minLength} m, the shortest a road can be`;
/** Words for reversing part of a one-way. */
export const WHOLE_REVERSE = "A one-way can only be reversed whole";
/** Words for part of a bridge or ramp. */
export const WHOLE_ONLY = "A bridge or ramp can only be taken whole";

/** The `sections` list in a payload, one per segment, or the reason it is not one. Null when it is left out. */
function readSections(command: string, value: unknown, count: number): Section[] | null | string {
  if (value === undefined) return null;
  const need = `${command} needs one stretch [from, to] for each segment it names, with 0 <= from < to <= 1`;
  if (!Array.isArray(value) || value.length !== count) return need;
  let cut = 0;
  for (const section of value) {
    if (!Array.isArray(section) || section.length !== 2) return need;
    const [from, to] = section as unknown[];
    if (typeof from !== "number" || typeof to !== "number" || !(from >= 0 && from < to && to <= 1)) return need;
    if (from > 0 || to < 1) cut++;
  }
  if (cut > ROAD_BUILD.editMaxSections) {
    return `${command} can take part of at most ${ROAD_BUILD.editMaxSections} segments at once, and this cuts ${cut}`;
  }
  return value as Section[];
}

/** Whether a segment can be cut to edit part of it: anything but a bridge or a ramp. */
export function sectionable(net: SegmentLevelsNetwork, seg: number): boolean {
  const level = net.segLevelA[seg];
  return level !== LEVEL_BRIDGE && level === net.segLevelB[seg];
}

/** The rows `sectionable` reads. */
export interface SegmentLevelsNetwork {
  readonly segLevelA: ArrayLike<number>;
  readonly segLevelB: ArrayLike<number>;
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

function quadLength(q: Quad): number {
  return curveLength(q.ax, q.az, q.cx, q.cz, q.bx, q.bz);
}

/**
 * Where segment `seg`, shaped `shape`, would be cut at parameter `u`: on a
 * straight segment the nearest build grid point, as a crossing road's
 * junction is, and its parameter along the line; on a curve the exact
 * point on it.
 */
function cutAt(shape: Quad, u: number): SectionCut {
  const p = quadPoint(shape, u);
  if (!isStraight(shape)) return { u, x: p.x, z: p.z };
  const x = snapToGrid(p.x);
  const z = snapToGrid(p.z);
  const sx = shape.bx - shape.ax;
  const sz = shape.bz - shape.az;
  const len2 = sx * sx + sz * sz;
  const t = len2 > 0 ? ((x - shape.ax) * sx + (z - shape.az) * sz) / len2 : u;
  return { u: t < 0 ? 0 : t > 1 ? 1 : t, x, z };
}

/** The piece of `shape` between two points on it at parameters `t0` and `t1`. */
function pieceOf(shape: Quad, t0: number, t1: number, a: { x: number; z: number }, b: { x: number; z: number }): Quad {
  if (isStraight(shape)) return { ax: a.x, az: a.z, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, bx: b.x, bz: b.z };
  const c = subControl(shape, t0, t1);
  return { ax: a.x, az: a.z, cx: c.x, cz: c.z, bx: b.x, bz: b.z };
}

function pieceLength(q: Quad): number {
  return isStraight(q) ? distance(q.ax, q.az, q.bx, q.bz) : quadLength(q);
}

/**
 * Where an edit of stretch `section` of segment `seg` would cut it, and the
 * piece it would act on, or the reason it cannot. Each end of the stretch
 * that would leave a piece under the minimum road length moves to the end
 * of the segment. Changes nothing. The tools draw the mark from this, so
 * what they show is what the sim cuts.
 */
export function planSection(net: RoadNetwork, seg: number, section: Section): SectionPlan | string {
  const shape = segmentQuad(net, seg);
  const whole: SectionPlan = { seg, from: 0, to: 1, cuts: [], piece: 0, shape, length: net.segLength[seg] ?? 0 };
  if (section[0] <= 0 && section[1] >= 1) return whole;
  if (!sectionable(net, seg)) return WHOLE_ONLY;
  const a = { x: shape.ax, z: shape.az };
  const b = { x: shape.bx, z: shape.bz };
  let start: SectionCut | null = section[0] > 0 ? cutAt(shape, section[0]) : null;
  let end: SectionCut | null = section[1] < 1 ? cutAt(shape, section[1]) : null;
  if (start && pieceLength(pieceOf(shape, 0, start.u, a, start)) < ROAD_BUILD.minLength) start = null;
  if (end && pieceLength(pieceOf(shape, end.u, 1, end, b)) < ROAD_BUILD.minLength) end = null;
  if (!start && !end) return whole;
  const from = start ? start.u : 0;
  const to = end ? end.u : 1;
  const middle = pieceOf(shape, from, to, start ?? a, end ?? b);
  const length = pieceLength(middle);
  if (!(from < to) || length < ROAD_BUILD.minLength) return SHORT_SECTION;
  const cuts = [start, end].filter((c): c is SectionCut => c !== null);
  return { seg, from, to, cuts, piece: start ? 1 : 0, shape: middle, length };
}

/** The section of each segment in a payload, or null when it takes them all whole. */
function sectionsOf(
  net: RoadNetwork,
  segments: readonly number[],
  sections: readonly Section[] | null,
  i: number,
): SectionPlan | null | string {
  const section = sections?.[i];
  if (!section) return null;
  const plan = planSection(net, segments[i] as number, section);
  if (typeof plan === "string") return plan;
  return plan.cuts.length === 0 ? null : plan;
}

/**
 * Cuts each segment of `plans` as its plan says, in ascending segment
 * order, and returns the id of the piece each edit acts on, by segment.
 * Each cut adds a node on the ground there, as a crossing road's junction
 * does.
 */
function cutSections(net: RoadNetwork, terrain: Terrain, plans: readonly SectionPlan[]): Map<number, number> {
  const pieces = new Map<number, number>();
  for (const plan of [...plans].sort((p, q) => p.seg - q.seg)) {
    const nodes = plan.cuts.map((c) => addNode(net, c.x, c.z, heightAt(terrain, c.x, c.z)));
    const ids = splitSegment(
      net,
      plan.seg,
      nodes,
      plan.cuts.map((c) => c.u),
    );
    pieces.set(plan.seg, ids[plan.piece] ?? NONE);
  }
  return pieces;
}

/**
 * Checks a bulldoze against the network. Returns the plan to apply it, or
 * the reason it cannot be done in words a player reads. Changes nothing.
 */
export function planBulldoze(net: RoadNetwork, payload: unknown): BulldozePlanResult {
  if (!isRecord(payload)) return { ok: false, reason: "BulldozeRoad needs a list of segment ids" };
  const segments = readSegments("BulldozeRoad", payload["segments"]);
  if (typeof segments === "string") return { ok: false, reason: segments };
  const seen = readEnds("BulldozeRoad", payload["ends"], segments.length);
  if (typeof seen === "string") return { ok: false, reason: seen };
  const types = readTypes("BulldozeRoad", payload["types"], segments.length);
  if (typeof types === "string") return { ok: false, reason: types };
  const asked = readSections("BulldozeRoad", payload["sections"], segments.length);
  if (typeof asked === "string") return { ok: false, reason: asked };
  const sections: SectionPlan[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as number;
    if (!isSegment(net, seg)) return { ok: false, reason: `Segment ${seg} does not exist` };
    if (!asSeen(net, seg, seen[i] as SegmentEnds, types[i] as string)) return { ok: false, reason: SEGMENT_CHANGED };
    if (isFixedSegment(net, seg)) return { ok: false, reason: `Segment ${seg} is fixed and cannot be bulldozed` };
    const section = sectionsOf(net, segments, asked, i);
    if (typeof section === "string") return { ok: false, reason: section };
    if (section) sections.push(section);
  }

  const cut = new Map(sections.map((s) => [s.seg, s]));
  // Whether removing `seg` takes it away from its end `node`: a whole
  // segment does, and so does a stretch with no cut on that side.
  const leaves = (seg: number, node: number): boolean => {
    const s = cut.get(seg);
    if (!s) return true;
    return node === net.segA[seg] ? s.from === 0 : s.to === 1;
  };
  const removing = new Set(segments);
  const ends = new Set<number>();
  let length = 0;
  let cost = 0;
  for (const seg of segments) {
    const a = net.segA[seg] ?? NONE;
    const b = net.segB[seg] ?? NONE;
    if (leaves(seg, a)) ends.add(a);
    if (leaves(seg, b)) ends.add(b);
    const segLength = cut.get(seg)?.length ?? net.segLength[seg] ?? 0;
    length += segLength;
    if (net.segNetwork[seg] === NETWORK_ROAD) {
      const type = typeAt(net, seg);
      cost += segLength * perMetre(net, seg, type, type.demolitionCostPerMetre);
    }
  }
  const nodes: number[] = [];
  for (const node of ends) {
    if (((net.nodeFlags[node] ?? 0) & NODE_FIXED) !== 0) continue;
    let kept = false;
    for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE && !kept; seg = nextSegmentAt(net, seg, node)) {
      if (!removing.has(seg) || !leaves(seg, node)) kept = true;
    }
    if (!kept) nodes.push(node);
  }
  const ascending = (a: number, b: number) => a - b;
  return {
    ok: true,
    plan: {
      segments: [...segments].sort(ascending),
      sections: sections.sort((p, q) => p.seg - q.seg),
      nodes: nodes.sort(ascending),
      length,
      cost: Math.round(cost),
    },
  };
}

/**
 * Applies a plan from `planBulldoze`, so every machine hands out and frees
 * the same ids in the same order: first the cuts, segment by segment in
 * ascending id order, then the segments and the pieces cut out of them in
 * ascending id order, then the nodes.
 */
export function bulldozeRoad(net: RoadNetwork, terrain: Terrain, plan: BulldozePlan): void {
  const pieces = cutSections(net, terrain, plan.sections);
  const going = plan.segments.map((seg) => pieces.get(seg) ?? seg).sort((a, b) => a - b);
  for (const seg of going) removeSegment(net, seg);
  for (const node of plan.nodes) removeNode(net, node);
}

/**
 * Why a bridge segment's ramps would be too steep for `type`, or null. Each
 * ramp runs from its bank node to the deck by the last dry sample before
 * the water, as when the bridge was placed.
 */
function rampsProblem(terrain: Terrain, net: RoadNetwork, seg: number, type: RoadType): string | null {
  const smp = sampleGround(terrain, segmentQuad(net, seg));
  const first = smp.findIndex((s) => s.wet);
  if (first < 0) return null;
  let last = first;
  for (let k = smp.length - 1; k > first; k--) {
    if ((smp[k] as Sample).wet) {
      last = k;
      break;
    }
  }
  const deck = bridgeDeckLevel(terrain.waterLevel);
  const bankA = smp[0] as Sample;
  const bankB = smp[smp.length - 1] as Sample;
  const ramp = (bank: Sample, run: number): string | null => {
    const rise = deck > bank.h ? deck - bank.h : bank.h - deck;
    if (rise <= type.maxSlope * run) return null;
    return rampProblem(type, run > 0 ? rise / run : Infinity, deck > bank.h);
  };
  const shoreA = first > 0 ? (smp[first - 1] as Sample).s : 0;
  const shoreB = last < smp.length - 1 ? (smp[last + 1] as Sample).s : bankB.s;
  return ramp(bankA, shoreA - bankA.s) ?? ramp(bankB, bankB.s - shoreB);
}

/**
 * Why segment `seg` breaks a limit of road type `type`, or null if it meets
 * them all. With `piece`, only that part of it, which is never a bridge.
 */
function limitProblem(terrain: Terrain, net: RoadNetwork, seg: number, type: RoadType, piece?: Quad): string | null {
  const shape = piece ?? segmentQuad(net, seg);
  const radius = minRadius(shape);
  if (radius < type.minCurveRadius) return TIGHT(type, radius);
  const level = net.segLevelA[seg];
  // A road at one level, ground or not, was built with the ground check.
  if (level !== LEVEL_BRIDGE && level === net.segLevelB[seg]) return groundProblem(terrain, type, shape);
  if (level === LEVEL_BRIDGE) {
    const length = net.segLength[seg] ?? 0;
    if (length > type.bridge.maxLength) return bridgeTooLong(type, length);
    return rampsProblem(terrain, net, seg, type);
  }
  return null;
}

/**
 * Checks an upgrade against the network and the ground. Returns the plan to
 * apply it, or the reason it cannot be done in words a player reads.
 * Changes nothing.
 *
 * The price of each segment is the full cost of the new type less
 * `upgradeCredit` of the old, never below zero. Reversing a one-way only
 * turns its signs round and costs nothing.
 */
export function planUpgrade(net: RoadNetwork, terrain: Terrain, payload: unknown): UpgradePlanResult {
  if (!isRecord(payload)) return { ok: false, reason: "UpgradeRoad needs a list of segment ids and a road type" };
  const segments = readSegments("UpgradeRoad", payload["segments"]);
  if (typeof segments === "string") return { ok: false, reason: segments };
  const seen = readEnds("UpgradeRoad", payload["ends"], segments.length);
  if (typeof seen === "string") return { ok: false, reason: seen };
  const types = readTypes("UpgradeRoad", payload["types"], segments.length);
  if (typeof types === "string") return { ok: false, reason: types };
  if (typeof payload["type"] !== "string") return { ok: false, reason: "UpgradeRoad needs a road type" };
  const id = payload["type"];
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) return { ok: false, reason: `There is no road type "${id}"` };
  if (!type.buildable) return { ok: false, reason: `${type.name}s cannot be built yet` };
  const asked = readSections("UpgradeRoad", payload["sections"], segments.length);
  if (typeof asked === "string") return { ok: false, reason: asked };
  const from = payload["from"];
  if (from !== undefined) {
    if (!type.oneWay) return { ok: false, reason: "Only an upgrade to a one-way takes a direction" };
    if (!Array.isArray(from) || from.length !== segments.length) {
      return { ok: false, reason: "UpgradeRoad needs one starting node for each segment" };
    }
  }

  const reverse: boolean[] = [];
  const sections: (SectionPlan | null)[] = [];
  let length = 0;
  let cost = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as number;
    if (!isSegment(net, seg)) return { ok: false, reason: `Segment ${seg} does not exist` };
    if (!asSeen(net, seg, seen[i] as SegmentEnds, types[i] as string)) return { ok: false, reason: SEGMENT_CHANGED };
    if (net.segNetwork[seg] !== NETWORK_ROAD) return { ok: false, reason: `Segment ${seg} is not a road` };
    if (isFixedSegment(net, seg)) return { ok: false, reason: `Segment ${seg} is fixed and cannot be changed` };
    const section = sectionsOf(net, segments, asked, i);
    if (typeof section === "string") return { ok: false, reason: section };
    sections.push(section);
    const old = typeAt(net, seg);
    const segLength = section?.length ?? net.segLength[seg] ?? 0;
    length += segLength;
    if (old.index === type.index) {
      if (!type.oneWay) return { ok: false, reason: `Segment ${seg} is already ${article(type)} ${type.name.toLowerCase()}` };
      if (from !== undefined) return { ok: false, reason: `Segment ${seg} is already a one-way: upgrade it again to reverse it` };
      // Half a one-way reversed would meet the other half head on.
      if (section) return { ok: false, reason: WHOLE_REVERSE };
      reverse.push(true);
      continue;
    }
    let flip = false;
    if (type.oneWay && !old.oneWay && from !== undefined) {
      const start = from[i];
      if (start !== net.segA[seg] && start !== net.segB[seg]) {
        return { ok: false, reason: `Segment ${seg} does not start or end at node ${String(start)}` };
      }
      flip = start === net.segB[seg];
    }
    reverse.push(flip);
    const piece = section?.shape;
    const problem = limitProblem(terrain, net, seg, type, piece);
    if (problem !== null && limitProblem(terrain, net, seg, old, piece) === null) return { ok: false, reason: problem };
    const fresh = segLength * perMetre(net, seg, type, type.buildCostPerMetre);
    const credit = segLength * perMetre(net, seg, old, old.buildCostPerMetre) * ROAD_BUILD.upgradeCredit;
    if (fresh > credit) cost += fresh - credit;
  }
  return { ok: true, plan: { type, segments: [...segments], reverse, sections, length, cost: Math.round(cost) } };
}

function article(type: RoadType): string {
  return "aeiou".includes(type.name.charAt(0).toLowerCase()) ? "an" : "a";
}

/**
 * Applies a plan from `planUpgrade`. A whole segment keeps its id. Part of
 * one is cut out first, segment by segment in ascending id order, and the
 * piece is changed; then the changes go in the order the command named them.
 */
export function upgradeRoad(net: RoadNetwork, terrain: Terrain, plan: UpgradePlan): void {
  const pieces = cutSections(
    net,
    terrain,
    plan.sections.filter((s): s is SectionPlan => s !== null),
  );
  plan.segments.forEach((seg, i) => restyleSegment(net, pieces.get(seg) ?? seg, plan.type.index, plan.reverse[i] ?? false));
}
