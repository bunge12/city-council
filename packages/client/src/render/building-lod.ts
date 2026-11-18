// Levels of detail for buildings (issue M2-13, PRD "Zoom bands"): which
// form each 500 m chunk of buildings takes, how one form fades into the
// next, and the geometry of the three merged forms. No three.js scene here,
// so all of it can be tested without a GPU.
//
// Four forms:
// - full: the theme's models, drawn instanced (building-meshes.ts). Only
//   chunks near the camera in the street band take this form, and a chunk
//   that leaves frees its instances.
// - simple: each building its model without its small parts and paving
//   (theme/model.ts, `simplify`), all of a chunk's in one mesh. Chunks
//   within a few kilometres of the camera, in the street band beyond the
//   full form's reach and in the district band. It is the full model's own
//   geometry, colours and window pattern, so a chunk changing between it
//   and the full form keeps its shapes and colours. A chunk that leaves
//   frees it, which bounds its memory by the radius, not the city.
// - box: each building a plain box of its footprint and height, in its wall
//   and roof colours, all of a chunk's in one mesh. Chunks further out in
//   the street and district bands, where a building is a few pixels.
// - flat: each building a flat block on the ground, coloured by its zone
//   and density. The city band, where every chunk is in view, so the
//   blocks of `BUILDINGS.flatGroup` × `flatGroup` chunks share one mesh
//   (issue #133) and each vertex carries its chunk's slot in the group, by
//   which the shader reads that chunk's fade.
//
// A chunk going from one form to another shows both for `fadeSeconds`,
// the new one dithered in as the old one dithers out on the pixels it
// leaves, so nothing pops. The fade is one number a form carries, `fade`
// below, which the materials read.

import type { ZoomBand } from "../camera/zoom-band";
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "@city-council/sim";
import { SURFACE, type ModelArrays } from "../theme/model";
import { BUILDINGS } from "./config";

export type BuildingForm = "full" | "simple" | "box" | "flat";

/**
 * The form a chunk wants. `near` is whether it is held within the full
 * form's reach (`isNear`), and `mid` within the simple form's; only the
 * street band draws near chunks in full.
 */
export function formFor(band: ZoomBand, near: boolean, mid: boolean): BuildingForm {
  if (band === "city") return "flat";
  if (band === "street" && near) return "full";
  return mid ? "simple" : "box";
}

/** Chunks a side of a group of flat blocks, chunks in one, and groups a side of the map. */
export const FLAT_GROUP = BUILDINGS.flatGroup;
export const FLAT_SLOTS = FLAT_GROUP * FLAT_GROUP;
export const FLAT_GROUPS_PER_SIDE = Math.ceil(CHUNKS_PER_SIDE / FLAT_GROUP);

/** The group of flat blocks chunk `c` is drawn in, numbered row by row as chunks are. */
export function flatGroupOf(c: number): number {
  const ci = c % CHUNKS_PER_SIDE;
  const cj = (c - ci) / CHUNKS_PER_SIDE;
  return Math.floor(cj / FLAT_GROUP) * FLAT_GROUPS_PER_SIDE + Math.floor(ci / FLAT_GROUP);
}

/** Chunk `c`'s slot in its group, 0 to `FLAT_SLOTS - 1`, row by row. */
export function flatSlotOf(c: number): number {
  const ci = c % CHUNKS_PER_SIDE;
  const cj = (c - ci) / CHUNKS_PER_SIDE;
  return (cj % FLAT_GROUP) * FLAT_GROUP + (ci % FLAT_GROUP);
}

/**
 * The slot attribute of a group's merged blocks: for each run of items in
 * `runs`, in order, `count` items of four vertices each, all in `slot`.
 */
export function flatSlots(runs: readonly { slot: number; count: number }[]): Float32Array {
  let n = 0;
  for (const r of runs) n += r.count * 4;
  const out = new Float32Array(n);
  let at = 0;
  for (const r of runs) {
    out.fill(r.slot, at, at + r.count * 4);
    at += r.count * 4;
  }
  return out;
}

/** Metres from (x, z) to the nearest point of chunk `c`'s square. */
export function chunkDistance(c: number, x: number, z: number): number {
  const ci = c % CHUNKS_PER_SIDE;
  const cj = (c - ci) / CHUNKS_PER_SIDE;
  const dx = Math.max(ci * CHUNK_SIZE - x, 0, x - (ci + 1) * CHUNK_SIZE);
  const dz = Math.max(cj * CHUNK_SIZE - z, 0, z - (cj + 1) * CHUNK_SIZE);
  return Math.hypot(dx, dz);
}

/**
 * Whether chunk `c` is near the camera at (x, z): within `radius` metres,
 * or within `radius + hysteresis` if it was near already, so a chunk on the
 * line does not flick between forms as the camera moves along it.
 */
export function isNear(c: number, x: number, z: number, wasNear: boolean, radius: number, hysteresis: number): boolean {
  return chunkDistance(c, x, z) <= radius + (wasNear ? hysteresis : 0);
}

/**
 * A chunk's forms over time. `shown` is drawn whole; `next`, while it is
 * set, fades in over it as `t` goes from 0 to 1, and then takes its place.
 */
export interface ChunkFade {
  shown: BuildingForm | null;
  next: BuildingForm | null;
  t: number;
}

/** What one step of a chunk's fade did: the form it let go of, if any. */
export interface FadeStep {
  released: BuildingForm | null;
}

/**
 * Moves a chunk's fade on by `seconds` towards `want`. `ready(form)` says
 * whether a form can be drawn now: a form not ready yet is not faded in,
 * and the chunk keeps what it shows until it is. A chunk showing nothing
 * takes the form it wants at once, with no fade, as after a snapshot.
 * A fade turned back half way runs back the way it came.
 */
export function stepFade(f: ChunkFade, want: BuildingForm, ready: (form: BuildingForm) => boolean, seconds: number, fadeSeconds: number): FadeStep {
  const rate = fadeSeconds > 0 ? seconds / fadeSeconds : Infinity;
  if (f.shown === null) {
    if (ready(want)) f.shown = want;
    return { released: null };
  }
  if (f.next === null) {
    if (want !== f.shown && ready(want)) {
      f.next = want;
      f.t = 0;
    } else return { released: null };
  }
  if (want === f.shown) {
    // Turned back: the fade runs out the way it came, and the form that was coming in is let go.
    f.t -= rate;
    if (f.t > 0) return { released: null };
    const gone = f.next;
    f.next = null;
    f.t = 0;
    return { released: gone };
  }
  f.t += rate;
  if (f.t < 1) return { released: null };
  const gone = f.shown;
  f.shown = f.next;
  f.next = null;
  f.t = 0;
  // A chunk that now wants a third form starts towards it on its next step.
  return { released: gone };
}

/**
 * The number a form's material reads to fade it, for a chunk in state `f`:
 * 1 for a form drawn whole, `t` in [0, 1) for one fading in, which keeps
 * the pixels whose dither value is under it, and 2 + `t` for one fading
 * out, which keeps the rest. 0 when the form is not drawn.
 */
export function fadeOf(f: ChunkFade, form: BuildingForm): number {
  if (f.next === null) return f.shown === form ? 1 : 0;
  if (f.next === form) return f.t;
  if (f.shown === form) return 2 + f.t;
  return 0;
}

/** Whether a chunk in state `f` draws `form` at all. */
export function draws(f: ChunkFade, form: BuildingForm): boolean {
  return f.shown === form || f.next === form;
}

/** An axis-aligned box in a model's own frame, metres. */
export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * The box round a model's positions, leaving out the vertices of surface
 * `skip`: the theme's paving, so a flat block is the building and not its car park.
 * A model with nothing else gets the box round everything.
 */
export function modelExtent(positions: ArrayLike<number>, surfaces: ArrayLike<number>, skip: number): Extent {
  const e: Extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const take = (all: boolean) => {
    for (let v = 0; v < surfaces.length; v++) {
      if (!all && surfaces[v] === skip) continue;
      const x = positions[v * 3] ?? 0;
      const y = positions[v * 3 + 1] ?? 0;
      const z = positions[v * 3 + 2] ?? 0;
      e.minX = Math.min(e.minX, x);
      e.maxX = Math.max(e.maxX, x);
      e.minY = Math.min(e.minY, y);
      e.maxY = Math.max(e.maxY, y);
      e.minZ = Math.min(e.minZ, z);
      e.maxZ = Math.max(e.maxZ, z);
    }
  };
  take(false);
  if (e.minX > e.maxX) take(true);
  if (e.minX > e.maxX) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  return e;
}

/**
 * Where one building of a merged chunk stands: its model and the model's
 * extent, and the place that takes the model's frame to the world. The model is stretched
 * by `sx` along the road and `sz` back from it, turned by `angle` about +y
 * as three.js turns, and set down at (x, y, z).
 */
export interface MergedItem {
  /** The geometry the simple form draws: the model, simplified. */
  model: ModelArrays;
  extent: Extent;
  x: number;
  y: number;
  z: number;
  angle: number;
  sx: number;
  sz: number;
  /** Colours as sRGB hex: the building's tints for the simple form, `flat` for a flat block. */
  wall: number;
  roof: number;
  trim: number;
  flat: number;
  /** The tick the sim built it on, and its model's height in metres above the ground, for a building under construction (construction.ts). */
  built?: number;
  height?: number;
}

/** The colours no building tints, as sRGB hex. */
export interface FixedColours {
  glass: number;
  paving: number;
}

/**
 * A merged chunk's arrays. Colours are sRGB bytes, which the shader takes
 * to linear light; for the simple form the alpha byte is the vertex's
 * `FACADE` and `facades` holds where it is on its facade, in windows along
 * the wall with the lot's stretch taken out and in floors up, as the full
 * models' shader works them out. Normals are signed bytes, x, y, z and a
 * zero. The flat form has neither, and alpha 255.
 */
export interface MergedArrays {
  positions: Float32Array;
  normals: Int8Array | null;
  colours: Uint8Array;
  facades: Float32Array | null;
  indices: Uint16Array | Uint32Array;
  /** The centre and radius of a sphere round every vertex, for culling. */
  centre: [number, number, number];
  radius: number;
}

/** A point of an item's extent, in the world. */
function place(item: MergedItem, lx: number, ly: number, lz: number, out: number[], at: number): void {
  const c = Math.cos(item.angle);
  const s = Math.sin(item.angle);
  const x = lx * item.sx;
  const z = lz * item.sz;
  // three.js's turn about +y: x' = x cos + z sin, z' = -x sin + z cos.
  out[at] = item.x + x * c + z * s;
  out[at + 1] = item.y + ly;
  out[at + 2] = item.z - x * s + z * c;
}

function rgbaOf(hex: number): [number, number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, 255];
}

function bounds(positions: Float32Array): { centre: [number, number, number]; radius: number } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k] ?? 0;
    const y = positions[k + 1] ?? 0;
    const z = positions[k + 2] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (minX > maxX) return { centre: [0, 0, 0], radius: 0 };
  const centre: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  return { centre, radius: Math.hypot(maxX - centre[0], maxY - centre[1], maxZ - centre[2]) };
}

/**
 * One chunk's buildings as their simplified models, merged: each model
 * stretched, turned and set down as its building is, every vertex in the
 * colour of its surface, from the building's tints or `fixed`.
 */
export function mergeModels(items: readonly MergedItem[], fixed: FixedColours): MergedArrays {
  let vertices = 0;
  let count = 0;
  for (const item of items) {
    vertices += item.model.surfaces.length;
    count += item.model.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Int8Array(vertices * 4);
  const colours = new Uint8Array(vertices * 4);
  const facades = new Float32Array(vertices * 2);
  const indices = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  const at = [0, 0, 0];
  let v = 0;
  let i = 0;
  for (const item of items) {
    const m = item.model;
    const c = Math.cos(item.angle);
    const s = Math.sin(item.angle);
    const bySurface = [rgbaOf(item.wall), rgbaOf(item.roof), rgbaOf(item.trim), rgbaOf(fixed.glass), rgbaOf(fixed.paving)];
    const n = m.surfaces.length;
    for (let k = 0; k < n; k++) {
      place(item, m.positions[k * 3] ?? 0, m.positions[k * 3 + 1] ?? 0, m.positions[k * 3 + 2] ?? 0, at, 0);
      positions[(v + k) * 3] = at[0] ?? 0;
      positions[(v + k) * 3 + 1] = at[1] ?? 0;
      positions[(v + k) * 3 + 2] = at[2] ?? 0;
      // A stretch turns a normal by the inverse: divide by the scale, then turn as the positions turn.
      const lx = (m.normals[k * 3] ?? 0) / item.sx;
      const ly = m.normals[k * 3 + 1] ?? 0;
      const lz = (m.normals[k * 3 + 2] ?? 0) / item.sz;
      const len = Math.hypot(lx, ly, lz) || 1;
      normals[(v + k) * 4] = Math.round(((lx * c + lz * s) / len) * 127);
      normals[(v + k) * 4 + 1] = Math.round((ly / len) * 127);
      normals[(v + k) * 4 + 2] = Math.round(((-lx * s + lz * c) / len) * 127);
      const surface = Math.round(m.surfaces[k] ?? SURFACE.wall);
      const colour = bySurface[surface] ?? bySurface[SURFACE.wall] ?? [0, 0, 0, 0];
      colours[(v + k) * 4] = colour[0];
      colours[(v + k) * 4 + 1] = colour[1];
      colours[(v + k) * 4 + 2] = colour[2];
      colours[(v + k) * 4 + 3] = m.facades[k * 4 + 3] ?? 0;
      const axis = m.facades[k * 4 + 2] ?? 0;
      facades[(v + k) * 2] = (m.facades[k * 4] ?? 0) * (axis < 0.5 ? item.sx : item.sz);
      facades[(v + k) * 2 + 1] = m.facades[k * 4 + 1] ?? 0;
    }
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = v + (m.indices[k] ?? 0);
    v += n;
    i += m.indices.length;
  }
  return { positions, normals, colours, facades, indices, ...bounds(positions) };
}

/** Corners of a box face, as bits of the corner index: x is bit 0, y bit 1, z bit 2. */
const BOX_FACES: readonly { corners: readonly [number, number, number, number]; roof: boolean }[] = [
  { corners: [1, 3, 7, 5], roof: false },
  { corners: [0, 4, 6, 2], roof: false },
  { corners: [4, 5, 7, 6], roof: false },
  { corners: [0, 2, 3, 1], roof: false },
  { corners: [2, 6, 7, 3], roof: true },
];

/**
 * One chunk's buildings as plain boxes, merged: the box round each model
 * without its paving, four walls and a roof, no floor, flat shaded. Walls
 * take the building's wall colour and the roof its roof colour. In the
 * simple form's vertex format, with no facade pattern, so one material
 * draws both.
 */
export function mergeBoxes(items: readonly MergedItem[]): MergedArrays {
  const faces = BOX_FACES.length;
  const vertices = items.length * faces * 4;
  const positions = new Float32Array(vertices * 3);
  const normals = new Int8Array(vertices * 4);
  const colours = new Uint8Array(vertices * 4);
  const facades = new Float32Array(vertices * 2);
  const indices = vertices > 0xffff ? new Uint32Array(items.length * faces * 6) : new Uint16Array(items.length * faces * 6);
  const corner = new Array<number>(24).fill(0);
  const mid = [0, 0, 0];
  let v = 0;
  let i = 0;
  for (const item of items) {
    const e = item.extent;
    for (let k = 0; k < 8; k++) place(item, k & 1 ? e.maxX : e.minX, k & 2 ? e.maxY : e.minY, k & 4 ? e.maxZ : e.minZ, corner, k * 3);
    place(item, (e.minX + e.maxX) / 2, (e.minY + e.maxY) / 2, (e.minZ + e.maxZ) / 2, mid, 0);
    const wall = rgbaOf(item.wall);
    const roof = rgbaOf(item.roof);
    for (const face of BOX_FACES) {
      let q = [...face.corners];
      const p = (n: number, a: number) => corner[(q[n] ?? 0) * 3 + a] ?? 0;
      // The face's normal from its corners, turned to point away from the box's middle.
      let nx = (p(1, 1) - p(0, 1)) * (p(2, 2) - p(0, 2)) - (p(1, 2) - p(0, 2)) * (p(2, 1) - p(0, 1));
      let ny = (p(1, 2) - p(0, 2)) * (p(2, 0) - p(0, 0)) - (p(1, 0) - p(0, 0)) * (p(2, 2) - p(0, 2));
      let nz = (p(1, 0) - p(0, 0)) * (p(2, 1) - p(0, 1)) - (p(1, 1) - p(0, 1)) * (p(2, 0) - p(0, 0));
      const out = (p(0, 0) + p(2, 0)) / 2 - (mid[0] ?? 0);
      const up = (p(0, 1) + p(2, 1)) / 2 - (mid[1] ?? 0);
      const across = (p(0, 2) + p(2, 2)) / 2 - (mid[2] ?? 0);
      if (nx * out + ny * up + nz * across < 0) {
        q = [q[0] ?? 0, q[3] ?? 0, q[2] ?? 0, q[1] ?? 0];
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const colour = face.roof ? roof : wall;
      for (let n = 0; n < 4; n++) {
        positions[(v + n) * 3] = p(n, 0);
        positions[(v + n) * 3 + 1] = p(n, 1);
        positions[(v + n) * 3 + 2] = p(n, 2);
        normals[(v + n) * 4] = Math.round((nx / len) * 127);
        normals[(v + n) * 4 + 1] = Math.round((ny / len) * 127);
        normals[(v + n) * 4 + 2] = Math.round((nz / len) * 127);
        colours[(v + n) * 4] = colour[0];
        colours[(v + n) * 4 + 1] = colour[1];
        colours[(v + n) * 4 + 2] = colour[2];
        // Alpha is the facade pattern: none.
        colours[(v + n) * 4 + 3] = 0;
      }
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i);
      v += 4;
      i += 6;
    }
  }
  return { positions, normals, colours, facades, indices, ...bounds(positions) };
}

/**
 * Buildings as flat blocks, merged: each the footprint of its
 * box, at the highest ground under its lot, in its `flat` colour. Wound to
 * face up.
 */
export function mergeFlats(items: readonly MergedItem[]): MergedArrays {
  const positions = new Float32Array(items.length * 4 * 3);
  const colours = new Uint8Array(items.length * 4 * 4);
  const indices = new Uint32Array(items.length * 6);
  const at = new Array<number>(12).fill(0);
  let v = 0;
  let i = 0;
  for (const item of items) {
    const e = item.extent;
    place(item, e.minX, 0, e.minZ, at, 0);
    place(item, e.minX, 0, e.maxZ, at, 3);
    place(item, e.maxX, 0, e.maxZ, at, 6);
    place(item, e.maxX, 0, e.minZ, at, 9);
    // Upward when (b - a) x (c - a) has a positive y.
    const cross = ((at[5] ?? 0) - (at[2] ?? 0)) * ((at[6] ?? 0) - (at[0] ?? 0)) - ((at[3] ?? 0) - (at[0] ?? 0)) * ((at[8] ?? 0) - (at[2] ?? 0));
    const order = cross >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    const colour = rgbaOf(item.flat);
    for (let n = 0; n < 4; n++) {
      const k = (order[n] ?? 0) * 3;
      positions.set([at[k] ?? 0, at[k + 1] ?? 0, at[k + 2] ?? 0], (v + n) * 3);
      colours.set(colour, (v + n) * 4);
    }
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i);
    v += 4;
    i += 6;
  }
  return { positions, normals: null, colours, facades: null, indices, ...bounds(positions) };
}

/** Vertices a merged form gives each item, in the order the merge functions above write them. */
function verticesOf(item: MergedItem, form: "simple" | "box" | "flat"): number {
  if (form === "simple") return item.model.surfaces.length;
  return form === "box" ? BOX_FACES.length * 4 : 4;
}

/**
 * The attribute a merged chunk with a building under construction rises by
 * (issue 136): per vertex of `positions`, as `form`'s merge function wrote
 * them for `items`, its building's `built` tick, its building's height above
 * the ground, and its own height above the bottom of its foundations. The
 * shader sinks each building into the ground by the share it has still to
 * rise.
 */
export function mergedRise(items: readonly MergedItem[], positions: Float32Array, form: "simple" | "box" | "flat"): Float32Array {
  const out = new Float32Array(positions.length);
  let v = 0;
  for (const item of items) {
    const n = verticesOf(item, form);
    for (let k = 0; k < n; k++) {
      out[(v + k) * 3] = item.built ?? -1e9;
      out[(v + k) * 3 + 1] = item.height ?? 0;
      out[(v + k) * 3 + 2] = (positions[(v + k) * 3 + 1] ?? 0) - item.y - item.extent.minY;
    }
    v += n;
  }
  return out;
}
