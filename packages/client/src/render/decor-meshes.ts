// Decoration on screen: trees and grass tufts as instanced low-poly meshes,
// one set per terrain chunk, built the first time a chunk comes near the
// camera and hidden again when it is far. Placement comes from decor.ts.
// Nothing stands where a road is: the road layer gives each chunk a mask,
// and a chunk whose mask changes is built again.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshLambertNodeMaterial,
  Object3D,
  Vector3,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Terrain } from "@city-council/sim";
import { DECOR } from "./config";
import { DECOR_STRIDE, placeDecor, withoutDropped, type DecorInstances } from "./decor";
import { MASK_GRASS, MASK_TREES, masked } from "./road-geometry";
import { chunkCentre, chunksPerSide } from "./terrain-chunks";

/**
 * Milliseconds of each frame spent building chunks that came into range, so
 * moving the camera does not stutter. At least one chunk is built per frame.
 */
const BUILD_MS_PER_FRAME = 6;

const TRUNK = 0x6b4f36;
/** Tints an instance's leaves pick between, by its shade. */
const LEAVES = { broadleaf: [0x4f7d3a, 0x76994a], conifer: [0x2f5634, 0x4a6e3d], grass: [0x6f9a45, 0x9bb860] } as const;

/** Paints every vertex of `g` one colour, as a `color` attribute. */
function paint(g: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

/** Merges parts into one non-indexed geometry with position, normal and color. */
function merge(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((p) => {
    const f = p.index ? p.toNonIndexed() : p;
    f.deleteAttribute("uv");
    return f;
  });
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error("decor geometry parts do not match");
  for (const p of [...parts, ...flat]) p.dispose();
  return merged;
}

// Unit models, 1 m tall with the base at the origin. Instances scale them to
// their height. Open-ended trunks and cones: their caps sit inside the crown
// or under the ground, so they would only cost triangles. Trunks are white times the trunk colour, leaves white, so
// the instance colour tints only the leaves.

function broadleafGeometry(): BufferGeometry {
  const trunk = paint(new CylinderGeometry(0.035, 0.05, 0.4, 5, 1, true).translate(0, 0.2, 0), TRUNK);
  const crown = paint(new IcosahedronGeometry(0.3, 0).scale(1, 1.05, 1).translate(0, 0.66, 0), 0xffffff);
  return merge([trunk, crown]);
}

function coniferGeometry(): BufferGeometry {
  const trunk = paint(new CylinderGeometry(0.03, 0.045, 0.25, 5, 1, true).translate(0, 0.125, 0), TRUNK);
  const lower = paint(new ConeGeometry(0.24, 0.55, 7, 1, true).translate(0, 0.42, 0), 0xffffff);
  const upper = paint(new ConeGeometry(0.16, 0.4, 7, 1, true).translate(0, 0.78, 0), 0xffffff);
  return merge([trunk, lower, upper]);
}

/**
 * A tuft: three thin blades fanned around the base, each wound both ways
 * with an upward normal, so it lights the same from any side. (A
 * double-sided material would flip the normal on back faces and draw them
 * dark.)
 */
function grassGeometry(): BufferGeometry {
  const blades = 3;
  const positions: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI;
    const dx = Math.cos(a) * 0.12;
    const dz = Math.sin(a) * 0.12;
    const lean = (b - 1) * 0.18;
    const tip = [Math.sin(a) * lean, 1, -Math.cos(a) * lean];
    const left = [-dx, 0, -dz];
    const right = [dx, 0, dz];
    positions.push(...left, ...right, ...tip, ...right, ...left, ...tip);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    normals[v * 3 + 1] = 1;
    // Darker at the root, so a tuft reads against the ground.
    const y = positions[v * 3 + 1] ?? 0;
    const k = 0.55 + 0.45 * y;
    colors[v * 3] = k;
    colors[v * 3 + 1] = k;
    colors[v * 3 + 2] = k;
  }
  g.setAttribute("normal", new BufferAttribute(normals, 3));
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

/** Decoration shown on the map, and its controls. */
export interface DecorLayer {
  /** Shows or hides each chunk's decoration for the camera at `eye`, building any newly in range. */
  update(eye: Vector3): void;
  /** Instances drawn last update: trees and grass tufts. */
  counts(): { trees: number; grass: number };
  /**
   * Checks the road mask of each of `chunks` again and drops any built
   * decoration whose mask changed, so the next update builds it anew.
   * Returns the chunks dropped.
   */
  refresh(chunks: Iterable<number>): number[];
  dispose(): void;
}

interface ChunkSlot {
  centre: Vector3;
  trees: Group | null;
  grass: Group | null;
  treeCount: number;
  grassCount: number;
  /** Fingerprint of the road mask the decoration was built with. */
  maskKey: string;
}

/** A short fingerprint of a mask, to tell whether it changed. */
function maskKey(mask: Uint8Array | null): string {
  if (!mask) return "";
  let h = 0x811c9dc5;
  let set = 0;
  for (let k = 0; k < mask.length; k++) {
    const v = mask[k] ?? 0;
    if (v === 0) continue;
    set++;
    h = Math.imul(h ^ k, 0x01000193);
    h = Math.imul(h ^ v, 0x01000193);
  }
  return `${set}:${(h >>> 0).toString(16)}`;
}

/** Builds the decoration layer for `terrain` under `parent`. Nothing is placed until `update`. */
export function createDecorLayer(
  terrain: Terrain,
  parent: Object3D,
  roadMask: (chunk: number) => Uint8Array | null = () => null,
): DecorLayer {
  const geometries = {
    broadleaf: broadleafGeometry(),
    conifer: coniferGeometry(),
    grass: grassGeometry(),
  };
  const treeMaterial = new MeshLambertNodeMaterial({ vertexColors: true });
  treeMaterial.name = "trees";
  const grassMaterial = new MeshLambertNodeMaterial({ vertexColors: true });
  grassMaterial.name = "grass";

  const root = new Group();
  root.name = "decor";
  parent.add(root);

  const per = chunksPerSide(terrain);
  const slots: ChunkSlot[] = [];
  for (let cj = 0; cj < per; cj++) {
    for (let ci = 0; ci < per; ci++) {
      const c = chunkCentre(ci, cj);
      slots.push({
        centre: new Vector3(c.x, terrain.waterLevel, c.z),
        trees: null,
        grass: null,
        treeCount: 0,
        grassCount: 0,
        maskKey: "",
      });
    }
  }

  const dummy = new Object3D();
  const tint = new Color();
  const tintA = new Color();
  const tintB = new Color();

  function instanced(kind: keyof typeof geometries, placed: DecorInstances, widthScale: number): InstancedMesh | null {
    if (placed.count === 0) return null;
    const mesh = new InstancedMesh(geometries[kind], kind === "grass" ? grassMaterial : treeMaterial, placed.count);
    mesh.name = kind;
    const [a, b] = LEAVES[kind];
    tintA.set(a);
    tintB.set(b);
    const d = placed.data;
    for (let k = 0; k < placed.count; k++) {
      const o = k * DECOR_STRIDE;
      const h = d[o + 3] ?? 1;
      dummy.position.set(d[o] ?? 0, d[o + 1] ?? 0, d[o + 2] ?? 0);
      dummy.rotation.set(0, d[o + 4] ?? 0, 0);
      dummy.scale.set(h * widthScale, h, h * widthScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      mesh.setColorAt(k, tint.lerpColors(tintA, tintB, d[o + 5] ?? 0));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  function build(slot: ChunkSlot, index: number): void {
    const placed = placeDecor(terrain, index % per, Math.floor(index / per));
    const mask = roadMask(index);
    const off = (bit: number) => (x: number, z: number) => masked(mask, index, x, z, bit);
    const decor = {
      broadleaf: withoutDropped(placed.broadleaf, off(MASK_TREES)),
      conifer: withoutDropped(placed.conifer, off(MASK_TREES)),
      grass: withoutDropped(placed.grass, off(MASK_GRASS)),
    };
    slot.maskKey = maskKey(mask);
    const trees = new Group();
    const grass = new Group();
    for (const m of [instanced("broadleaf", decor.broadleaf, 1), instanced("conifer", decor.conifer, 1)]) {
      if (m) trees.add(m);
    }
    const g = instanced("grass", decor.grass, 1);
    if (g) grass.add(g);
    trees.visible = false;
    grass.visible = false;
    root.add(trees, grass);
    slot.trees = trees;
    slot.grass = grass;
    slot.treeCount = decor.broadleaf.count + decor.conifer.count;
    slot.grassCount = decor.grass.count;
  }

  let shown = { trees: 0, grass: 0 };

  function drop(slot: ChunkSlot): void {
    for (const group of [slot.trees, slot.grass]) {
      if (!group) continue;
      group.removeFromParent();
      group.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
    }
    slot.trees = null;
    slot.grass = null;
  }

  return {
    update(eye) {
      const start = performance.now();
      let built = false;
      const next = { trees: 0, grass: 0 };
      slots.forEach((slot, index) => {
        const distance = eye.distanceTo(slot.centre);
        const wantTrees = distance < DECOR.trees.drawDistance;
        if (wantTrees && !slot.trees && (!built || performance.now() - start < BUILD_MS_PER_FRAME)) {
          build(slot, index);
          built = true;
        }
        const wantGrass = distance < DECOR.grass.drawDistance;
        if (slot.trees) slot.trees.visible = wantTrees;
        if (slot.grass) slot.grass.visible = wantGrass;
        if (slot.trees && wantTrees) next.trees += slot.treeCount;
        if (slot.grass && wantGrass) next.grass += slot.grassCount;
      });
      shown = next;
    },
    counts: () => shown,
    refresh(chunks) {
      const dropped: number[] = [];
      for (const c of chunks) {
        const slot = slots[c];
        if (!slot?.trees) continue;
        if (maskKey(roadMask(c)) === slot.maskKey) continue;
        drop(slot);
        dropped.push(c);
      }
      return dropped;
    },
    dispose() {
      parent.remove(root);
      for (const g of Object.values(geometries)) g.dispose();
      treeMaterial.dispose();
      grassMaterial.dispose();
      root.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
    },
  };
}
