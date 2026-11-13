// Geometry for the road tool's previews: a flat strip as wide as the road
// type, laid on the ground with a cross-section at most every
// `ROADS.sampleStep` metres like the real roads, and a disc where the road
// would meet another. A curved preview follows the true curve, with
// cross-sections close enough that each piece turns at most
// `ROADS.curves.surfaceTurn` radians, as the built road does. The parts that
// would be bridges get a narrower strip of their own colour on top. No
// three.js here, so it can be tested in Node.

import { curveLength, heightAt, minRadius, quadPoint, type Quad, type Terrain } from "@city-council/sim";
import { ROADS, ROAD_PREVIEW } from "./config";
import { linearRgb, stations } from "./road-geometry";

/** How a preview is drawn: buildable, refused, or sent and waiting for the sim. */
export type PreviewLook = "ok" | "refused" | "pending";

/** A stretch of road in plan: from a to b, through a control point when curved. */
export interface PreviewSpanShape {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** The control point of a curved road, or null for a straight one. */
  control: { x: number; z: number } | null;
}

export interface PreviewShape extends PreviewSpanShape {
  /** Kerb to kerb, metres. */
  width: number;
  look: PreviewLook;
  /** Where the road would meet another road. */
  junctions: readonly { x: number; z: number }[];
  /** The parts that would be bridges. */
  bridges: readonly PreviewSpanShape[];
}

export interface PreviewArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

/** A stable text key for a list of shapes, so the mesh rebuilds only when one changes. */
export function previewKey(shapes: readonly PreviewShape[]): string {
  return shapes
    .map((s) => `${spanKey(s)},${s.width},${s.look};${s.junctions.map((j) => `${j.x},${j.z}`).join(";")};${s.bridges.map(spanKey).join(";")}`)
    .join("|");
}

function spanKey(s: PreviewSpanShape): string {
  return `${s.ax},${s.az},${s.bx},${s.bz},${s.control ? `${s.control.x},${s.control.z}` : "-"}`;
}

export function buildPreviewGeometry(terrain: Terrain, shapes: readonly PreviewShape[]): PreviewArrays {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const lift = ROAD_PREVIEW.lift;
  const vertex = (x: number, z: number, rgb: readonly [number, number, number], extra = 0): number => {
    positions.push(x, heightAt(terrain, x, z) + lift + extra, z);
    colours.push(rgb[0], rgb[1], rgb[2]);
    return positions.length / 3 - 1;
  };

  for (const shape of shapes) {
    const rgb = linearRgb(ROAD_PREVIEW.colours[shape.look]);
    strip(shape, shape.width, rgb, 0);
    // The parts that would be bridges, over the strip in their own colour.
    const bridge = linearRgb(ROAD_PREVIEW.colours.bridge);
    for (const b of shape.bridges) strip(b, shape.width * ROAD_PREVIEW.bridgeScale, bridge, ROAD_PREVIEW.bridgeLift);
    junctionsOf(shape);
  }

  /** A strip from a to b, along the curve through the control point when there is one. */
  function strip(span: PreviewSpanShape, width: number, rgb: readonly [number, number, number], extra: number): void {
    if (span.control) {
      curvedStrip(span, span.control, width, rgb, extra);
      return;
    }
    const dx = span.bx - span.ax;
    const dz = span.bz - span.az;
    const length = Math.hypot(dx, dz);
    if (!(length > 0)) return;
    const ux = dx / length;
    const uz = dz / length;
    // Left of the direction of travel, in plan.
    const half = width / 2;
    const lx = uz * half;
    const lz = -ux * half;
    let previous: [number, number] | null = null;
    for (const t of stations(span.ax, span.az, ux, uz, 0, length, ROADS.sampleStep)) {
      const cx = span.ax + ux * t;
      const cz = span.az + uz * t;
      const left = vertex(cx + lx, cz + lz, rgb, extra);
      const right = vertex(cx - lx, cz - lz, rgb, extra);
      if (previous) indices.push(previous[0], previous[1], left, previous[1], right, left);
      previous = [left, right];
    }
  }

  function junctionsOf(shape: PreviewShape): void {
    const marker = linearRgb(ROAD_PREVIEW.colours.junction);
    const radius = shape.width * ROAD_PREVIEW.junctionScale;
    for (const j of shape.junctions) disc(j.x, j.z, radius, marker);
  }

  /** A strip along the quadratic curve from a through the control point to b. */
  function curvedStrip(
    shape: PreviewSpanShape,
    c: { x: number; z: number },
    width: number,
    rgb: readonly [number, number, number],
    extra: number,
  ): void {
    const q: Quad = { ax: shape.ax, az: shape.az, cx: c.x, cz: c.z, bx: shape.bx, bz: shape.bz };
    const length = curveLength(q.ax, q.az, q.cx, q.cz, q.bx, q.bz);
    if (!(length > 0)) return;
    const radius = minRadius(q);
    const bend = Math.max(ROADS.curves.minPiece, radius * ROADS.curves.surfaceTurn);
    const pieces = Math.min(ROAD_PREVIEW.maxCurvePieces, Math.max(1, Math.ceil(length / Math.min(ROADS.sampleStep, bend))));
    const half = width / 2;
    let previous: [number, number] | null = null;
    for (let i = 0; i <= pieces; i++) {
      const t = i / pieces;
      const p = quadPoint(q, t);
      // The tangent, or the chord where the control point sits on an end.
      let tx = q.cx - q.ax + t * (q.ax - 2 * q.cx + q.bx);
      let tz = q.cz - q.az + t * (q.az - 2 * q.cz + q.bz);
      let tl = Math.hypot(tx, tz);
      if (tl < 1e-9) {
        tx = q.bx - q.ax;
        tz = q.bz - q.az;
        tl = Math.hypot(tx, tz) || 1;
      }
      const lx = (tz / tl) * half;
      const lz = (-tx / tl) * half;
      const left = vertex(p.x + lx, p.z + lz, rgb, extra);
      const right = vertex(p.x - lx, p.z - lz, rgb, extra);
      if (previous) indices.push(previous[0], previous[1], left, previous[1], right, left);
      previous = [left, right];
    }
  }

  function disc(x: number, z: number, radius: number, rgb: readonly [number, number, number]): void {
    const sides = ROAD_PREVIEW.junctionSides;
    // A little higher than the strip, so the marker reads over it.
    const centre = vertex(x, z, rgb, ROAD_PREVIEW.junctionLift);
    const first = positions.length / 3;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      vertex(x + Math.cos(a) * radius, z + Math.sin(a) * radius, rgb, ROAD_PREVIEW.junctionLift);
    }
    for (let k = 0; k < sides; k++) indices.push(centre, first + ((k + 1) % sides), first + k);
  }

  return {
    positions: new Float32Array(positions),
    colours: new Float32Array(colours),
    indices: new Uint32Array(indices),
  };
}
