// The North American theme's building generators (issue M2-12, PRD "Art
// direction"). One generator per building type in the sim's
// `buildings.json`, each a short function that builds the type's model from
// the lot it stands on and one of its variants: the floor count, the roof
// shape, the window rhythm and what stands at street level. Plain shapes
// for now; a generator can be replaced by a better one, or by an authored
// model, without touching the sim or the renderer.
//
// The kits below are the shapes the generators share: a house, a row of
// units, a block, a tower on a podium, a shed and a tank farm.

import { FACADE, ModelBuilder, SURFACE, type Facade, type FacadeKind, type ModelArrays } from "../model";

/** The lot a model is built for, in metres: x from -w/2 to w/2 along the road, z from -d/2 at the back to d/2 at the road. */
export interface Lot {
  w: number;
  d: number;
}

/**
 * How far a building's base reaches below its floor, in metres. A building
 * stands at the highest ground under it (render/building-place.ts); on a
 * slope the base fills the gap down to the ground. Zoning allows a rise of
 * 0.25 (zoning.json), 12 m over a lot six cells deep.
 */
export const BASE_DEPTH = 13;
/** Height of the base above the ground at its highest corner. */
const BASE_TOP = 0.3;

const { wall: WALL, roof: ROOF, trim: TRIM, glass: GLASS, paving: PAVING } = SURFACE;

function facade(kind: FacadeKind, spacing: number, floor: number): Facade {
  return { kind, spacing, floor };
}

/** The base a building stands on, under x0..x1, z0..z1. */
function base(b: ModelBuilder, x0: number, x1: number, z0: number, z1: number): void {
  b.box(x0, x1, -BASE_DEPTH, BASE_TOP, z0, z1, TRIM, TRIM);
}

/** Paving at street level over x0..x1, z0..z1: a drive, a yard or a car park. */
function paving(b: ModelBuilder, x0: number, x1: number, z0: number, z1: number): void {
  b.box(x0, x1, -BASE_DEPTH, 0.12, z0, z1, PAVING, PAVING);
}

/** A flat roof with a cornice: the roof's top at `y` over x0..x1, z0..z1, edged in trim. */
function flatRoof(b: ModelBuilder, x0: number, x1: number, z0: number, z1: number, y: number, lip = 0.35): void {
  b.box(x0 - lip, x1 + lip, y - 0.5, y + 0.4, z0 - lip, z1 + lip, TRIM, ROOF);
}

/** A small box on a roof: a plant room or a stair head. */
function plantRoom(b: ModelBuilder, x0: number, x1: number, z0: number, z1: number, y: number, h: number): void {
  b.box(x0, x1, y, y + h, z0, z1, TRIM, TRIM);
}

// The kits.

export interface HouseVariant {
  floors: 1 | 2;
  roof: "gable" | "hip" | "side-gable";
  porch: boolean;
  garage: boolean;
  /** Metres from the road to the front wall. */
  front: number;
  /** Metres between windows. */
  spacing: number;
}

/** A detached house with a yard, a porch and a garage on a drive. */
export function house(lot: Lot, v: HouseVariant): ModelArrays {
  const b = new ModelBuilder();
  const garage = v.garage && lot.w >= 12;
  const side = Math.min(1.5, lot.w * 0.1);
  const x0 = -lot.w / 2 + side;
  const x1 = lot.w / 2 - side - (garage ? 4 : 0);
  const z1 = lot.d / 2 - Math.min(v.front, lot.d * 0.3);
  const z0 = Math.max(-lot.d / 2 + Math.max(2, lot.d * 0.2), z1 - 11);
  const storey = 2.9;
  const top = BASE_TOP + v.floors * storey;
  base(b, x0, x1, z0, z1);
  b.box(x0, x1, BASE_TOP, top, z0, z1, WALL, null, facade(FACADE.windows, v.spacing, storey));
  const rise = Math.min(x1 - x0, z1 - z0) * 0.38;
  if (v.roof === "hip") b.hip(x0, x1, z0, z1, top, rise, ROOF);
  else b.gable(x0, x1, z0, z1, top, rise, v.roof === "gable", ROOF, WALL);
  if (v.porch) {
    const p0 = x0 + 0.6;
    const p1 = Math.min(x1 - 0.6, p0 + Math.max(3, (x1 - x0) * 0.45));
    b.box(p0, p1, -BASE_DEPTH, BASE_TOP + 0.15, z1, z1 + 1.8, TRIM, TRIM);
    b.box(p0, p1, 2.6, 2.85, z1, z1 + 1.9, TRIM, ROOF);
    b.box(p0, p0 + 0.2, BASE_TOP, 2.6, z1 + 1.6, z1 + 1.8, TRIM, null);
    b.box(p1 - 0.2, p1, BASE_TOP, 2.6, z1 + 1.6, z1 + 1.8, TRIM, null);
  }
  if (garage) {
    const g0 = x1 + 0.2;
    const g1 = g0 + 3.6;
    const gz0 = z1 - 6.5;
    base(b, g0, g1, gz0, z1);
    b.box(g0, g1, BASE_TOP, 3, gz0, z1, WALL, null, facade(FACADE.doors, 3.6, 3));
    b.gable(g0, g1, gz0, z1, 3, 1.2, false, ROOF, WALL, 0.25);
    paving(b, g0 + 0.3, g1 - 0.3, z1, lot.d / 2);
  } else {
    paving(b, x0 + 0.6, x0 + 1.8, z1 + (v.porch ? 1.8 : 0), lot.d / 2);
  }
  return b.build();
}

export interface RowVariant {
  floors: number;
  /** Metres of road front each unit takes, about. */
  unit: number;
  roof: "gable" | "flat";
  /** Units step back and up in turn, so a row reads as houses. */
  stagger: boolean;
  /** Shops at street level. */
  shops: boolean;
  front: number;
  spacing: number;
}

/** A row of units side by side: plexes, townhomes, shops with flats over them. */
export function row(lot: Lot, v: RowVariant): ModelArrays {
  const b = new ModelBuilder();
  const side = lot.w >= 16 ? 0.8 : 0.4;
  const x0 = -lot.w / 2 + side;
  const x1 = lot.w / 2 - side;
  const front = Math.min(v.front, lot.d * 0.3);
  const z1 = lot.d / 2 - front;
  const z0 = Math.max(-lot.d / 2 + Math.min(3, lot.d * 0.15), z1 - 13);
  const units = Math.max(1, Math.round((x1 - x0) / v.unit));
  const each = (x1 - x0) / units;
  const ground = v.shops ? 4.2 : 3;
  for (let i = 0; i < units; i++) {
    const a = x0 + i * each;
    const c = a + each;
    const back = v.stagger && i % 2 === 1 ? 0.8 : 0;
    const extra = v.stagger ? ((i * 5 + 2) % 3) * 0.5 : 0;
    const uz1 = z1 - back;
    const top = BASE_TOP + ground + (v.floors - 1) * 3 + extra;
    base(b, a, c, z0, uz1);
    if (v.shops) {
      b.box(a, c, BASE_TOP, BASE_TOP + ground, z0, uz1, WALL, null, facade(FACADE.storefront, Math.min(each, 6), ground));
      b.box(a - 0.1, c + 0.1, BASE_TOP + ground - 0.35, BASE_TOP + ground, z0, uz1 + 0.5, TRIM, TRIM);
      if (v.floors > 1) b.box(a, c, BASE_TOP + ground, top, z0, uz1, WALL, null, facade(FACADE.windows, v.spacing, 3));
    } else {
      b.box(a, c, BASE_TOP, top, z0, uz1, WALL, null, facade(FACADE.windows, v.spacing, 3));
    }
    if (v.roof === "gable") b.gable(a, c, z0, uz1, top, Math.min(each, uz1 - z0) * 0.42, false, ROOF, WALL, 0.2);
    else flatRoof(b, a, c, z0, uz1, top, 0.2);
    if (!v.shops) b.box(a + each * 0.2, a + each * 0.2 + 1.4, -BASE_DEPTH, BASE_TOP + 0.2, uz1, uz1 + 1.2, TRIM, TRIM);
  }
  return b.build();
}

export interface BlockVariant {
  floors: number;
  /** What stands at street level. */
  ground: "storefront" | "windows" | "lobby";
  /** The walls above it. */
  upper: "windows" | "curtain";
  roof: "flat" | "gable" | "hip";
  /** Metres between windows. */
  spacing: number;
  /** Metres from one floor to the next. */
  storey: number;
  /** Metres from the road to the front wall, and from the lot's sides. */
  front: number;
  side: number;
  /** Share of the lot's depth the building takes, from its front. */
  cover: number;
  /** A plant room on the roof. */
  plant: boolean;
  /** Paving between the building and the road. */
  forecourt: boolean;
}

/** One block of several floors: apartments, shops, offices, a main street block. */
export function block(lot: Lot, v: BlockVariant): ModelArrays {
  const b = new ModelBuilder();
  const side = Math.min(v.side, lot.w * 0.15);
  const x0 = -lot.w / 2 + side;
  const x1 = lot.w / 2 - side;
  const z1 = lot.d / 2 - Math.min(v.front, lot.d * 0.35);
  const z0 = Math.max(-lot.d / 2 + 1, z1 - (lot.d - 1) * v.cover);
  const groundH = v.ground === "storefront" ? 4.5 : v.ground === "lobby" ? 4.2 : v.storey;
  const top = BASE_TOP + groundH + (v.floors - 1) * v.storey;
  base(b, x0, x1, z0, z1);
  const groundFacade = v.ground === "windows" ? facade(FACADE.windows, v.spacing, v.storey) : facade(v.ground === "lobby" ? FACADE.curtain : FACADE.storefront, 5, groundH);
  b.box(x0, x1, BASE_TOP, BASE_TOP + groundH, z0, z1, WALL, null, groundFacade);
  if (v.ground === "storefront") b.box(x0 - 0.1, x1 + 0.1, BASE_TOP + groundH - 0.45, BASE_TOP + groundH, z1, z1 + 1.2, TRIM, TRIM);
  if (v.floors > 1) {
    const upper = v.upper === "curtain" ? facade(FACADE.curtain, 1.6, v.storey) : facade(FACADE.windows, v.spacing, v.storey);
    b.box(x0, x1, BASE_TOP + groundH, top, z0, z1, WALL, null, upper);
  }
  const rise = Math.min(x1 - x0, z1 - z0) * 0.3;
  if (v.roof === "gable") b.gable(x0, x1, z0, z1, top, rise, true, ROOF, WALL);
  else if (v.roof === "hip") b.hip(x0, x1, z0, z1, top, rise, ROOF);
  else flatRoof(b, x0, x1, z0, z1, top);
  if (v.plant && v.roof === "flat") {
    const w = (x1 - x0) * 0.3;
    const d = (z1 - z0) * 0.3;
    plantRoom(b, -w / 2, w / 2, (z0 + z1) / 2 - d / 2, (z0 + z1) / 2 + d / 2, top + 0.4, 2.6);
  }
  if (v.forecourt) paving(b, x0, x1, z1, lot.d / 2);
  return b.build();
}

export interface TowerVariant {
  /** Floors of the podium, 0 for none. */
  podium: number;
  /** Shops in the podium's street level. */
  shops: boolean;
  floors: number;
  /** Share of the podium's width and depth the tower takes. */
  share: number;
  curtain: boolean;
  spacing: number;
  storey: number;
  /** What tops the tower. */
  crown: "flat" | "step" | "mast";
}

/** A tower, alone on its lot or on a podium. */
export function tower(lot: Lot, v: TowerVariant): ModelArrays {
  const b = new ModelBuilder();
  const x0 = -lot.w / 2 + 2;
  const x1 = lot.w / 2 - 2;
  const z1 = lot.d / 2 - 3;
  const z0 = -lot.d / 2 + 2;
  let y = BASE_TOP;
  base(b, x0, x1, z0, z1);
  if (v.podium > 0) {
    const ground = 4.5;
    b.box(x0, x1, y, y + ground, z0, z1, WALL, null, facade(v.shops ? FACADE.storefront : FACADE.curtain, v.shops ? 5 : 1.8, ground));
    y += ground;
    if (v.podium > 1) {
      b.box(x0, x1, y, y + (v.podium - 1) * 4, z0, z1, WALL, null, facade(FACADE.windows, 4, 4));
      y += (v.podium - 1) * 4;
    }
    flatRoof(b, x0, x1, z0, z1, y + 0.1, 0.3);
    y += 0.5;
  } else {
    paving(b, -lot.w / 2 + 0.5, lot.w / 2 - 0.5, z1, lot.d / 2);
  }
  const tw = (x1 - x0) * (v.podium > 0 ? v.share : 1);
  const td = (z1 - z0) * (v.podium > 0 ? v.share : 1);
  const tz = v.podium > 0 ? z0 + (z1 - z0 - td) * 0.35 + td / 2 : (z0 + z1) / 2;
  const t0 = -tw / 2;
  const t1 = tw / 2;
  const u0 = tz - td / 2;
  const u1 = tz + td / 2;
  const top = y + v.floors * v.storey;
  const walls = v.curtain ? facade(FACADE.curtain, 1.6, v.storey) : facade(FACADE.windows, v.spacing, v.storey);
  b.box(t0, t1, y, top, u0, u1, WALL, null, walls);
  if (v.crown === "step") {
    b.box(t0 + 1.2, t1 - 1.2, top, top + v.storey * 1.5, u0 + 1.2, u1 - 1.2, TRIM, null, facade(FACADE.windows, v.spacing, v.storey));
    flatRoof(b, t0 + 1.2, t1 - 1.2, u0 + 1.2, u1 - 1.2, top + v.storey * 1.5 + 0.3, 0.25);
  } else {
    flatRoof(b, t0, t1, u0, u1, top + 0.2, 0.3);
    plantRoom(b, t0 + tw * 0.3, t1 - tw * 0.3, u0 + td * 0.3, u1 - td * 0.3, top + 0.6, 3);
    if (v.crown === "mast") b.prism(0, tz, 0.4, top + 3.6, top + 3.6 + Math.max(8, v.floors * 0.6), 6, TRIM, TRIM);
  }
  return b.build();
}

export interface ShedVariant {
  height: number;
  roof: "flat" | "gable" | "saw";
  /** Share of the lot's depth the building takes. */
  cover: number;
  /** What its front wall shows. */
  front: "storefront" | "doors" | "windows" | "curtain";
  /** Paving: a car park in front, or a yard beside the building. */
  lot: "front" | "yard" | "none";
  /** A small office block at the front corner. */
  office: boolean;
  chimneys: number;
}

/** A low, wide building: a workshop, a warehouse, a factory, a store, a mall. */
export function shed(lot: Lot, v: ShedVariant): ModelArrays {
  const b = new ModelBuilder();
  const yard = v.lot === "yard";
  const x0 = -lot.w / 2 + 1;
  const x1 = lot.w / 2 - 1 - (yard ? lot.w * 0.3 : 0);
  const front = v.lot === "front" ? Math.min(lot.d * 0.4, 22) : 2.5;
  const z1 = lot.d / 2 - front;
  const z0 = Math.max(-lot.d / 2 + 1, z1 - (lot.d - front - 1) * v.cover);
  const top = BASE_TOP + v.height;
  base(b, x0, x1, z0, z1);
  const frontFacade =
    v.front === "storefront"
      ? facade(FACADE.storefront, 6, Math.min(v.height, 5))
      : v.front === "doors"
        ? facade(FACADE.doors, 6, v.height)
        : v.front === "curtain"
          ? facade(FACADE.curtain, 1.8, 3.8)
          : facade(FACADE.windows, 4, 4);
  b.box(x0, x1, BASE_TOP, top, z0, z1, WALL, null, frontFacade);
  if (v.roof === "gable") b.gable(x0, x1, z0, z1, top, Math.min(x1 - x0, z1 - z0) * 0.12, false, ROOF, WALL, 0.3);
  else if (v.roof === "saw") {
    const teeth = Math.max(2, Math.round((z1 - z0) / 8));
    const each = (z1 - z0) / teeth;
    for (let k = 0; k < teeth; k++) {
      const a = z0 + k * each;
      b.face(
        [
          [x0, top, a],
          [x1, top, a],
          [x1, top + 2.4, a + each],
          [x0, top + 2.4, a + each],
        ],
        ROOF,
        [(x0 + x1) / 2, top - 1, a + each * 0.6],
      );
      b.face(
        [
          [x1, top, a + each],
          [x0, top, a + each],
          [x0, top + 2.4, a + each],
          [x1, top + 2.4, a + each],
        ],
        GLASS,
        [(x0 + x1) / 2, top + 1, a],
      );
      b.face([[x0, top, a], [x0, top + 2.4, a + each], [x0, top, a + each]], WALL, [x0 + 1, top, a + each / 2]);
      b.face([[x1, top, a], [x1, top, a + each], [x1, top + 2.4, a + each]], WALL, [x1 - 1, top, a + each / 2]);
    }
  } else flatRoof(b, x0, x1, z0, z1, top, 0.3);
  if (v.office) {
    const ow = Math.min(12, (x1 - x0) * 0.4);
    base(b, x0, x0 + ow, z1, z1 + 1);
    b.box(x0, x0 + ow, BASE_TOP, BASE_TOP + 7.6, z1 - 6, z1 + 1, WALL, null, facade(FACADE.windows, 2.6, 3.8));
    flatRoof(b, x0, x0 + ow, z1 - 6, z1 + 1, BASE_TOP + 7.8, 0.2);
  }
  for (let k = 0; k < v.chimneys; k++) {
    const cx = x1 - 3 - k * 4;
    b.prism(cx, z0 + 3, 0.9, top, top + v.height * 1.4 + 4, 8, TRIM, TRIM);
  }
  if (v.lot === "front") paving(b, -lot.w / 2 + 0.5, lot.w / 2 - 0.5, z1, lot.d / 2 - 0.5);
  if (yard) paving(b, x1 + 0.5, lot.w / 2 - 0.5, -lot.d / 2 + 0.5, lot.d / 2 - 0.5);
  return b.build();
}

export interface TanksVariant {
  /** Tanks across and back. */
  across: number;
  back: number;
  height: number;
  /** A process hall at the front, as a share of the lot's depth, 0 for none. */
  hall: number;
  chimneys: number;
}

/** Tanks in a yard, with a process hall at the front. */
export function tanks(lot: Lot, v: TanksVariant): ModelArrays {
  const b = new ModelBuilder();
  paving(b, -lot.w / 2 + 0.5, lot.w / 2 - 0.5, -lot.d / 2 + 0.5, lot.d / 2 - 0.5);
  const hallD = (lot.d - 2) * v.hall;
  const z1 = lot.d / 2 - 1 - hallD;
  const z0 = -lot.d / 2 + 1;
  const cw = (lot.w - 2) / v.across;
  const cd = (z1 - z0) / v.back;
  const r = Math.min(cw, cd) * 0.4;
  for (let i = 0; i < v.across; i++) {
    for (let j = 0; j < v.back; j++) {
      const x = -lot.w / 2 + 1 + cw * (i + 0.5);
      const z = z0 + cd * (j + 0.5);
      b.prism(x, z, r, -BASE_DEPTH, v.height, 12, WALL, ROOF);
    }
  }
  if (hallD > 0) {
    const h0 = -lot.w / 2 + 1.5;
    const h1 = lot.w / 2 - 1.5;
    const hz0 = z1 + 0.5;
    const hz1 = lot.d / 2 - 1.5;
    base(b, h0, h1, hz0, hz1);
    b.box(h0, h1, BASE_TOP, BASE_TOP + 9, hz0, hz1, WALL, null, facade(FACADE.doors, 7, 9));
    flatRoof(b, h0, h1, hz0, hz1, BASE_TOP + 9, 0.2);
    for (let k = 0; k < v.chimneys; k++) b.prism(h1 - 2.5 - k * 3.5, (hz0 + hz1) / 2, 0.8, BASE_TOP + 9, BASE_TOP + 26, 8, TRIM, TRIM);
  }
  return b.build();
}

/** A generator: the model of variant `variant` for a lot. */
export type Generator = (lot: Lot, variant: number) => ModelArrays;

/** A generator for one type, from its kit and its variants. */
function of<V>(kit: (lot: Lot, v: V) => ModelArrays, variants: readonly V[]): { generate: Generator; models: number } {
  return { generate: (lot, k) => kit(lot, variants[k % variants.length] as V), models: variants.length };
}

const H = (floors: 1 | 2, roof: HouseVariant["roof"], porch: boolean, garage: boolean, front = 6, spacing = 3.2): HouseVariant => ({
  floors,
  roof,
  porch,
  garage,
  front,
  spacing,
});
const R = (floors: number, unit: number, roof: RowVariant["roof"], stagger: boolean, shops = false, front = 4, spacing = 2.8): RowVariant => ({
  floors,
  unit,
  roof,
  stagger,
  shops,
  front,
  spacing,
});
const B = (
  floors: number,
  ground: BlockVariant["ground"],
  roof: BlockVariant["roof"],
  more: Partial<BlockVariant> = {},
): BlockVariant => ({ floors, ground, roof, upper: "windows", spacing: 3, storey: 3.1, front: 3, side: 1, cover: 0.85, plant: true, forecourt: false, ...more });
const T = (floors: number, podium: number, share: number, more: Partial<TowerVariant> = {}): TowerVariant => ({
  floors,
  podium,
  share,
  shops: false,
  curtain: false,
  spacing: 3,
  storey: 3.2,
  crown: "flat",
  ...more,
});
const S = (height: number, roof: ShedVariant["roof"], front: ShedVariant["front"], lot: ShedVariant["lot"], more: Partial<ShedVariant> = {}): ShedVariant => ({
  height,
  roof,
  front,
  lot,
  cover: 0.9,
  office: false,
  chimneys: 0,
  ...more,
});

/** Every type's generator, by the type's id in `buildings.json`. */
export const GENERATORS: Readonly<Record<string, { generate: Generator; models: number }>> = {
  // Residential.
  "single-family-home": of(house, [H(2, "gable", true, true), H(1, "hip", false, true, 7), H(2, "side-gable", true, false, 5), H(1, "gable", true, false, 6, 2.6)]),
  plex: of(row, [R(2, 8, "gable", false), R(3, 12, "flat", false, false, 5, 3), R(2, 12, "gable", true, false, 5)]),
  townhomes: of(row, [R(3, 6, "flat", true), R(2, 6, "gable", true, false, 3.5), R(3, 7, "gable", false, false, 4, 2.6)]),
  apartments: of(block, [
    B(4, "windows", "flat", { front: 5, cover: 0.7 }),
    B(6, "lobby", "flat", { front: 6, cover: 0.7, spacing: 3.4 }),
    B(3, "windows", "hip", { front: 5, cover: 0.65, spacing: 2.8 }),
  ]),
  "low-tower": of(tower, [T(12, 0, 1, { spacing: 3.2 }), T(10, 2, 0.75, { crown: "step" }), T(14, 0, 1, { curtain: true })]),
  "high-tower": of(tower, [T(26, 3, 0.6, { curtain: true, crown: "mast" }), T(22, 2, 0.65, { crown: "step", spacing: 3.4 }), T(30, 0, 1, { curtain: true })]),

  // Commercial.
  "corner-store": of(block, [B(1, "storefront", "flat", { front: 2, plant: false }), B(2, "storefront", "flat", { front: 1.5, plant: false }), B(1, "storefront", "gable", { front: 3 })]),
  restaurant: of(block, [B(1, "storefront", "gable", { front: 4, cover: 0.6 }), B(2, "storefront", "flat", { front: 2, cover: 0.7, plant: false }), B(1, "storefront", "hip", { front: 5, cover: 0.55, forecourt: true })]),
  "shop-row": of(row, [R(1, 6, "flat", false, true, 2), R(2, 7, "flat", true, true, 2), R(1, 8, "gable", false, true, 3)]),
  "retail-block": of(block, [B(2, "storefront", "flat", { front: 2 }), B(3, "storefront", "flat", { front: 2, spacing: 4 }), B(2, "storefront", "flat", { front: 6, forecourt: true })]),
  "small-office-park": of(shed, [
    S(7.6, "flat", "curtain", "front", { cover: 0.7 }),
    S(8, "flat", "windows", "front", { cover: 0.75 }),
    S(4, "flat", "curtain", "front", { cover: 0.7 }),
  ]),
  "strip-mall": of(shed, [S(5, "flat", "storefront", "front"), S(6, "flat", "storefront", "front", { cover: 0.95 }), S(5, "gable", "storefront", "front")]),
  "small-mall": of(shed, [S(9, "flat", "storefront", "front", { cover: 0.85 }), S(10, "flat", "curtain", "front", { cover: 0.9 }), S(8, "gable", "storefront", "front")]),
  "retail-podium": of(tower, [T(6, 2, 0.7, { shops: true }), T(8, 2, 0.6, { shops: true, curtain: true }), T(5, 3, 0.75, { shops: true, crown: "step" })]),
  "department-store": of(block, [
    B(5, "storefront", "flat", { front: 2, storey: 4.2, spacing: 5, cover: 0.95 }),
    B(4, "storefront", "flat", { front: 2, storey: 4.5, upper: "curtain", cover: 0.95 }),
    B(6, "storefront", "flat", { front: 3, storey: 4, spacing: 4, cover: 0.9 }),
  ]),
  "big-box-store": of(shed, [S(9, "flat", "storefront", "front", { cover: 0.9 }), S(8, "flat", "doors", "front"), S(10, "gable", "storefront", "front")]),
  "shopping-centre": of(shed, [S(14, "flat", "storefront", "front"), S(12, "flat", "curtain", "front"), S(16, "saw", "storefront", "front")]),

  // Office.
  "converted-house-office": of(house, [H(2, "gable", true, false, 7), H(2, "hip", true, true, 6), H(2, "side-gable", false, false, 5)]),
  "low-office-block": of(block, [
    B(2, "lobby", "flat", { front: 6, forecourt: true, storey: 3.8 }),
    B(3, "windows", "flat", { front: 5, storey: 3.8, spacing: 3.5 }),
    B(2, "windows", "hip", { front: 6, storey: 3.8 }),
  ]),
  "office-pavilion": of(shed, [S(8, "flat", "curtain", "front", { cover: 0.8 }), S(4.5, "flat", "curtain", "front"), S(8, "flat", "windows", "front", { cover: 0.85 })]),
  "mid-rise-office": of(block, [
    B(6, "lobby", "flat", { storey: 3.8, upper: "curtain" }),
    B(5, "lobby", "flat", { storey: 3.8, spacing: 3.6 }),
    B(7, "lobby", "flat", { storey: 3.8, spacing: 2.4 }),
  ]),
  "office-slab": of(block, [
    B(8, "lobby", "flat", { storey: 3.8, upper: "curtain", front: 5, forecourt: true }),
    B(7, "lobby", "flat", { storey: 3.8, spacing: 3, front: 4 }),
    B(9, "lobby", "flat", { storey: 3.8, spacing: 2.2, front: 6, forecourt: true }),
  ]),
  "mid-rise-office-tower": of(tower, [T(10, 0, 1, { curtain: true, storey: 3.8 }), T(9, 1, 0.8, { storey: 3.8, spacing: 2.6 }), T(12, 0, 1, { storey: 3.8, crown: "step" })]),
  "slim-office-tower": of(tower, [T(18, 0, 1, { curtain: true, storey: 3.8 }), T(16, 0, 1, { storey: 3.8, crown: "step", spacing: 2.4 }), T(20, 0, 1, { curtain: true, crown: "mast", storey: 3.8 })]),
  "office-tower": of(tower, [T(24, 2, 0.7, { curtain: true, storey: 3.8 }), T(20, 0, 1, { storey: 3.8, spacing: 2.6, crown: "step" }), T(28, 2, 0.65, { curtain: true, storey: 3.8, crown: "mast" })]),
  "tall-office-tower": of(tower, [T(40, 3, 0.6, { curtain: true, storey: 3.8, crown: "mast" }), T(34, 3, 0.62, { curtain: true, storey: 3.8, crown: "step" }), T(44, 2, 0.55, { storey: 3.8, spacing: 2.2 })]),

  // Industrial.
  workshop: of(shed, [S(5, "gable", "doors", "none", { cover: 0.8 }), S(4.5, "flat", "doors", "none"), S(6, "saw", "doors", "none", { cover: 0.85 })]),
  "yard-depot": of(shed, [S(5, "flat", "doors", "yard", { cover: 0.4 }), S(6, "gable", "doors", "yard", { cover: 0.5 }), S(4, "flat", "windows", "yard", { cover: 0.35 })]),
  "small-factory": of(shed, [S(7, "saw", "doors", "none", { office: true }), S(8, "flat", "doors", "none", { chimneys: 1 }), S(7, "gable", "doors", "yard", { cover: 0.85, chimneys: 1 })]),
  "light-industrial-unit": of(shed, [S(6, "flat", "doors", "none", { office: true, cover: 0.8 }), S(7, "gable", "doors", "none"), S(6, "flat", "windows", "front", { cover: 0.8 })]),
  warehouse: of(shed, [S(10, "flat", "doors", "none"), S(11, "gable", "doors", "none", { cover: 0.85 }), S(9, "flat", "doors", "yard", { office: true })]),
  "medium-factory": of(shed, [S(11, "saw", "doors", "yard", { chimneys: 2, office: true }), S(12, "flat", "doors", "none", { chimneys: 1 }), S(10, "gable", "doors", "yard", { chimneys: 2 })]),
  "tank-farm": of(tanks, [
    { across: 2, back: 3, height: 12, hall: 0, chimneys: 0 },
    { across: 1, back: 2, height: 16, hall: 0.3, chimneys: 1 },
    { across: 2, back: 2, height: 9, hall: 0.25, chimneys: 0 },
  ]),
  "processing-plant": of(tanks, [
    { across: 2, back: 2, height: 14, hall: 0.45, chimneys: 2 },
    { across: 3, back: 2, height: 10, hall: 0.4, chimneys: 1 },
    { across: 2, back: 1, height: 18, hall: 0.5, chimneys: 3 },
  ]),
  "large-factory": of(shed, [S(14, "saw", "doors", "yard", { chimneys: 3, office: true }), S(15, "flat", "doors", "none", { chimneys: 2, office: true }), S(13, "gable", "doors", "yard", { chimneys: 3 })]),

  // Mixed.
  "corner-walk-up": of(block, [B(3, "storefront", "flat", { front: 1, side: 0.5 }), B(4, "storefront", "flat", { front: 1, side: 0.5, spacing: 2.6 }), B(3, "storefront", "gable", { front: 1.5, side: 0.5 })]),
  "shop-top-row": of(row, [R(3, 6, "flat", false, true, 1), R(2, 7, "flat", true, true, 1), R(3, 8, "gable", false, true, 1.5)]),
  "main-street-block": of(block, [
    B(3, "storefront", "flat", { front: 1, side: 0.3, cover: 0.75 }),
    B(4, "storefront", "flat", { front: 1, side: 0.3, cover: 0.7, spacing: 2.6 }),
    B(3, "storefront", "flat", { front: 1.5, side: 0.5, cover: 0.8, spacing: 3.6 }),
  ]),
  "walk-up-over-shops": of(block, [B(4, "storefront", "flat", { front: 1 }), B(5, "storefront", "flat", { front: 1, spacing: 2.6 }), B(4, "storefront", "hip", { front: 1.5 })]),
  "mixed-mid-rise": of(block, [B(7, "storefront", "flat", { front: 1 }), B(6, "storefront", "flat", { front: 1.5, upper: "curtain" }), B(8, "storefront", "flat", { front: 1, spacing: 2.8 })]),
  "perimeter-block": of(block, [B(6, "storefront", "flat", { front: 1, side: 0.5, cover: 0.9 }), B(5, "storefront", "hip", { front: 1, side: 0.5 }), B(7, "storefront", "flat", { front: 1, side: 0.5, spacing: 2.6 })]),
  "mixed-slab": of(tower, [T(12, 2, 0.7, { shops: true }), T(14, 2, 0.65, { shops: true, curtain: true }), T(10, 3, 0.75, { shops: true, crown: "step" })]),
  "podium-tower": of(tower, [T(16, 3, 0.6, { shops: true }), T(18, 3, 0.55, { shops: true, curtain: true }), T(14, 2, 0.65, { shops: true, crown: "step" })]),
  "tall-podium-tower": of(tower, [T(30, 4, 0.55, { shops: true, curtain: true, crown: "mast" }), T(26, 3, 0.6, { shops: true, crown: "step" }), T(34, 4, 0.5, { shops: true, curtain: true })]),

  // Through-lots (M2-14): a lot across a whole block, from one road to the
  // next, up to 96 m square. The car park or yard faces the front road.
  "big-box-centre": of(shed, [S(10, "flat", "storefront", "front", { cover: 0.85 }), S(9, "flat", "storefront", "front", { cover: 0.8, office: true }), S(11, "gable", "storefront", "front", { cover: 0.85 })]),
  "regional-mall": of(shed, [S(16, "flat", "storefront", "front", { cover: 0.9 }), S(14, "flat", "curtain", "front", { cover: 0.85 }), S(18, "saw", "storefront", "front", { cover: 0.9 })]),
  "distribution-centre": of(shed, [S(13, "flat", "doors", "yard", { cover: 0.85, office: true }), S(12, "flat", "doors", "front", { cover: 0.8, office: true }), S(14, "gable", "doors", "yard", { cover: 0.8 })]),
  "heavy-plant": of(shed, [S(18, "saw", "doors", "yard", { chimneys: 4, office: true }), S(16, "flat", "doors", "yard", { chimneys: 3, office: true }), S(20, "gable", "doors", "none", { chimneys: 5 })]),
};
