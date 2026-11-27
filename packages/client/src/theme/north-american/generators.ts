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
import { landmarkTypeId } from "../theme";

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

/** The walls of an upper floor: windows `spacing` metres apart, a glass curtain wall, or ribbons of glass. */
function facadeOf(kind: "windows" | "curtain" | "bands", spacing: number, storey: number): Facade {
  if (kind === "curtain") return facade(FACADE.curtain, 1.6, storey);
  if (kind === "bands") return facade(FACADE.bands, 1.5, storey);
  return facade(FACADE.windows, spacing, storey);
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
    // Clear of the house by more than the garage's eave, so its gable end does not lie on the house's wall.
    const g0 = x1 + 0.3;
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
      // The fascia wraps the unit, so none of its faces lies on a wall of storefronts.
      b.box(a - 0.1, c + 0.1, BASE_TOP + ground - 0.35, BASE_TOP + ground, z0 - 0.1, uz1 + 0.5, TRIM, TRIM);
      if (v.floors > 1) b.box(a, c, BASE_TOP + ground, top, z0, uz1, WALL, null, facade(FACADE.windows, v.spacing, 3));
    } else {
      b.box(a, c, BASE_TOP, top, z0, uz1, WALL, null, facade(FACADE.windows, v.spacing, 3));
    }
    // No eave along the row: a unit's eave would hang over its neighbour's slope and leave a slit to see into the roof through.
    if (v.roof === "gable") b.gable(a, c, z0, uz1, top, Math.min(each, uz1 - z0) * 0.42, false, ROOF, WALL, 0);
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
  upper: "windows" | "curtain" | "bands";
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
  /** Top floors set back from the front and sides, behind a terrace, 0 for none. Flat roofs only. */
  setback?: number;
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
  const upper = facadeOf(v.upper, v.spacing, v.storey);
  // The top floors set back keep at least one floor in front of them.
  const back = v.roof === "flat" ? Math.max(0, Math.min(v.setback ?? 0, v.floors - 2)) : 0;
  const lowTop = top - back * v.storey;
  if (v.floors > 1) b.box(x0, x1, BASE_TOP + groundH, lowTop, z0, z1, WALL, null, upper);
  // The outline of the top floors, and the height of their roof.
  let [r0, r1, q0, q1, roofY] = [x0, x1, z0, z1, top];
  if (back > 0) {
    const inset = Math.min(3, (x1 - x0) * 0.15, (z1 - z0) * 0.2);
    flatRoof(b, x0, x1, z0, z1, lowTop, 0.25);
    [r0, r1, q0, q1, roofY] = [x0 + inset, x1 - inset, z0 + inset * 0.5, z1 - inset, top + 0.4];
    b.box(r0, r1, lowTop + 0.4, roofY, q0, q1, WALL, null, upper);
  }
  const rise = Math.min(x1 - x0, z1 - z0) * 0.3;
  if (v.roof === "gable") b.gable(x0, x1, z0, z1, top, rise, true, ROOF, WALL);
  else if (v.roof === "hip") b.hip(x0, x1, z0, z1, top, rise, ROOF);
  else flatRoof(b, r0, r1, q0, q1, roofY);
  if (v.plant && v.roof === "flat") {
    const w = (r1 - r0) * 0.3;
    const d = (q1 - q0) * 0.3;
    const xm = (r0 + r1) / 2;
    const zm = (q0 + q1) / 2;
    plantRoom(b, xm - w / 2, xm + w / 2, zm - d / 2, zm + d / 2, roofY + 0.4, 2.6);
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
  /** Ribbons of glass along each floor, where `curtain` is false. */
  bands?: boolean;
  spacing: number;
  storey: number;
  /** What tops the tower: a flat roof with a plant room, a narrower top storey, a mast, or a pyramid. */
  crown: "flat" | "step" | "mast" | "pyramid";
  /** Times the tower steps in on its way up, 0 to 2. */
  setbacks?: number;
  /** Two slabs side by side, one shorter than the other, in place of one shaft. */
  split?: boolean;
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
  const walls = facadeOf(v.curtain ? "curtain" : v.bands ? "bands" : "windows", v.spacing, v.storey);
  // The outline of the shaft's top, which the crown stands on, and its height.
  let [r0, r1, q0, q1] = [t0, t1, u0, u1];
  let top = y + v.floors * v.storey;
  if (v.split) {
    // The shorter slab beside the tall one, a little shallower.
    const xm = t0 + tw * 0.56;
    const low = y + Math.max(2, Math.round(v.floors * 0.6)) * v.storey;
    const inset = td * 0.08;
    b.box(xm, t1, y, low, u0 + inset, u1 - inset, WALL, null, walls);
    flatRoof(b, xm, t1, u0 + inset, u1 - inset, low + 0.2, 0.3);
    b.box(t0, xm, y, top, u0, u1, WALL, null, walls);
    r1 = xm;
  } else {
    // Each tier but the last is about a fifth of the floors less, then steps in.
    const tiers = Math.max(0, Math.min(2, v.setbacks ?? 0)) + 1;
    let floors = v.floors;
    let at = y;
    for (let k = 0; k < tiers; k++) {
      const last = k === tiers - 1;
      const these = last ? floors : Math.min(floors - 1, Math.max(2, Math.round(v.floors * (k === 0 ? 1 - 0.22 * (tiers - 1) : 0.22))));
      floors -= these;
      b.box(r0, r1, at, at + these * v.storey, q0, q1, WALL, null, walls);
      at += these * v.storey;
      if (last) break;
      flatRoof(b, r0, r1, q0, q1, at + 0.2, 0.3);
      at += 0.6;
      const ix = (r1 - r0) * 0.13;
      const iz = (q1 - q0) * 0.13;
      [r0, r1, q0, q1] = [r0 + ix, r1 - ix, q0 + iz, q1 - iz];
    }
    top = at;
  }
  const rw = r1 - r0;
  const rd = q1 - q0;
  const xm = (r0 + r1) / 2;
  const zm = (q0 + q1) / 2;
  // Every crown closes the shaft's top: a roof the camera cannot see past.
  flatRoof(b, r0, r1, q0, q1, top + 0.2, 0.3);
  if (v.crown === "step") {
    b.box(r0 + 1.2, r1 - 1.2, top + 0.6, top + 0.6 + v.storey * 1.5, q0 + 1.2, q1 - 1.2, TRIM, null, facade(FACADE.windows, v.spacing, v.storey));
    flatRoof(b, r0 + 1.2, r1 - 1.2, q0 + 1.2, q1 - 1.2, top + 0.6 + v.storey * 1.5 + 0.3, 0.25);
  } else if (v.crown === "pyramid") {
    b.hip(r0, r1, q0, q1, top + 0.6, Math.min(rw, rd) * 0.45, ROOF, 0);
  } else {
    plantRoom(b, r0 + rw * 0.3, r1 - rw * 0.3, q0 + rd * 0.3, q1 - rd * 0.3, top + 0.6, 3);
    if (v.crown === "mast") b.prism(xm, zm, 0.4, top + 3.6, top + 3.6 + Math.max(8, v.floors * 0.6), 6, TRIM, TRIM);
  }
  return b.build();
}

export interface ShedVariant {
  height: number;
  roof: "flat" | "gable" | "saw";
  /** Share of the lot's depth the building takes. */
  cover: number;
  /** What its front wall shows. */
  front: "storefront" | "doors" | "windows" | "curtain" | "bands";
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
          : v.front === "bands"
            ? facade(FACADE.bands, 1.8, 3.8)
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
    // It stands proud of the shed's side and its cornice, so its windows are not drawn on the plane of the shed's doors or trim.
    const ow = Math.min(12, (x1 - x0) * 0.4);
    const o0 = x0 - 0.5;
    base(b, o0, x0 + ow, z1, z1 + 1);
    b.box(o0, x0 + ow, BASE_TOP, BASE_TOP + 7.6, z1 - 6, z1 + 1, WALL, null, facade(FACADE.windows, 2.6, 3.8));
    flatRoof(b, o0, x0 + ow, z1 - 6, z1 + 1, BASE_TOP + 7.8, 0.2);
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
): BlockVariant => ({ floors, ground, roof, upper: "windows", spacing: 3, storey: 3.1, front: 3, side: 1, cover: 0.85, plant: true, forecourt: false, setback: 0, ...more });
const T = (floors: number, podium: number, share: number, more: Partial<TowerVariant> = {}): TowerVariant => ({
  floors,
  podium,
  share,
  shops: false,
  curtain: false,
  bands: false,
  spacing: 3,
  storey: 3.2,
  crown: "flat",
  setbacks: 0,
  split: false,
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
  "single-family-home": of(house, [
    H(2, "gable", true, true),
    H(1, "hip", false, true, 7),
    H(2, "side-gable", true, false, 5),
    H(1, "gable", true, false, 6, 2.6),
    H(2, "hip", true, true, 6, 3.6),
    H(1, "side-gable", false, true, 8, 2.8),
  ]),
  plex: of(row, [R(2, 8, "gable", false), R(3, 12, "flat", false, false, 5, 3), R(2, 12, "gable", true, false, 5), R(2, 10, "gable", true, false, 6, 3.4)]),
  townhomes: of(row, [R(3, 6, "flat", true), R(2, 6, "gable", true, false, 3.5), R(3, 7, "gable", false, false, 4, 2.6), R(3, 5.5, "flat", false, false, 3, 2.4)]),
  apartments: of(block, [
    B(4, "windows", "flat", { front: 5, cover: 0.7 }),
    B(6, "lobby", "flat", { front: 6, cover: 0.7, spacing: 3.4 }),
    B(3, "windows", "hip", { front: 5, cover: 0.65, spacing: 2.8 }),
    B(5, "windows", "flat", { front: 5, cover: 0.7, upper: "bands" }),
    B(6, "lobby", "flat", { front: 6, cover: 0.7, spacing: 2.8, setback: 1 }),
  ]),
  "low-tower": of(tower, [
    T(12, 0, 1, { spacing: 3.2 }),
    T(10, 2, 0.75, { crown: "step" }),
    T(14, 0, 1, { curtain: true }),
    T(12, 0, 1, { setbacks: 1, spacing: 2.8 }),
    T(11, 2, 0.7, { bands: true, crown: "pyramid" }),
  ]),
  "high-tower": of(tower, [
    T(26, 3, 0.6, { curtain: true, crown: "mast" }),
    T(22, 2, 0.65, { crown: "step", spacing: 3.4 }),
    T(30, 0, 1, { curtain: true }),
    T(28, 2, 0.6, { curtain: true, setbacks: 2 }),
    T(24, 0, 1, { split: true, spacing: 3 }),
  ]),

  // Commercial.
  "corner-store": of(block, [
    B(1, "storefront", "flat", { front: 2, plant: false }),
    B(2, "storefront", "flat", { front: 1.5, plant: false }),
    B(1, "storefront", "gable", { front: 3 }),
    B(2, "storefront", "hip", { front: 2 }),
  ]),
  restaurant: of(block, [B(1, "storefront", "gable", { front: 4, cover: 0.6 }), B(2, "storefront", "flat", { front: 2, cover: 0.7, plant: false }), B(1, "storefront", "hip", { front: 5, cover: 0.55, forecourt: true })]),
  "shop-row": of(row, [R(1, 6, "flat", false, true, 2), R(2, 7, "flat", true, true, 2), R(1, 8, "gable", false, true, 3), R(2, 6, "gable", true, true, 2)]),
  "retail-block": of(block, [
    B(2, "storefront", "flat", { front: 2 }),
    B(3, "storefront", "flat", { front: 2, spacing: 4 }),
    B(2, "storefront", "flat", { front: 6, forecourt: true }),
    B(3, "storefront", "flat", { front: 2, upper: "bands" }),
  ]),
  "small-office-park": of(shed, [
    S(7.6, "flat", "curtain", "front", { cover: 0.7 }),
    S(8, "flat", "windows", "front", { cover: 0.75 }),
    S(4, "flat", "curtain", "front", { cover: 0.7 }),
    S(8, "flat", "bands", "front", { cover: 0.75 }),
  ]),
  "strip-mall": of(shed, [S(5, "flat", "storefront", "front"), S(6, "flat", "storefront", "front", { cover: 0.95 }), S(5, "gable", "storefront", "front")]),
  "small-mall": of(shed, [S(9, "flat", "storefront", "front", { cover: 0.85 }), S(10, "flat", "curtain", "front", { cover: 0.9 }), S(8, "gable", "storefront", "front")]),
  "retail-podium": of(tower, [T(6, 2, 0.7, { shops: true }), T(8, 2, 0.6, { shops: true, curtain: true }), T(5, 3, 0.75, { shops: true, crown: "step" }), T(6, 2, 0.7, { shops: true, bands: true })]),
  "department-store": of(block, [
    B(5, "storefront", "flat", { front: 2, storey: 4.2, spacing: 5, cover: 0.95 }),
    B(4, "storefront", "flat", { front: 2, storey: 4.5, upper: "curtain", cover: 0.95 }),
    B(6, "storefront", "flat", { front: 3, storey: 4, spacing: 4, cover: 0.9 }),
    B(5, "storefront", "flat", { front: 2, storey: 4.2, upper: "bands", cover: 0.95 }),
  ]),
  "big-box-store": of(shed, [S(9, "flat", "storefront", "front", { cover: 0.9 }), S(8, "flat", "doors", "front"), S(10, "gable", "storefront", "front")]),
  "shopping-centre": of(shed, [S(14, "flat", "storefront", "front"), S(12, "flat", "curtain", "front"), S(16, "saw", "storefront", "front")]),

  // Office.
  "converted-house-office": of(house, [H(2, "gable", true, false, 7), H(2, "hip", true, true, 6), H(2, "side-gable", false, false, 5), H(2, "gable", false, true, 6, 2.8)]),
  "low-office-block": of(block, [
    B(2, "lobby", "flat", { front: 6, forecourt: true, storey: 3.8 }),
    B(3, "windows", "flat", { front: 5, storey: 3.8, spacing: 3.5 }),
    B(2, "windows", "hip", { front: 6, storey: 3.8 }),
    B(3, "lobby", "flat", { front: 5, storey: 3.8, upper: "bands", forecourt: true }),
  ]),
  "office-pavilion": of(shed, [
    S(8, "flat", "curtain", "front", { cover: 0.8 }),
    S(4.5, "flat", "curtain", "front"),
    S(8, "flat", "windows", "front", { cover: 0.85 }),
    S(7.6, "flat", "bands", "front", { cover: 0.8 }),
  ]),
  "mid-rise-office": of(block, [
    B(6, "lobby", "flat", { storey: 3.8, upper: "curtain" }),
    B(5, "lobby", "flat", { storey: 3.8, spacing: 3.6 }),
    B(7, "lobby", "flat", { storey: 3.8, spacing: 2.4 }),
    B(6, "lobby", "flat", { storey: 3.8, upper: "bands" }),
    B(8, "lobby", "flat", { storey: 3.8, spacing: 3, setback: 2 }),
  ]),
  "office-slab": of(block, [
    B(8, "lobby", "flat", { storey: 3.8, upper: "curtain", front: 5, forecourt: true }),
    B(7, "lobby", "flat", { storey: 3.8, spacing: 3, front: 4 }),
    B(9, "lobby", "flat", { storey: 3.8, spacing: 2.2, front: 6, forecourt: true }),
    B(10, "lobby", "flat", { storey: 3.8, upper: "bands", front: 5, forecourt: true }),
    B(9, "lobby", "flat", { storey: 3.8, upper: "curtain", front: 4, setback: 2 }),
  ]),
  "mid-rise-office-tower": of(tower, [
    T(10, 0, 1, { curtain: true, storey: 3.8 }),
    T(9, 1, 0.8, { storey: 3.8, spacing: 2.6 }),
    T(12, 0, 1, { storey: 3.8, crown: "step" }),
    T(11, 0, 1, { storey: 3.8, bands: true, crown: "pyramid" }),
    T(12, 1, 0.8, { storey: 3.8, curtain: true, split: true }),
  ]),
  "slim-office-tower": of(tower, [
    T(18, 0, 1, { curtain: true, storey: 3.8 }),
    T(16, 0, 1, { storey: 3.8, crown: "step", spacing: 2.4 }),
    T(20, 0, 1, { curtain: true, crown: "mast", storey: 3.8 }),
    T(19, 0, 1, { storey: 3.8, bands: true, setbacks: 1 }),
    T(17, 0, 1, { storey: 3.8, curtain: true, crown: "pyramid" }),
  ]),
  "office-tower": of(tower, [
    T(24, 2, 0.7, { curtain: true, storey: 3.8 }),
    T(20, 0, 1, { storey: 3.8, spacing: 2.6, crown: "step" }),
    T(28, 2, 0.65, { curtain: true, storey: 3.8, crown: "mast" }),
    T(26, 2, 0.7, { curtain: true, storey: 3.8, setbacks: 2, crown: "mast" }),
    T(22, 0, 1, { storey: 3.8, bands: true, split: true }),
  ]),
  "tall-office-tower": of(tower, [
    T(40, 3, 0.6, { curtain: true, storey: 3.8, crown: "mast" }),
    T(34, 3, 0.62, { curtain: true, storey: 3.8, crown: "step" }),
    T(44, 2, 0.55, { storey: 3.8, spacing: 2.2 }),
    T(42, 3, 0.6, { curtain: true, storey: 3.8, setbacks: 2, crown: "pyramid" }),
    T(38, 2, 0.62, { storey: 3.8, bands: true, split: true }),
  ]),

  // Industrial.
  workshop: of(shed, [S(5, "gable", "doors", "none", { cover: 0.8 }), S(4.5, "flat", "doors", "none"), S(6, "saw", "doors", "none", { cover: 0.85 }), S(5.5, "gable", "doors", "yard", { cover: 0.6 })]),
  "yard-depot": of(shed, [S(5, "flat", "doors", "yard", { cover: 0.4 }), S(6, "gable", "doors", "yard", { cover: 0.5 }), S(4, "flat", "windows", "yard", { cover: 0.35 })]),
  "small-factory": of(shed, [
    S(7, "saw", "doors", "none", { office: true }),
    S(8, "flat", "doors", "none", { chimneys: 1 }),
    S(7, "gable", "doors", "yard", { cover: 0.85, chimneys: 1 }),
    S(8, "flat", "doors", "yard", { chimneys: 2, office: true }),
  ]),
  "light-industrial-unit": of(shed, [
    S(6, "flat", "doors", "none", { office: true, cover: 0.8 }),
    S(7, "gable", "doors", "none"),
    S(6, "flat", "windows", "front", { cover: 0.8 }),
    S(7, "flat", "bands", "front", { cover: 0.75 }),
  ]),
  warehouse: of(shed, [S(10, "flat", "doors", "none"), S(11, "gable", "doors", "none", { cover: 0.85 }), S(9, "flat", "doors", "yard", { office: true }), S(12, "saw", "doors", "none", { office: true })]),
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
  "walk-up-over-shops": of(block, [
    B(4, "storefront", "flat", { front: 1 }),
    B(5, "storefront", "flat", { front: 1, spacing: 2.6 }),
    B(4, "storefront", "hip", { front: 1.5 }),
    B(5, "storefront", "gable", { front: 1, spacing: 3.2 }),
  ]),
  "mixed-mid-rise": of(block, [
    B(7, "storefront", "flat", { front: 1 }),
    B(6, "storefront", "flat", { front: 1.5, upper: "curtain" }),
    B(8, "storefront", "flat", { front: 1, spacing: 2.8 }),
    B(7, "storefront", "flat", { front: 1, setback: 2 }),
    B(6, "storefront", "flat", { front: 1, upper: "bands" }),
  ]),
  "perimeter-block": of(block, [
    B(6, "storefront", "flat", { front: 1, side: 0.5, cover: 0.9 }),
    B(5, "storefront", "hip", { front: 1, side: 0.5 }),
    B(7, "storefront", "flat", { front: 1, side: 0.5, spacing: 2.6 }),
    B(6, "storefront", "flat", { front: 1, side: 0.5, cover: 0.9, setback: 1 }),
  ]),
  "mixed-slab": of(tower, [T(12, 2, 0.7, { shops: true }), T(14, 2, 0.65, { shops: true, curtain: true }), T(10, 3, 0.75, { shops: true, crown: "step" }), T(12, 2, 0.7, { shops: true, bands: true, setbacks: 1 })]),
  "podium-tower": of(tower, [
    T(16, 3, 0.6, { shops: true }),
    T(18, 3, 0.55, { shops: true, curtain: true }),
    T(14, 2, 0.65, { shops: true, crown: "step" }),
    T(17, 3, 0.6, { shops: true, curtain: true, crown: "pyramid" }),
  ]),
  "tall-podium-tower": of(tower, [
    T(30, 4, 0.55, { shops: true, curtain: true, crown: "mast" }),
    T(26, 3, 0.6, { shops: true, crown: "step" }),
    T(34, 4, 0.5, { shops: true, curtain: true }),
    T(28, 4, 0.55, { shops: true, setbacks: 2, crown: "mast" }),
    T(32, 3, 0.6, { shops: true, curtain: true, split: true }),
  ]),

  // Through-lots (M2-14): a lot across a whole block, from one road to the
  // next, up to 96 m square. The car park or yard faces the front road.
  "big-box-centre": of(shed, [S(10, "flat", "storefront", "front", { cover: 0.85 }), S(9, "flat", "storefront", "front", { cover: 0.8, office: true }), S(11, "gable", "storefront", "front", { cover: 0.85 })]),
  "regional-mall": of(shed, [S(16, "flat", "storefront", "front", { cover: 0.9 }), S(14, "flat", "curtain", "front", { cover: 0.85 }), S(18, "saw", "storefront", "front", { cover: 0.9 })]),
  "distribution-centre": of(shed, [S(13, "flat", "doors", "yard", { cover: 0.85, office: true }), S(12, "flat", "doors", "front", { cover: 0.8, office: true }), S(14, "gable", "doors", "yard", { cover: 0.8 })]),
  "heavy-plant": of(shed, [S(18, "saw", "doors", "yard", { chimneys: 4, office: true }), S(16, "flat", "doors", "yard", { chimneys: 3, office: true }), S(20, "gable", "doors", "none", { chimneys: 5 })]),
};

// Landmarks (M4-17, PRD "Landmarks"). Each kind has a generator of its own,
// keyed `landmark:` and its id in economy.json, and one model per stage: the
// sim's stage, 1 and up, picks model `stage - 1`.

/**
 * City Hall at stage `stage`, 1 to 4, on its lot of 6 by 6 cells. It reads
 * as civic from any distance: a wide base of two wings, a taller central
 * block behind a columned portico and a forecourt with steps and flags, and
 * on the central block something that rises with each stage, a flat roof,
 * then a square tower, then a drum and dome, then a taller drum, a dome
 * with a lantern and a spire.
 */
export function cityHall(lot: Lot, stage: number): ModelArrays {
  const b = new ModelBuilder();
  const s = Math.max(1, Math.min(4, Math.floor(stage)));
  const storey = 4.2;
  const front = lot.d / 2 - Math.max(8, lot.d * 0.3);
  const back = -lot.d / 2 + Math.max(3, lot.d * 0.1);
  const half = lot.w / 2 - Math.max(2, lot.w * 0.06);
  const core = Math.min(9, lot.w * 0.2);
  const windows = facade(FACADE.windows, 3.6, storey);
  // The wings, either side of the central block, a floor taller from stage 2.
  const wingTop = BASE_TOP + (s >= 2 ? 3 : 2) * storey;
  const wingFront = front - 2;
  for (const [x0, x1] of [
    [-half, -core + 0.5],
    [core - 0.5, half],
  ] as const) {
    base(b, x0, x1, back + 2, wingFront);
    b.box(x0, x1, BASE_TOP, BASE_TOP + storey, back + 2, wingFront, WALL, null, facade(FACADE.windows, 3.6, storey));
    b.box(x0, x1, BASE_TOP + storey, wingTop, back + 2, wingFront, WALL, null, windows);
    b.box(x0 - 0.3, x1 + 0.3, wingTop - 0.4, wingTop + 0.6, back + 1.7, wingFront + 0.3, TRIM, TRIM);
  }
  // The central block, a floor taller at each of the first three stages.
  const floors = 2 + Math.min(s, 3);
  const top = BASE_TOP + floors * storey;
  base(b, -core, core, back, front);
  b.box(-core, core, BASE_TOP, top, back, front, WALL, null, windows);
  b.box(-core - 0.4, core + 0.4, top - 0.5, top + 0.8, back - 0.4, front + 0.4, TRIM, TRIM);
  // The portico: columns two storeys tall, the beam across them and a pediment, with steps down to the forecourt.
  const deep = 4.5;
  const portico = BASE_TOP + 2 * storey;
  const p0 = -core + 1.5;
  const p1 = core - 1.5;
  b.box(p0 - 0.5, p1 + 0.5, -BASE_DEPTH, BASE_TOP + 0.6, front, front + deep, TRIM, TRIM);
  const columns = 6;
  for (let k = 0; k < columns; k++) {
    const x = p0 + ((p1 - p0) * k) / (columns - 1);
    b.prism(x, front + deep - 0.9, 0.55, BASE_TOP + 0.6, portico, 8, TRIM, null);
  }
  b.box(p0 - 0.5, p1 + 0.5, portico, portico + 1.1, front, front + deep, TRIM, TRIM);
  b.gable(p0 - 0.5, p1 + 0.5, front, front + deep, portico + 1.1, 2.6, false, TRIM, TRIM, 0.2);
  for (let k = 0; k < 3; k++) b.box(p0 - 0.5 - k * 0.6, p1 + 0.5 + k * 0.6, -BASE_DEPTH, BASE_TOP + 0.4 - k * 0.15, front + deep, front + deep + 0.8 + k * 0.8, TRIM, TRIM);
  // The forecourt, from the steps to the road, with a flag either side.
  paving(b, -half, half, front + deep, lot.d / 2);
  paving(b, -half, half, wingFront, front + deep);
  for (const x of [-core - 3, core + 3]) b.box(x - 0.12, x + 0.12, 0.12, 13, lot.d / 2 - 3.12, lot.d / 2 - 2.88, TRIM, TRIM);
  // What rises on the central block.
  const zm = (back + front) / 2;
  if (s === 2) {
    const t = Math.min(4.5, core * 0.5);
    b.box(-t, t, top + 0.8, top + 0.8 + 2 * storey, zm - t, zm + t, WALL, null, facade(FACADE.windows, 2.4, storey));
    b.box(-t - 0.3, t + 0.3, top + 0.8 + 2 * storey - 0.3, top + 0.8 + 2 * storey + 0.5, zm - t - 0.3, zm + t + 0.3, TRIM, TRIM);
    b.hip(-t, t, zm - t, zm + t, top + 0.8 + 2 * storey + 0.5, t * 0.9, ROOF, 0.3);
  } else if (s >= 3) {
    const r = Math.min(6.5, core * 0.7);
    const drum = s === 4 ? 7 : 4.5;
    b.prism(0, zm, r + 0.6, top + 0.8, top + 1.6, 16, TRIM, TRIM);
    b.prism(0, zm, r, top + 1.6, top + 1.6 + drum, 16, WALL, null);
    b.prism(0, zm, r + 0.3, top + 1.6 + drum, top + 2.2 + drum, 16, TRIM, null);
    const domeY = top + 2.2 + drum;
    const rise = s === 4 ? r * 1.05 : r * 0.9;
    b.dome(0, zm, r, domeY, rise, 16, 5, ROOF);
    if (s === 4) {
      const lantern = domeY + rise - 0.6;
      b.prism(0, zm, 1.5, lantern, lantern + 3, 8, TRIM, null);
      b.dome(0, zm, 1.7, lantern + 3, 1.4, 8, 3, ROOF);
      b.prism(0, zm, 0.18, lantern + 4.2, lantern + 9, 6, TRIM, TRIM);
    }
  }
  return b.build();
}

/** Every landmark's generator, by `landmarkTypeId` of its id in economy.json: one model a stage. */
export const LANDMARK_GENERATORS: Readonly<Record<string, { generate: Generator; models: number }>> = {
  [landmarkTypeId("cityHall")]: { generate: (lot, k) => cityHall(lot, k + 1), models: 4 },
};
