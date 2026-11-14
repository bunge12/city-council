// The scene's light: one fixed sun and one ambient light, set up for the
// graphics preset in use. Low has a flat fill and no shadows. Balanced and
// High fill from the sky and the ground, and the sun casts shadows from one
// shadow map that follows the point the camera looks at.
//
// Shadows cost new shaders for every lit material. They are compiled before
// the switch, on a stand-in scene that shares the real scene's geometry and
// materials, so the frame loop keeps drawing the old lighting meanwhile and
// the first frame never waits for them.

import {
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  Scene,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type WebGPURenderer,
} from "three/webgpu";
import { LIGHTING, SHADOWS } from "./config";
import { lightingFor, type LightingSettings, type Preset } from "./presets";

/** A world point as x, y, z in metres. */
export type Vec3 = readonly [number, number, number];

/**
 * Where the shadow map centres: the ground point the camera looks at, found
 * by marching the view ray down to `groundAt`, but never more than `range`
 * metres from the camera across the ground, so shadows stay near the camera
 * when it looks at the horizon.
 */
export function shadowFocus(eye: Vec3, forward: Vec3, groundAt: (x: number, z: number) => number, range: number): Vec3 {
  const [ex, ey, ez] = eye;
  const [fx, fy, fz] = forward;
  const across = Math.hypot(fx, fz);
  // How far along the ray the camera may look before the cap applies.
  const cap = across > 1e-6 ? range / across : 0;
  let t = cap;
  if (fy < -1e-6) {
    // Two refinements of the plane through the ground below, then the ground at the hit.
    let ground = groundAt(ex, ez);
    for (let k = 0; k < 3; k++) {
      const hit = (ground - ey) / fy;
      if (!(hit > 0)) break;
      t = Math.min(hit, cap);
      ground = groundAt(ex + fx * t, ez + fz * t);
    }
  }
  const x = ex + fx * t;
  const z = ez + fz * t;
  return [x, groundAt(x, z), z];
}

/**
 * Moves `focus` to the nearest point on the shadow map's texel grid, seen
 * from the sun, so the shadows of things standing still do not crawl as the
 * camera pans. The axes match a DirectionalLight's shadow camera, which looks
 * down `-sun` with +y up.
 */
export function snapToTexels(focus: Vec3, sun: Vec3, texel: number): Vec3 {
  const d = new Vector3(...sun).normalize();
  const right = new Vector3(0, 1, 0).cross(d).normalize();
  const up = new Vector3().crossVectors(d, right);
  const p = new Vector3(...focus);
  const u = Math.round(p.dot(right) / texel) * texel;
  const v = Math.round(p.dot(up) / texel) * texel;
  const w = p.dot(d);
  const out = right.multiplyScalar(u).add(up.multiplyScalar(v)).add(d.multiplyScalar(w));
  return [out.x, out.y, out.z];
}

/** What the lighting reports, for tests and the debug panel. */
export interface LightingReport {
  preset: Preset;
  shadows: boolean;
  /** Half-width of the square the shadow map covers, metres, or 0. */
  shadowRange: number;
  shadowMapSize: number;
  softAmbient: boolean;
  /** Where the shadow map centres now. */
  focus: Vec3 | null;
}

export interface Lighting {
  /** The preset whose lighting is on screen. */
  preset(): Preset;
  /**
   * Switches to `preset`. Shaders it needs are compiled first, off the frame
   * loop, and the switch lands once they are ready. A later call wins over
   * an earlier one still compiling.
   */
  setPreset(preset: Preset): Promise<void>;
  /** Moves the shadow map to follow the camera. Call before each frame. */
  update(camera: Camera, groundAt: ((x: number, z: number) => number) | null): void;
  report(): LightingReport;
}

const tmpDir = new Vector3();

/** A key for the shader a mesh needs: its material, its attributes and how it is drawn. */
function shaderKey(mesh: Mesh): string {
  const g = mesh.geometry as BufferGeometry;
  const attrs = Object.keys(g.attributes).sort().join(",");
  const inst = mesh instanceof InstancedMesh ? `i${mesh.instanceColor ? "c" : ""}` : "m";
  const material = mesh.material as Material | Material[];
  const mats = Array.isArray(material) ? material.map((m) => m.uuid).join("+") : material.uuid;
  return `${mats}|${attrs}|${inst}|${g.index ? "x" : "-"}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
}

/** Adds the sun and the ambient light to `scene`, lit as Low until `setPreset` says otherwise. */
export function createLighting(renderer: WebGPURenderer, scene: Scene): Lighting {
  // Always on: whether a frame draws shadows is the sun's castShadow. Turning
  // the renderer's flag on and off would change every material's shaders.
  renderer.shadowMap.enabled = true;

  const sun = new DirectionalLight(LIGHTING.sun.colour, LIGHTING.sun.intensity);
  sun.name = "sun";
  sun.position.set(...LIGHTING.sun.direction);
  sun.castShadow = false;
  sun.shadow.bias = SHADOWS.bias;
  sun.shadow.normalBias = SHADOWS.normalBias;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SHADOWS.depth * 2;
  scene.add(sun, sun.target);

  const ambient = new HemisphereLight(LIGHTING.ambient.sky, LIGHTING.ambient.ground, LIGHTING.ambient.intensity);
  ambient.name = "ambient";
  scene.add(ambient);

  let settings: LightingSettings = lightingFor("low");
  let focus: Vec3 | null = null;
  /** Bumped by every setPreset, so a slow compile does not land after a newer choice. */
  let request = 0;

  function apply(next: LightingSettings, light: DirectionalLight, fill: HemisphereLight): void {
    if (next.softAmbient) {
      fill.color.set(LIGHTING.ambient.sky);
      fill.groundColor.set(LIGHTING.ambient.ground);
    } else {
      fill.color.set(LIGHTING.ambient.flat);
      fill.groundColor.set(LIGHTING.ambient.flat);
    }
    const shadows = next.shadows;
    light.castShadow = shadows !== null;
    if (shadows) {
      const cam = light.shadow.camera;
      cam.left = -shadows.range;
      cam.right = shadows.range;
      cam.top = shadows.range;
      cam.bottom = -shadows.range;
      cam.updateProjectionMatrix();
      if (light.shadow.mapSize.x !== shadows.mapSize) {
        light.shadow.mapSize.set(shadows.mapSize, shadows.mapSize);
        // A shadow map of the old size is thrown away and made again at the next frame.
        light.shadow.map?.dispose();
        light.shadow.map = null;
      }
    }
  }
  apply(settings, sun, ambient);

  /**
   * Compiles the shaders `next` needs on a stand-in scene: one mesh per
   * distinct shader in the real scene, sharing its geometry and material,
   * lit by a copy of the lights set up as `next`. Shader programs are cached
   * by their code, so when the real scene switches it finds them ready.
   */
  async function compileFor(next: LightingSettings, camera: Camera): Promise<void> {
    const proxy = new Scene();
    const light = sun.clone();
    const fill = ambient.clone();
    apply(next, light, fill);
    proxy.add(light, light.target, fill);
    const seen = new Set<string>();
    scene.traverse((o: Object3D) => {
      if (!(o instanceof Mesh) || o.parent === null) return;
      // Empty layers, such as a preview with nothing to show, have no shader yet.
      if (!(o.geometry as BufferGeometry).getAttribute("position")) return;
      const key = shaderKey(o);
      if (seen.has(key)) return;
      seen.add(key);
      let stand: Mesh;
      if (o instanceof InstancedMesh) {
        const inst = new InstancedMesh(o.geometry, o.material, o.count);
        inst.instanceMatrix = o.instanceMatrix;
        inst.instanceColor = o.instanceColor;
        stand = inst;
      } else {
        stand = new Mesh(o.geometry, o.material);
      }
      stand.castShadow = o.castShadow;
      stand.receiveShadow = o.receiveShadow;
      stand.renderOrder = o.renderOrder;
      stand.frustumCulled = false;
      proxy.add(stand);
    });
    await renderer.compileAsync(proxy, camera);
  }

  let camera: Camera | null = null;

  return {
    preset: () => settings.preset,
    async setPreset(preset) {
      const mine = ++request;
      const next = lightingFor(preset);
      // Only shadows change the shaders. The ambient colours are uniforms.
      if (next.shadows !== null && settings.shadows === null && camera) {
        try {
          await compileFor(next, camera);
        } catch {
          // The switch still lands; its shaders then compile on the frame that needs them.
        }
      }
      if (mine !== request) return;
      settings = next;
      apply(settings, sun, ambient);
    },
    update(cam, groundAt) {
      camera = cam;
      const shadows = settings.shadows;
      if (!shadows || !groundAt) {
        focus = null;
        return;
      }
      cam.getWorldDirection(tmpDir);
      const eye: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
      const raw = shadowFocus(eye, [tmpDir.x, tmpDir.y, tmpDir.z], groundAt, shadows.range);
      const at = snapToTexels(raw, LIGHTING.sun.direction, (2 * shadows.range) / shadows.mapSize);
      focus = at;
      const d = tmpDir.set(...LIGHTING.sun.direction).normalize();
      sun.target.position.set(...at);
      sun.position.set(at[0] + d.x * SHADOWS.depth, at[1] + d.y * SHADOWS.depth, at[2] + d.z * SHADOWS.depth);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
    },
    report() {
      return {
        preset: settings.preset,
        shadows: settings.shadows !== null,
        shadowRange: settings.shadows?.range ?? 0,
        shadowMapSize: settings.shadows?.mapSize ?? 0,
        softAmbient: settings.softAmbient,
        focus,
      };
    },
  };
}

/** Sky colour behind everything. */
export function skyColour(): Color {
  return new Color(LIGHTING.sky);
}
