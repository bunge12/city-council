// Geometry for the road tool's previews: a flat strip as wide as the road
// type, laid on the ground with a cross-section at most every
// `ROADS.sampleStep` metres like the real roads, and a disc where the road
// would meet another. A curved preview follows the true curve, with
// cross-sections close enough that each piece turns at most
// `ROADS.curves.surfaceTurn` radians, as the built road does. The parts that
// would be bridges get a narrower strip of their own colour on top. A shape
// that marks a bridge already built, as the bulldoze and upgrade tools draw
// (issue M1-13), is drawn at the deck's height, as the road is. No three.js
// here, so it can be tested in Node.

import {
  bridgeDeckHeight,
  bridgeDeckLevel,
  curveLength,
  heightAt,
  minRadius,
  quadPoint,
  type Quad,
  type Terrain,
} from "@city-council/sim";
import { ROADS, ROAD_PREVIEW } from "./config";
import { linearRgb, stations } from "./road-geometry";

/** How a preview is drawn: buildable, refused, sent and waiting for the sim, marked for the bulldozer, on a route, or outlining a block. */
export type PreviewLook = "ok" | "refused" | "pending" | "bulldoze" | "route" | "block";

/** A built bridge's deck, so its mark is drawn where the deck is: bank node heights and the type's slope limit. */
export interface PreviewDeck {
  hA: number;
  hB: number;
  grade: number;
}

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
  /** Set when the shape marks a built bridge: the whole strip is drawn at its deck. */
  deck?: PreviewDeck;
}

export interface PreviewArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

/** A stable text key for a list of shapes, so the mesh rebuilds only when one changes. */
export function previewKey(shapes: readonly PreviewShape[]): string {
  return shapes
    .map((s) => `${spanKey(s)},${s.width},${s.look},${s.deck ? `${s.deck.hA},${s.deck.hB},${s.deck.grade}` : "-"};${s.junctions.map((j) => `${j.x},${j.z}`).join(";")};${s.bridges.map(spanKey).join(";")}`)
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
  const deckLevel = bridgeDeckLevel(terrain.waterLevel);
  /** The deck of the shape being built, with its length, or null to lay it on the ground. */
  let deck: { d: PreviewDeck; length: number } | null = null;
  /** A vertex `s` metres along the shape being built, on the ground or on its deck. */
  const vertex = (x: number, z: number, rgb: readonly [number, number, number], extra = 0, s = 0): number => {
    const ground = deck ? bridgeDeckHeight(deck.d.hA, deck.d.hB, deck.length, s, deckLevel, deck.d.grade) : heightAt(terrain, x, z);
    positions.push(x, ground + lift + extra, z);
    colours.push(rgb[0], rgb[1], rgb[2]);
    return positions.length / 3 - 1;
  };

  for (const shape of shapes) {
    const rgb = linearRgb(ROAD_PREVIEW.colours[shape.look]);
    deck = shape.deck ? { d: shape.deck, length: spanLength(shape) } : null;
    strip(shape, shape.width, rgb, 0);
    deck = null;
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
      const left = vertex(cx + lx, cz + lz, rgb, extra, t);
      const right = vertex(cx - lx, cz - lz, rgb, extra, t);
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
    // Distance along, from the polyline through the pieces, scaled to the curve's length for the deck height.
    let along = 0;
    let last = quadPoint(q, 0);
    const chords: number[] = [0];
    for (let i = 1; i <= pieces; i++) {
      const p = quadPoint(q, i / pieces);
      along += Math.hypot(p.x - last.x, p.z - last.z);
      chords.push(along);
      last = p;
    }
    const scale = along > 0 ? length / along : 0;
    for (let i = 0; i <= pieces; i++) {
      const t = i / pieces;
      const p = quadPoint(q, t);
      const s = (chords[i] ?? 0) * scale;
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
      const left = vertex(p.x + lx, p.z + lz, rgb, extra, s);
      const right = vertex(p.x - lx, p.z - lz, rgb, extra, s);
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

/** Plan length of a span, along the curve when it has a control point. */
function spanLength(s: PreviewSpanShape): number {
  return s.control ? curveLength(s.ax, s.az, s.control.x, s.control.z, s.bx, s.bz) : Math.hypot(s.bx - s.ax, s.bz - s.az);
}
