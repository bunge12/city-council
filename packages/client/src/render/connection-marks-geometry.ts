// Geometry for the outside connection marks: a disc on each connection's
// edge node with an arrow pointing into the map along its stub. Flat shapes
// laid on the ground and sized in screen pixels, like the snap marks. No
// three.js here, so it can be tested in Node.

import { NONE, connectionEnd, heightAt, type RoadNetwork, type Terrain } from "@city-council/sim";
import { CONNECTION_MARKS } from "./config";
import { linearRgb } from "./road-geometry";
import type { ReadonlyDeep } from "../protocol/mirror";

/** One connection to mark: where its disc sits and which way is into the map. */
export interface ConnectionMark {
  /** The disc's centre, a disc's radius in from the edge node so it is all on the map. */
  x: number;
  z: number;
  /** Unit vector along the stub, from the edge into the map. */
  ux: number;
  uz: number;
  /** The edge node. */
  edgeX: number;
  edgeZ: number;
}

/**
 * The marks for a state's outside connections. `metresPerPixel` gives the
 * scale at a ground point, so each disc sits a radius in from its own edge.
 */
export function connectionMarks(
  net: ReadonlyDeep<RoadNetwork>,
  connections: ArrayLike<number>,
  metresPerPixel: (x: number, z: number) => number,
): ConnectionMark[] {
  const marks: ConnectionMark[] = [];
  for (let i = 0; i < connections.length; i++) {
    const edge = connections[i] ?? NONE;
    const inner = connectionEnd(net as RoadNetwork, edge);
    if (inner === NONE) continue;
    const ex = net.nodeX[edge] ?? 0;
    const ez = net.nodeZ[edge] ?? 0;
    const dx = (net.nodeX[inner] ?? 0) - ex;
    const dz = (net.nodeZ[inner] ?? 0) - ez;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uz = dz / len;
    const r = CONNECTION_MARKS.discPx * metresPerPixel(ex, ez);
    marks.push({ x: ex + ux * r, z: ez + uz * r, ux, uz, edgeX: ex, edgeZ: ez });
  }
  return marks;
}

export interface ConnectionMarkArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

/**
 * Triangles for the marks, each at its own scale in metres per pixel. The
 * arrow is a chevron drawn over the disc, slightly higher, so the two never
 * fight for depth.
 */
export function buildConnectionMarks(
  terrain: Terrain,
  marks: readonly ConnectionMark[],
  scales: readonly number[],
): ConnectionMarkArrays {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const disc = linearRgb(CONNECTION_MARKS.disc);
  const arrow = linearRgb(CONNECTION_MARKS.arrow);
  const vertex = (x: number, z: number, rgb: readonly number[], lift: number): number => {
    positions.push(x, heightAt(terrain, x, z) + CONNECTION_MARKS.lift + lift, z);
    colours.push(rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1);
    return positions.length / 3 - 1;
  };
  /** A strip of width `w` from a to b, as one quad. */
  const bar = (ax: number, az: number, bx: number, bz: number, w: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) return;
    const lx = ((bz - az) / len) * (w / 2);
    const lz = (-(bx - ax) / len) * (w / 2);
    const p = vertex(ax + lx, az + lz, arrow, 0.05);
    const q = vertex(ax - lx, az - lz, arrow, 0.05);
    const s = vertex(bx + lx, bz + lz, arrow, 0.05);
    const t = vertex(bx - lx, bz - lz, arrow, 0.05);
    indices.push(p, q, s, q, t, s);
  };
  marks.forEach((m, k) => {
    const px = scales[k] ?? 1;
    const r = CONNECTION_MARKS.discPx * px;
    const centre = vertex(m.x, m.z, disc, 0);
    const first = positions.length / 3;
    const sides = CONNECTION_MARKS.discSides;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      vertex(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r, disc, 0);
    }
    for (let i = 0; i < sides; i++) indices.push(centre, first + i, first + ((i + 1) % sides));
    // A chevron pointing along the stub: two bars from the back corners to the tip.
    const half = (CONNECTION_MARKS.arrowPx / 2) * px;
    const wide = (CONNECTION_MARKS.arrowWidthPx / 2) * px;
    const tipX = m.x + m.ux * half;
    const tipZ = m.z + m.uz * half;
    const backX = m.x - m.ux * half;
    const backZ = m.z - m.uz * half;
    const sx = -m.uz * wide;
    const sz = m.ux * wide;
    const stroke = CONNECTION_MARKS.arrowStrokePx * px;
    bar(backX + sx, backZ + sz, tipX, tipZ, stroke);
    bar(backX - sx, backZ - sz, tipX, tipZ, stroke);
  });
  return {
    positions: new Float32Array(positions),
    colours: new Float32Array(colours),
    indices: new Uint32Array(indices),
  };
}

/** A stable text key for the marks at their scales, so the mesh rebuilds only when one changes. */
export function connectionMarksKey(marks: readonly ConnectionMark[], scales: readonly number[]): string {
  return marks.map((m, k) => `${m.x.toFixed(2)},${m.z.toFixed(2)},${(scales[k] ?? 1).toPrecision(2)}`).join("|");
}
