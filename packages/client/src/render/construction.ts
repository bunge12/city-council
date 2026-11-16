// Construction on screen (issue 136): a new building draws in three stages
// over `CONSTRUCTION.ticks` of game time. Scaffolding rises round its lot,
// the building rises inside it, and the scaffolding comes down. It is a view
// of a building the sim built whole on one tick: the sim has no construction
// state, and nothing here reaches it.
//
// A building's age is the game tick on screen less its `builtAt`, so the
// animation runs on game time: faster at 4x, frozen when paused, and done for
// a building already older than the animation when the city loads or when it
// comes into view. The shaders work the stages out per vertex from the
// building's `builtAt` and one uniform, the tick, so an animating building
// costs no draw call and no write a frame (building-meshes.ts).

import { attribute, clamp, float, floor, fract, max, min, mix, positionGeometry, select, step, uniform, varying } from "three/tsl";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, MeshLambertNodeMaterial, Vector3, type Node, type UniformNode } from "three/webgpu";
import { TICK_MS } from "@city-council/sim";
import { CONSTRUCTION } from "./config";

/** A `builtAt` that is always finished: for a building drawn before the animation, or with it off. */
export const LONG_AGO = -1e9;

/** How far through each stage a building `age` ticks old is, each from 0 to 1. */
export interface Stages {
  /** Share of the scaffolding's height standing: up over the first stage, down over the last. */
  scaffold: number;
  /** Share of the building's height risen out of the ground. */
  rise: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The stages of a building `age` ticks old. The shaders below work out the same. */
export function stagesAt(age: number): Stages {
  const u = age / CONSTRUCTION.ticks;
  const up = clamp01(u / CONSTRUCTION.scaffoldUp);
  const down = clamp01((u - (1 - CONSTRUCTION.scaffoldDown)) / CONSTRUCTION.scaffoldDown);
  const rise = clamp01((u - CONSTRUCTION.scaffoldUp) / (1 - CONSTRUCTION.scaffoldUp - CONSTRUCTION.scaffoldDown));
  return { scaffold: u >= 1 ? 0 : up * (1 - down), rise };
}

/** Whether a building built at `builtAt` is still under construction at tick `tick`. */
export function underConstruction(builtAt: number, tick: number): boolean {
  return tick - builtAt < CONSTRUCTION.ticks;
}

/** The tick a building's construction ends on. */
export function finishedAt(builtAt: number): number {
  return builtAt + CONSTRUCTION.ticks;
}

type F = Node<"float">;

/** The tick on screen, read by every construction shader. Set once a frame. */
export function tickUniform(): UniformNode<"float", number> {
  // Far in the future until the first frame sets it, so nothing animates before the city is known.
  return uniform(1e9);
}

/** `stagesAt(tick - built).rise`, in a shader. */
export function riseNode(tick: F, built: F) {
  const u = float(tick).sub(built).div(CONSTRUCTION.ticks);
  return clamp(u.sub(CONSTRUCTION.scaffoldUp).div(1 - CONSTRUCTION.scaffoldUp - CONSTRUCTION.scaffoldDown), 0, 1);
}

/** `stagesAt(tick - built).scaffold`, in a shader. */
export function scaffoldNode(tick: F, built: F) {
  const u = float(tick).sub(built).div(CONSTRUCTION.ticks);
  const up = clamp(u.div(CONSTRUCTION.scaffoldUp), 0, 1);
  const down = clamp(u.sub(1 - CONSTRUCTION.scaffoldDown).div(CONSTRUCTION.scaffoldDown), 0, 1);
  return select(u.greaterThanEqual(1), 0, up.mul(float(1).sub(down)));
}

/**
 * A rising building, in a shader. `built` is when it was built, `height` its
 * height in metres above the ground it stands on, and `y` each vertex's
 * height above the bottom of its foundations. The building is drawn `sink`
 * metres lower than it stands, a little more than its height at first, so
 * it comes up out of the ground as it rises. Whatever has sunk below where
 * the bottom of its foundations stands is not drawn: `keep` is false there.
 * The foundations reach down past the lowest ground under the lot (theme
 * generators), so on a slope the building comes up out of the ground on
 * every side, with the terrain hiding what is still under it. A finished
 * building sinks by nothing and keeps every pixel.
 */
export function rising(tick: F, built: F, height: F, y: F) {
  const r = riseNode(tick, built);
  // 20 cm more than the height, so a flat roof is under the ground before the building starts to rise.
  const sink = varying(float(1).sub(r).mul(float(height).add(0.2)));
  const below = varying(float(y));
  const done = varying(r).greaterThanEqual(0.999);
  return { sink, keep: done.or(below.greaterThanEqual(sink)) };
}

/**
 * Scaffolding round one building, as one instance of a unit box's four
 * walls (`scaffoldGeometry`), scaled to the building and drawn as a lattice
 * by its material: poles and boards, and nothing between them.
 */
export function scaffoldGeometry(): BufferGeometry {
  // Walls of the box x, z in [-0.5, 0.5], y in [0, 1]: +x, -x, +z, -z. Each its own four corners, flat shaded.
  const walls: { n: [number, number, number]; along: 0 | 1; corners: [number, number, number][] }[] = [
    { n: [1, 0, 0], along: 1, corners: [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]] },
    { n: [-1, 0, 0], along: 1, corners: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]] },
    { n: [0, 0, 1], along: 0, corners: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] },
    { n: [0, 0, -1], along: 0, corners: [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]] },
  ];
  const positions = new Float32Array(walls.length * 4 * 3);
  const normals = new Float32Array(walls.length * 4 * 3);
  const axes = new Float32Array(walls.length * 4);
  const indices = new Uint16Array(walls.length * 6);
  walls.forEach((w, k) => {
    w.corners.forEach((c, n) => {
      positions.set(c, (k * 4 + n) * 3);
      normals.set(w.n, (k * 4 + n) * 3);
      axes[k * 4 + n] = w.along;
    });
    indices.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setAttribute("normal", new BufferAttribute(normals, 3));
  g.setAttribute("scaffoldAxis", new BufferAttribute(axes, 1));
  g.setIndex(new BufferAttribute(indices, 1));
  return g;
}

function linear(hex: number) {
  const c = new Color(hex);
  return uniform(new Vector3(c.r, c.g, c.b));
}

/** 1 within `half` metres of a line every `size / n` metres along a span of `size` metres, `t` in [0, 1] across it, including both ends. */
function lines(t: F, size: F, spacing: number, half: number) {
  const n = max(floor(float(size).div(spacing).add(0.5)), 1);
  const f = fract(float(t).mul(n));
  return step(min(f, float(1).sub(f)).mul(float(size).div(n)), half);
}

/**
 * The scaffolding's material. Each instance carries its box's size in
 * metres, `scaffoldSize`, its building's `builtAt`, `scaffoldBuilt`, and its
 * chunk's fade, `scaffoldFade`. A pixel is drawn where a pole or a board is,
 * up to the share of the height the stage has standing; `kept` is the
 * buildings' dither for a chunk changing form (building-meshes.ts).
 */
export function scaffoldMaterial(tick: F, kept: (fade: Node<"float">) => Node<"float">): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial();
  m.name = "scaffolding";
  m.side = DoubleSide;
  const size = attribute<"vec3">("scaffoldSize", "vec3");
  const built = attribute<"float">("scaffoldBuilt", "float");
  const fade = varying(attribute<"float">("scaffoldFade", "float"));
  const axis = attribute<"float">("scaffoldAxis", "float");
  const standing = varying(scaffoldNode(tick, built));
  const height = varying(size.y);
  const up = varying(positionGeometry.y.mul(size.y));
  // Across the wall from one corner to the other, 0 to 1, and the wall's length.
  const t = varying(select(axis.lessThan(0.5), positionGeometry.x, positionGeometry.z).add(0.5));
  const span = varying(select(axis.lessThan(0.5), size.x, size.z));
  const pole = lines(t, span, CONSTRUCTION.poleSpacing, CONSTRUCTION.pole / 2);
  const board = lines(float(up).div(height), height, CONSTRUCTION.lift, CONSTRUCTION.board / 2);
  m.colorNode = mix(linear(CONSTRUCTION.boardColour), linear(CONSTRUCTION.poleColour), pole);
  const lattice = max(pole, board).greaterThan(0.5);
  // The scaffolding stands from the ground up to its share: rising, it grows from the bottom, and coming down, it goes from the top.
  m.maskNode = lattice.and(float(up).lessThanEqual(float(standing).mul(height))).and(standing.greaterThan(0)).and(kept(fade).greaterThan(0.5));
  return m;
}

/**
 * The tick on screen, from the mirror's: the mirror moves in whole ticks
 * when deltas arrive, and between them the clock runs on at the city's
 * speed, by at most `lead` ticks, so a building rises smoothly at 1x. It
 * never runs back, except to a snapshot, which may be of another city.
 * Paused, it stops. Real time is read here only to smooth what is drawn;
 * nothing the sim does depends on it.
 */
export interface GameClock {
  /** The mirror is at `tick` and runs at `speed`, as of real time `nowMs`. */
  observe(tick: number, speed: number, nowMs: number): void;
  /** A snapshot: the clock starts again at its tick. */
  reset(tick: number, speed: number, nowMs: number): void;
  /** The tick to draw at real time `nowMs`. */
  at(nowMs: number): number;
}

export function createGameClock(lead = 1): GameClock {
  let tick = 0;
  let speed = 0;
  let since = 0;
  let shown = -Infinity;
  return {
    observe(t, s, nowMs) {
      if (t !== tick || s !== speed) {
        tick = t;
        speed = s;
        since = nowMs;
      }
    },
    reset(t, s, nowMs) {
      tick = t;
      speed = s;
      since = nowMs;
      shown = -Infinity;
    },
    at(nowMs) {
      const ahead = Math.min(lead, (Math.max(0, nowMs - since) * speed) / TICK_MS);
      shown = Math.max(shown, tick + ahead);
      return shown;
    },
  };
}
