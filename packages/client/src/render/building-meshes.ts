// Buildings on screen (issue M2-12): every building in the mirror, drawn
// with one instanced mesh per model and the building's tint as data on its
// instance.
//
// A model is one of a type's generator variants at one lot width, built by
// the theme (theme/). The sim's variant number picks the variant and the
// building's id picks its wall, roof and trim colours (building-tint.ts), so
// neither depends on this page. A model is built the first time a building
// needs it. A lot deeper or shallower than the model's, or bent on a curve,
// stretches the model back from the road; the shader takes the stretch out
// of the window pattern, so windows keep their rhythm.
//
// Buildings are filed by the 500 m chunk the mirror puts them in. Chunks
// waiting to be read are read nearest the camera first, within a time
// budget per frame, so a snapshot fills in from the camera outward and no
// frame stalls. Reading a chunk for a delta that only added or removed
// buildings writes only the instances of those buildings: adding one
// touches one instance. A chunk whose roads changed is rebuilt: every
// building in it is placed again, since its lot may have moved.
//
// The renderer reads the mirror; it never writes it.

import { attribute, floor, fract, mix, mod, select, sRGBTransferEOTF, step, uniform, vec3 } from "three/tsl";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertNodeMaterial,
  Quaternion,
  Vector3,
  type Node,
  type Object3D,
} from "three/webgpu";
import { BUILDING_TYPES, CHUNKS_PER_SIDE, CHUNK_SIZE, ZONING_BALANCE, type BuildingInfo } from "@city-council/sim";
import type { ModelArrays } from "../theme/model";
import type { Theme } from "../theme/theme";
import { placeLot, type Placement } from "./building-place";
import { MASK_GRASS, MASK_SIDE, MASK_TREES } from "./road-geometry";
import { ROADS } from "./config";
import { tintFor } from "./building-tint";

/** Where the layer reads buildings from: the mirror's copy of state. */
export interface BuildingSource {
  /** Every building whose lot's centre is in the chunk, with its lot's corners. Empty before the first snapshot. */
  buildingsInChunk(chunk: number): BuildingInfo[];
}

/** What the layer reports, for the debug panel and tests. */
export interface BuildingStats {
  /** Buildings drawn. */
  buildings: number;
  /** Models built, each one instanced mesh. */
  models: number;
  /** Chunks waiting to be read. */
  pending: number;
  /**
   * Instances written and chunks rebuilt by the last change, counted from
   * when chunks started waiting until none were left, and in all since the
   * layer was made. A chunk is rebuilt when every building in it is placed
   * again, after a snapshot or a change of its roads; a delta that only
   * adds or removes buildings rebuilds none. `lastBuildMs` is the time the
   * last change took, summed over the frames it was spread across.
   */
  lastWrites: number;
  totalWrites: number;
  lastRebuilt: number;
  totalRebuilt: number;
  lastBuildMs: number;
}

export interface BuildingLayer {
  /** Every chunk may have changed, as after a snapshot. Rebuilds them all, nearest the camera first. */
  reset(): void;
  /** The roads of these chunks changed: every building in them is placed again. */
  rebuild(chunks: readonly number[]): void;
  /** Buildings came or went in these chunks: only those are written. */
  apply(chunks: readonly number[]): void;
  /** Called once a frame: reads waiting chunks, nearest the camera at (x, z) first, for about `budgetMs`. */
  update(camera: { x: number; z: number }, budgetMs: number): void;
  /**
   * The chunks holding a corner of a lot that a building came onto or left
   * since the last call. A lot can reach over a chunk line, so the zoning
   * overlay redraws these as well as the lot's own chunk.
   */
  takeLotChunks(): number[];
  /**
   * Which cells of chunk `chunk`'s decoration mask (road-geometry.ts,
   * `roadMask`) a drawn building's lot covers, so no tree or tuft of grass
   * stands in a yard or through a roof. Null when no lot reaches the chunk.
   */
  lotMask(chunk: number): Uint8Array | null;
  /** The colours building `id` is drawn in, as sRGB hex, or null if it is not drawn. For tests. */
  tintOf(id: number): { wall: number; roof: number; trim: number } | null;
  stats(): BuildingStats;
  dispose(): void;
}

/** Instances a model's mesh has room for at first. It doubles when full. */
const FIRST_CAPACITY = 16;
const CELL = ZONING_BALANCE.cellSize;

/** A colour as one float: r * 65536 + g * 256 + b, exact in a float32. */
function packed(hex: number): number {
  return hex & 0xffffff;
}

/** sRGB bytes packed by `packed`, back as a linear colour. */
function unpack(p: Node<"float">) {
  const c = vec3(floor(p.div(65536)), mod(floor(p.div(256)), 256), mod(p, 256)).div(255);
  return sRGBTransferEOTF(c) as unknown as typeof c;
}

/** An sRGB hex colour as a linear vec3 uniform, as the renderer works in linear light. */
function linear(hex: number) {
  const c = new Color(hex);
  return uniform(new Vector3(c.r, c.g, c.b));
}

/** 1 where u is in [u0, u1] and v in [v0, v1], else 0. */
function inside(u: Node<"float">, v: Node<"float">, u0: number, u1: number, v0: number, v1: number) {
  return step(u0, u).mul(step(u, u1)).mul(step(v0, v)).mul(step(v, v1));
}

/**
 * The buildings' material: lit like the terrain and the trees, so it takes
 * the preset's sun, fill and shadows (lighting.ts). Each surface takes its
 * colour from the instance's tints or the theme, and walls draw their
 * pattern from the vertex's place on the facade (theme/model.ts).
 */
function buildingMaterial(theme: Theme): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial();
  m.name = "buildings";
  const surface = attribute<"float">("buildingSurface", "float");
  const facade = attribute<"vec4">("buildingFacade", "vec4");
  const tint = attribute<"vec3">("buildingTint", "vec3");
  const stretch = attribute<"vec2">("buildingScale", "vec2");
  const glass = linear(theme.fixed.glass);
  const pave = linear(theme.fixed.paving);
  const wall = unpack(tint.x);
  const roof = unpack(tint.y);
  const trim = unpack(tint.z);
  const colour = select(surface.lessThan(0.5), wall, select(surface.lessThan(1.5), roof, select(surface.lessThan(2.5), trim, select(surface.lessThan(3.5), glass, pave))));
  // Windows along the wall, in the lot's metres: the stretch of this instance along the wall's axis is taken out.
  const kind = facade.w;
  const along = facade.x.mul(select(facade.z.lessThan(0.5), stretch.x, stretch.y));
  const u = fract(along.add(0.5));
  const v = fract(facade.y);
  const pane = select(
    kind.lessThan(0.5),
    0,
    select(
      kind.lessThan(1.5),
      inside(u, v, 0.27, 0.73, 0.32, 0.8),
      select(kind.lessThan(2.5), inside(u, v, 0.05, 0.95, 0.06, 0.78), select(kind.lessThan(3.5), inside(u, v, 0.05, 0.95, 0.05, 0.95), inside(u, v, 0.1, 0.9, 0, 0.82))),
    ),
  );
  // Loading and garage doors are a darker shade of the wall; every other opening is glass.
  const opening = select(kind.greaterThan(3.5), wall.mul(0.6), glass);
  m.colorNode = mix(colour, opening, pane);
  return m;
}

/** One model: its geometry and the instanced mesh drawing every building that uses it. */
interface Model {
  key: string;
  arrays: ModelArrays;
  mesh: InstancedMesh;
  tints: InstancedBufferAttribute;
  scales: InstancedBufferAttribute;
  /** The building drawn by each instance. */
  ids: Int32Array;
  count: number;
}

/** A building drawn. */
interface Drawn {
  model: Model;
  slot: number;
  chunk: number;
  /** What the building is: its model and the row fields that decide where and how it is drawn. */
  sig: string;
  /** Corner chunks of its lot. */
  lotChunks: number[];
  /** Its lot's corners, as the mirror gave them. */
  corners: number[];
  tint: { wall: number; roof: number; trim: number };
}

function sameCorners(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Whether (x, z) is inside the convex quadrilateral `q`, corners in order either way round. */
function inQuad(q: readonly number[], x: number, z: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[k * 2] ?? 0;
    const az = q[k * 2 + 1] ?? 0;
    const bx = q[((k + 1) % 4) * 2] ?? 0;
    const bz = q[((k + 1) % 4) * 2 + 1] ?? 0;
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function chunkOf(x: number, z: number): number {
  const ci = Math.min(CHUNKS_PER_SIDE - 1, Math.max(0, Math.floor(x / CHUNK_SIZE)));
  const cj = Math.min(CHUNKS_PER_SIDE - 1, Math.max(0, Math.floor(z / CHUNK_SIZE)));
  return cj * CHUNKS_PER_SIDE + ci;
}

function cornerChunks(corners: ArrayLike<number>): number[] {
  const out = new Set<number>();
  for (let k = 0; k < 4; k++) out.add(chunkOf(corners[k * 2] ?? 0, corners[k * 2 + 1] ?? 0));
  return [...out];
}

export function createBuildingLayer(parent: Object3D, source: BuildingSource, theme: Theme, height: (x: number, z: number) => number): BuildingLayer {
  const root = new Group();
  root.name = "buildings";
  parent.add(root);
  const material = buildingMaterial(theme);
  const models = new Map<string, Model>();
  const drawn = new Map<number, Drawn>();
  const byChunk = new Map<number, Set<number>>();
  /** Drawn buildings by the chunks their lots' corners are in. */
  const byLotChunk = new Map<number, Set<number>>();
  /** Chunks waiting, and whether each is to be rebuilt or only brought up to date. */
  const dirty = new Map<number, "rebuild" | "apply">();
  let lotChunks = new Set<number>();
  let stats: BuildingStats = { buildings: 0, models: 0, pending: 0, lastWrites: 0, totalWrites: 0, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0 };
  let batchWrites = 0;
  let batchRebuilt = 0;
  let batchMs = 0;

  // A stand-in drawn from the first frame: one instance of a single
  // triangle, scaled to nothing. Every model shares its material and its
  // attributes, so the shaders all buildings need are compiled with the
  // first frame, and again by the lighting before a switch to shadows
  // (lighting.ts), not on the frame the first building arrives.
  const warm = meshFor("warm-up", {
    positions: new Float32Array(9),
    normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0),
    surfaces: new Float32Array(3),
    facades: new Float32Array(12),
    indices: Uint16Array.of(0, 1, 2),
  }, 1);
  warm.mesh.setMatrixAt(0, new Matrix4().makeScale(0, 0, 0));
  warm.mesh.count = 1;
  root.add(warm.mesh);

  const matrix = new Matrix4();
  const position = new Vector3();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const size = new Vector3();

  function geometryFor(arrays: ModelArrays, tints: InstancedBufferAttribute, scales: InstancedBufferAttribute): BufferGeometry {
    // Attributes of its own around the model's arrays, so disposing an
    // outgrown mesh's geometry frees nothing a newer one uses.
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(arrays.positions, 3));
    g.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
    g.setAttribute("buildingSurface", new BufferAttribute(arrays.surfaces, 1));
    g.setAttribute("buildingFacade", new BufferAttribute(arrays.facades, 4));
    g.setAttribute("buildingTint", tints);
    g.setAttribute("buildingScale", scales);
    g.setIndex(new BufferAttribute(arrays.indices, 1));
    return g;
  }

  function meshFor(key: string, arrays: ModelArrays, capacity: number): { mesh: InstancedMesh; tints: InstancedBufferAttribute; scales: InstancedBufferAttribute } {
    const tints = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    const scales = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    const mesh = new InstancedMesh(geometryFor(arrays, tints, scales), material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = `buildings ${key}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The instances spread over the whole map: one bounding sphere would cull nothing.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return { mesh, tints, scales };
  }

  function modelFor(info: BuildingInfo): Model {
    const type = BUILDING_TYPES[info.type];
    const typeId = type?.id ?? "";
    const model = info.variant % theme.modelCount(typeId);
    const key = `${typeId}/${model}/${info.width}`;
    let m = models.get(key);
    if (m) return m;
    const arrays = theme.model(typeId, model, info.width, theme.modelDepth(typeId));
    const made = meshFor(key, arrays, FIRST_CAPACITY);
    m = { key, arrays, ...made, ids: new Int32Array(FIRST_CAPACITY).fill(-1), count: 0 };
    root.add(m.mesh);
    models.set(key, m);
    return m;
  }

  /** Doubles a model's room for instances: a new mesh with the old one's instances copied over. */
  function grow(m: Model): void {
    const capacity = m.ids.length * 2;
    const next = meshFor(m.key, m.arrays, capacity);
    next.mesh.instanceMatrix.array.set(m.mesh.instanceMatrix.array);
    next.tints.array.set(m.tints.array);
    next.scales.array.set(m.scales.array);
    next.mesh.count = m.count;
    const ids = new Int32Array(capacity).fill(-1);
    ids.set(m.ids);
    root.add(next.mesh);
    m.mesh.removeFromParent();
    m.mesh.geometry.dispose();
    m.mesh.dispose();
    m.mesh = next.mesh;
    m.tints = next.tints;
    m.scales = next.scales;
    m.ids = ids;
  }

  function touched(m: Model, slot: number): void {
    m.mesh.instanceMatrix.addUpdateRange(slot * 16, 16);
    m.mesh.instanceMatrix.needsUpdate = true;
    m.tints.addUpdateRange(slot * 3, 3);
    m.tints.needsUpdate = true;
    m.scales.addUpdateRange(slot * 2, 2);
    m.scales.needsUpdate = true;
    batchWrites++;
  }

  function write(m: Model, slot: number, place: Placement, widthCells: number, typeId: string, tint: Drawn["tint"]): void {
    const sx = place.width / (widthCells * CELL);
    const sz = place.depth / (theme.modelDepth(typeId) * CELL);
    position.set(place.x, place.y, place.z);
    turn.setFromAxisAngle(up, place.angle);
    size.set(sx, 1, sz);
    matrix.compose(position, turn, size);
    m.mesh.setMatrixAt(slot, matrix);
    m.tints.setXYZ(slot, packed(tint.wall), packed(tint.roof), packed(tint.trim));
    m.scales.setXY(slot, sx, sz);
    touched(m, slot);
  }

  function file(id: number, chunk: number): void {
    let set = byChunk.get(chunk);
    if (!set) byChunk.set(chunk, (set = new Set()));
    set.add(id);
  }

  function unfile(id: number, chunk: number): void {
    byChunk.get(chunk)?.delete(id);
  }

  function remove(id: number): void {
    const d = drawn.get(id);
    if (!d) return;
    const m = d.model;
    const last = m.count - 1;
    if (d.slot !== last) {
      // The last instance moves into the gap.
      const moved = m.ids[last] ?? -1;
      m.mesh.instanceMatrix.array.copyWithin(d.slot * 16, last * 16, last * 16 + 16);
      m.tints.array.copyWithin(d.slot * 3, last * 3, last * 3 + 3);
      m.scales.array.copyWithin(d.slot * 2, last * 2, last * 2 + 2);
      m.ids[d.slot] = moved;
      const other = drawn.get(moved);
      if (other) other.slot = d.slot;
      touched(m, d.slot);
    }
    m.ids[last] = -1;
    m.count = last;
    m.mesh.count = last;
    unfile(id, d.chunk);
    for (const c of d.lotChunks) {
      lotChunks.add(c);
      byLotChunk.get(c)?.delete(id);
    }
    drawn.delete(id);
  }

  function add(info: BuildingInfo, place: Placement, sig: string, chunk: number): void {
    const m = modelFor(info);
    if (m.count === m.ids.length) grow(m);
    const slot = m.count++;
    m.mesh.count = m.count;
    m.ids[slot] = info.id;
    const typeId = BUILDING_TYPES[info.type]?.id ?? "";
    const tint = tintFor(info.id, theme.palette(typeId));
    write(m, slot, place, info.width, typeId, tint);
    const corners = info.corners ? [...info.corners] : [];
    const lots = cornerChunks(corners);
    for (const c of lots) {
      lotChunks.add(c);
      let set = byLotChunk.get(c);
      if (!set) byLotChunk.set(c, (set = new Set()));
      set.add(info.id);
    }
    drawn.set(info.id, { model: m, slot, chunk, sig, lotChunks: lots, corners, tint });
    file(info.id, chunk);
  }

  /** Brings the buildings of chunk `c` in line with the mirror. */
  function read(c: number, mode: "rebuild" | "apply"): void {
    const infos = source.buildingsInChunk(c);
    const seen = new Set<number>();
    for (const info of infos) {
      if (!info.corners) continue;
      seen.add(info.id);
      const sig = `${info.type}/${info.variant}/${info.width}/${info.depth}/${info.builtAt}`;
      const d = drawn.get(info.id);
      if (d && d.sig === sig && mode === "apply" && d.chunk === c) continue;
      const place = placeLot(info.corners, height);
      if (d && d.sig === sig && sameCorners(d.corners, info.corners)) {
        // The same building on the same lot: placed again in its own instance, as the ground or the model may differ.
        write(d.model, d.slot, place, info.width, BUILDING_TYPES[info.type]?.id ?? "", d.tint);
        if (d.chunk !== c) {
          unfile(info.id, d.chunk);
          d.chunk = c;
          file(info.id, c);
        }
        continue;
      }
      if (d) remove(info.id);
      add(info, place, sig, c);
    }
    for (const id of [...(byChunk.get(c) ?? [])]) if (!seen.has(id)) remove(id);
    if (mode === "rebuild") batchRebuilt++;
  }

  function mark(chunks: Iterable<number>, mode: "rebuild" | "apply"): void {
    for (const c of chunks) if (mode === "rebuild" || !dirty.has(c)) dirty.set(c, mode);
    stats = { ...stats, pending: dirty.size };
  }

  return {
    reset() {
      mark(
        Array.from({ length: CHUNKS_PER_SIDE * CHUNKS_PER_SIDE }, (_, c) => c),
        "rebuild",
      );
    },
    rebuild: (chunks) => mark(chunks, "rebuild"),
    apply: (chunks) => mark(chunks, "apply"),
    update(camera, budgetMs) {
      if (dirty.size === 0) return;
      const start = performance.now();
      const distance = (c: number) => {
        const ci = c % CHUNKS_PER_SIDE;
        const cj = (c - ci) / CHUNKS_PER_SIDE;
        return Math.hypot((ci + 0.5) * CHUNK_SIZE - camera.x, (cj + 0.5) * CHUNK_SIZE - camera.z);
      };
      const list = [...dirty.keys()].map((c) => ({ c, d: distance(c) })).sort((a, b) => a.d - b.d || a.c - b.c);
      const writesBefore = batchWrites;
      let done = 0;
      for (const { c } of list) {
        if (done > 0 && performance.now() - start >= budgetMs) break;
        const mode = dirty.get(c) ?? "apply";
        dirty.delete(c);
        read(c, mode);
        done++;
      }
      batchMs += performance.now() - start;
      stats = {
        ...stats,
        buildings: drawn.size,
        models: models.size,
        pending: dirty.size,
        totalWrites: stats.totalWrites + (batchWrites - writesBefore),
        totalRebuilt: stats.totalRebuilt,
      };
      if (dirty.size === 0) {
        stats = { ...stats, lastWrites: batchWrites, lastRebuilt: batchRebuilt, totalRebuilt: stats.totalRebuilt + batchRebuilt, lastBuildMs: batchMs };
        batchWrites = 0;
        batchRebuilt = 0;
        batchMs = 0;
      }
    },
    takeLotChunks() {
      const out = [...lotChunks];
      lotChunks = new Set();
      return out;
    },
    lotMask(chunk) {
      const ids = byLotChunk.get(chunk);
      if (!ids || ids.size === 0) return null;
      const cell = ROADS.maskCell;
      const ci = chunk % CHUNKS_PER_SIDE;
      const cj = (chunk - ci) / CHUNKS_PER_SIDE;
      const x0 = ci * CHUNK_SIZE;
      const z0 = cj * CHUNK_SIZE;
      const mask = new Uint8Array(MASK_SIDE * MASK_SIDE);
      for (const id of ids) {
        const q = drawn.get(id)?.corners;
        if (!q || q.length < 8) continue;
        const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
        const zs = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
        const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / cell));
        const i1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(...xs) - x0) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(...zs) - z0) / cell));
        const j1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(...zs) - z0) / cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (inQuad(q, x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell)) mask[j * MASK_SIDE + i] = MASK_TREES | MASK_GRASS;
          }
        }
      }
      return mask;
    },
    tintOf: (id) => drawn.get(id)?.tint ?? null,
    stats: () => stats,
    dispose() {
      warm.mesh.geometry.dispose();
      warm.mesh.dispose();
      for (const m of models.values()) {
        m.mesh.geometry.dispose();
        m.mesh.dispose();
      }
      root.removeFromParent();
      material.dispose();
    },
  };
}
