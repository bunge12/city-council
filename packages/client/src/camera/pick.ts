// Ground picking against the height array, not against meshes. The surface
// is the one the sim's `heightAt` reads: bilinear between samples, flat at
// the edge height past the last sample, bounded by the map square. Meshes
// differ from it a little by level of detail; the sim's heights are what a
// command will be checked against, so picking uses them.
//
// No three.js here, so this can be tested in Node.

import { heightAt, mapSize, type Terrain } from "@city-council/sim";

/** A ray in world metres. The direction need not be unit length. */
export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

/** A point on the ground, in world metres. */
export interface GroundHit {
  x: number;
  y: number;
  z: number;
  /** Distance from the ray origin, in metres. */
  distance: number;
}

/** What picking needs to know about a map, computed once per map. */
interface SurfaceBounds {
  size: number;
  minHeight: number;
  maxHeight: number;
  /** Upper bound on the surface's slope (rise over run) anywhere on the map. */
  maxSlope: number;
}

const boundsCache = new WeakMap<Terrain, SurfaceBounds>();

function surfaceBounds(terrain: Terrain): SurfaceBounds {
  const cached = boundsCache.get(terrain);
  if (cached) return cached;
  const { heights: h, samples: n, spacing } = terrain;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let maxDx = 0;
  let maxDz = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const v = h[k] ?? 0;
      if (v < minHeight) minHeight = v;
      if (v > maxHeight) maxHeight = v;
      if (i < n - 1) maxDx = Math.max(maxDx, Math.abs((h[k + 1] ?? 0) - v));
      if (j < n - 1) maxDz = Math.max(maxDz, Math.abs((h[k + n] ?? 0) - v));
    }
  }
  // Inside a bilinear cell the x slope is a blend of the two x edges' slopes
  // and likewise for z, so neither exceeds the largest edge slope.
  const maxSlope = Math.sqrt(maxDx * maxDx + maxDz * maxDz) / spacing;
  const bounds = { size: mapSize(terrain), minHeight, maxHeight, maxSlope };
  boundsCache.set(terrain, bounds);
  return bounds;
}

/** Height range of the map's surface, in metres. */
export function heightRange(terrain: Terrain): { min: number; max: number } {
  const b = surfaceBounds(terrain);
  return { min: b.minHeight, max: b.maxHeight };
}

/** Shortest march step, in metres along the ray. Features narrower than this can be missed. */
const MIN_STEP = 0.25;
/** Bisection rounds once a crossing is bracketed. 2^-40 of a step is far below a millimetre. */
const BISECT_ROUNDS = 40;
/**
 * How far the map square is widened for the clip, in metres. The camera rig
 * can stand exactly on an edge's plane, and a ray from there may start a
 * rounding error outside the map; without this it would miss everything.
 */
const RIM = 1e-6;
/** A ceiling on march steps, so a degenerate ray cannot hang the frame. */
const MAX_STEPS = 50_000;

/**
 * First point where `ray` meets the ground inside the map square, or null if
 * it misses. A ray that starts under the ground returns null. A ray that
 * enters the map through its side below the ground's edge hits the edge.
 */
export function intersectGround(terrain: Terrain, ray: Ray): GroundHit | null {
  const len = Math.sqrt(ray.dx * ray.dx + ray.dy * ray.dy + ray.dz * ray.dz);
  if (!(len > 0)) return null;
  const dx = ray.dx / len;
  const dy = ray.dy / len;
  const dz = ray.dz / len;
  const { ox, oy, oz } = ray;
  const b = surfaceBounds(terrain);

  // Clip the ray to the box that holds the surface: the map square, from
  // the lowest to the highest point. Slab method.
  let t0 = 0;
  let t1 = Infinity;
  const slabs: [number, number, number, number][] = [
    [ox, dx, -RIM, b.size + RIM],
    [oy, dy, b.minHeight, b.maxHeight],
    [oz, dz, -RIM, b.size + RIM],
  ];
  for (const [o, d, lo, hi] of slabs) {
    if (d === 0) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let a = (lo - o) / d;
    let c = (hi - o) / d;
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return null;
  }

  /** Height of the ray above the ground at distance t. */
  const gap = (t: number) => oy + dy * t - heightAt(terrain, ox + dx * t, oz + dz * t);
  const onMap = (v: number) => (v < 0 ? 0 : v > b.size ? b.size : v);
  const at = (t: number): GroundHit => {
    const x = onMap(ox + dx * t);
    const z = onMap(oz + dz * t);
    return { x, y: heightAt(terrain, x, z), z, distance: t };
  };

  let t = t0;
  let g = gap(t);
  if (g <= 0) return t0 > 0 ? at(t0) : null;

  // March. The gap changes by at most |dy| + maxSlope * (horizontal speed)
  // per metre of ray, so a step of gap / that rate cannot pass the surface.
  // Far from the ground the steps are long; near it they shrink to MIN_STEP.
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  const rate = Math.abs(dy) + b.maxSlope * horizontal + 1e-9;
  for (let steps = 0; steps < MAX_STEPS && t < t1; steps++) {
    const next = Math.min(t1, t + Math.max(g / rate, MIN_STEP));
    const gn = gap(next);
    if (gn <= 0) {
      // Crossing between t and next. Bisect on the sign of the gap.
      let lo = t;
      let hi = next;
      for (let r = 0; r < BISECT_ROUNDS; r++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) > 0) lo = mid;
        else hi = mid;
      }
      return at(hi);
    }
    t = next;
    g = gn;
  }
  return null;
}
