// Building types from `balance/buildings.json`, checked when the module
// loads (M2-09, PRD "M2 Zoning and buildings"). Buildings in state are in
// buildings.ts and the lot finder in lots.ts.

import balance from "../../balance/buildings.json" with { type: "json" };
import { ZONING_BALANCE } from "../zoning/balance";

/** One building type as written in the balance file. */
export interface BuildingTypeBalance {
  id: string;
  name: string;
  /** A zone id from zoning.json. */
  zone: string;
  /** 1, 2 or 3. */
  density: number;
  /** Lot width along the road in cells, [low, high], both included. */
  width: [number, number];
  /** Lot depth back from the road in cells, [low, high], both included. */
  depth: [number, number];
  /** Residents [low, high]; [0, 0] for a type nobody lives in. */
  residents: [number, number];
  /** True for a starting value from M2-09 with nothing behind it yet. */
  proposal?: boolean;
  /** True to draw residents per building between low and high; otherwise they scale with lot area (M2-10). */
  drawResidents?: boolean;
  /** True for a type that stands on a through-lot, two back-to-back strips joined (M2-14). Its depth is more than the zoning depth. */
  throughLot?: boolean;
}

/** The buildings balance file. */
export interface BuildingsBalance {
  /** The widest lot along a road, in cells. The deepest is `zoneDepthCells`. */
  maxLotWidth: number;
  /** The widest through-lot along its roads, in cells (M2-14). The deepest is twice `zoneDepthCells`. */
  maxThroughLotWidth: number;
  /** Game days the grower plans to build out the free frontage in (issue 135). */
  fillDays: number;
  /** Front cells the grower counts one building as taking when it plans a day. */
  frontCellsPerBuilding: number;
  /** The fewest buildings the grower plans for a day. */
  growthPerDayMin: number;
  /** The most buildings the grower plans for a day, which keeps its ticks inside the budget. */
  growthPerDayMax: number;
  /** Free cells the grower draws for one building before it gives that building up. */
  growthTries: number;
  /** The most buildings one `BulldozeBuilding` may name (M2-11). */
  bulldozeMaxBuildings: number;
  types: BuildingTypeBalance[];
}

/** A building type as the sim uses it: the balance entry with its zone as a number. */
export interface BuildingType extends BuildingTypeBalance {
  /** Its place in `BUILDINGS_BALANCE.types`, which is what state stores. */
  index: number;
  /** 1 plus the zone's place in `ZONING_BALANCE.zones`, as a cell stores it. */
  zoneNumber: number;
}

const FIELDS = ["id", "name", "zone", "density", "width", "depth", "residents"] as const;
const KNOWN = new Set<string>([...FIELDS, "proposal", "drawResidents", "throughLot"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Whether `value` is [low, high], whole numbers with low <= high, each from `min` to `max`. */
function isRange(value: unknown, min: number, max: number): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [low, high] = value as unknown[];
  return Number.isSafeInteger(low) && Number.isSafeInteger(high) && (low as number) >= min && (low as number) <= (high as number) && (high as number) <= max;
}

/**
 * Every problem with a buildings balance file, or none. A missing field is
 * a problem, and so are two types of one zone and density that take the
 * same lot shape, since the shape must pick the type.
 */
export function checkBuildingsBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the buildings balance is not an object"];
  const errors: string[] = [];
  const maxWidth = data["maxLotWidth"];
  const widthOk = Number.isSafeInteger(maxWidth) && (maxWidth as number) >= 1;
  if (!widthOk) errors.push("maxLotWidth must be a whole number of at least 1");
  const widest = widthOk ? (maxWidth as number) : 0;
  const maxThrough = data["maxThroughLotWidth"];
  const throughOk = Number.isSafeInteger(maxThrough) && (maxThrough as number) >= 1;
  if (!throughOk) errors.push("maxThroughLotWidth must be a whole number of at least 1");
  const widestThrough = throughOk ? (maxThrough as number) : 0;
  for (const key of ["fillDays", "frontCellsPerBuilding"]) {
    const v = data[key];
    if (!Number.isSafeInteger(v) || (v as number) < 1) errors.push(`${key} must be a whole number of at least 1`);
  }
  const perDayMin = data["growthPerDayMin"];
  const perDayMax = data["growthPerDayMax"];
  const minOk = Number.isSafeInteger(perDayMin) && (perDayMin as number) >= 0;
  if (!minOk) errors.push("growthPerDayMin must be a whole number of at least 0");
  if (!Number.isSafeInteger(perDayMax) || (perDayMax as number) < 1) errors.push("growthPerDayMax must be a whole number of at least 1");
  else if (minOk && (perDayMax as number) < (perDayMin as number)) errors.push("growthPerDayMax must be at least growthPerDayMin");
  const tries = data["growthTries"];
  if (!Number.isSafeInteger(tries) || (tries as number) < 1) errors.push("growthTries must be a whole number of at least 1");
  const most = data["bulldozeMaxBuildings"];
  if (!Number.isSafeInteger(most) || (most as number) < 1) errors.push("bulldozeMaxBuildings must be a whole number of at least 1");
  const deepest = ZONING_BALANCE.zoneDepthCells;
  const types = data["types"];
  if (!Array.isArray(types) || types.length === 0) {
    errors.push("types must be a non-empty list");
    return errors;
  }
  const ids = new Set<string>();
  // Lot shapes taken, as "zone/density/width/depth", with the type that took each.
  const shapes = new Map<string, string>();
  types.forEach((type: unknown, i) => {
    const where = `types[${i}]`;
    if (!isRecord(type)) {
      errors.push(`${where} is not an object`);
      return;
    }
    for (const field of FIELDS) if (!(field in type)) errors.push(`${where}.${field} is missing`);
    for (const key of Object.keys(type)) if (!KNOWN.has(key) && !key.startsWith("_")) errors.push(`${where} has an unknown field "${key}"`);
    const { id, name, zone, density, width, depth, residents, proposal, drawResidents, throughLot } = type;
    if (!isText(id)) errors.push(`${where}.id must be text`);
    else if (ids.has(id)) errors.push(`${where}.id "${id}" appears twice`);
    else ids.add(id);
    if ("name" in type && !isText(name)) errors.push(`${where}.name must be text`);
    const zoneOk = ZONING_BALANCE.zones.some((z) => z.id === zone);
    if ("zone" in type && !zoneOk) errors.push(`${where}.zone ${JSON.stringify(zone)} is not a zone in zoning.json`);
    const densityOk = ZONING_BALANCE.densities.some((d) => d.level === density);
    if ("density" in type && !densityOk) errors.push(`${where}.density ${JSON.stringify(density)} is not a density in zoning.json`);
    if (throughLot !== undefined && typeof throughLot !== "boolean") errors.push(`${where}.throughLot must be true or false`);
    // A through-lot is deeper than one strip and a lot on one strip is not,
    // so a lot's depth says which it is.
    const through = throughLot === true;
    const widthRange = isRange(width, 1, through ? widestThrough : widest);
    if ("width" in type && !widthRange) errors.push(`${where}.width must be [low, high] cells, from 1 to ${through ? "maxThroughLotWidth" : "maxLotWidth"}`);
    const depthRange = isRange(depth, through ? deepest + 1 : 1, through ? 2 * deepest : deepest);
    if ("depth" in type && !depthRange) {
      errors.push(
        through
          ? `${where}.depth must be [low, high] cells, from one more than the zoning depth to twice it`
          : `${where}.depth must be [low, high] cells, from 1 to the zoning depth`,
      );
    }
    if ("residents" in type && !isRange(residents, 0, Number.MAX_SAFE_INTEGER)) errors.push(`${where}.residents must be [low, high], whole numbers`);
    if (proposal !== undefined && typeof proposal !== "boolean") errors.push(`${where}.proposal must be true or false`);
    if (drawResidents !== undefined && typeof drawResidents !== "boolean") errors.push(`${where}.drawResidents must be true or false`);
    if (!zoneOk || !densityOk || !widthRange || !depthRange) return;
    for (let w = width[0]; w <= width[1]; w++) {
      for (let d = depth[0]; d <= depth[1]; d++) {
        const key = `${zone as string}/${density as number}/${w}/${d}`;
        const other = shapes.get(key);
        if (other !== undefined) {
          errors.push(`${where} "${String(id)}" and "${other}" both take a ${w} x ${d} lot in ${zone as string} density ${density as number}`);
        } else {
          shapes.set(key, String(id));
        }
      }
    }
  });
  return errors;
}

/** Checks a buildings balance and returns it. Throws listing every problem. */
export function resolveBuildingsBalance(data: unknown): BuildingsBalance {
  const errors = checkBuildingsBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/buildings.json: ${errors.join("; ")}`);
  return data as BuildingsBalance;
}

/** The buildings balance, checked. */
export const BUILDINGS_BALANCE: BuildingsBalance = resolveBuildingsBalance(balance);

/** Every building type, in file order, with its zone as a number. */
export const BUILDING_TYPES: readonly BuildingType[] = BUILDINGS_BALANCE.types.map((type, index) => ({
  ...type,
  index,
  zoneNumber: ZONING_BALANCE.zones.findIndex((z) => z.id === type.zone) + 1,
}));

/** The types that grow on a zone and density, in file order. Zone as a cell stores it. */
export function typesFor(zone: number, density: number): readonly BuildingType[] {
  return TYPES_BY_ZONE.get(zone)?.get(density) ?? NO_TYPES;
}

const NO_TYPES: readonly BuildingType[] = [];

/** `typesFor`'s lists by zone, then density, made once: the grower asks many times a draw (issue 166). */
const TYPES_BY_ZONE = new Map<number, Map<number, readonly BuildingType[]>>();
for (const t of BUILDING_TYPES) {
  const byDensity = TYPES_BY_ZONE.get(t.zoneNumber) ?? new Map<number, readonly BuildingType[]>();
  TYPES_BY_ZONE.set(t.zoneNumber, byDensity);
  byDensity.set(t.density, [...(byDensity.get(t.density) ?? []), t]);
}

/** The widest lot of any kind, in cells: how far along a strip the lot finder looks. */
export const WIDEST_LOT = Math.max(BUILDINGS_BALANCE.maxLotWidth, ...BUILDING_TYPES.map((t) => t.width[1]));
