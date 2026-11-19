// Issue M2-12: building rendering. The theme's generators and palettes, a
// building's tint and place, and the instanced layer that draws them.
import { describe, expect, it } from "vitest";
import { Scene } from "three/webgpu";
import { BUILDING_TYPES, CHUNKS_PER_SIDE, CHUNK_SIZE, ZONING_BALANCE, type BuildingInfo } from "@city-council/sim";
import { createBuildingLayer, type BuildingSource } from "../src/render/building-meshes";
import { placeLot } from "../src/render/building-place";
import { hashId, tintFor } from "../src/render/building-tint";
import { MASK_GRASS, MASK_SIDE, MASK_TREES } from "../src/render/road-geometry";
import { BUILDINGS, CELLS, CONSTRUCTION, ROADS } from "../src/render/config";
import { FACADE, SURFACE } from "../src/theme/model";
import { NORTH_AMERICAN } from "../src/theme/north-american";
import { BASE_DEPTH } from "../src/theme/north-american/generators";

const CELL = ZONING_BALANCE.cellSize;
const theme = NORTH_AMERICAN;

describe("the North American theme", () => {
  it("has three or more models for every type, and so for every zone and density", () => {
    for (const t of BUILDING_TYPES) expect(theme.modelCount(t.id), t.id).toBeGreaterThanOrEqual(3);
  });

  it("builds every model of every type at every width it comes in, inside its lot", () => {
    for (const t of BUILDING_TYPES) {
      const depth = theme.modelDepth(t.id);
      expect(depth, t.id).toBeGreaterThanOrEqual(t.depth[0]);
      expect(depth, t.id).toBeLessThanOrEqual(t.depth[1]);
      for (let model = 0; model < theme.modelCount(t.id); model++) {
        for (let w = t.width[0]; w <= t.width[1]; w++) {
          const label = `${t.id} model ${model} width ${w}`;
          const m = theme.model(t.id, model, w, depth);
          const n = m.positions.length / 3;
          expect(n, label).toBeGreaterThan(0);
          expect(m.normals.length, label).toBe(n * 3);
          expect(m.surfaces.length, label).toBe(n);
          expect(m.facades.length, label).toBe(n * 4);
          expect(m.indices.length % 3, label).toBe(0);
          expect(Math.max(...m.indices), label).toBeLessThan(n);
          // Inside the lot, give or take an eave, and down to the base below the ground.
          const half = { x: (w * CELL) / 2 + 0.5, z: (depth * CELL) / 2 + 0.5 };
          let top = 0;
          for (let v = 0; v < n; v++) {
            const x = m.positions[v * 3] ?? NaN;
            const y = m.positions[v * 3 + 1] ?? NaN;
            const z = m.positions[v * 3 + 2] ?? NaN;
            expect(Math.abs(x) <= half.x && Math.abs(z) <= half.z && y >= -BASE_DEPTH - 1e-6, `${label}: vertex at ${x}, ${y}, ${z}`).toBe(true);
            top = Math.max(top, y);
            const len = Math.hypot(m.normals[v * 3] ?? 0, m.normals[v * 3 + 1] ?? 0, m.normals[v * 3 + 2] ?? 0);
            expect(Math.abs(len - 1), label).toBeLessThan(1e-5);
          }
          expect(top, label).toBeGreaterThan(2.5);
          // Every model marks the surfaces a building tints.
          const surfaces = new Set(m.surfaces);
          expect(surfaces.has(SURFACE.wall), label).toBe(true);
          expect(surfaces.has(SURFACE.roof), label).toBe(true);
        }
      }
    }
  });

  it("winds every face so its normal points out of the model", () => {
    const m = theme.model("warehouse", 1, 3, theme.modelDepth("warehouse"));
    const at = (k: number, axis: number) => m.positions[k * 3 + axis] ?? 0;
    for (let i = 0; i < m.indices.length; i += 3) {
      const a = m.indices[i] ?? 0;
      const b = m.indices[i + 1] ?? 0;
      const c = m.indices[i + 2] ?? 0;
      const [ux, uy, uz] = [at(b, 0) - at(a, 0), at(b, 1) - at(a, 1), at(b, 2) - at(a, 2)];
      const [vx, vy, vz] = [at(c, 0) - at(a, 0), at(c, 1) - at(a, 1), at(c, 2) - at(a, 2)];
      const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as const;
      const n = [m.normals[a * 3] ?? 0, m.normals[a * 3 + 1] ?? 0, m.normals[a * 3 + 2] ?? 0] as const;
      // Counter-clockwise seen from outside: the winding's normal is the face's.
      expect(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2]).toBeGreaterThan(0);
    }
  });

  it("gives walls a facade pattern and roofs none", () => {
    const m = theme.model("apartments", 0, 3, theme.modelDepth("apartments"));
    const kinds = new Set<number>();
    for (let v = 0; v < m.surfaces.length; v++) {
      const kind = m.facades[v * 4 + 3] ?? 0;
      if (m.surfaces[v] === SURFACE.roof) expect(kind).toBe(FACADE.none);
      kinds.add(kind);
    }
    expect(kinds.has(FACADE.windows)).toBe(true);
  });

  it("has a palette with wall, roof and trim colours for every type", () => {
    for (const t of BUILDING_TYPES) {
      const p = theme.palette(t.id);
      for (const part of [p.wall, p.roof, p.trim]) {
        expect(part.length, t.id).toBeGreaterThan(0);
        for (const c of part) expect(Number.isInteger(c) && c >= 0 && c <= 0xffffff, t.id).toBe(true);
      }
    }
  });
});

describe("a building's tint", () => {
  it("is a function of the id alone", () => {
    const palette = theme.palette("single-family-home");
    // The same id gives the same colours however often it is asked, and the
    // numbers are fixed: they may not move between versions of the game
    // without every street changing colour.
    expect(tintFor(7, palette)).toEqual(tintFor(7, palette));
    expect(hashId(0)).toBe(hashId(0));
    expect([hashId(0), hashId(1), hashId(123456)]).toEqual([493009611, 1059954845, 380219111]);
    // Whatever else the row says, the layer tints by id: see "draws a building's colours from its id" below.
  });

  it("varies from one id to the next", () => {
    const palette = theme.palette("single-family-home");
    const seen = new Set<string>();
    let sameAsNext = 0;
    for (let id = 0; id < 200; id++) {
      const t = JSON.stringify(tintFor(id, palette));
      seen.add(t);
      if (t === JSON.stringify(tintFor(id + 1, palette))) sameAsNext++;
    }
    expect(seen.size).toBeGreaterThan(50);
    expect(sameAsNext).toBeLessThan(5);
  });
});

/** The corners of a w x d metre lot with its front on the road at z = z0, running from x0, facing -z. */
function lot(x0: number, z0: number, w: number, d: number): number[] {
  // Road edge first column, its back, the back of the last column, its road edge.
  return [x0, z0, x0, z0 + d, x0 + w, z0 + d, x0 + w, z0];
}

describe("where a building stands", () => {
  it("stands in the middle of its lot, faces the road and takes the lot's size", () => {
    const p = placeLot(lot(100, 200, 16, 32), () => 5);
    expect(p.x).toBe(108);
    expect(p.z).toBe(216);
    expect(p.width).toBe(16);
    expect(p.depth).toBe(32);
    // The road is at -z: the model's front, +z, turns to face it.
    expect(Math.sin(p.angle)).toBeCloseTo(0);
    expect(Math.cos(p.angle)).toBeCloseTo(-1);
    expect(p.y).toBe(5);
  });

  it("stands at the highest ground under its lot", () => {
    const p = placeLot(lot(0, 0, 16, 32), (x, z) => x * 0.1 + z * 0.2);
    // Near the high corner (16, 32), a little in from it.
    expect(p.y).toBeGreaterThan(7);
    expect(p.y).toBeLessThan(16 * 0.1 + 32 * 0.2);
  });
});

/** A fake mirror: buildings by id, filed by the chunk of their lot's centre. */
function fakeSource() {
  const rows = new Map<number, BuildingInfo>();
  const chunkOf = (b: BuildingInfo) => {
    const c = b.corners ?? [];
    const x = ((c[0] ?? 0) + (c[4] ?? 0)) / 2;
    const z = ((c[1] ?? 0) + (c[5] ?? 0)) / 2;
    return Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);
  };
  const source: BuildingSource = {
    buildingsInChunk: (chunk) => [...rows.values()].filter((b) => chunkOf(b) === chunk).sort((a, b) => a.id - b.id),
    buildingChunk: (id) => {
      const b = rows.get(id);
      return b ? chunkOf(b) : -1;
    },
  };
  const house = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  const put = (id: number, x: number, z: number, variant = 0, type = house) => {
    const info: BuildingInfo = {
      id,
      firstSeg: 0,
      firstSide: 0,
      firstPlace: 0,
      dir: 0,
      width: 2,
      depth: 3,
      backSeg: 0,
      backSide: 0,
      backPlace: 0,
      backDir: 0,
      backDepth: 0,
      zone: 1,
      density: 1,
      type,
      residents: 3,
      variant,
      builtAt: 0,
      corners: lot(x, z, 2 * CELL, 3 * CELL),
      chunk: 0,
    };
    info.chunk = chunkOf(info);
    rows.set(id, info);
    return info.chunk;
  };
  return { source, rows, put };
}

/**
 * Runs the layer's frame work until nothing waits, with the camera over
 * (4000, 4000) in the street band, so the chunks there are drawn in full.
 */
function settle(layer: ReturnType<typeof createBuildingLayer>, camera = { x: 4000, z: 4000 }): void {
  layer.update(camera, 1000);
  for (let k = 0; k < 1000 && (layer.stats().pending > 0 || layer.stats().waiting > 0); k++) layer.update(camera, 1000);
}

describe("the building layer", () => {
  it("draws every building after a snapshot, one instanced mesh per model", () => {
    const { source, put } = fakeSource();
    for (let id = 0; id < 10; id++) put(id, 4000 + id * 16, 4000, id % 2);
    const scene = new Scene();
    const layer = createBuildingLayer(scene, source, theme, () => 0);
    layer.reset();
    settle(layer);
    const s = layer.stats();
    expect(s.buildings).toBe(10);
    expect(s.models).toBe(2);
    // Near the camera: every building has an instance, written once when its chunk was first drawn in full.
    expect(s.totalWrites).toBe(10);
    expect(s.forms.full).toMatchObject({ buildings: 10, meshes: 2 });
    expect(s.lastRebuilt).toBe(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE);
    layer.dispose();
  });

  it("writes one instance and rebuilds no chunk for a building that comes, and fills a gap when one goes", () => {
    const { source, rows, put } = fakeSource();
    for (let id = 0; id < 5; id++) put(id, 4000 + id * 16, 4000);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    settle(layer);
    const chunk = put(5, 4000 + 5 * 16, 4000);
    layer.apply([chunk]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 6, lastWrites: 1, lastRebuilt: 0 });
    // Removing one in the middle moves the last instance into its place: one write.
    rows.delete(2);
    layer.apply([chunk]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 5, lastWrites: 1, lastRebuilt: 0 });
    expect(layer.tintOf(2)).toBeNull();
    // Removing the one in the last instance moves nothing. Building 5 took 2's place, so 4 is last.
    rows.delete(4);
    layer.apply([chunk]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 4, lastWrites: 0, lastRebuilt: 0 });
    // A building that came with a change of roads, named by id alone, is found and written.
    put(6, 4000 + 6 * 16, 4000);
    layer.applyIds([6]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 5, lastWrites: 1, lastRebuilt: 0 });
    rows.delete(6);
    // A lot that moved with its row unchanged, as when a road widens, is placed again.
    const moved = rows.get(0);
    if (moved?.corners) moved.corners = moved.corners.map((v, i) => (i % 2 === 1 ? v + 2 : v));
    layer.apply([chunk]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 4, lastWrites: 1, lastRebuilt: 0 });
    // A change of roads places every building in the chunk again.
    layer.rebuild([chunk]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 4, lastWrites: 4, lastRebuilt: 1 });
    layer.dispose();
  });

  it("counts the instance of a building that comes to a chunk with none, written when the chunk is filled (issue #222)", () => {
    const { source, put } = fakeSource();
    put(0, 4000, 4000);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    settle(layer);
    // The chunk next door had no building, so it is not drawn in full until the frame's forms fill it.
    const chunk = put(1, 4000 + CHUNK_SIZE, 4000);
    expect(chunk).not.toBe(source.buildingChunk(0));
    const before = layer.stats().totalWrites;
    layer.apply([chunk]);
    settle(layer);
    expect(layer.stats().totalWrites - before).toBe(1);
    expect(layer.stats()).toMatchObject({ buildings: 2, lastWrites: 1, lastRebuilt: 0 });
    layer.dispose();
  });

  it("grows a model's mesh past its first size and keeps every instance", () => {
    const { source, put } = fakeSource();
    for (let id = 0; id < 40; id++) put(id, 1000 + (id % 20) * 16, 1000 + Math.floor(id / 20) * 48);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    settle(layer, { x: 1000, z: 1000 });
    expect(layer.stats().forms.full.buildings).toBe(40);
    expect(layer.stats().buildings).toBe(40);
    expect(layer.stats().models).toBe(1);
    for (let id = 0; id < 40; id++) expect(layer.tintOf(id)).not.toBeNull();
    layer.dispose();
  });

  it("draws a building's colours from its id, whatever its model or place", () => {
    const one = fakeSource();
    const two = fakeSource();
    one.put(9, 4000, 4000, 0);
    two.put(9, 6000, 2000, 1);
    const a = createBuildingLayer(new Scene(), one.source, theme, () => 0);
    const b = createBuildingLayer(new Scene(), two.source, theme, () => 50);
    for (const l of [a, b]) {
      l.reset();
      settle(l);
    }
    expect(a.tintOf(9)).toEqual(tintFor(9, theme.palette("single-family-home")));
    expect(b.tintOf(9)).toEqual(a.tintOf(9));
    a.dispose();
    b.dispose();
  });

  it("keeps decoration off the lots it draws and trees off the ground round them, and says which chunks they touch", () => {
    const { source, put } = fakeSource();
    const chunk = put(1, 4004, 4004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    expect(layer.lotMask(chunk)).toBeNull();
    layer.reset();
    settle(layer);
    // The lot is 4 m from the chunk lines at x = 4000 and z = 4000, inside the trees' clearance, so the chunks over them are named too.
    expect(BUILDINGS.treeClearance).toBeGreaterThan(4);
    expect(layer.takeLotChunks().sort((a, b) => a - b)).toEqual([chunk - CHUNKS_PER_SIDE - 1, chunk - CHUNKS_PER_SIDE, chunk - 1, chunk]);
    expect(layer.takeLotChunks()).toEqual([]);
    expect(layer.lotMask(chunk - 1)).not.toBeNull();
    const mask = layer.lotMask(chunk);
    expect(mask).not.toBeNull();
    const ci = chunk % CHUNKS_PER_SIDE;
    const cj = Math.floor(chunk / CHUNKS_PER_SIDE);
    const at = (x: number, z: number) => mask?.[Math.floor((z - cj * CHUNK_SIZE) / ROADS.maskCell) * MASK_SIDE + Math.floor((x - ci * CHUNK_SIZE) / ROADS.maskCell)] ?? 0;
    expect(at(4010, 4010) & MASK_TREES).toBe(MASK_TREES);
    expect(at(4010, 4010) & MASK_GRASS).toBe(MASK_GRASS);
    // The lot ends at x = 4020. Just past it, a tree's crown would reach the building (issue #137): no trees there, but grass.
    expect(at(4023, 4010)).toBe(MASK_TREES);
    expect(at(4020 + BUILDINGS.treeClearance + 3, 4010)).toBe(0);
    layer.dispose();
  });

  it("keeps trees off the ground round a turned lot in a chunk none of its corners reach, and makes each mask once until a lot comes or goes", () => {
    const { source, rows, put } = fakeSource();
    const chunk = put(1, 4004, 4004);
    // Turned 45 degrees about (4510, 4510), its corners 15 m out along the axes: the chunk over (4500, 4500) to the south-west holds
    // none of them, but its corner is 7 m from the lot's middle, well inside the clearance.
    const row = rows.get(1);
    if (!row) throw new Error("no row");
    row.corners = [4510, 4525, 4495, 4510, 4510, 4495, 4525, 4510];
    const mid = 9 * CHUNKS_PER_SIDE + 9;
    row.chunk = mid;
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    settle(layer, { x: 4510, z: 4510 });
    expect(chunk).not.toBe(mid);
    const corner = (9 - 1) * CHUNKS_PER_SIDE + 9 - 1;
    expect(layer.takeLotChunks()).toContain(corner);
    const mask = layer.lotMask(corner);
    expect(mask).not.toBeNull();
    // The cell at (4499, 4499) is about 4.6 m from the lot's nearest edge.
    const at = (m: Uint8Array | null, c: number, x: number, z: number) =>
      m?.[Math.floor((z - Math.floor(c / CHUNKS_PER_SIDE) * CHUNK_SIZE) / ROADS.maskCell) * MASK_SIDE + Math.floor((x - (c % CHUNKS_PER_SIDE) * CHUNK_SIZE) / ROADS.maskCell)] ?? 0;
    expect(at(mask, corner, 4499, 4499)).toBe(MASK_TREES);
    // Asked again with nothing changed, the same mask; a building gone, a new one.
    expect(layer.lotMask(corner)).toBe(mask);
    rows.delete(1);
    layer.applyIds([1]);
    settle(layer, { x: 4510, z: 4510 });
    expect(layer.lotMask(corner)).toBeNull();
    layer.dispose();
  });
});

describe("the building layer's levels of detail (issue M2-13)", () => {
  const near = { x: 4000, z: 4000 };
  const run = (layer: ReturnType<typeof createBuildingLayer>, camera: { x: number; z: number }, band: "street" | "district" | "city", frames = 50, seconds = 1) => {
    for (let k = 0; k < frames; k++) layer.update(camera, 1000, { band, seconds });
  };

  it("draws chunks near the camera in full, simplified within the simple form's reach and boxes beyond, and blocks in the city band", () => {
    const { source, put } = fakeSource();
    const here = put(1, 4004, 4004);
    const mid = put(2, 5004, 4004);
    const far = put(3, 9004, 9004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "street");
    expect([layer.formOf(here), layer.formOf(mid), layer.formOf(far)]).toEqual(["full", "simple", "box"]);
    expect(layer.stats().forms).toMatchObject({ full: { buildings: 1, meshes: 1 }, simple: { buildings: 1, meshes: 1 }, box: { buildings: 1, meshes: 1 }, flat: { buildings: 0, meshes: 0 } });
    run(layer, near, "district");
    expect([layer.formOf(here), layer.formOf(mid), layer.formOf(far)]).toEqual(["simple", "simple", "box"]);
    run(layer, near, "city");
    expect([layer.formOf(here), layer.formOf(mid), layer.formOf(far)]).toEqual(["flat", "flat", "flat"]);
    // The near two chunks are in one group of flat blocks (issue #133), the far one in another: two meshes for three chunks.
    expect(layer.stats().forms).toMatchObject({ full: { buildings: 0, meshes: 0 }, simple: { meshes: 0 }, box: { meshes: 0 }, flat: { chunks: 3, buildings: 3, meshes: 2 } });
    layer.dispose();
  });

  it("with no budget and no fade, shows every chunk in the form it wants in one update, building nothing ahead (issue #223)", () => {
    const { source, put } = fakeSource();
    const here = put(1, 4004, 4004);
    const mid = put(2, 5004, 4004);
    const far = put(3, 9004, 9004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    expect(layer.idle()).toBe(false);
    layer.update(near, Infinity, { band: "street", seconds: Infinity, noAhead: true });
    expect([layer.formOf(here), layer.formOf(mid), layer.formOf(far)]).toEqual(["full", "simple", "box"]);
    expect(layer.idle()).toBe(true);
    // Only what is drawn was merged: no flat blocks for a zoom out later.
    expect(layer.stats().mergedBytes.flat).toBe(0);
    // A zoom out: one update fades straight to the blocks.
    layer.update(near, Infinity, { band: "city", seconds: Infinity, noAhead: true });
    expect([layer.formOf(here), layer.formOf(mid), layer.formOf(far)]).toEqual(["flat", "flat", "flat"]);
    expect(layer.idle()).toBe(true);
    // A building that comes is waiting until the next update reads it.
    layer.applyIds([1]);
    expect(layer.idle()).toBe(false);
    layer.update(near, Infinity, { band: "city", seconds: Infinity, noAhead: true });
    expect(layer.idle()).toBe(true);
    layer.dispose();
  });

  it("draws the flat blocks of a group of chunks in one mesh, each chunk fading on its own, built once for a change to several (issue #133)", () => {
    const { source, rows, put } = fakeSource();
    // Chunks (8, 8) and (9, 8) share a group; slots 0 and 1 of it.
    const a = put(1, 4004, 4004);
    const b = put(2, 4504, 4004);
    put(3, 4540, 4004);
    expect(BUILDINGS.flatGroup).toBe(4);
    const scene = new Scene();
    const layer = createBuildingLayer(scene, source, theme, () => 0);
    layer.reset();
    run(layer, near, "district");
    type Blocks = { visible: boolean; userData: { fades: Float32Array }; geometry: { getAttribute(n: string): { array: ArrayLike<number> } } };
    const blocks = () => {
      const out: Blocks[] = [];
      scene.traverse((o) => {
        if (o.name.startsWith("building blocks ")) out.push(o as unknown as Blocks);
      });
      return out;
    };
    // Built ahead of a zoom out, and not drawn.
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]?.visible).toBe(false);
    // Each vertex carries its chunk's slot: one building in slot 0, two in slot 1, four vertices each.
    expect(Array.from(blocks()[0]?.geometry.getAttribute("mergedSlot").array ?? [])).toEqual([...new Array<number>(4).fill(0), ...new Array<number>(8).fill(1)]);
    // One frame into the city band: both chunks fading in, the rest of the group's slots drawing nothing.
    run(layer, near, "city", 1, 0.016);
    const fades = blocks()[0]?.userData.fades ?? new Float32Array(0);
    expect(blocks()[0]?.visible).toBe(true);
    expect(fades[0]).toBeGreaterThan(0);
    expect(fades[0]).toBeLessThan(1);
    expect(fades[1]).toBe(fades[0]);
    expect(Array.from(fades.subarray(2)).every((f) => f === 0)).toBe(true);
    run(layer, near, "city");
    expect(Array.from(fades.subarray(0, 2))).toEqual([1, 1]);
    expect([layer.formOf(a), layer.formOf(b)]).toEqual(["flat", "flat"]);
    // A building gone from each chunk: the group is built once, not once per chunk.
    const merged = layer.stats().totalMerged;
    rows.delete(1);
    rows.delete(3);
    layer.apply([a, b]);
    run(layer, near, "city");
    expect(layer.stats().totalMerged).toBe(merged + 1);
    // Chunk a is empty now: its slot draws nothing, and the group's mesh holds chunk b's building alone.
    expect(layer.formOf(a)).toBeNull();
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]?.userData.fades[0]).toBe(0);
    expect(Array.from(blocks()[0]?.geometry.getAttribute("mergedSlot").array ?? [])).toEqual([1, 1, 1, 1]);
    expect(layer.stats().forms.flat).toEqual({ chunks: 1, buildings: 1, meshes: 1 });
    // The last building gone: the group's mesh goes too.
    rows.delete(2);
    layer.apply([b]);
    run(layer, near, "city");
    expect(blocks()).toHaveLength(0);
    expect(layer.stats().mergedBytes.flat).toBe(0);
    layer.dispose();
  });

  it("frees a chunk's simplified buildings once it leaves the simple form's reach, so their memory follows the camera", () => {
    const { source, put } = fakeSource();
    const here = put(1, 4004, 4004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "district");
    expect(layer.formOf(here)).toBe("simple");
    expect(layer.stats().mergedBytes.simple).toBeGreaterThan(0);
    // Far away the chunk draws boxes, and its simplified buildings are freed once they have faded out.
    run(layer, { x: 9000, z: 9000 }, "district");
    expect(layer.formOf(here)).toBe("box");
    expect(layer.stats().mergedBytes.simple).toBe(0);
    expect(layer.stats().mergedBytes.box).toBeGreaterThan(0);
    // Back again: built again and drawn, and the boxes freed.
    run(layer, near, "district");
    expect(layer.formOf(here)).toBe("simple");
    expect(layer.stats().mergedBytes.box).toBe(0);
    layer.dispose();
  });

  it("frees instances filled for a fade that never started, once the camera leaves", () => {
    const { source, put } = fakeSource();
    const here = put(1, 4004, 4004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "city", 5, 0.016);
    // Half way from blocks to simple buildings, the camera drops into the street band: the chunk is filled, but the fade under way goes on.
    run(layer, near, "district", 3, 0.016);
    run(layer, near, "street", 1, 0.016);
    expect(layer.formOf(here)).toBe("flat");
    // Then back out before the full form could fade in: its instances go.
    run(layer, near, "district", 60, 0.016);
    expect(layer.formOf(here)).toBe("simple");
    expect(layer.stats().forms.full).toEqual({ chunks: 0, buildings: 0, meshes: 0 });
    layer.dispose();
  });

  it("frees a chunk's instances once it leaves the camera, and draws them again when it comes back", () => {
    const { source, put } = fakeSource();
    for (let id = 0; id < 20; id++) put(id, 4004 + (id % 10) * 16, 4004 + Math.floor(id / 10) * 48);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "street");
    expect(layer.stats().forms.full.buildings).toBe(20);
    run(layer, { x: 9000, z: 9000 }, "street");
    expect(layer.stats().forms.full).toEqual({ chunks: 0, buildings: 0, meshes: 0 });
    // The colours stay and the chunk, now far, draws boxes: only the full form is freed.
    expect(layer.tintOf(3)).not.toBeNull();
    expect(layer.stats().forms.box.buildings).toBe(20);
    run(layer, near, "street");
    expect(layer.stats().forms.full.buildings).toBe(20);
    layer.dispose();
  });

  it("fades from one form to the next over the fade time, showing the old one until the new one is built", () => {
    const { source, put } = fakeSource();
    const here = put(1, 4004, 4004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "street", 5, 0.016);
    expect(layer.formOf(here)).toBe("full");
    // One frame into the district band: still full, fading to the simple form.
    run(layer, near, "district", 1, 0.016);
    expect(layer.formOf(here)).toBe("full");
    expect(layer.stats().fading).toBe(1);
    expect(layer.stats().forms.full.buildings).toBe(1);
    expect(layer.stats().forms.simple.buildings).toBe(1);
    // Past the fade time, the simple form alone.
    run(layer, near, "district", Math.ceil(BUILDINGS.fadeSeconds / 0.016) + 1, 0.016);
    expect(layer.formOf(here)).toBe("simple");
    expect(layer.stats().fading).toBe(0);
    expect(layer.stats().forms.full.buildings).toBe(0);
    layer.dispose();
  });

  it("builds a chunk's merged meshes again only when a building in it changes", () => {
    const { source, rows, put } = fakeSource();
    const a = put(1, 4004, 4004);
    const b = put(2, 9004, 9004);
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, near, "district");
    const built = layer.stats().totalMerged;
    // Two forms of each chunk, built once: simple buildings for the near one, boxes for the far one, and the blocks of both ahead of a zoom out.
    expect(built).toBe(4);
    // Changing band builds nothing again.
    run(layer, near, "city");
    run(layer, near, "district");
    expect(layer.stats().totalMerged).toBe(built);
    // A building gone from one chunk and one come to another: that chunk's
    // simple buildings and blocks are built again, and the emptied chunk's meshes are
    // dropped. Nothing is built again when the band changes after.
    rows.delete(2);
    put(3, 4040, 4004);
    layer.apply([a, b]);
    run(layer, near, "district");
    expect(layer.formOf(b)).toBeNull();
    expect(layer.stats().totalMerged).toBe(built + 2);
    run(layer, near, "city");
    expect(layer.stats().totalMerged).toBe(built + 2);
    layer.dispose();
  });

  it("colours a flat block by its zone and density, as the zoning overlay does", () => {
    const { source, put } = fakeSource();
    const tower = BUILDING_TYPES.findIndex((t) => t.id === "high-tower");
    put(1, 4004, 4004, 0, tower);
    const scene = new Scene();
    const layer = createBuildingLayer(scene, source, theme, () => 0);
    layer.reset();
    run(layer, near, "city");
    let colour: number[] = [];
    scene.traverse((o) => {
      if (o.name.startsWith("building blocks ")) {
        const c = (o as unknown as { geometry: { getAttribute(n: string): { array: ArrayLike<number> } } }).geometry.getAttribute("mergedColour").array;
        colour = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
      }
    });
    const hex = CELLS.zones["residential"]?.[2] ?? 0;
    expect(colour).toEqual([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]);
    layer.dispose();
  });
});

describe("buildings under construction (issue 136)", () => {
  const near = { x: 4000, z: 4000 };
  const run = (layer: ReturnType<typeof createBuildingLayer>, band: "street" | "district" | "city", tick: number | undefined, frames = 20) => {
    for (let k = 0; k < frames; k++) layer.update(near, 1000, { band, seconds: 1, ...(tick !== undefined ? { tick } : {}) });
  };
  const named = (scene: Scene, name: string) => {
    const out: string[] = [];
    scene.traverse((o) => {
      const m = (o as { material?: { name?: string } }).material;
      if (o.name.startsWith(name) && (o as { visible?: boolean }).visible !== false && m?.name) out.push(m.name);
    });
    return out;
  };

  it("draws scaffolding round a new building drawn in full, in one mesh, until its construction ends", () => {
    const { source, rows, put } = fakeSource();
    for (let id = 1; id <= 3; id++) put(id, 4000 + id * 16, 4000);
    for (const id of [1, 2]) Object.assign(rows.get(id) ?? {}, { builtAt: 1000 });
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, "street", 1010);
    expect(layer.stats()).toMatchObject({ building: 2, scaffolds: 2 });
    run(layer, "street", 1000 + CONSTRUCTION.ticks - 1);
    expect(layer.stats().scaffolds).toBe(2);
    run(layer, "street", 1000 + CONSTRUCTION.ticks);
    expect(layer.stats()).toMatchObject({ building: 0, scaffolds: 0 });
    layer.dispose();
  });

  it("draws an old building finished, and every building finished with no tick", () => {
    const { source, rows, put } = fakeSource();
    put(1, 4004, 4004);
    Object.assign(rows.get(1) ?? {}, { builtAt: 1000 });
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, "street", undefined);
    expect(layer.stats()).toMatchObject({ building: 0, scaffolds: 0 });
    const old = createBuildingLayer(new Scene(), source, theme, () => 0);
    old.reset();
    run(old, "street", 1000 + CONSTRUCTION.ticks + 5);
    expect(old.stats()).toMatchObject({ building: 0, scaffolds: 0 });
    layer.dispose();
    old.dispose();
  });

  it("frees a building's scaffolding when its chunk leaves the full form, and gives it back when it returns", () => {
    const { source, rows, put } = fakeSource();
    put(1, 4004, 4004);
    Object.assign(rows.get(1) ?? {}, { builtAt: 1000 });
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, "street", 1010);
    expect(layer.stats().scaffolds).toBe(1);
    run(layer, "district", 1011);
    expect(layer.stats()).toMatchObject({ building: 1, scaffolds: 0 });
    run(layer, "street", 1012);
    expect(layer.stats().scaffolds).toBe(1);
    layer.dispose();
  });

  it("drops a building's scaffolding at once when the building goes", () => {
    const { source, rows, put } = fakeSource();
    const c = put(1, 4004, 4004);
    put(2, 4040, 4004);
    for (const id of [1, 2]) Object.assign(rows.get(id) ?? {}, { builtAt: 1000 });
    const layer = createBuildingLayer(new Scene(), source, theme, () => 0);
    layer.reset();
    run(layer, "street", 1010);
    expect(layer.stats().scaffolds).toBe(2);
    rows.delete(1);
    layer.apply([c]);
    run(layer, "street", 1011, 1);
    expect(layer.stats()).toMatchObject({ buildings: 1, building: 1, scaffolds: 1 });
    layer.dispose();
  });

  it("draws a merged chunk with a building under construction with the rising material, and builds the drawn one plain again once it is finished", () => {
    const { source, rows, put } = fakeSource();
    put(1, 4004, 4004);
    put(2, 4040, 4004);
    Object.assign(rows.get(1) ?? {}, { builtAt: 1000 });
    const scene = new Scene();
    const layer = createBuildingLayer(scene, source, theme, () => 0);
    layer.reset();
    run(layer, "district", 1010);
    expect(named(scene, "simple buildings")).toEqual(["rising simple buildings"]);
    run(layer, "city", 1011);
    expect(named(scene, "building blocks")).toEqual(["rising building blocks"]);
    const merged = layer.stats().totalMerged;
    run(layer, "city", 1000 + CONSTRUCTION.ticks);
    expect(named(scene, "building blocks")).toEqual(["building blocks"]);
    expect(layer.stats().totalMerged).toBeGreaterThan(merged);
    // The simple form was not drawn when its building finished: it keeps the rising material, which draws it finished, rather than be built again for nothing.
    run(layer, "district", 1000 + CONSTRUCTION.ticks + 1);
    expect(named(scene, "simple buildings")).toEqual(["rising simple buildings"]);
    layer.dispose();
  });
});

describe("the scaffolding's instances (issue 136)", () => {
  it("moves the last building's scaffolding into the gap one leaves, with its own built tick", () => {
    const { source, rows, put } = fakeSource();
    const c = put(1, 4004, 4004);
    put(2, 4040, 4004);
    Object.assign(rows.get(1) ?? {}, { builtAt: 1000 });
    Object.assign(rows.get(2) ?? {}, { builtAt: 1050 });
    const scene = new Scene();
    const layer = createBuildingLayer(scene, source, theme, () => 0);
    layer.reset();
    for (let k = 0; k < 20; k++) layer.update({ x: 4000, z: 4000 }, 1000, { band: "street", seconds: 1, tick: 1060 });
    const mesh = () => scene.getObjectByName("scaffolding") as unknown as { count: number; geometry: { getAttribute(n: string): { getX(i: number): number } } };
    expect(mesh().count).toBe(2);
    rows.delete(1);
    layer.apply([c]);
    layer.update({ x: 4000, z: 4000 }, 1000, { band: "street", seconds: 1, tick: 1061 });
    expect(mesh().count).toBe(1);
    expect(mesh().geometry.getAttribute("scaffoldBuilt").getX(0)).toBe(1050);
    layer.dispose();
  });
});
