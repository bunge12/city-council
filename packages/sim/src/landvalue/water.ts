// How far each terrain sample is from water, out to `water.far` in
// landvalue.json (M3-13). Derived from the terrain alone, built once per
// terrain on first use and never saved.
//
// An exact squared distance, in samples, to the nearest sample at or below
// the water level, found in two passes: down each column the distance to
// the nearest water in that column, then along each row the least of
// k^2 + that distance^2 over the columns within reach. Integers only, so
// every machine builds the same map (CLAUDE.md rule 6). Anything farther
// than the reach is stored as the reach plus one sample.

import type { Terrain } from "../terrain/terrain";
import { LAND_VALUE_BALANCE } from "./balance";

interface WaterMap {
  /** Samples the search reaches. */
  reach: number;
  /** Squared distance in samples, by sample, capped at (reach + 1)^2. */
  d2: Uint32Array;
}

const maps = new WeakMap<Terrain, WaterMap>();

function build(t: Terrain): WaterMap {
  const n = t.samples;
  const reach = Math.ceil(LAND_VALUE_BALANCE.water.far / t.spacing);
  const far = reach + 1;
  const h = t.heights;
  const level = t.waterLevel;
  const col = new Uint32Array(n * n);
  for (let i = 0; i < n; i++) {
    let run = far;
    for (let j = 0; j < n; j++) {
      const k = j * n + i;
      run = (h[k] ?? 0) <= level ? 0 : Math.min(far, run + 1);
      col[k] = run;
    }
    run = far;
    for (let j = n - 1; j >= 0; j--) {
      const k = j * n + i;
      run = Math.min(col[k] ?? far, run + 1, far);
      col[k] = run;
    }
  }
  const cap = far * far;
  const d2 = new Uint32Array(n * n);
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = 0; i < n; i++) {
      let best = cap;
      const from = Math.max(0, i - reach);
      const to = Math.min(n - 1, i + reach);
      for (let ii = from; ii <= to; ii++) {
        const g = col[row + ii] ?? far;
        if (g >= far) continue;
        const di = ii - i;
        const v = di * di + g * g;
        if (v < best) best = v;
      }
      d2[row + i] = best;
    }
  }
  return { reach, d2 };
}

function mapOf(t: Terrain): WaterMap {
  let map = maps.get(t);
  if (!map) maps.set(t, (map = build(t)));
  return map;
}

/** Builds the map for `t` now if it has none, so a host's load pays for it and not a tick. */
export function prepareWaterMap(t: Terrain): void {
  mapOf(t);
}

/**
 * Metres from (x, z) to the nearest water, measured from the sample nearest
 * the point, or Infinity when there is none within `water.far`.
 */
export function waterDistanceAt(t: Terrain, x: number, z: number): number {
  const { reach, d2 } = mapOf(t);
  const n = t.samples;
  const i = Math.min(n - 1, Math.max(0, Math.floor(x / t.spacing + 0.5)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(z / t.spacing + 0.5)));
  const v = d2[j * n + i] ?? 0;
  if (v >= (reach + 1) * (reach + 1)) return Number.POSITIVE_INFINITY;
  return Math.sqrt(v) * t.spacing;
}
