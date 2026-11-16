// The zone tool's marks on screen (issue M2-07): the cells a click would
// change, and those of strokes sent and not yet painted. Two meshes, one per
// look, each rebuilt only when its cells change. Drawn through the terrain
// over the zoning overlay, like the road preview. Built from the tool's
// state; the sim knows nothing of it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from "three/webgpu";
import { heightAt, type Terrain } from "@city-council/sim";
import { ZONE_PREVIEW } from "./config";
import { linearRgb } from "./road-geometry";

/** One cell to mark: its corners and the colour to draw it in, as sRGB hex. */
export interface ZoneMark {
  corners: readonly number[];
  colour: number;
}

/** Typed arrays for the marks, ready for a BufferGeometry. */
export interface ZoneMarkArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

/**
 * One quad a cell, shrunk around its centre by `inset` so neighbouring
 * cells read apart, lifted `lift` metres over the ground. The building
 * marks (building-marks.ts) draw lots the same way.
 */
export function buildZoneMarks(
  marks: readonly ZoneMark[],
  height: (x: number, z: number) => number,
  inset: number = ZONE_PREVIEW.inset,
  lift: number = ZONE_PREVIEW.lift,
): ZoneMarkArrays {
  const positions = new Float32Array(marks.length * 12);
  const colours = new Float32Array(marks.length * 12);
  const indices = new Uint32Array(marks.length * 6);
  const k = inset;
  marks.forEach((m, n) => {
    const c = m.corners;
    const cx = ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4;
    const cz = ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4;
    const rgb = linearRgb(m.colour);
    for (let i = 0; i < 4; i++) {
      const x = cx + ((c[i * 2] ?? 0) - cx) * k;
      const z = cz + ((c[i * 2 + 1] ?? 0) - cz) * k;
      const v = n * 4 + i;
      positions.set([x, height(x, z) + lift, z], v * 3);
      colours.set(rgb, v * 3);
    }
    const v0 = n * 4;
    indices.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], n * 6);
  });
  return { positions, colours, indices };
}

export interface ZonePreviewLayer {
  /**
   * Shows the cells a click would change, and those of strokes in flight.
   * `key` changes whenever the cells do; the marks are only asked for then.
   */
  show(preview: () => readonly ZoneMark[], pending: () => readonly ZoneMark[], key: string): void;
  dispose(): void;
}

export function createZonePreviewLayer(scene: Scene, terrain: () => Terrain): ZonePreviewLayer {
  const make = (name: string, opacity: number, order: number) => {
    const material = new MeshBasicNodeMaterial({ vertexColors: true, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(new BufferGeometry(), material);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  };
  // Pending under the preview, both under the road preview at 9.
  const pendingMesh = make("zone pending", ZONE_PREVIEW.pendingOpacity, 7);
  const previewMesh = make("zone preview", ZONE_PREVIEW.opacity, 8);
  let shown = "";
  const height = (x: number, z: number) => {
    const t = terrain();
    return Math.max(heightAt(t, x, z), t.waterLevel);
  };
  const fill = (mesh: Mesh, marks: readonly ZoneMark[]) => {
    mesh.geometry.dispose();
    const geometry = new BufferGeometry();
    if (marks.length > 0) {
      const a = buildZoneMarks(marks, height);
      geometry.setAttribute("position", new BufferAttribute(a.positions, 3));
      geometry.setAttribute("color", new BufferAttribute(a.colours, 3));
      geometry.setIndex(new BufferAttribute(a.indices, 1));
    }
    mesh.geometry = geometry;
    mesh.visible = marks.length > 0;
  };
  return {
    show(preview, pending, key) {
      if (key === shown) return;
      shown = key;
      fill(previewMesh, preview());
      fill(pendingMesh, pending());
    },
    dispose() {
      for (const mesh of [previewMesh, pendingMesh]) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
