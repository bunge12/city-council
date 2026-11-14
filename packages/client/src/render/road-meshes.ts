// Roads on screen: one merged mesh per 500 m chunk for each zoom band's
// layer, built from the mirror's copy of the road graph by road-geometry.ts.
// A chunk rebuilds only when a delta says a road it draws changed.
//
// Layers by zoom band (PRD, "Zoom bands"):
// - street: road surfaces, lane markings, crossings and one-way arrows, and
//   the traffic lights and yield signs at junctions (issue 87)
// - district: road surfaces, with markings and arrows while the camera is
//   below `ROADS.markingsBelow`
// - city: avenues and highways only, as lines of a fixed screen width
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
  Object3D,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CHUNKS_PER_SIDE, type Terrain } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { ROADS } from "./config";
import {
  PROP_STRIDE,
  RoadChunks,
  buildRoadChunk,
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
}

export interface RoadLayer {
  /** Draws `net` from scratch, as after a snapshot. Returns the chunks built. */
  show(net: RoadNet): number[];
  /** Rebuilds what a delta's changed rows touch. Returns the chunks rebuilt. */
  apply(nodeIds: readonly number[], segIds: readonly number[]): number[];
  /** Shows the layers for zoom band `band` with the camera `height` metres over the ground. */
  setBand(band: ZoomBand, height: number): void;
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
  const roots = { surface: new Group(), markings: new Group(), lines: new Group(), props: new Group() };
  roots.surface.name = "road surfaces";
  roots.markings.name = "road markings";
  roots.lines.name = "road lines";
  roots.props.name = "road props";
  for (const r of Object.values(roots)) parent.add(r);
  const materials = { surface: surfaceMaterial(), markings: markingMaterial(), lines: lineMaterial() };
  const propMaterial = new MeshLambertNodeMaterial({ vertexColors: true });
  propMaterial.name = "road props";
  const propGeometries = { signals: signalGeometry(), yields: yieldGeometry() };
  const dummy = new Object3D();

  /** One instanced mesh of `kind` standing at each prop in `data`, or null when there are none. */
  function instanced(kind: keyof typeof propGeometries, data: Float32Array): InstancedMesh | null {
    const count = data.length / PROP_STRIDE;
    if (count === 0) return null;
    const mesh = new InstancedMesh(propGeometries[kind], propMaterial, count);
    mesh.name = kind;
    // Lights and signs stand up off the road, so they cast shadows as trees do.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let k = 0; k < count; k++) {
      const o = k * PROP_STRIDE;
      dummy.position.set(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0);
      dummy.rotation.set(0, data[o + 3] ?? 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  const index = new RoadChunks();
  const chunks: (ChunkMeshes | null)[] = new Array<ChunkMeshes | null>(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE).fill(null);
  let net: RoadNet | null = null;
  /** Junctions of the network as it is now, for the decoration mask. */
  let current: (node: number) => Junction | null = () => null;
  let stats: RoadStats = { chunks: 0, segmentPieces: 0, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0, signals: 0, yields: 0 };

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
        if (chunks[c]) built.push(c);
      }
      stats = { ...counts(), lastRebuilt: built.length, totalRebuilt: 0, lastBuildMs: performance.now() - start };
      return built;
    },
    apply(nodeIds, segIds) {
      if (!net) return [];
      const start = performance.now();
      const dirty = [...index.apply(net, nodeIds, segIds)].sort((a, b) => a - b);
      const junctions = junctionCache(net);
      current = junctions;
      for (const c of dirty) build(c, junctions);
      stats = {
        ...counts(),
        lastRebuilt: dirty.length,
        totalRebuilt: stats.totalRebuilt + dirty.length,
        lastBuildMs: performance.now() - start,
      };
      return dirty;
    },
    setBand(band, height) {
      roots.surface.visible = band !== "city";
      roots.markings.visible = band !== "city" && height < ROADS.markingsBelow;
      roots.lines.visible = band === "city";
      roots.props.visible = band === "street";
    },
    stats: () => stats,
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
      for (let c = 0; c < chunks.length; c++) clear(c);
      for (const r of Object.values(roots)) r.removeFromParent();
      for (const m of Object.values(materials)) m.dispose();
      propMaterial.dispose();
      for (const g of Object.values(propGeometries)) g.dispose();
    },
  };
}
