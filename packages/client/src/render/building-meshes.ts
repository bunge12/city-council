// Buildings on screen (issues M2-12 and M2-13): every building in the
// mirror, in one of three forms by how far out the camera is (PRD, "Zoom
// bands"; building-lod.ts):
// - full: one instanced mesh per model, with the building's tint as data on
//   its instance. Only for chunks near the camera in the street band. A
//   chunk that leaves frees its instances.
// - simple: the same, from each model without its small parts and paving
//   (theme/model.ts, `simplify`): one instanced mesh per simplified model,
//   with the same material, tints and window pattern. Every other chunk in
//   the street band, and every chunk in the district band.
// - flat: a flat block on the ground per building, coloured by its zone and
//   density, one mesh per chunk. The city band.
// A chunk changing form fades from one to the next, dithered, so nothing
// pops.
//
// A model is one of a type's generator variants at one lot width, built by
// the theme (theme/). The sim's variant number picks the variant and the
// building's id picks its wall, roof and trim colours (building-tint.ts), so
// neither depends on this page. A model, and its simplified copy, is built
// the first time a building needs it. A lot deeper or
// shallower than the model's, or bent on a curve, stretches the model back
// from the road; the shader takes the stretch out of the window pattern, so
// windows keep their rhythm.
//
// Buildings are filed by the 500 m chunk the mirror puts them in. Chunks
// waiting to be read are read nearest the camera first, within a time
// budget per frame, so a snapshot fills in from the camera outward and no
// frame stalls. Reading a chunk for a delta that only added or removed
// buildings places only those buildings: adding one in a full chunk touches
// one instance. A chunk whose roads changed is placed again whole, since its
// lots may have moved. A chunk's flat mesh is built again only when a
// building in it changed, and only once the form is drawn.
//
// The renderer reads the mirror; it never writes it.

import { attribute, dot, floor, fract, mix, mod, positionLocal, cameraPosition, screenCoordinate, select, sRGBTransferEOTF, step, uniform, varying, vec2, vec3, vec4 } from "three/tsl";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type Node,
  type Object3D,
} from "three/webgpu";
import { BUILDING_TYPES, CHUNKS_PER_SIDE, CHUNK_SIZE, ZONING_BALANCE, type BuildingInfo } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { SURFACE, simplify, type ModelArrays } from "../theme/model";
import type { Theme } from "../theme/theme";
import { placeLot, type Placement } from "./building-place";
import {
  chunkDistance,
  draws,
  fadeOf,
  formFor,
  isNear,
  mergeFlats,
  modelExtent,
  stepFade,
  type BuildingForm,
  type ChunkFade,
  type Extent,
  type MergedArrays,
  type MergedItem,
} from "./building-lod";
import { MASK_GRASS, MASK_SIDE, MASK_TREES } from "./road-geometry";
import { BUILDINGS, CELLS, ROADS } from "./config";
import { tintFor } from "./building-tint";

/** Where the layer reads buildings from: the mirror's copy of state. */
export interface BuildingSource {
  /** Every building whose lot's centre is in the chunk, with its lot's corners. Empty before the first snapshot. */
  buildingsInChunk(chunk: number): BuildingInfo[];
  /** The chunk building `id`'s lot's centre is in, or -1 if there is no such building or lot. */
  buildingChunk(id: number): number;
}

/** What one form draws in the last frame: chunks, buildings and meshes, each mesh one draw call. */
export interface FormStats {
  chunks: number;
  buildings: number;
  meshes: number;
}

/** What the layer reports, for the debug panel and tests. */
export interface BuildingStats {
  /** Buildings the layer knows, in whatever form. */
  buildings: number;
  /** Models built. Each is an instanced mesh per form, full and simple, while a building drawn in that form uses it. */
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
  /** Merged flat meshes built in the last frame that built any, and in all. */
  lastMerged: number;
  totalMerged: number;
  /** Bytes of vertices and indices the flat meshes hold now. The instanced forms hold only their models and 88 bytes an instance. */
  mergedBytes: number;
  /** What each form drew in the last frame, counting only meshes in the camera's view. */
  forms: Record<BuildingForm, FormStats>;
  /** Chunks fading from one form to another, and chunks waiting for the form they want to be built. */
  fading: number;
  waiting: number;
}

/** Where the camera is, for the layer's frame work. */
export interface BuildingView {
  band: ZoomBand;
  /** Seconds since the last frame, for the fades. */
  seconds: number;
  /** The camera's view, to count what is drawn. Without it every mesh counts. */
  frustum?: Frustum;
}

export interface BuildingLayer {
  /** Every chunk may have changed, as after a snapshot. Rebuilds them all, nearest the camera first. */
  reset(): void;
  /** The roads of these chunks changed: every building in them is placed again. */
  rebuild(chunks: readonly number[]): void;
  /** Buildings came or went in these chunks: only those are written. */
  apply(chunks: readonly number[]): void;
  /**
   * These buildings came, went or changed, in chunks not known yet: the
   * chunks they are drawn in and the ones the mirror puts them in now are
   * brought up to date, as `apply` does, on the next update.
   */
  applyIds(ids: readonly number[]): void;
  /**
   * Called once a frame: reads waiting chunks, nearest the camera at (x, z)
   * first, then moves each chunk towards the form `view` wants for it, all
   * in about `budgetMs`. Without `view`, the street band with no fades.
   */
  update(camera: { x: number; z: number }, budgetMs: number, view?: BuildingView): void;
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
  /** The form chunk `chunk` shows whole, or null. For tests. */
  formOf(chunk: number): BuildingForm | null;
  stats(): BuildingStats;
  dispose(): void;
}

/** Instances a model's mesh has room for at first. It doubles when full. */
const FIRST_CAPACITY = 16;
const CELL = ZONING_BALANCE.cellSize;
const CHUNK_COUNT = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
/** Update ranges an attribute may carry in a frame before it is sent whole instead. */
const MAX_RANGES = 32;

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
 * 1 where a pixel of a form with fade number `fade` (building-lod.ts,
 * `fadeOf`) is drawn and 0 where it is not, by a dither value fixed to the
 * pixel: a form fading in takes the pixels under its fade, and one fading
 * out the rest, so the two share the screen with no gap and no overlap.
 * Interleaved gradient noise, so the dither has no pattern to see.
 */
function kept(fade: Node<"float">) {
  const d = fract(fract(dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(52.9829189));
  return select(fade.lessThan(1.5), step(d, fade.sub(1e-4)), step(fade.sub(2), d));
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
  const fade = varying(attribute<"float">("buildingFade", "float"));
  const glass = linear(theme.fixed.glass);
  const pave = linear(theme.fixed.paving);
  // Unpacked per vertex: the packed number is exact there, and the same at
  // every vertex of an instance, so the colours reach the fragments whole.
  const wall = varying(unpack(tint.x));
  const roof = varying(unpack(tint.y));
  const trim = varying(unpack(tint.z));
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
  // A mask and not an opacity: three.js reads it in the shadow pass too, so a fading form's shadow fades with it.
  m.maskNode = kept(fade).greaterThan(0.5);
  return m;
}

/** A merged mesh's fade, read from the mesh drawn: each chunk's mesh carries its own in `userData.fade`. */
function objectFade() {
  return uniform(1).onObjectUpdate(({ object }) => {
    const f = (object as Object3D | null)?.userData["fade"];
    return typeof f === "number" ? f : 1;
  });
}

/**
 * The flat form's material: unlit like the zoning overlay, so a block's
 * colour is its zone's in the legend at every preset, and lifted in the
 * shader as the overlay's cells are, a little higher so a block lies over
 * them.
 */
function flatMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = "building blocks";
  const fill = attribute<"vec4">("mergedColour", "vec4");
  const distance = cameraPosition.distance(positionLocal);
  m.positionNode = positionLocal.add(vec3(0, distance.mul(BUILDINGS.flatLift.perMetre).add(BUILDINGS.flatLift.base), 0));
  m.colorNode = vec4(sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb, 1);
  m.maskNode = kept(objectFade()).greaterThan(0.5);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

/** The two instanced forms. */
type Level = "full" | "simple";
const LEVELS: readonly Level[] = ["full", "simple"];

/** One form of a model: its geometry and the instanced mesh drawing the buildings in that form. */
interface Instances {
  arrays: ModelArrays;
  /** Null while no building drawn in this form uses the model. */
  mesh: InstancedMesh | null;
  tints: InstancedBufferAttribute | null;
  scales: InstancedBufferAttribute | null;
  fades: InstancedBufferAttribute | null;
  /** The building drawn by each instance. */
  ids: Int32Array;
  count: number;
}

/** A model: its full and simplified forms, and its box, which the flat form draws the footprint of. */
interface Model {
  key: string;
  extent: Extent;
  levels: Record<Level, Instances>;
}

/** A building the layer knows. */
interface Placed {
  id: number;
  model: Model;
  /** Its instance in each of `model`'s meshes, or -1 while its chunk is not drawn in that form. */
  slots: Record<Level, number>;
  chunk: number;
  /** What the building is: its model and the row fields that decide where and how it is drawn. */
  sig: string;
  /** Corner chunks of its lot. */
  lotChunks: number[];
  /** Its lot's corners, as the mirror gave them. */
  corners: number[];
  tint: { wall: number; roof: number; trim: number };
  place: Placement;
  /** The model's stretch along the road and back from it. */
  sx: number;
  sz: number;
  /** Its zone and density's colour, for the flat form. */
  flat: number;
}

/** A chunk's forms. */
interface Chunk {
  ids: Set<number>;
  fade: ChunkFade;
  near: boolean;
  /** Whether every building in it has an instance in each instanced form. */
  on: Record<Level, boolean>;
  /** The fade number each form's instances were last written with. */
  fades: Record<Level, number>;
  flat: Mesh | null;
  /** Whether the flat form has been built, and whether a building changed since. */
  flatBuilt: boolean;
  flatStale: boolean;
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

/** The flat form's colour for a building type: its zone's at its density, as the overlay draws them. */
function flatColour(type: number): number {
  const t = BUILDING_TYPES[type];
  const shades = t ? CELLS.zones[t.zone] : undefined;
  return shades?.[(t?.density ?? 1) - 1] ?? CELLS.unzoned;
}

function zeroStats(): Record<BuildingForm, FormStats> {
  return { full: { chunks: 0, buildings: 0, meshes: 0 }, simple: { chunks: 0, buildings: 0, meshes: 0 }, flat: { chunks: 0, buildings: 0, meshes: 0 } };
}

export function createBuildingLayer(parent: Object3D, source: BuildingSource, theme: Theme, height: (x: number, z: number) => number): BuildingLayer {
  const root = new Group();
  root.name = "buildings";
  parent.add(root);
  const material = buildingMaterial(theme);
  const flats = flatMaterial();
  const models = new Map<string, Model>();
  const placed = new Map<number, Placed>();
  /** Drawn buildings by the chunks their lots' corners are in. */
  const byLotChunk = new Map<number, Set<number>>();
  const chunks = new Map<number, Chunk>();
  /** Chunks waiting, and whether each is to be rebuilt or only brought up to date. */
  const dirty = new Map<number, "rebuild" | "apply">();
  let lotChunks = new Set<number>();
  /** Buildings whose chunks are to be found at the next update. */
  let pendingIds = new Set<number>();
  let stats: BuildingStats = {
    buildings: 0,
    models: 0,
    pending: 0,
    lastWrites: 0,
    totalWrites: 0,
    lastRebuilt: 0,
    totalRebuilt: 0,
    lastBuildMs: 0,
    lastMerged: 0,
    totalMerged: 0,
    mergedBytes: 0,
    forms: zeroStats(),
    fading: 0,
    waiting: 0,
  };
  /** Instances written since the layer was made, and by the reads since chunks started waiting. */
  let writes = 0;
  let batchWrites = 0;
  let batchRebuilt = 0;
  let batchMs = 0;
  let merged = 0;
  let mergedBytes = 0;

  // Stand-ins drawn from the first frame: a single triangle of each
  // material, scaled to nothing. Every model, full or simple, shares one
  // material and its attributes, and every flat chunk the other, so the
  // shaders all buildings need are compiled with the first frame, and again
  // by the lighting before a switch to shadows (lighting.ts), not on the
  // frame the first building or block arrives.
  const warmArrays: ModelArrays = {
    positions: new Float32Array(9),
    normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0),
    surfaces: new Float32Array(3),
    facades: new Float32Array(12),
    indices: Uint16Array.of(0, 1, 2),
  };
  const warm = meshFor("warm-up", warmArrays, 1);
  warm.mesh.setMatrixAt(0, new Matrix4().makeScale(0, 0, 0));
  warm.mesh.count = 1;
  root.add(warm.mesh);
  const warmMerged: MergedArrays = { positions: new Float32Array(9), colours: new Uint8Array(12), indices: Uint32Array.of(0, 1, 2), centre: [0, 0, 0], radius: 0 };
  const warmFlat = mergedMesh("warm-up blocks", warmMerged);
  warmFlat.frustumCulled = false;
  root.add(warmFlat);

  const matrix = new Matrix4();
  const position = new Vector3();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const size = new Vector3();
  const sphere = new Sphere();

  function geometryFor(arrays: ModelArrays, tints: InstancedBufferAttribute, scales: InstancedBufferAttribute, fades: InstancedBufferAttribute): BufferGeometry {
    // Attributes of its own around the model's arrays, so disposing an
    // outgrown mesh's geometry frees nothing a newer one uses.
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(arrays.positions, 3));
    g.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
    g.setAttribute("buildingSurface", new BufferAttribute(arrays.surfaces, 1));
    g.setAttribute("buildingFacade", new BufferAttribute(arrays.facades, 4));
    g.setAttribute("buildingTint", tints);
    g.setAttribute("buildingScale", scales);
    g.setAttribute("buildingFade", fades);
    g.setIndex(new BufferAttribute(arrays.indices, 1));
    return g;
  }

  function meshFor(key: string, arrays: ModelArrays, capacity: number): { mesh: InstancedMesh; tints: InstancedBufferAttribute; scales: InstancedBufferAttribute; fades: InstancedBufferAttribute } {
    const tints = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    const scales = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    const fades = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(DynamicDrawUsage);
    const mesh = new InstancedMesh(geometryFor(arrays, tints, scales, fades), material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = `buildings ${key}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The instances spread over the chunks near the camera: one bounding sphere would cull little.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return { mesh, tints, scales, fades };
  }

  function mergedMesh(name: string, a: MergedArrays): Mesh {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(a.positions, 3));
    g.setAttribute("mergedColour", new BufferAttribute(a.colours, 4, true));
    g.setIndex(new BufferAttribute(a.indices, 1));
    // The flat form is lifted in the shader: the sphere allows for it.
    g.boundingSphere = new Sphere(new Vector3(...a.centre), a.radius + 40);
    const mesh = new Mesh(g, flats);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.userData["fade"] = 1;
    // Nothing in the city band casts a shadow. Over the cells, which draw at 1.5, and under the roads at 2.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 1.6;
    return mesh;
  }

  function instances(arrays: ModelArrays): Instances {
    return { arrays, mesh: null, tints: null, scales: null, fades: null, ids: new Int32Array(0), count: 0 };
  }

  function modelFor(info: BuildingInfo): Model {
    const type = BUILDING_TYPES[info.type];
    const typeId = type?.id ?? "";
    const model = info.variant % theme.modelCount(typeId);
    const key = `${typeId}/${model}/${info.width}`;
    let m = models.get(key);
    if (m) return m;
    const arrays = theme.model(typeId, model, info.width, theme.modelDepth(typeId));
    m = { key, extent: modelExtent(arrays.positions, arrays.surfaces, SURFACE.paving), levels: { full: instances(arrays), simple: instances(simplify(arrays, BUILDINGS.simplify)) } };
    models.set(key, m);
    return m;
  }

  /** Makes a form's mesh of a model, or doubles its room for instances: a new mesh with the old one's instances copied over. */
  function grow(key: string, level: Level, m: Instances): void {
    const capacity = Math.max(FIRST_CAPACITY, m.ids.length * 2);
    const next = meshFor(level === "full" ? key : `${key} simple`, m.arrays, capacity);
    const ids = new Int32Array(capacity).fill(-1);
    if (m.mesh && m.tints && m.scales && m.fades) {
      next.mesh.instanceMatrix.array.set(m.mesh.instanceMatrix.array);
      next.tints.array.set(m.tints.array);
      next.scales.array.set(m.scales.array);
      next.fades.array.set(m.fades.array);
      ids.set(m.ids);
      m.mesh.removeFromParent();
      m.mesh.geometry.dispose();
      m.mesh.dispose();
    }
    next.mesh.count = m.count;
    root.add(next.mesh);
    m.mesh = next.mesh;
    m.tints = next.tints;
    m.scales = next.scales;
    m.fades = next.fades;
    m.ids = ids;
  }

  /** Frees a form's mesh of a model once no building drawn in that form uses it. The model's arrays are kept. */
  function shrink(m: Instances): void {
    if (m.count > 0 || !m.mesh) return;
    m.mesh.removeFromParent();
    m.mesh.geometry.dispose();
    m.mesh.dispose();
    m.mesh = null;
    m.tints = null;
    m.scales = null;
    m.fades = null;
    m.ids = new Int32Array(0);
  }

  /**
   * Attributes sent whole this frame. Each update range is one upload, so
   * an attribute with more than `MAX_RANGES` of them in a frame, as when a
   * chunk is drawn in full or fades, goes up in one.
   */
  const whole = new Set<BufferAttribute>();
  function dirtyRange(a: BufferAttribute, start: number, count: number): void {
    a.needsUpdate = true;
    if (whole.has(a)) return;
    if (a.updateRanges.length >= MAX_RANGES) {
      a.clearUpdateRanges();
      whole.add(a);
      return;
    }
    a.addUpdateRange(start, count);
  }

  function touched(m: Instances, slot: number): void {
    if (!m.mesh || !m.tints || !m.scales || !m.fades) return;
    dirtyRange(m.mesh.instanceMatrix, slot * 16, 16);
    dirtyRange(m.tints, slot * 3, 3);
    dirtyRange(m.scales, slot * 2, 2);
    dirtyRange(m.fades, slot, 1);
    writes++;
  }

  /** Writes a building's instance in one form: the same matrix, tints and stretch in both, so the forms stand in the same place. */
  function write(p: Placed, level: Level): void {
    const m = p.model.levels[level];
    const slot = p.slots[level];
    if (!m.mesh || !m.tints || !m.scales || !m.fades || slot < 0) return;
    position.set(p.place.x, p.place.y, p.place.z);
    turn.setFromAxisAngle(up, p.place.angle);
    size.set(p.sx, 1, p.sz);
    matrix.compose(position, turn, size);
    m.mesh.setMatrixAt(slot, matrix);
    m.tints.setXYZ(slot, packed(p.tint.wall), packed(p.tint.roof), packed(p.tint.trim));
    m.scales.setXY(slot, p.sx, p.sz);
    m.fades.setX(slot, chunkAt(p.chunk).fades[level]);
    touched(m, slot);
  }

  /** Gives a building an instance in its model's mesh for one form. */
  function addInstance(p: Placed, level: Level): void {
    const m = p.model.levels[level];
    if (!m.mesh || m.count === m.ids.length) grow(p.model.key, level, m);
    const slot = m.count++;
    p.slots[level] = slot;
    if (m.mesh) m.mesh.count = m.count;
    m.ids[slot] = p.id;
    write(p, level);
  }

  /** Takes a building's instance in one form away: the last instance moves into the gap. */
  function removeInstance(p: Placed, level: Level): void {
    const m = p.model.levels[level];
    const slot = p.slots[level];
    if (slot < 0 || !m.mesh || !m.tints || !m.scales || !m.fades) {
      p.slots[level] = -1;
      return;
    }
    const last = m.count - 1;
    if (slot !== last) {
      const moved = m.ids[last] ?? -1;
      m.mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      m.tints.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      m.scales.array.copyWithin(slot * 2, last * 2, last * 2 + 2);
      m.fades.array.copyWithin(slot, last, last + 1);
      m.ids[slot] = moved;
      const other = placed.get(moved);
      if (other) other.slots[level] = slot;
      touched(m, slot);
    }
    m.ids[last] = -1;
    m.count = last;
    m.mesh.count = last;
    p.slots[level] = -1;
    shrink(m);
  }

  function chunkAt(c: number): Chunk {
    let ch = chunks.get(c);
    if (!ch) {
      ch = { ids: new Set(), fade: { shown: null, next: null, t: 0 }, near: false, on: { full: false, simple: false }, fades: { full: 0, simple: 0 }, flat: null, flatBuilt: false, flatStale: false };
      chunks.set(c, ch);
    }
    return ch;
  }

  /** A building in chunk `c` came, went or moved: its flat form is out of date. */
  function staleChunk(c: number): void {
    chunkAt(c).flatStale = true;
  }

  /** Brings a building's instances in line with its chunk: one in each form the chunk has filled, none in the others. */
  function syncInstance(p: Placed): void {
    for (const level of LEVELS) {
      const want = chunkAt(p.chunk).on[level];
      if (p.slots[level] >= 0 && !want) removeInstance(p, level);
      if (want && p.slots[level] < 0) addInstance(p, level);
      else if (want) write(p, level);
    }
  }

  /** Files a lot by its corners' chunks, and notes them for the overlay and the decoration. */
  function fileLot(id: number, list: readonly number[]): void {
    for (const c of list) {
      lotChunks.add(c);
      let set = byLotChunk.get(c);
      if (!set) byLotChunk.set(c, (set = new Set()));
      set.add(id);
    }
  }

  function unfileLot(id: number, list: readonly number[]): void {
    for (const c of list) {
      lotChunks.add(c);
      byLotChunk.get(c)?.delete(id);
    }
  }

  function remove(id: number): void {
    const p = placed.get(id);
    if (!p) return;
    for (const level of LEVELS) removeInstance(p, level);
    chunkAt(p.chunk).ids.delete(id);
    staleChunk(p.chunk);
    unfileLot(id, p.lotChunks);
    placed.delete(id);
  }

  function placeInfo(info: BuildingInfo, place: Placement): { sx: number; sz: number } {
    const typeId = BUILDING_TYPES[info.type]?.id ?? "";
    return { sx: place.width / (info.width * CELL), sz: place.depth / (theme.modelDepth(typeId) * CELL) };
  }

  function add(info: BuildingInfo, place: Placement, sig: string, chunk: number): void {
    const model = modelFor(info);
    const typeId = BUILDING_TYPES[info.type]?.id ?? "";
    const tint = tintFor(info.id, theme.palette(typeId));
    const corners = info.corners ? [...info.corners] : [];
    const lots = cornerChunks(corners);
    fileLot(info.id, lots);
    const p: Placed = { id: info.id, model, slots: { full: -1, simple: -1 }, chunk, sig, lotChunks: lots, corners, tint, place, ...placeInfo(info, place), flat: flatColour(info.type) };
    placed.set(info.id, p);
    chunkAt(chunk).ids.add(info.id);
    staleChunk(chunk);
    syncInstance(p);
  }

  /** Brings the buildings of chunk `c` in line with the mirror. */
  function read(c: number, mode: "rebuild" | "apply"): void {
    const infos = source.buildingsInChunk(c);
    const seen = new Set<number>();
    for (const info of infos) {
      if (!info.corners) continue;
      seen.add(info.id);
      const sig = `${info.type}/${info.variant}/${info.width}/${info.depth}/${info.builtAt}`;
      const p = placed.get(info.id);
      if (p && p.sig === sig && mode === "apply" && p.chunk === c && sameCorners(p.corners, info.corners)) continue;
      const place = placeLot(info.corners, height);
      if (p && p.sig === sig) {
        // The same building: placed again in its own instance, on its lot as it is now.
        p.place = place;
        Object.assign(p, placeInfo(info, place));
        staleChunk(p.chunk);
        if (p.chunk !== c) {
          chunkAt(p.chunk).ids.delete(info.id);
          p.chunk = c;
          chunkAt(c).ids.add(info.id);
          staleChunk(c);
        }
        if (!sameCorners(p.corners, info.corners)) {
          unfileLot(info.id, p.lotChunks);
          p.corners = [...info.corners];
          p.lotChunks = cornerChunks(p.corners);
          fileLot(info.id, p.lotChunks);
        }
        syncInstance(p);
        continue;
      }
      if (p) remove(info.id);
      add(info, place, sig, c);
    }
    for (const id of [...(chunks.get(c)?.ids ?? [])]) if (!seen.has(id)) remove(id);
    if (mode === "rebuild") batchRebuilt++;
  }

  function mark(list: Iterable<number>, mode: "rebuild" | "apply"): void {
    for (const c of list) if (mode === "rebuild" || !dirty.has(c)) dirty.set(c, mode);
    stats = { ...stats, pending: dirty.size };
  }

  function itemsOf(ch: Chunk): MergedItem[] {
    const items: MergedItem[] = [];
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (!p) continue;
      items.push({ extent: p.model.extent, x: p.place.x, y: p.place.y, z: p.place.z, angle: p.place.angle, sx: p.sx, sz: p.sz, flat: p.flat });
    }
    return items;
  }

  function dropFlat(ch: Chunk): void {
    const mesh = ch.flat;
    if (!mesh) return;
    mergedBytes -= Number(mesh.userData["bytes"] ?? 0);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    ch.flat = null;
  }

  /** Builds a chunk's flat mesh from its buildings as they are now. */
  function buildFlat(c: number, ch: Chunk): void {
    dropFlat(ch);
    const items = itemsOf(ch);
    if (items.length > 0) {
      const ci = c % CHUNKS_PER_SIDE;
      const cj = (c - ci) / CHUNKS_PER_SIDE;
      const arrays = mergeFlats(items);
      const mesh = mergedMesh(`building blocks ${ci},${cj}`, arrays);
      mesh.visible = draws(ch.fade, "flat");
      mesh.userData["fade"] = fadeOf(ch.fade, "flat");
      mesh.userData["bytes"] = arrays.positions.byteLength + arrays.colours.byteLength + arrays.indices.byteLength;
      mergedBytes += Number(mesh.userData["bytes"]);
      root.add(mesh);
      ch.flat = mesh;
    }
    ch.flatBuilt = true;
    ch.flatStale = false;
    merged++;
  }

  /** Gives every building in a chunk an instance in one form, so it can be drawn in it. */
  function fill(ch: Chunk, level: Level): void {
    ch.on[level] = true;
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (p && p.slots[level] < 0) addInstance(p, level);
    }
  }

  /** Takes every instance of a chunk in one form away: that form is freed. */
  function free(ch: Chunk, level: Level): void {
    ch.on[level] = false;
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (p) removeInstance(p, level);
    }
  }

  /**
   * Whether a chunk can draw `form` now. An instanced form is ready once
   * the chunk is filled. A flat form that a building changed since it was
   * built is not ready to fade in, though one already drawn stays drawn
   * until it is built again.
   */
  function ready(ch: Chunk, form: BuildingForm): boolean {
    if (form !== "flat") return ch.on[form];
    return ch.flatBuilt && (!ch.flatStale || draws(ch.fade, "flat"));
  }

  /** Writes a chunk's fade into its flat mesh and, when it changed, into its instances. */
  function showFade(ch: Chunk): void {
    if (ch.flat) {
      ch.flat.visible = draws(ch.fade, "flat");
      ch.flat.userData["fade"] = fadeOf(ch.fade, "flat");
    }
    for (const level of LEVELS) {
      const f = fadeOf(ch.fade, level);
      if (f === ch.fades[level]) continue;
      ch.fades[level] = f;
      for (const id of ch.ids) {
        const p = placed.get(id);
        const m = p?.model.levels[level];
        const slot = p?.slots[level] ?? -1;
        if (!m?.fades || slot < 0) continue;
        m.fades.setX(slot, f);
        dirtyRange(m.fades, slot, 1);
      }
    }
  }

  /** One step of the forms, after the reads: what each chunk wants, what that needs built, and the fades. */
  function forms(camera: { x: number; z: number }, view: BuildingView, start: number, budgetMs: number): void {
    const needs: { c: number; ch: Chunk; d: number; form: BuildingForm }[] = [];
    for (const [c, ch] of chunks) {
      if (ch.ids.size === 0) {
        // Every building gone: nothing left to draw or fade.
        for (const level of LEVELS) free(ch, level);
        dropFlat(ch);
        chunks.delete(c);
        continue;
      }
      ch.near = isNear(c, camera.x, camera.z, ch.near, BUILDINGS.fullRadius, BUILDINGS.fullHysteresis);
      const want = formFor(view.band, ch.near);
      const d = chunkDistance(c, camera.x, camera.z);
      if (!ready(ch, want) || (want === "flat" && ch.flatStale)) needs.push({ c, ch, d, form: want });
    }
    needs.sort((a, b) => a.d - b.d || a.c - b.c);
    let done = 0;
    for (const n of needs) {
      if (done > 0 && performance.now() - start >= budgetMs) break;
      if (n.form === "flat") buildFlat(n.c, n.ch);
      else fill(n.ch, n.form);
      done++;
    }
    let fading = 0;
    let waiting = 0;
    for (const ch of chunks.values()) {
      const want = formFor(view.band, ch.near);
      const { released } = stepFade(ch.fade, want, (form) => ready(ch, form), view.seconds, BUILDINGS.fadeSeconds);
      // A form no longer drawn frees its instances, and so does one filled for a fade that never started, because another was under way and then the camera left.
      for (const level of LEVELS) if (ch.on[level] && !draws(ch.fade, level) && (released === level || want !== level)) free(ch, level);
      showFade(ch);
      if (ch.fade.next !== null) fading++;
      else if (ch.fade.shown !== want) waiting++;
    }
    // With time left, the flat forms not drawn are built ahead, or again if a building changed, nearest first, so a zoom out finds them ready.
    if (performance.now() - start < budgetMs) {
      const ahead: { c: number; ch: Chunk; d: number }[] = [];
      for (const [c, ch] of chunks) if (!ch.flatBuilt || ch.flatStale) ahead.push({ c, ch, d: chunkDistance(c, camera.x, camera.z) });
      ahead.sort((a, b) => a.d - b.d || a.c - b.c);
      for (const a of ahead) {
        if (performance.now() - start >= budgetMs) break;
        buildFlat(a.c, a.ch);
      }
    }
    stats = { ...stats, fading, waiting };
  }

  /** What each form drew, counting meshes in the camera's view. */
  function count(frustum: Frustum | undefined): Record<BuildingForm, FormStats> {
    const out = zeroStats();
    for (const m of models.values()) {
      for (const level of LEVELS) {
        const inst = m.levels[level];
        if (!inst.mesh || inst.count === 0) continue;
        out[level].meshes++;
        out[level].buildings += inst.count;
      }
    }
    for (const ch of chunks.values()) {
      for (const level of LEVELS) if (draws(ch.fade, level)) out[level].chunks++;
      const mesh = ch.flat;
      if (!mesh?.visible) continue;
      const bs = mesh.geometry.boundingSphere;
      if (frustum && bs && !frustum.intersectsSphere(sphere.copy(bs))) continue;
      out.flat.chunks++;
      out.flat.meshes++;
      out.flat.buildings += ch.ids.size;
    }
    return out;
  }

  return {
    reset() {
      mark(
        Array.from({ length: CHUNK_COUNT }, (_, c) => c),
        "rebuild",
      );
    },
    rebuild: (list) => mark(list, "rebuild"),
    apply: (list) => mark(list, "apply"),
    applyIds(ids) {
      for (const id of ids) pendingIds.add(id);
    },
    update(camera, budgetMs, view = { band: "street", seconds: Infinity }) {
      if (pendingIds.size > 0) {
        const ids = pendingIds;
        pendingIds = new Set();
        const list: number[] = [];
        for (const id of ids) {
          const p = placed.get(id);
          if (p) list.push(p.chunk);
          const now = source.buildingChunk(id);
          if (now >= 0) list.push(now);
        }
        mark(list, "apply");
      }
      whole.clear();
      const start = performance.now();
      const writesBefore = writes;
      const mergedBefore = merged;
      const wasDirty = dirty.size > 0;
      if (wasDirty) {
        const distance = (c: number) => {
          const ci = c % CHUNKS_PER_SIDE;
          const cj = (c - ci) / CHUNKS_PER_SIDE;
          return Math.hypot((ci + 0.5) * CHUNK_SIZE - camera.x, (cj + 0.5) * CHUNK_SIZE - camera.z);
        };
        const list = [...dirty.keys()].map((c) => ({ c, d: distance(c) })).sort((a, b) => a.d - b.d || a.c - b.c);
        let done = 0;
        for (const { c } of list) {
          if (done > 0 && performance.now() - start >= budgetMs) break;
          const mode = dirty.get(c) ?? "apply";
          dirty.delete(c);
          read(c, mode);
          done++;
        }
      }
      if (wasDirty) {
        batchWrites += writes - writesBefore;
        batchMs += performance.now() - start;
      }
      forms(camera, view, start, budgetMs);
      stats = {
        ...stats,
        buildings: placed.size,
        models: models.size,
        pending: dirty.size,
        totalWrites: writes,
        lastMerged: merged > mergedBefore ? merged - mergedBefore : stats.lastMerged,
        totalMerged: merged,
        mergedBytes,
        forms: count(view.frustum),
      };
      if (dirty.size === 0 && wasDirty) {
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
        const q = placed.get(id)?.corners;
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
    tintOf: (id) => placed.get(id)?.tint ?? null,
    formOf: (chunk) => chunks.get(chunk)?.fade.shown ?? null,
    stats: () => stats,
    dispose() {
      warm.mesh.geometry.dispose();
      warm.mesh.dispose();
      warmFlat.geometry.dispose();
      for (const m of models.values()) {
        for (const level of LEVELS) {
          m.levels[level].mesh?.geometry.dispose();
          m.levels[level].mesh?.dispose();
        }
      }
      for (const ch of chunks.values()) dropFlat(ch);
      root.removeFromParent();
      material.dispose();
      flats.dispose();
    },
  };
}
