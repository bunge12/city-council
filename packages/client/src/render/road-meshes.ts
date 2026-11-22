// Roads on screen: one merged mesh per 500 m chunk for each zoom band's
// layer, built from the mirror's copy of the road graph by road-geometry.ts.
// A chunk rebuilds only when a delta says a road it draws changed.
//
// Layers by zoom band (PRD, "Zoom bands"):
// - street: road surfaces, sidewalks, lane markings, crossings and one-way
//   arrows, the traffic lights and yield signs at junctions (issue 87), and
//   sidewalks and street lights near the camera (issue 151)
// - district: road surfaces, with markings, arrows and the sidewalks near
//   the camera while it is below `ROADS.markingsBelow`
// - city: avenues and highways only, as lines of a fixed screen width
//
// Sidewalks and street lights are a second pass per chunk, built only for
// chunks near the camera, a few each frame, and freed when it moves away
// (issue 151). A big city has millions of sidewalk vertices, and building
// them all with the roads doubled the time a 30,000 segment city took to
// show its roads.
//
// The renderer reads the mirror; it never writes it.

import { attribute, cameraPosition, max, positionLocal, vec3 } from "three/tsl";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  type Object3D,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type Terrain } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { ROADS } from "./config";
import {
  PROP_STRIDE,
  RoadChunks,
  buildRoadChunk,
  buildStreetChunk,
  propsWithin,
  tileMesh,
  junctionAt,
  neighbourhood,
  roadMask,
  type Junction,
  type MeshArrays,
  type RoadNet,
} from "./road-geometry";

/** What the road layer reports, for the debug panel and tests. */
export interface RoadStats {
  /** Chunks with any road mesh. */
  chunks: number;
  /** Road segments drawn, counted once per chunk they draw in. */
  segmentPieces: number;
  /** Chunks rebuilt by the last change, and since the network was shown. */
  lastRebuilt: number;
  totalRebuilt: number;
  /** Milliseconds the last change or full build took. */
  lastBuildMs: number;
  /** Traffic lights and yield signs standing, in every chunk. */
  signals: number;
  yields: number;
  /** Chunks with their sidewalks and street lights built, and the street lights in them. */
  streetChunks: number;
  lamps: number;
}

export interface RoadLayer {
  /** Draws `net` from scratch, as after a snapshot. Returns the chunks built. */
  show(net: RoadNet): number[];
  /** Rebuilds what a delta's changed rows touch. Returns the chunks rebuilt. */
  apply(nodeIds: readonly number[], segIds: readonly number[]): number[];
  /** Shows the layers for zoom band `band` with the camera `height` metres over the ground. */
  setBand(band: ZoomBand, height: number): void;
  /**
   * Builds the sidewalks and street lights of chunks near the camera at
   * (x, z), nearest first, for up to `budgetMs` milliseconds but at least
   * one chunk, and frees those it has left behind. Call each frame.
   */
  update(x: number, z: number, budgetMs: number): void;
  /** Chunks near the camera still waiting for their sidewalks and street lights, while they are shown. */
  pending(): number;
  stats(): RoadStats;
  /** Where decoration must not stand in `chunk`, or null if no road is near. See `roadMask`. */
  decorMask(chunk: number): Uint8Array | null;
  dispose(): void;
}

interface ChunkMeshes {
  meshes: Mesh[];
  /** Instanced props, which share their geometry with every chunk's. */
  props: InstancedMesh[];
  segments: number;
  signals: number;
  yields: number;
}

/** One tile of a chunk's sidewalks, and its square on the ground. */
interface SidewalkTile {
  mesh: Mesh;
  x0: number;
  z0: number;
}

/** A chunk's sidewalks and street lights. */
interface StreetMeshes {
  /** In tiles of `ROADS.sidewalks.tile` metres, each shown only near the camera. */
  sidewalks: SidewalkTile[];
  /** Holds every light in the chunk; only those near the camera are written in, `count` of them. */
  lamps: InstancedMesh | null;
  /** Every light in the chunk, `PROP_STRIDE` numbers apiece. */
  lampData: Float32Array;
  /** Where the camera was when the lights shown were chosen, or null before the first choice. */
  lampsAt: { x: number; z: number } | null;
}

/** Distance from the camera, in metres. Model matrices are the identity, so local is world. */
const distance = () => cameraPosition.distance(positionLocal);
const lift = () => distance().mul(ROADS.lift.perMetre).add(ROADS.lift.base);

function surfaceMaterial(): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial({ vertexColors: true });
  m.name = "road surface";
  m.positionNode = positionLocal.add(vec3(0, lift(), 0));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  return m;
}

/** Sidewalks: lit like the surface, and offset over it as the markings are, which never overlap them. */
function sidewalkMaterial(): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial({ vertexColors: true });
  m.name = "sidewalks";
  m.positionNode = positionLocal.add(vec3(0, lift(), 0));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -4;
  return m;
}

function markingMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ vertexColors: true });
  m.name = "road markings";
  m.positionNode = positionLocal.add(vec3(0, lift(), 0));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -4;
  return m;
}

function lineMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ vertexColors: true });
  m.name = "road lines";
  const side = attribute<"vec2">("lineSide", "vec2");
  const half = attribute<"float">("lineHalfWidth", "float");
  const width = max(half, distance().mul(ROADS.cityLines.perMetre));
  m.positionNode = positionLocal.add(vec3(side.x.mul(width), lift(), side.y.mul(width)));
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  return m;
}

/** Paints every vertex of `g` one colour, as a `color` attribute, and drops its uvs. */
function paint(g: BufferGeometry, hex: number): BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.deleteAttribute("uv");
  const c = new Color(hex);
  const n = flat.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) colors.set([c.r, c.g, c.b], v * 3);
  flat.setAttribute("color", new BufferAttribute(colors, 3));
  return flat;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts);
  if (!g) throw new Error("prop geometry parts do not match");
  for (const p of parts) p.dispose();
  return g;
}

/**
 * A flat plate of corners `points` (x, y pairs in its plane, in order round
 * it), facing +z at depth `z`, with a back facing -z just behind it.
 */
function plate(points: readonly number[], z: number, front: number, back: number): BufferGeometry[] {
  const faces: BufferGeometry[] = [];
  for (const [dz, hex, flip] of [
    [z, front, false],
    [z - 0.02, back, true],
  ] as const) {
    const pos: number[] = [];
    const n = points.length / 2;
    for (let k = 1; k + 1 < n; k++) {
      const tri = [0, k, k + 1];
      if (flip) tri.reverse();
      for (const v of tri) pos.push(points[v * 2] ?? 0, points[v * 2 + 1] ?? 0, dz);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    faces.push(paint(g, hex));
  }
  return faces;
}

/**
 * A traffic light: a pole at the origin, a mast arm reaching along -x over
 * the road, and a signal head at its end and one on the pole, both facing
 * +z, toward the traffic they control.
 */
function signalGeometry(): BufferGeometry {
  const s = ROADS.props.signal;
  const top = s.poleHeight;
  const head = (x: number, y: number) => [
    paint(new BoxGeometry(0.4, 1.1, 0.3).translate(x, y, 0), s.housing),
    paint(new BoxGeometry(0.32, 1.0, 0.04).translate(x, y, 0.16), s.head),
    paint(new BoxGeometry(0.2, 0.2, 0.04).translate(x, y + 0.32, 0.19), s.red),
    paint(new BoxGeometry(0.2, 0.2, 0.04).translate(x, y, 0.19), s.amber),
    paint(new BoxGeometry(0.2, 0.2, 0.04).translate(x, y - 0.32, 0.19), s.green),
  ];
  return merged([
    paint(new CylinderGeometry(0.11, 0.14, top, 6, 1, true).translate(0, top / 2, 0), s.pole),
    paint(new BoxGeometry(s.mast, 0.14, 0.14).translate(-s.mast / 2, top - 0.25, 0), s.pole),
    ...head(-s.mast + 0.4, top - 0.95),
    ...head(-0.32, 3.0),
  ]);
}

/** A yield sign: a post at the origin and a red and white triangle, point down, facing +z. */
function yieldGeometry(): BufferGeometry {
  const y = ROADS.props.yield;
  const r = y.size / Math.sqrt(3);
  const c = y.poleHeight + r / 2;
  // A triangle of side `size` about (0, c), point down; the inner one is white.
  const tri = (k: number) => [-(y.size / 2) * k, c + (r / 2) * k, 0, c - r * k, (y.size / 2) * k, c + (r / 2) * k];
  return merged([
    paint(new CylinderGeometry(0.04, 0.04, c, 5, 1, true).translate(0, c / 2, -0.06), y.pole),
    ...plate(tri(1), 0, y.red, y.back),
    ...plate(tri(0.55), 0.01, y.white, y.back),
  ]);
}

/**
 * A street light: a pole at the origin and an arm reaching along +x, over
 * the road, with the lamp's head at its end and the lens under it.
 */
function lampGeometry(): BufferGeometry {
  const l = ROADS.lamps;
  const top = l.poleHeight;
  return merged([
    paint(new CylinderGeometry(0.08, 0.12, top, 5, 1, true).translate(0, top / 2, 0), l.pole),
    paint(new BoxGeometry(l.arm, 0.1, 0.1).translate(l.arm / 2, top - 0.1, 0), l.pole),
    paint(new BoxGeometry(0.7, 0.18, 0.32).translate(l.arm, top - 0.12, 0), l.head),
    paint(new BoxGeometry(0.56, 0.04, 0.24).translate(l.arm, top - 0.23, 0), l.lens),
  ]);
}

/** Furthest a vertex moves in the shader, in metres, so frustum culling allows for it. */
const SHADER_REACH = 40;

function geometryOf(a: MeshArrays): BufferGeometry | null {
  if (a.indices.length === 0) return null;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(a.positions, 3));
  g.setAttribute("color", new BufferAttribute(a.colors, 3));
  if (a.normals.length > 0) g.setAttribute("normal", new BufferAttribute(a.normals, 3));
  if (a.sides.length > 0) {
    g.setAttribute("lineSide", new BufferAttribute(a.sides, 2));
    g.setAttribute("lineHalfWidth", new BufferAttribute(a.halves, 1));
  }
  g.setIndex(new BufferAttribute(a.indices, 1));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += SHADER_REACH;
  return g;
}

export function createRoadLayer(terrain: Terrain, parent: Object3D): RoadLayer {
  const roots = { surface: new Group(), sidewalks: new Group(), markings: new Group(), lines: new Group(), props: new Group() };
  roots.surface.name = "road surfaces";
  roots.sidewalks.name = "sidewalks";
  roots.markings.name = "road markings";
  roots.lines.name = "road lines";
  roots.props.name = "road props";
  for (const r of Object.values(roots)) parent.add(r);
  const materials = { surface: surfaceMaterial(), sidewalks: sidewalkMaterial(), markings: markingMaterial(), lines: lineMaterial() };
  const propMaterial = new MeshLambertNodeMaterial({ vertexColors: true });
  propMaterial.name = "road props";
  const propGeometries = { signals: signalGeometry(), yields: yieldGeometry(), lamps: lampGeometry() };

  /** Stands the first `count` instances of `mesh` at the first `count` props in `data`. */
  function place(mesh: InstancedMesh, data: Float32Array, count: number): void {
    const m = mesh.instanceMatrix.array;
    for (let k = 0; k < count; k++) {
      const o = k * PROP_STRIDE;
      const yaw = data[o + 3] ?? 0;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      m.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, 1], k * 16);
    }
    mesh.count = count;
    // Only the rows written: a chunk's lights are chosen again as the camera moves (issue 264).
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** One instanced mesh of `kind` standing at each prop in `data`, or null when there are none. */
  function instanced(kind: keyof typeof propGeometries, data: Float32Array): InstancedMesh | null {
    const count = data.length / PROP_STRIDE;
    if (count === 0) return null;
    const mesh = new InstancedMesh(propGeometries[kind], propMaterial, count);
    mesh.name = kind;
    // Lights and signs stand up off the road, so they cast shadows as trees do.
    // Street lights cast none: a big city has a hundred thousand of them.
    mesh.castShadow = kind !== "lamps";
    mesh.receiveShadow = true;
    // A turn about y and a move, written straight into the matrix: a street
    // light per 17 m of road makes this the most instances a chunk sets.
    place(mesh, data, count);
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  const index = new RoadChunks();
  const chunks: (ChunkMeshes | null)[] = new Array<ChunkMeshes | null>(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE).fill(null);
  let net: RoadNet | null = null;
  /** Junctions of the network as it is now, for the decoration mask. */
  let current: (node: number) => Junction | null = () => null;
  let stats: RoadStats = { chunks: 0, segmentPieces: 0, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0, signals: 0, yields: 0, streetChunks: 0, lamps: 0 };
  const street: (StreetMeshes | null)[] = new Array<StreetMeshes | null>(chunks.length).fill(null);
  /** Whether sidewalks show at all: in the street band, and the district band below `ROADS.markingsBelow`. */
  let streetShown = false;
  /** Where the camera was at the last `update`, across the ground. */
  let eye: { x: number; z: number } | null = null;
  /** Ground distance from the camera to the nearest point of chunk `c`, squared. */
  const reach = (c: number): number => {
    if (!eye) return Infinity;
    const cx = ((c % CHUNKS_PER_SIDE) + 0.5) * CHUNK_SIZE;
    const cz = (Math.floor(c / CHUNKS_PER_SIDE) + 0.5) * CHUNK_SIZE;
    const dx = Math.max(0, Math.abs(eye.x - cx) - CHUNK_SIZE / 2);
    const dz = Math.max(0, Math.abs(eye.z - cz) - CHUNK_SIZE / 2);
    return dx * dx + dz * dz;
  };
  const hasRoads = (c: number) => (index.chunkSegs[c]?.size ?? 0) > 0 || (index.chunkNodes[c]?.size ?? 0) > 0;
  /** Chunks near the camera with roads and no street furniture yet, nearest first. */
  const wanted = (): number[] => {
    if (!streetShown || !net) return [];
    const within = ROADS.sidewalks.buildWithin * ROADS.sidewalks.buildWithin;
    const out: number[] = [];
    for (let c = 0; c < chunks.length; c++) if (!street[c] && hasRoads(c) && reach(c) <= within) out.push(c);
    return out.sort((a, b) => reach(a) - reach(b) || a - b);
  };

  function clearStreet(c: number): void {
    const old = street[c];
    if (!old) return;
    for (const t of old.sidewalks) {
      t.mesh.removeFromParent();
      t.mesh.geometry.dispose();
    }
    if (old.lamps) {
      old.lamps.removeFromParent();
      old.lamps.dispose();
    }
    street[c] = null;
  }

  function buildStreet(c: number): void {
    clearStreet(c);
    if (!net) return;
    const g = buildStreetChunk(net, terrain, c, index.chunkSegs[c] ?? [], index.chunkNodes[c] ?? [], current);
    const name = `${c % CHUNKS_PER_SIDE},${Math.floor(c / CHUNKS_PER_SIDE)}`;
    const size = ROADS.sidewalks.tile;
    const x0 = (c % CHUNKS_PER_SIDE) * CHUNK_SIZE;
    const z0 = Math.floor(c / CHUNKS_PER_SIDE) * CHUNK_SIZE;
    const sidewalks: SidewalkTile[] = [];
    for (const tile of tileMesh(g.sidewalks, x0, z0, size, Math.ceil(CHUNK_SIZE / size))) {
      const geometry = geometryOf(tile.arrays);
      if (!geometry) continue;
      const mesh = new Mesh(geometry, materials.sidewalks);
      mesh.name = `sidewalks ${name} ${tile.col},${tile.row}`;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 2;
      mesh.receiveShadow = true;
      roots.sidewalks.add(mesh);
      sidewalks.push({ mesh, x0: x0 + tile.col * size, z0: z0 + tile.row * size });
    }
    const lamps = instanced("lamps", g.lamps);
    if (lamps) {
      lamps.name = `lamps ${name}`;
      roots.props.add(lamps);
    }
    // An empty entry still marks the chunk built, so it is not tried again each frame.
    const built: StreetMeshes = { sidewalks, lamps, lampData: g.lamps, lampsAt: null };
    street[c] = built;
    showNear(built);
  }

  /** How far the camera moves before a chunk's street lights are chosen again, in metres. */
  const LAMPS_EVERY = 10;
  /** Scratch for the street lights shown in a chunk. */
  let nearLamps = new Float32Array(0);

  /**
   * Shows only the parts of `s` within `ROADS.sidewalks.drawWithin` of the
   * camera across the ground: the sidewalk tiles with any of their square
   * that near, and the street lights standing that near (issue 264). A
   * software renderer pays for every vertex it is given, drawn or not.
   */
  function showNear(s: StreetMeshes): void {
    if (!eye) return;
    const r = ROADS.sidewalks.drawWithin;
    const size = ROADS.sidewalks.tile;
    for (const t of s.sidewalks) {
      const dx = Math.max(0, t.x0 - eye.x, eye.x - (t.x0 + size));
      const dz = Math.max(0, t.z0 - eye.z, eye.z - (t.z0 + size));
      t.mesh.visible = dx * dx + dz * dz <= r * r;
    }
    if (!s.lamps) return;
    if (s.lampsAt && Math.hypot(s.lampsAt.x - eye.x, s.lampsAt.z - eye.z) < LAMPS_EVERY) return;
    if (nearLamps.length < s.lampData.length) nearLamps = new Float32Array(s.lampData.length);
    const n = propsWithin(s.lampData, eye.x, eye.z, r, nearLamps);
    const all = s.lampData.length / PROP_STRIDE;
    // None then and none now, or all then and all now: the same lights, so nothing to send.
    if (!(s.lampsAt && n === s.lamps.count && (n === 0 || n === all))) place(s.lamps, nearLamps, n);
    s.lampsAt = { x: eye.x, z: eye.z };
  }

  function clear(c: number): void {
    const old = chunks[c];
    if (!old) return;
    for (const mesh of old.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    for (const mesh of old.props) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    chunks[c] = null;
  }

  function build(c: number, junctions: (node: number) => Junction | null): void {
    clear(c);
    if (!net) return;
    const segs = index.chunkSegs[c] ?? new Set<number>();
    const nodes = index.chunkNodes[c] ?? new Set<number>();
    if (segs.size === 0 && nodes.size === 0) return;
    const g = buildRoadChunk(net, terrain, c, segs, nodes, junctions);
    const meshes: Mesh[] = [];
    for (const layer of ["surface", "markings", "lines"] as const) {
      const geometry = geometryOf(g[layer]);
      if (!geometry) continue;
      const mesh = new Mesh(geometry, materials[layer]);
      mesh.name = `${layer} ${c % CHUNKS_PER_SIDE},${Math.floor(c / CHUNKS_PER_SIDE)}`;
      mesh.matrixAutoUpdate = false;
      // Over the terrain and the water, which draws after the terrain.
      mesh.renderOrder = 2;
      // Road surfaces take the sun's shadows. They cast none: they lie flat on the ground.
      mesh.receiveShadow = layer === "surface";
      roots[layer].add(mesh);
      meshes.push(mesh);
    }
    const props: InstancedMesh[] = [];
    for (const kind of ["signals", "yields"] as const) {
      const mesh = instanced(kind, g[kind]);
      if (!mesh) continue;
      mesh.name = `${kind} ${c % CHUNKS_PER_SIDE},${Math.floor(c / CHUNKS_PER_SIDE)}`;
      roots.props.add(mesh);
      props.push(mesh);
    }
    const signals = g.signals.length / PROP_STRIDE;
    const yields = g.yields.length / PROP_STRIDE;
    if (meshes.length > 0 || props.length > 0) chunks[c] = { meshes, props, segments: g.segments, signals, yields };
  }

  /** Junctions computed once per batch: the network does not change while a batch builds. */
  function junctionCache(current: RoadNet): (node: number) => Junction | null {
    const cache = new Map<number, Junction | null>();
    return (node) => {
      let j = cache.get(node);
      if (j === undefined) {
        j = junctionAt(current, node);
        cache.set(node, j);
      }
      return j;
    };
  }

  function counts(): Pick<RoadStats, "chunks" | "segmentPieces" | "signals" | "yields"> {
    let n = 0;
    let pieces = 0;
    let signals = 0;
    let yields = 0;
    for (const c of chunks) {
      if (!c) continue;
      n++;
      pieces += c.segments;
      signals += c.signals;
      yields += c.yields;
    }
    return { chunks: n, segmentPieces: pieces, signals, yields };
  }

  function streetCounts(): Pick<RoadStats, "streetChunks" | "lamps"> {
    let n = 0;
    let lamps = 0;
    for (const c of street) {
      if (!c) continue;
      n++;
      lamps += c.lampData.length / PROP_STRIDE;
    }
    return { streetChunks: n, lamps };
  }

  return {
    show(next) {
      const start = performance.now();
      net = next;
      index.reset(next);
      const junctions = junctionCache(next);
      current = junctions;
      const built: number[] = [];
      for (let c = 0; c < chunks.length; c++) {
        build(c, junctions);
        clearStreet(c);
        if (chunks[c]) built.push(c);
      }
      stats = { ...counts(), ...streetCounts(), lastRebuilt: built.length, totalRebuilt: 0, lastBuildMs: performance.now() - start };
      return built;
    },
    apply(nodeIds, segIds) {
      if (!net) return [];
      const start = performance.now();
      const dirty = [...index.apply(net, nodeIds, segIds)].sort((a, b) => a - b);
      const junctions = junctionCache(net);
      current = junctions;
      for (const c of dirty) {
        build(c, junctions);
        // Built again at once where it stands, so an edit near the camera never leaves a gap for a frame.
        if (street[c]) buildStreet(c);
      }
      stats = {
        ...counts(),
        ...streetCounts(),
        lastRebuilt: dirty.length,
        totalRebuilt: stats.totalRebuilt + dirty.length,
        lastBuildMs: performance.now() - start,
      };
      return dirty;
    },
    setBand(band, height) {
      roots.surface.visible = band !== "city";
      streetShown = band !== "city" && height < ROADS.markingsBelow;
      roots.sidewalks.visible = streetShown;
      roots.markings.visible = band !== "city" && height < ROADS.markingsBelow;
      roots.lines.visible = band === "city";
      roots.props.visible = band === "street";
    },
    update(x, z, budgetMs) {
      eye = { x, z };
      const keep = ROADS.sidewalks.keepWithin * ROADS.sidewalks.keepWithin;
      for (let c = 0; c < street.length; c++) if (street[c] && reach(c) > keep) clearStreet(c);
      for (const s of street) if (s) showNear(s);
      const todo = wanted();
      if (todo.length === 0) return;
      const start = performance.now();
      for (const c of todo) {
        buildStreet(c);
        if (performance.now() - start >= budgetMs) break;
      }
    },
    pending: () => wanted().length,
    stats: () => ({ ...stats, ...streetCounts() }),
    decorMask(chunk) {
      if (!net) return null;
      const near = new Set<number>();
      const rings: number[][] = [];
      for (const c of neighbourhood(chunk)) {
        for (const s of index.chunkSegs[c] ?? []) near.add(s);
        for (const node of index.chunkNodes[c] ?? []) {
          const ring = current(node)?.ring;
          if (ring && ring.length >= 6) rings.push(ring);
        }
      }
      return near.size === 0 ? null : roadMask(net, chunk, near, rings);
    },
    dispose() {
      for (let c = 0; c < chunks.length; c++) {
        clear(c);
        clearStreet(c);
      }
      for (const r of Object.values(roots)) r.removeFromParent();
      for (const m of Object.values(materials)) m.dispose();
      propMaterial.dispose();
      for (const g of Object.values(propGeometries)) g.dispose();
    },
  };
}
