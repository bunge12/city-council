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
}

/** The buildings balance file. */
export interface BuildingsBalance {
  /** The widest lot along a road, in cells. The deepest is `zoneDepthCells`. */
  maxLotWidth: number;
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
const KNOWN = new Set<string>([...FIELDS, "proposal"]);

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
    const { id, name, zone, density, width, depth, residents, proposal } = type;
    if (!isText(id)) errors.push(`${where}.id must be text`);
    else if (ids.has(id)) errors.push(`${where}.id "${id}" appears twice`);
    else ids.add(id);
    if ("name" in type && !isText(name)) errors.push(`${where}.name must be text`);
    const zoneOk = ZONING_BALANCE.zones.some((z) => z.id === zone);
    if ("zone" in type && !zoneOk) errors.push(`${where}.zone ${JSON.stringify(zone)} is not a zone in zoning.json`);
    const densityOk = ZONING_BALANCE.densities.some((d) => d.level === density);
    if ("density" in type && !densityOk) errors.push(`${where}.density ${JSON.stringify(density)} is not a density in zoning.json`);
    const widthRange = isRange(width, 1, widest);
    if ("width" in type && !widthRange) errors.push(`${where}.width must be [low, high] cells, from 1 to maxLotWidth`);
    const depthRange = isRange(depth, 1, deepest);
    if ("depth" in type && !depthRange) errors.push(`${where}.depth must be [low, high] cells, from 1 to the zoning depth`);
    if ("residents" in type && !isRange(residents, 0, Number.MAX_SAFE_INTEGER)) errors.push(`${where}.residents must be [low, high], whole numbers`);
    if (proposal !== undefined && typeof proposal !== "boolean") errors.push(`${where}.proposal must be true or false`);
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
export function typesFor(zone: number, density: number): BuildingType[] {
  return BUILDING_TYPES.filter((t) => t.zoneNumber === zone && t.density === density);
}
