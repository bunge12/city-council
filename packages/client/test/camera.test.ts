// Ground picking against the height array, zoom bands, and the camera rig's
// limits. Picking is checked against a brute-force march with a fine step.
import { beforeAll, describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three/webgpu";
import { generateTerrain, heightAt, mapSize, slopeAt, type Terrain } from "@city-council/sim";
import { CAMERA_LIMITS, ZOOM_BANDS } from "../src/camera/config";
import { intersectGround, type Ray } from "../src/camera/pick";
import { createCameraRig } from "../src/camera/rig";
import { zoomBand } from "../src/camera/zoom-band";

let terrain: Terrain;
let size: number;
beforeAll(() => {
  terrain = generateTerrain(1);
  size = mapSize(terrain);
});

/** First crossing by fixed steps of `step` metres, then bisection. Slow and obviously right. */
function bruteForce(ray: Ray, step = 0.05, maxT = 40_000): { x: number; y: number; z: number } | null {
  const len = Math.hypot(ray.dx, ray.dy, ray.dz);
  const [dx, dy, dz] = [ray.dx / len, ray.dy / len, ray.dz / len];
  const inside = (x: number, z: number) => x >= 0 && x <= size && z >= 0 && z <= size;
  const gap = (t: number) => ray.oy + dy * t - heightAt(terrain, ray.ox + dx * t, ray.oz + dz * t);
  let prev = 0;
  for (let t = step; t < maxT; t += step) {
    const x = ray.ox + dx * t;
    const z = ray.oz + dz * t;
    if (inside(x, z) && gap(t) <= 0) {
      let lo = prev;
      let hi = t;
      for (let r = 0; r < 40; r++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) > 0) lo = mid;
        else hi = mid;
      }
      const hx = ray.ox + dx * hi;
      const hz = ray.oz + dz * hi;
      return { x: hx, y: heightAt(terrain, hx, hz), z: hz };
    }
    prev = t;
  }
  return null;
}

/** A ray from `distance` metres away, `pitch` radians above the horizon on bearing `yaw`, aimed at (x, z) on the ground. */
function aimedAt(x: number, z: number, distance: number, pitch: number, yaw: number): Ray {
  const y = heightAt(terrain, x, z);
  const flat = distance * Math.cos(pitch);
  const ox = x + flat * Math.sin(yaw);
  const oy = y + distance * Math.sin(pitch);
  const oz = z + flat * Math.cos(yaw);
  return { ox, oy, oz, dx: x - ox, dy: y - oy, dz: z - oz };
}

/** The steepest sample on the map, as world (x, z). */
function steepest(): { x: number; z: number; slope: number } {
  let best = { x: 0, z: 0, slope: -1 };
  for (let j = 1; j < terrain.samples - 1; j++) {
    for (let i = 1; i < terrain.samples - 1; i++) {
      const x = (i + 0.5) * terrain.spacing;
      const z = (j + 0.5) * terrain.spacing;
      const s = slopeAt(terrain, x, z);
      if (s > best.slope) best = { x, z, slope: s };
    }
  }
  return best;
}

describe("intersectGround", () => {
  it("a ray straight down lands on heightAt", () => {
    for (const [x, z] of [
      [6000, 6000],
      [123.4, 9876.5],
      [11000.25, 300.75],
    ] as const) {
      const hit = intersectGround(terrain, { ox: x, oy: 5000, oz: z, dx: 0, dy: -1, dz: 0 });
      expect(hit).not.toBeNull();
      expect(hit?.x).toBeCloseTo(x, 6);
      expect(hit?.z).toBeCloseTo(z, 6);
      expect(hit?.y).toBeCloseTo(heightAt(terrain, x, z), 3);
    }
  });

  it("oblique rays agree with a brute-force march to within a centimetre", () => {
    const cases: Ray[] = [
      aimedAt(4000, 7000, 2500, 0.6, 0.3),
      aimedAt(8000, 3000, 9000, 0.35, 2.1),
      aimedAt(2500, 2500, 600, 0.25, -1.2),
      aimedAt(6000, 6000, 14000, 0.7, 0),
    ];
    for (const ray of cases) {
      const hit = intersectGround(terrain, ray);
      const want = bruteForce(ray);
      expect(want).not.toBeNull();
      expect(hit).not.toBeNull();
      expect(Math.hypot((hit?.x ?? 0) - (want?.x ?? 0), (hit?.z ?? 0) - (want?.z ?? 0))).toBeLessThan(0.01);
    }
  });

  it("picks on the steepest slope of the map, from across and along it", () => {
    const s = steepest();
    expect(s.slope).toBeGreaterThan(0.5);
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      for (const pitch of [0.15, 0.5, 1.3]) {
        const ray = aimedAt(s.x, s.z, 800, pitch, yaw);
        const hit = intersectGround(terrain, ray);
        const want = bruteForce(ray, 0.02);
        expect(want).not.toBeNull();
        expect(Math.hypot((hit?.x ?? 0) - (want?.x ?? 0), (hit?.z ?? 0) - (want?.z ?? 0))).toBeLessThan(0.01);
      }
    }
  });

  it("picks at the map edges and corners", () => {
    for (const [x, z] of [
      [0, 6000],
      [size, 6000],
      [6000, 0],
      [6000, size],
      [size - 0.5, size - 0.5],
      [0.25, 0.25],
    ] as const) {
      const ray = aimedAt(x, z, 3000, 0.9, Math.atan2(x - size / 2, z - size / 2) + Math.PI);
      const hit = intersectGround(terrain, ray);
      expect(hit).not.toBeNull();
      expect(Math.hypot((hit?.x ?? 0) - x, (hit?.z ?? 0) - z)).toBeLessThan(0.01);
    }
  });

  it("a ray just past the edge misses, and one entering through the side hits the edge", () => {
    const edgeH = heightAt(terrain, size, 6000);
    expect(intersectGround(terrain, { ox: size + 1, oy: 3000, oz: 6000, dx: 0, dy: -1, dz: 0 })).toBeNull();
    const side = intersectGround(terrain, { ox: size + 500, oy: edgeH - 5, oz: 6000, dx: -1, dy: 0, dz: 0 });
    expect(side?.x).toBeCloseTo(size, 6);
    expect(side?.y).toBeCloseTo(edgeH, 3);
  });

  it("misses when the ray looks at the sky or starts underground", () => {
    expect(intersectGround(terrain, { ox: 6000, oy: 2000, oz: 6000, dx: 0.3, dy: 1, dz: 0 })).toBeNull();
    const h = heightAt(terrain, 6000, 6000);
    expect(intersectGround(terrain, { ox: 6000, oy: h - 10, oz: 6000, dx: 0, dy: -1, dz: 0 })).toBeNull();
  });
});

describe("zoomBand", () => {
  it("changes at the configured heights", () => {
    expect(zoomBand(0)).toBe("street");
    expect(zoomBand(ZOOM_BANDS.streetBelow - 0.01)).toBe("street");
    expect(zoomBand(ZOOM_BANDS.streetBelow)).toBe("district");
    expect(zoomBand(ZOOM_BANDS.districtBelow - 0.01)).toBe("district");
    expect(zoomBand(ZOOM_BANDS.districtBelow)).toBe("city");
    expect(zoomBand(50_000)).toBe("city");
  });

  it("starts from the PRD's values", () => {
    expect(ZOOM_BANDS).toEqual({ streetBelow: 500, districtBelow: 3000 });
  });
});

describe("camera rig", () => {
  const viewport = { width: 1280, height: 720 };
  function rig() {
    const camera = new PerspectiveCamera(45, viewport.width / viewport.height, 10, 60_000);
    return { camera, rig: createCameraRig(camera, terrain, () => viewport) };
  }
  const clearOf = (camera: PerspectiveCamera) =>
    camera.position.y - heightAt(terrain, camera.position.x, camera.position.z);

  it("never puts the camera under the terrain", () => {
    const { camera, rig: r } = rig();
    const s = steepest();
    r.setPose([s.x, -500, s.z + 50], [s.x, heightAt(terrain, s.x, s.z), s.z]);
    expect(clearOf(camera)).toBeGreaterThanOrEqual(CAMERA_LIMITS.clearance - 1e-6);
    // Tilt down and zoom in hard all around the steepest point.
    for (let k = 0; k < 64; k++) {
      r.orbit(0.1, -0.5);
      r.zoomAt(0.5, viewport.width / 2, viewport.height / 2);
      expect(clearOf(camera)).toBeGreaterThanOrEqual(CAMERA_LIMITS.clearance - 1e-6);
    }
  });

  it("keeps the target on the map and the distance in range", () => {
    const { rig: r } = rig();
    r.setPose([6000, 3000, 9000], [6000, 0, 6000]);
    r.pan(1e6, -1e6);
    expect(r.pose.target.x).toBe(size);
    expect(r.pose.target.z).toBe(0);
    for (let k = 0; k < 50; k++) r.zoomAt(4, 10, 10);
    expect(r.pose.distance).toBe(CAMERA_LIMITS.maxDistance);
    for (let k = 0; k < 50; k++) r.zoomAt(0.25, 640, 360);
    expect(r.pose.distance).toBe(CAMERA_LIMITS.minDistance);
    // Whatever happened, the ground is still under the screen centre.
    expect(r.pickGround(viewport.width / 2, viewport.height / 2)).not.toBeNull();
  });

  it("zooming keeps the ground under the cursor where it was", () => {
    const { rig: r } = rig();
    r.setPose([5000, 2500, 8000], [5000, 0, 5500]);
    const [sx, sy] = [900, 500];
    const before = r.pickGround(sx, sy);
    expect(before).not.toBeNull();
    r.zoomAt(0.7, sx, sy);
    const after = r.pickGround(sx, sy);
    expect(Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.z ?? 0) - (before?.z ?? 0))).toBeLessThan(1);
  });

  it("dragging keeps the grabbed ground under the cursor", () => {
    const { rig: r } = rig();
    r.setPose([5000, 2500, 8000], [5000, 0, 5500]);
    const grabbed = r.pickGround(600, 400);
    r.grab(600, 400);
    r.dragTo(700, 300);
    const after = r.pickGround(700, 300);
    expect(Math.hypot((after?.x ?? 0) - (grabbed?.x ?? 0), (after?.z ?? 0) - (grabbed?.z ?? 0))).toBeLessThan(1);
  });

  it("reports the zoom band from the camera's height above the ground", () => {
    const { rig: r } = rig();
    const ground = heightAt(terrain, 6000, 6000);
    for (const [height, band] of [
      [400, "street"],
      [600, "district"],
      [2900, "district"],
      [3100, "city"],
    ] as const) {
      // Nearly straight down; the pitch limit tilts it a little off vertical.
      r.setPose([6000, ground + height, 6000.5], [6000, ground, 6000]);
      expect(Math.abs(r.heightAboveGround() - height)).toBeLessThan(30);
      expect(r.zoomBand()).toBe(band);
    }
  });
});

describe("intersectGround at the rim", () => {
  it("a ray aimed exactly at a point on the edge hits it", () => {
    // The rig clamps its target onto the edge and looks straight at it; the
    // centre ray then meets the ground right at the boundary.
    for (const [x, z] of [
      [size, size],
      [size, 4321.5],
      [0, 0],
      [777.7, size],
    ] as const) {
      for (const [pitch, yaw] of [
        [0.14, 0.3],
        [0.6, 2.5],
        [1.2, -2],
      ] as const) {
        const ray = aimedAt(x, z, 20_000, pitch, yaw);
        const hit = intersectGround(terrain, ray);
        expect(hit, `edge ${x}, ${z} from pitch ${pitch} yaw ${yaw}`).not.toBeNull();
      }
    }
  });
});

describe("intersectGround along the rim", () => {
  it("a ray running in the plane of an edge, a rounding error outside it, still hits", () => {
    // What the rig produces with its target clamped to x = 0 and yaw 0: the
    // camera sits on the edge plane and the ray from it runs along that plane.
    for (const ox of [0, -1e-12, -1e-9, size + 1e-9]) {
      const x = ox < size / 2 ? 0 : size;
      const y = heightAt(terrain, x, 0);
      const ray = { ox, oy: y + 14142, oz: 14142, dx: 0, dy: -14142, dz: -14142 };
      const hit = intersectGround(terrain, ray);
      expect(hit, `origin x ${ox}`).not.toBeNull();
      expect(hit?.z ?? 99).toBeCloseTo(0, 2);
    }
  });
});
