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
// Checks feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Lint enforces it in this folder.

import { ROAD_BUILD, ROAD_TYPES, type RoadType } from "./balance";
import { bridgeDeckLevel } from "./bridge";
import { TIGHT, bridgeTooLong, groundProblem, rampProblem, sampleGround, type Sample } from "./build";
import { minRadius, segmentQuad } from "./curve";
import {
  LEVEL_BRIDGE,
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
import type { Terrain } from "../terrain/terrain";

/** What a BulldozeRoad command carries besides the player id. */
export interface BulldozeRoadPayload {
  /** Segment ids to remove. At least one, none twice. */
  segments: number[];
}

/** A bulldoze that passed every check, ready to apply. */
export interface BulldozePlan {
  /** The segments to remove, ascending. */
  segments: number[];
  /** The nodes they leave with no segments, which go too, ascending. */
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
  /** A buildable road type id from the balance file, such as "avenue". */
  type: string;
  /**
   * Only when the new type is a one-way and a segment is not one already:
   * the node each segment leaves from, one per segment, in the same order.
   * Leave it out to run every segment from its node A.
   */
  from?: number[];
}

/** An upgrade that passed every check, ready to apply. */
export interface UpgradePlan {
  type: RoadType;
  /** The segments to change, in the order the command named them. */
  segments: number[];
  /** Whether each segment's ends swap, in the same order. */
  reverse: boolean[];
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
  const seen = new Set<number>();
  for (const id of value) {
    if (!Number.isSafeInteger(id)) return `${command} needs whole-number segment ids`;
    if (seen.has(id as number)) return `Segment ${id} is named twice`;
    seen.add(id as number);
  }
  return value as number[];
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

/**
 * Checks a bulldoze against the network. Returns the plan to apply it, or
 * the reason it cannot be done in words a player reads. Changes nothing.
 */
export function planBulldoze(net: RoadNetwork, payload: unknown): BulldozePlanResult {
  if (!isRecord(payload)) return { ok: false, reason: "BulldozeRoad needs a list of segment ids" };
  const segments = readSegments("BulldozeRoad", payload["segments"]);
  if (typeof segments === "string") return { ok: false, reason: segments };
  for (const seg of segments) {
    if (!isSegment(net, seg)) return { ok: false, reason: `Segment ${seg} does not exist` };
    if (isFixedSegment(net, seg)) return { ok: false, reason: `Segment ${seg} is fixed and cannot be bulldozed` };
  }

  const removing = new Set(segments);
  const ends = new Set<number>();
  let length = 0;
  let cost = 0;
  for (const seg of segments) {
    ends.add(net.segA[seg] ?? NONE);
    ends.add(net.segB[seg] ?? NONE);
    const segLength = net.segLength[seg] ?? 0;
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
      if (!removing.has(seg)) kept = true;
    }
    if (!kept) nodes.push(node);
  }
  const ascending = (a: number, b: number) => a - b;
  return {
    ok: true,
    plan: { segments: [...segments].sort(ascending), nodes: nodes.sort(ascending), length, cost: Math.round(cost) },
  };
}

/**
 * Applies a plan from `planBulldoze`: the segments go in ascending id order,
 * then the nodes, so every machine frees the same ids in the same order.
 */
export function bulldozeRoad(net: RoadNetwork, plan: BulldozePlan): void {
  for (const seg of plan.segments) removeSegment(net, seg);
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

/** Why segment `seg` breaks a limit of road type `type`, or null if it meets them all. */
function limitProblem(terrain: Terrain, net: RoadNetwork, seg: number, type: RoadType): string | null {
  const shape = segmentQuad(net, seg);
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
  if (typeof payload["type"] !== "string") return { ok: false, reason: "UpgradeRoad needs a road type" };
  const id = payload["type"];
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) return { ok: false, reason: `There is no road type "${id}"` };
  if (!type.buildable) return { ok: false, reason: `${type.name}s cannot be built yet` };
  const from = payload["from"];
  if (from !== undefined) {
    if (!type.oneWay) return { ok: false, reason: "Only an upgrade to a one-way takes a direction" };
    if (!Array.isArray(from) || from.length !== segments.length) {
      return { ok: false, reason: "UpgradeRoad needs one starting node for each segment" };
    }
  }

  const reverse: boolean[] = [];
  let length = 0;
  let cost = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as number;
    if (!isSegment(net, seg)) return { ok: false, reason: `Segment ${seg} does not exist` };
    if (net.segNetwork[seg] !== NETWORK_ROAD) return { ok: false, reason: `Segment ${seg} is not a road` };
    if (isFixedSegment(net, seg)) return { ok: false, reason: `Segment ${seg} is fixed and cannot be changed` };
    const old = typeAt(net, seg);
    const segLength = net.segLength[seg] ?? 0;
    length += segLength;
    if (old.index === type.index) {
      if (!type.oneWay) return { ok: false, reason: `Segment ${seg} is already ${article(type)} ${type.name.toLowerCase()}` };
      if (from !== undefined) return { ok: false, reason: `Segment ${seg} is already a one-way: upgrade it again to reverse it` };
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
    const problem = limitProblem(terrain, net, seg, type);
    if (problem !== null && limitProblem(terrain, net, seg, old) === null) return { ok: false, reason: problem };
    const fresh = segLength * perMetre(net, seg, type, type.buildCostPerMetre);
    const credit = segLength * perMetre(net, seg, old, old.buildCostPerMetre) * ROAD_BUILD.upgradeCredit;
    if (fresh > credit) cost += fresh - credit;
  }
  return { ok: true, plan: { type, segments: [...segments], reverse, length, cost: Math.round(cost) } };
}

function article(type: RoadType): string {
  return "aeiou".includes(type.name.charAt(0).toLowerCase()) ? "an" : "a";
}

/** Applies a plan from `planUpgrade`. No ids are handed out or freed. */
export function upgradeRoad(net: RoadNetwork, plan: UpgradePlan): void {
  plan.segments.forEach((seg, i) => restyleSegment(net, seg, plan.type.index, plan.reverse[i] ?? false));
}
