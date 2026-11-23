// Building types from `balance/buildings.json`, checked when the module
// loads (M2-09, PRD "M2 Zoning and buildings"). Buildings in state are in
// buildings.ts and the lot finder in lots.ts.

import balance from "../../balance/buildings.json" with { type: "json" };
import { SHARE_SLACK, isRecord, isShare, shareProblems } from "../balance-fields";
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
  /** Jobs per cell of lot, 0 for a type that offers none (M3-01). See `jobsOf` in jobs.ts. */
  jobsPerCell: number;
  /** True for a starting value from M2-09 with nothing behind it yet. */
  proposal?: boolean;
  /**
   * True for a home one household lives in, however few people it holds
   * (M3-08): newcomers move in only while nobody lives there.
   */
  oneHousehold?: boolean;
  /** True for a type that stands on a through-lot, two back-to-back strips joined (M2-14). Its depth is more than the zoning depth. */
  throughLot?: boolean;
}

/** The buildings balance file. */
export interface BuildingsBalance {
  /** The widest lot along a road, in cells. The deepest is `zoneDepthCells`. */
  maxLotWidth: number;
  /** The widest through-lot along its roads, in cells (M2-14). The deepest is twice `zoneDepthCells`. */
  maxThroughLotWidth: number;
  /** The most buildings the grower adds a day, every zone together, which keeps its ticks inside the budget. */
  growthPerDayMax: number;
  /** The most buildings one `BulldozeBuilding` may name (M2-11). */
  bulldozeMaxBuildings: number;
  /** For each kind of job, the share of its jobs at each education level (M3-01). */
  jobKinds: Record<JobKind, EducationShares>;
  /** For each zone id, densities 1 to 3 in order: the share of a building's jobs of each kind (M3-01). */
  jobMix: Record<string, Partial<Record<JobKind, number>>[]>;
  types: BuildingTypeBalance[];
}

/** The kinds of job, as the running totals and the demand bars count them (PRD, "City statistics"). */
export const JOB_KINDS = ["commercial", "office", "industrial"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** The three education levels, lowest first (PRD, "M3 Demand"). Pops have the same levels. */
export const EDUCATION_LEVELS = ["low", "medium", "high"] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

/** A share for each education level, adding to 1. */
export type EducationShares = Record<EducationLevel, number>;

/** A building type as the sim uses it: the balance entry with its zone as a number. */
export interface BuildingType extends BuildingTypeBalance {
  /** Its place in `BUILDINGS_BALANCE.types`, which is what state stores. */
  index: number;
  /** 1 plus the zone's place in `ZONING_BALANCE.zones`, as a cell stores it. */
  zoneNumber: number;
}

const FIELDS = ["id", "name", "zone", "density", "width", "depth", "residents", "jobsPerCell"] as const;
const KNOWN = new Set<string>([...FIELDS, "proposal", "oneHousehold", "throughLot"]);

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Problems with the job shares: `jobKinds` gives every kind its education
 * shares, and `jobMix` gives every zone one entry per density, each either
 * empty, for a zone and density with no jobs, or shares of the kinds
 * adding to 1. Whether a type with jobs has a mix is checked per type.
 */
function jobShareProblems(data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const kinds = data["jobKinds"];
  if (!isRecord(kinds)) errors.push("jobKinds must be an object");
  else {
    for (const kind of JOB_KINDS) {
      if (!(kind in kinds)) errors.push(`jobKinds.${kind} is missing`);
      else errors.push(...shareProblems(kinds[kind], EDUCATION_LEVELS, `jobKinds.${kind}`));
    }
    for (const key of Object.keys(kinds)) if (!(JOB_KINDS as readonly string[]).includes(key) && !key.startsWith("_")) errors.push(`jobKinds has an unknown kind "${key}"`);
  }
  const mix = data["jobMix"];
  if (!isRecord(mix)) {
    errors.push("jobMix must be an object");
    return errors;
  }
  const levels = ZONING_BALANCE.densities.length;
  for (const zone of ZONING_BALANCE.zones) {
    const list = mix[zone.id];
    const where = `jobMix.${zone.id}`;
    if (!(zone.id in mix)) errors.push(`${where} is missing`);
    else if (!Array.isArray(list) || list.length !== levels) errors.push(`${where} must list ${levels} densities`);
    else {
      list.forEach((entry: unknown, i) => {
        // A kind left out has no share. An empty entry is a zone and density without jobs.
        if (!isRecord(entry)) errors.push(`${where}[${i}] must be an object`);
        else if (Object.keys(entry).some((k) => !k.startsWith("_"))) {
          errors.push(...shareProblems({ ...Object.fromEntries(JOB_KINDS.map((k) => [k, 0])), ...entry }, JOB_KINDS, `${where}[${i}]`));
        }
      });
    }
  }
  for (const key of Object.keys(mix)) if (!ZONING_BALANCE.zones.some((z) => z.id === key) && !key.startsWith("_")) errors.push(`jobMix has an unknown zone "${key}"`);
  return errors;
}

/** Whether `zone` at `density` has job shares that add to 1 in `data.jobMix`. False when the mix is malformed. */
function zoneHasJobs(data: Record<string, unknown>, zone: unknown, density: unknown): boolean {
  const mix = data["jobMix"];
  if (!isRecord(mix) || typeof zone !== "string" || typeof density !== "number") return false;
  const list = mix[zone];
  const entry = Array.isArray(list) ? (list[density - 1] as unknown) : undefined;
  if (!isRecord(entry)) return false;
  let sum = 0;
  for (const kind of JOB_KINDS) {
    const v = entry[kind];
    if (isShare(v)) sum += v;
  }
  return Math.abs(sum - 1) <= SHARE_SLACK;
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
  const perDayMax = data["growthPerDayMax"];
  if (!Number.isSafeInteger(perDayMax) || (perDayMax as number) < 1) errors.push("growthPerDayMax must be a whole number of at least 1");
  const most = data["bulldozeMaxBuildings"];
  if (!Number.isSafeInteger(most) || (most as number) < 1) errors.push("bulldozeMaxBuildings must be a whole number of at least 1");
  errors.push(...jobShareProblems(data));
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
    const { id, name, zone, density, width, depth, residents, jobsPerCell, proposal, oneHousehold, throughLot } = type;
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
    if ("jobsPerCell" in type) {
      if (typeof jobsPerCell !== "number" || !Number.isFinite(jobsPerCell) || jobsPerCell < 0) errors.push(`${where}.jobsPerCell must be a number of at least 0`);
      else if (zoneOk && densityOk && jobsPerCell > 0 && !zoneHasJobs(data, zone, density)) {
        errors.push(`${where}.jobsPerCell is above 0 but jobMix.${zone as string}[${(density as number) - 1}] gives its jobs no kind`);
      } else if (zoneOk && densityOk && jobsPerCell === 0 && zoneHasJobs(data, zone, density)) {
        // A zone and density with a mix offers jobs, so a 0 here is a slip, not a type with none.
        errors.push(`${where}.jobsPerCell is 0 but jobMix.${zone as string}[${(density as number) - 1}] gives jobs there`);
      }
    }
    if (proposal !== undefined && typeof proposal !== "boolean") errors.push(`${where}.proposal must be true or false`);
    if (oneHousehold !== undefined && typeof oneHousehold !== "boolean") errors.push(`${where}.oneHousehold must be true or false`);
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

// Frozen: every grower draw reads these, and a list changed by a caller would change every city after it.
const NO_TYPES: readonly BuildingType[] = Object.freeze([]);

/** `typesFor`'s lists by zone, then density, made once: the grower asks many times a draw (issue 166). */
const TYPES_BY_ZONE = new Map<number, Map<number, readonly BuildingType[]>>();
for (const t of BUILDING_TYPES) {
  const byDensity = TYPES_BY_ZONE.get(t.zoneNumber) ?? new Map<number, readonly BuildingType[]>();
  TYPES_BY_ZONE.set(t.zoneNumber, byDensity);
  byDensity.set(t.density, Object.freeze([...(byDensity.get(t.density) ?? []), t]));
}

/** The widest lot of any kind, in cells: how far along a strip the lot finder looks. */
export const WIDEST_LOT = Math.max(BUILDINGS_BALANCE.maxLotWidth, ...BUILDING_TYPES.map((t) => t.width[1]));
