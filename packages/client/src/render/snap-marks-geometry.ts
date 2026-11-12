// Geometry for the road tool's snap markers: what the cursor caught and the
// guide that caught it. Flat shapes laid on the ground and sized in screen
// pixels, so they read the same at every zoom. No three.js here, so it can
// be tested in Node.

import { heightAt, type BuildPoint, type Terrain } from "@city-council/sim";
import type { Snap } from "../tools/snap";
import { SNAP_MARKS } from "./config";
import { linearRgb } from "./road-geometry";

/** One marker shape. Directions are unit vectors in plan. */
export type SnapMark =
  | { shape: "ring"; x: number; z: number; look: "node" }
  | { shape: "diamond"; x: number; z: number; look: "segment" }
  | { shape: "line"; ax: number; az: number; bx: number; bz: number; look: "angle" }
  | { shape: "square"; x: number; z: number; ux: number; uz: number; vx: number; vz: number; look: "square" }
  | { shape: "cross"; x: number; z: number; look: "grid" };

/**
 * The markers for a snap: one for what it caught, a guide line for an angle
 * snap, and a right-angle marker where the road is square to its source or
 * meets a segment square.
 */
export function snapMarks(snap: Snap, start: BuildPoint | null, metresPerPixel: number): SnapMark[] {
  const marks: SnapMark[] = [];
  if (snap.kind === "node") marks.push({ shape: "ring", x: snap.x, z: snap.z, look: "node" });
  if (snap.kind === "segment") marks.push({ shape: "diamond", x: snap.x, z: snap.z, look: "segment" });
  if (snap.kind === "grid") marks.push({ shape: "cross", x: snap.x, z: snap.z, look: "grid" });
  if (!start) return marks;
  const dx = snap.x - start.x;
  const dz = snap.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return marks;
  const ux = dx / len;
  const uz = dz / len;
  if (snap.kind === "angle") {
    const reach = len + SNAP_MARKS.guideOvershootPx * metresPerPixel;
    marks.push({ shape: "line", ax: start.x, az: start.z, bx: start.x + ux * reach, bz: start.z + uz * reach, look: "angle" });
  }
  if (snap.square && snap.squareTo) {
    marks.push({ shape: "square", x: start.x, z: start.z, ux, uz, vx: snap.squareTo.dx, vz: snap.squareTo.dz, look: "square" });
  }
  if (snap.kind === "segment" && snap.perpendicular && snap.along) {
    // Toward the start, and along the segment on whichever side.
    marks.push({ shape: "square", x: snap.x, z: snap.z, ux: -ux, uz: -uz, vx: snap.along.dx, vz: snap.along.dz, look: "square" });
  }
  return marks;
}

/** A stable text key for a list of marks and their scale, so the mesh rebuilds only when one changes. */
export function snapMarksKey(marks: readonly SnapMark[], metresPerPixel: number): string {
  if (marks.length === 0) return "";
  const r = (v: number) => v.toFixed(3);
  return `${metresPerPixel.toPrecision(3)}|${marks.map((m) => Object.values(m).map((v) => (typeof v === "number" ? r(v) : v)).join(",")).join("|")}`;
}

export interface SnapMarkArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

export function buildSnapMarks(terrain: Terrain, marks: readonly SnapMark[], metresPerPixel: number): SnapMarkArrays {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const px = metresPerPixel;
  let rgb: readonly [number, number, number] = [1, 1, 1];
  const vertex = (x: number, z: number): number => {
    positions.push(x, heightAt(terrain, x, z) + SNAP_MARKS.lift, z);
    colours.push(rgb[0], rgb[1], rgb[2]);
    return positions.length / 3 - 1;
  };
  /** A flat strip of width `w` from a to b, sampled along the ground. */
  const strip = (ax: number, az: number, bx: number, bz: number, w: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) return;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    const lx = uz * (w / 2);
    const lz = -ux * (w / 2);
    const steps = Math.max(1, Math.ceil(len / SNAP_MARKS.sampleStep));
    let prev: [number, number] | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = (len * i) / steps;
      const cx = ax + ux * t;
      const cz = az + uz * t;
      const left = vertex(cx + lx, cz + lz);
      const right = vertex(cx - lx, cz - lz);
      if (prev) indices.push(prev[0], prev[1], left, prev[1], right, left);
      prev = [left, right];
    }
  };

  for (const m of marks) {
    rgb = linearRgb(SNAP_MARKS.colours[m.look]);
    switch (m.shape) {
      case "ring": {
        const sides = 24;
        const inner = SNAP_MARKS.nodeRingPx.inner * px;
        const outer = SNAP_MARKS.nodeRingPx.outer * px;
        const first = positions.length / 3;
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2;
          vertex(m.x + Math.cos(a) * inner, m.z + Math.sin(a) * inner);
          vertex(m.x + Math.cos(a) * outer, m.z + Math.sin(a) * outer);
        }
        for (let k = 0; k < sides; k++) {
          const i0 = first + k * 2;
          const i1 = first + ((k + 1) % sides) * 2;
          indices.push(i0, i0 + 1, i1, i0 + 1, i1 + 1, i1);
        }
        break;
      }
      case "diamond": {
        const r = SNAP_MARKS.segmentDiamondPx * px;
        const c = vertex(m.x, m.z);
        const ring = [vertex(m.x + r, m.z), vertex(m.x, m.z + r), vertex(m.x - r, m.z), vertex(m.x, m.z - r)];
        for (let k = 0; k < 4; k++) indices.push(c, ring[k] ?? c, ring[(k + 1) % 4] ?? c);
        break;
      }
      case "line":
        strip(m.ax, m.az, m.bx, m.bz, SNAP_MARKS.guideWidthPx * px);
        break;
      case "square": {
        const s = SNAP_MARKS.squarePx * px;
        const w = SNAP_MARKS.squareWidthPx * px;
        const p = { x: m.x + m.ux * s, z: m.z + m.uz * s };
        const q = { x: m.x + m.vx * s, z: m.z + m.vz * s };
        const corner = { x: m.x + (m.ux + m.vx) * s, z: m.z + (m.uz + m.vz) * s };
        strip(p.x, p.z, corner.x, corner.z, w);
        strip(q.x, q.z, corner.x, corner.z, w);
        break;
      }
      case "cross": {
        const s = SNAP_MARKS.gridCrossPx * px;
        const w = SNAP_MARKS.gridWidthPx * px;
        strip(m.x - s, m.z, m.x + s, m.z, w);
        strip(m.x, m.z - s, m.x, m.z + s, w);
        break;
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    colours: new Float32Array(colours),
    indices: new Uint32Array(indices),
  };
}
