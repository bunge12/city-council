// The lots of the buildings the tools point at (issue M2-15): red for those
// a road or a grid would clear, fainter for those of one sent and not yet
// built, and white for the building under the pointer. Each lot is one quad
// at its four corners, drawn through the terrain and the buildings, like
// the road preview, so it shows behind the building on it. Built from the
// tools' previews; the sim knows nothing of it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from "three/webgpu";
import { heightAt, type Terrain } from "@city-council/sim";
import { BUILDING_MARKS } from "./config";
import { buildZoneMarks } from "./zone-preview";

/** The marks to show: lots as their corners, x0, z0, ..., x3, z3. */
export interface BuildingMarks {
  clear: readonly (readonly number[])[];
  pending: readonly (readonly number[])[];
  hover: readonly number[] | null;
}

export interface BuildingMarkLayer {
  /** Shows `marks()`. `key` changes whenever they do; they are only asked for then. */
  show(marks: () => BuildingMarks, key: string): void;
  dispose(): void;
}

export function createBuildingMarkLayer(scene: Scene, terrain: () => Terrain): BuildingMarkLayer {
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
  // Over the zone marks at 7 and 8, under the road preview at 9, so the road clearing them draws on top.
  const hoverMesh = make("building hover", BUILDING_MARKS.hoverOpacity, 8.3);
  const pendingMesh = make("buildings pending clear", BUILDING_MARKS.pendingOpacity, 8.4);
  const clearMesh = make("buildings to clear", BUILDING_MARKS.clearOpacity, 8.5);
  const meshes = [hoverMesh, pendingMesh, clearMesh];
  let shown = "";
  const height = (x: number, z: number) => {
    const t = terrain();
    return Math.max(heightAt(t, x, z), t.waterLevel);
  };
  const fill = (mesh: Mesh, lots: readonly (readonly number[])[], colour: number) => {
    mesh.geometry.dispose();
    const geometry = new BufferGeometry();
    if (lots.length > 0) {
      const a = buildZoneMarks(
        lots.map((corners) => ({ corners, colour })),
        height,
        BUILDING_MARKS.inset,
        BUILDING_MARKS.lift,
      );
      geometry.setAttribute("position", new BufferAttribute(a.positions, 3));
      geometry.setAttribute("color", new BufferAttribute(a.colours, 3));
      geometry.setIndex(new BufferAttribute(a.indices, 1));
    }
    mesh.geometry = geometry;
    mesh.visible = lots.length > 0;
  };
  return {
    show(marks, key) {
      if (key === shown) return;
      shown = key;
      const m = marks();
      fill(clearMesh, m.clear, BUILDING_MARKS.clear);
      fill(pendingMesh, m.pending, BUILDING_MARKS.clear);
      fill(hoverMesh, m.hover ? [m.hover] : [], BUILDING_MARKS.hover);
    },
    dispose() {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
