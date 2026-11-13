// Roads on screen: one merged mesh per 500 m chunk for each zoom band's
// layer, built from the mirror's copy of the road graph by road-geometry.ts.
// A chunk rebuilds only when a delta says a road it draws changed.
//
// Layers by zoom band (PRD, "Zoom bands"):
// - street: road surfaces, lane markings and one-way arrows
// - district: road surfaces, with markings and arrows while the camera is
//   below `ROADS.markingsBelow`
// - city: avenues and highways only, as lines of a fixed screen width
//
// The renderer reads the mirror; it never writes it.

import { attribute, cameraPosition, max, positionLocal, vec3 } from "three/tsl";
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicNodeMaterial, MeshLambertNodeMaterial, type Object3D } from "three/webgpu";
import { CHUNKS_PER_SIDE, type Terrain } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { ROADS } from "./config";
import {
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
  segments: number;
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
  const roots = { surface: new Group(), markings: new Group(), lines: new Group() };
  roots.surface.name = "road surfaces";
  roots.markings.name = "road markings";
  roots.lines.name = "road lines";
  for (const r of Object.values(roots)) parent.add(r);
  const materials = { surface: surfaceMaterial(), markings: markingMaterial(), lines: lineMaterial() };

  const index = new RoadChunks();
  const chunks: (ChunkMeshes | null)[] = new Array<ChunkMeshes | null>(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE).fill(null);
  let net: RoadNet | null = null;
  let stats: RoadStats = { chunks: 0, segmentPieces: 0, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0 };

  function clear(c: number): void {
    const old = chunks[c];
    if (!old) return;
    for (const mesh of old.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
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
      roots[layer].add(mesh);
      meshes.push(mesh);
    }
    if (meshes.length > 0) chunks[c] = { meshes, segments: g.segments };
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

  function counts(): Pick<RoadStats, "chunks" | "segmentPieces"> {
    let n = 0;
    let pieces = 0;
    for (const c of chunks) {
      if (!c) continue;
      n++;
      pieces += c.segments;
    }
    return { chunks: n, segmentPieces: pieces };
  }

  return {
    show(next) {
      const start = performance.now();
      net = next;
      index.reset(next);
      const junctions = junctionCache(next);
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
    },
    stats: () => stats,
    decorMask(chunk) {
      if (!net) return null;
      const near = new Set<number>();
      for (const c of neighbourhood(chunk)) for (const s of index.chunkSegs[c] ?? []) near.add(s);
      return near.size === 0 ? null : roadMask(net, chunk, near);
    },
    dispose() {
      for (let c = 0; c < chunks.length; c++) clear(c);
      for (const r of Object.values(roots)) r.removeFromParent();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}
