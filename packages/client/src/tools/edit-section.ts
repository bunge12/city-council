// Part of a road for the bulldozer and the upgrade tool (issue 86).
//
// Hovering with either tool marks a short stretch of the segment around the
// pointer, `EDIT_SECTION.metres` long, not the whole segment. Shift marks
// the whole segment, as both tools did before. A drag grows the stretch of
// each segment it passes over to cover everything it touched, so one
// command still carries the whole drag.
//
// A stretch is a `Section`: curve parameters along the segment from node A
// (0) to node B (1). The sim cuts there (roads/edit.ts), moving an end that
// would leave a stub under its minimum road length onto the segment's end,
// and refuses part of a bridge or ramp, so the tools take those whole.
//
// Client work only: the parameters are measured along a polyline through
// the curve, and only the numbers reach the sim, which checks them like any
// other payload.

import { nearestOnQuad, quadPoint, sectionable, segmentQuad, type Quad, type RoadNetwork, type Section } from "@city-council/sim";
import type { RoadNet } from "../render/road-geometry";
import { EDIT_SECTION } from "./config";

/** The whole segment. */
export const WHOLE: Section = [0, 1];

export function isWhole(section: Section): boolean {
  return section[0] <= 0 && section[1] >= 1;
}

function quadOf(net: RoadNet, seg: number): Quad {
  return segmentQuad(net as unknown as RoadNetwork, seg);
}

/** Running lengths along `q` at `n` even steps of its parameter: entry i is the length up to t = i / n. */
function lengthsAlong(q: Quad, n: number): number[] {
  const out = [0];
  let prev = quadPoint(q, 0);
  for (let i = 1; i <= n; i++) {
    const p = quadPoint(q, i / n);
    out.push((out[i - 1] ?? 0) + Math.hypot(p.x - prev.x, p.z - prev.z));
    prev = p;
  }
  return out;
}

/** Metres along from node A at parameter `t`. */
function metresAt(lengths: readonly number[], t: number): number {
  const n = lengths.length - 1;
  const f = Math.min(Math.max(t, 0), 1) * n;
  const i = Math.min(Math.floor(f), n - 1);
  const a = lengths[i] ?? 0;
  const b = lengths[i + 1] ?? a;
  return a + (b - a) * (f - i);
}

/** The parameter `s` metres along from node A. */
function paramAt(lengths: readonly number[], s: number): number {
  const n = lengths.length - 1;
  const total = lengths[n] ?? 0;
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let i = 0;
  while (i < n - 1 && (lengths[i + 1] ?? 0) < s) i++;
  const a = lengths[i] ?? 0;
  const b = lengths[i + 1] ?? a;
  return (i + (b > a ? (s - a) / (b - a) : 0)) / n;
}

/** The parameter along segment `seg` of the point on it nearest ground point (x, z). */
export function alongSegment(net: RoadNet, seg: number, x: number, z: number): number {
  return nearestOnQuad(quadOf(net, seg), x, z).t;
}

/**
 * The stretch of segment `seg` the tools mark with the pointer at parameter
 * `t` along it: `metres` long, centred there, or against the segment's end
 * when the pointer is nearer it than half that. The whole segment for a bridge or a ramp, which the sim only takes
 * whole, or when `whole` is set, as it is while Shift is held.
 */
export function sectionAt(net: RoadNet, seg: number, t: number, whole = false, metres: number = EDIT_SECTION.metres): Section {
  if (whole || !sectionable(net, seg)) return WHOLE;
  const lengths = lengthsAlong(quadOf(net, seg), EDIT_SECTION.curveSteps);
  const total = lengths[lengths.length - 1] ?? 0;
  if (total <= metres) return WHOLE;
  // Centred on the pointer, but slid back inside the segment near an end, so
  // the stretch is always the full length: a stretch cut short at a node
  // could come out under the sim's minimum once a straight's cut is put on
  // the build grid, and be refused.
  const s = Math.min(Math.max(metresAt(lengths, t), metres / 2), total - metres / 2);
  const from = paramAt(lengths, s - metres / 2);
  const to = paramAt(lengths, s + metres / 2);
  return from <= 0 && to >= 1 ? WHOLE : [from, to];
}

/** The stretch that covers both `a` and `b`. */
export function joinSections(a: Section, b: Section): Section {
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/** A short text key for a stretch, for telling when a preview needs working out again. */
export function sectionKey(section: Section | undefined): string {
  return section && !isWhole(section) ? `${section[0]}~${section[1]}` : "all";
}
