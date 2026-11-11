// The camera rig: an orbit around a point on the ground, with the limits
// that keep the camera above the terrain and the map in view. Input calls
// the rig; the rig writes the three.js camera. Nothing here touches sim
// state.
//
// Pose: `target` is the point orbited, kept on the ground and inside the
// map square. The camera sits `distance` from it, `pitch` above the horizon,
// on bearing `yaw` (0 puts the camera south of the target, at larger z,
// looking north).

import { heightAt, mapSize, type Terrain } from "@city-council/sim";
import { Raycaster, Vector2, type PerspectiveCamera } from "three/webgpu";
import { CAMERA_LIMITS } from "./config";
import { intersectGround, type GroundHit, type Ray } from "./pick";
import { zoomBand, type ZoomBand } from "./zoom-band";

type Vec3 = readonly [number, number, number];

export interface CameraPose {
  target: { x: number; y: number; z: number };
  distance: number;
  yaw: number;
  pitch: number;
}

/** Size of the area the camera draws to, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

export interface CameraRig {
  readonly pose: Readonly<CameraPose>;
  /** Places the camera at `position` looking at `target`, then applies the limits. */
  setPose(position: Vec3, target: Vec3): void;
  /** Turns the camera around the target. */
  orbit(dYaw: number, dPitch: number): void;
  /** Moves the target across the ground by (dx, dz) metres. */
  pan(dx: number, dz: number): void;
  /**
   * Multiplies the distance by `factor`, keeping the ground under screen
   * point (sx, sy) where it is. With no ground there, zooms on the target.
   */
  zoomAt(factor: number, sx: number, sy: number): void;
  /** Starts a drag that keeps the ground under (sx, sy) under the cursor. */
  grab(sx: number, sy: number): void;
  /** Continues a drag started by `grab`. */
  dragTo(sx: number, sy: number): void;
  /** The ground under screen point (sx, sy), in world metres, or null. */
  pickGround(sx: number, sy: number): GroundHit | null;
  /** Camera height above the ground directly below it, in metres. */
  heightAboveGround(): number;
  zoomBand(): ZoomBand;
  /** Switches to another map, keeping the pose as far as the limits allow. */
  setTerrain(terrain: Terrain): void;
}

export function createCameraRig(camera: PerspectiveCamera, terrain: Terrain, viewport: () => Viewport): CameraRig {
  let t = terrain;
  const pose: CameraPose = { target: { x: 0, y: 0, z: 0 }, distance: 1000, yaw: 0, pitch: Math.PI / 4 };
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  /** Ground point being dragged, if a drag is on. */
  let anchor: { x: number; y: number; z: number } | null = null;

  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  function cameraPosition(): [number, number, number] {
    const flat = pose.distance * Math.cos(pose.pitch);
    return [
      pose.target.x + flat * Math.sin(pose.yaw),
      pose.target.y + pose.distance * Math.sin(pose.pitch),
      pose.target.z + flat * Math.cos(pose.yaw),
    ];
  }

  /** Clamps the pose to the limits and writes the camera. */
  function apply(): void {
    const size = mapSize(t);
    pose.target.x = clamp(pose.target.x, 0, size);
    pose.target.z = clamp(pose.target.z, 0, size);
    pose.target.y = heightAt(t, pose.target.x, pose.target.z);
    pose.distance = clamp(pose.distance, CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
    pose.pitch = clamp(pose.pitch, CAMERA_LIMITS.minPitch, CAMERA_LIMITS.maxPitch);
    pose.yaw = Math.atan2(Math.sin(pose.yaw), Math.cos(pose.yaw));

    // Keep the camera clear of the ground below it by tilting it up. The
    // ground under the camera moves as it tilts, so repeat until it settles.
    let p = cameraPosition();
    for (let round = 0; round < 16; round++) {
      const floor = heightAt(t, p[0], p[2]) + CAMERA_LIMITS.clearance;
      if (p[1] >= floor) break;
      if (pose.pitch >= CAMERA_LIMITS.maxPitch) {
        // Straight above a peak taller than the distance allows: back off.
        pose.distance = Math.min(CAMERA_LIMITS.maxDistance, (floor - pose.target.y) / Math.sin(pose.pitch) + 1);
      } else {
        const need = clamp((floor - pose.target.y) / pose.distance, -1, 1);
        pose.pitch = clamp(Math.asin(need) + 1e-4, CAMERA_LIMITS.minPitch, CAMERA_LIMITS.maxPitch);
      }
      p = cameraPosition();
    }

    camera.position.set(p[0], p[1], p[2]);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    camera.updateMatrixWorld();
  }

  function rayAt(sx: number, sy: number): Ray {
    const { width, height } = viewport();
    ndc.set((sx / width) * 2 - 1, -(sy / height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const { origin: o, direction: d } = raycaster.ray;
    return { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
  }

  /** Where the ray through (sx, sy) crosses the level y, or null if it does not head down to it. */
  function hitLevel(sx: number, sy: number, y: number): { x: number; z: number } | null {
    const r = rayAt(sx, sy);
    const s = (y - r.oy) / r.dy;
    // A ray at the horizon would land kilometres away; ignore rays that flat.
    if (!(r.dy < -0.02) || !(s > 0)) return null;
    return { x: r.ox + r.dx * s, z: r.oz + r.dz * s };
  }

  /** Moves the target so that `point` lies under (sx, sy) again. */
  function keepUnder(point: { x: number; y: number; z: number }, sx: number, sy: number): void {
    const hit = hitLevel(sx, sy, point.y);
    if (!hit) return;
    pose.target.x += point.x - hit.x;
    pose.target.z += point.z - hit.z;
    apply();
  }

  function pickGround(sx: number, sy: number): GroundHit | null {
    return intersectGround(t, rayAt(sx, sy));
  }

  const rig: CameraRig = {
    pose,
    setPose(position, target) {
      const ex = position[0] - target[0];
      const ey = position[1] - target[1];
      const ez = position[2] - target[2];
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      pose.target.x = target[0];
      pose.target.y = target[1];
      pose.target.z = target[2];
      pose.distance = d > 0 ? d : CAMERA_LIMITS.minDistance;
      pose.yaw = Math.atan2(ex, ez);
      pose.pitch = d > 0 ? Math.asin(clamp(ey / d, -1, 1)) : CAMERA_LIMITS.maxPitch;
      anchor = null;
      apply();
    },
    orbit(dYaw, dPitch) {
      pose.yaw += dYaw;
      pose.pitch += dPitch;
      apply();
    },
    pan(dx, dz) {
      pose.target.x += dx;
      pose.target.z += dz;
      apply();
    },
    zoomAt(factor, sx, sy) {
      const hit = pickGround(sx, sy);
      const before = pose.distance;
      pose.distance = clamp(before * factor, CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
      if (!hit) {
        apply();
        return;
      }
      // Scale the view about the hit point: it stays put on screen while
      // everything else moves towards or away from it.
      const f = pose.distance / before;
      pose.target.x = hit.x + (pose.target.x - hit.x) * f;
      pose.target.z = hit.z + (pose.target.z - hit.z) * f;
      apply();
      // The target snaps to the ground, which moves the camera up or down a
      // little; nudge it so the hit point is back under the cursor.
      keepUnder(hit, sx, sy);
    },
    grab(sx, sy) {
      const hit = pickGround(sx, sy);
      anchor = hit ? { x: hit.x, y: hit.y, z: hit.z } : { ...pose.target };
    },
    dragTo(sx, sy) {
      if (anchor) keepUnder(anchor, sx, sy);
    },
    pickGround,
    heightAboveGround() {
      const p = camera.position;
      return p.y - heightAt(t, p.x, p.z);
    },
    zoomBand() {
      return zoomBand(rig.heightAboveGround());
    },
    setTerrain(next) {
      t = next;
      anchor = null;
      apply();
    },
  };
  apply();
  return rig;
}
