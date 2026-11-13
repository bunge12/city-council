// Road types from `balance/roads.json`, checked when the module loads and
// with every price brought to 2026 dollars.

import balance from "../../balance/roads.json" with { type: "json" };

/** A price as written in the balance file: whole dollars in its source year. */
export interface BalancePrice {
  amount: number;
  sourceYear: number;
  source: string;
  sourceUrl?: string;
  /** True when no usable source was found and the number is a stand-in. */
  placeholder?: boolean;
  note?: string;
}

/** One road type as written in the balance file. */
export interface RoadTypeBalance {
  id: string;
  name: string;
  /** Lanes across the whole road, both directions. */
  lanes: number;
  oneWay: boolean;
  speedKmh: number;
  /** Vehicles per hour per lane. */
  capacityPerLane: number;
  /** Metres, kerb to kerb. */
  width: number;
  zonable: boolean;
  /** Whether a player can build it. Highway is in the data before it is buildable. */
  buildable: boolean;
  /** Steepest grade allowed, rise over run. */
  maxSlope: number;
  /** Tightest curve allowed, metres. */
  minCurveRadius: number;
  buildCostPerMetre: BalancePrice;
  upkeepPerMetrePerYear: BalancePrice;
  /** Taking a metre of this road out. A bridge costs `bridge.costMultiplier` times this. */
  demolitionCostPerMetre: BalancePrice;
  /** What happens where this type crosses water. */
  bridge: BridgeBalance;
}

/** A road type's bridges. */
export interface BridgeBalance {
  /** Longest bridge, metres, ramps included. */
  maxLength: number;
  /** A metre of bridge costs this many times a metre of the road on the ground. */
  costMultiplier: number;
  sourceYear: number;
  source: string;
  sourceUrl?: string;
  placeholder?: boolean;
  note?: string;
}

/** How the sim checks a road before it builds one. */
export interface RoadBuildBalance {
  /** Positions are rounded to multiples of this, in metres. */
  gridStep: number;
  /** An end this close to an existing node, in metres, joins that node. */
  mergeDistance: number;
  /** Shortest segment, in metres. */
  minLength: number;
  /** Narrowest angle between two segments that meet at a node, in degrees. */
  minAngleDegrees: number;
  /** Most metres between two ground samples along a road. */
  groundSampleStep: number;
  /** Metres from the water surface up to a bridge deck. */
  bridgeClearance: number;
  /**
   * The share of the old road's build cost taken off the price of upgrading
   * it to another type, from 0 to 1. Reuse of the roadbed, not a refund.
   */
  upgradeCredit: number;
}

export interface RoadBalance {
  escalation: { toYear: number; annualFactor: number; source: string; sourceUrl?: string; sourceYear: number };
  build: RoadBuildBalance;
  types: RoadTypeBalance[];
}

/** A road type with its prices in whole 2026 dollars. */
export interface RoadType extends Omit<RoadTypeBalance, "buildCostPerMetre" | "upkeepPerMetrePerYear" | "demolitionCostPerMetre"> {
  /** Index in the balance file. This is what segments store. */
  index: number;
  buildCostPerMetre: number;
  upkeepPerMetrePerYear: number;
  demolitionCostPerMetre: number;
}

const NUMBER_FIELDS = ["lanes", "speedKmh", "capacityPerLane", "width", "maxSlope", "minCurveRadius"] as const;
const BOOLEAN_FIELDS = ["oneWay", "zonable", "buildable"] as const;
const BUILD_FIELDS = [
  "gridStep",
  "mergeDistance",
  "minLength",
  "minAngleDegrees",
  "groundSampleStep",
  "bridgeClearance",
] as const;
const PRICE_FIELDS = ["buildCostPerMetre", "upkeepPerMetrePerYear", "demolitionCostPerMetre"] as const;
/** Segments store the type in a Uint8Array. */
const MAX_TYPES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isInteger(value) || value < 1) return false;
  let v = value;
  while (v > 1) {
    if (v % 2 !== 0) return false;
    v /= 2;
  }
  return true;
}

function isYear(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1900 && (value as number) <= 2100;
}

function checkPrice(price: unknown, where: string, toYear: number, errors: string[]): void {
  if (!isRecord(price)) {
    errors.push(`${where} is missing`);
    return;
  }
  if (!Number.isSafeInteger(price["amount"]) || (price["amount"] as number) < 0) {
    errors.push(`${where}.amount must be a whole number of dollars`);
  }
  if (!isYear(price["sourceYear"])) errors.push(`${where}.sourceYear is missing`);
  else if ((price["sourceYear"] as number) > toYear) errors.push(`${where}.sourceYear is after ${toYear}`);
  if (typeof price["source"] !== "string" || price["source"].trim() === "") errors.push(`${where}.source is missing`);
  if (price["placeholder"] !== undefined && typeof price["placeholder"] !== "boolean") {
    errors.push(`${where}.placeholder must be true or false`);
  }
}

function checkBridge(bridge: unknown, where: string, toYear: number, errors: string[]): void {
  if (!isRecord(bridge)) {
    errors.push(`${where} is missing`);
    return;
  }
  if (!isPositive(bridge["maxLength"])) errors.push(`${where}.maxLength must be a positive number`);
  if (!isPositive(bridge["costMultiplier"])) errors.push(`${where}.costMultiplier must be a positive number`);
  if (!isYear(bridge["sourceYear"])) errors.push(`${where}.sourceYear is missing`);
  else if ((bridge["sourceYear"] as number) > toYear) errors.push(`${where}.sourceYear is after ${toYear}`);
  if (typeof bridge["source"] !== "string" || bridge["source"].trim() === "") errors.push(`${where}.source is missing`);
}

/**
 * Every problem with a road balance file, or none. A type missing a field,
 * or a price with no source or source year, is a problem.
 */
export function checkRoadBalance(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ["the road balance is not an object"];
  const escalation = data["escalation"];
  let toYear = 2026;
  if (!isRecord(escalation)) {
    errors.push("escalation is missing");
  } else {
    if (!isYear(escalation["toYear"])) errors.push("escalation.toYear is missing");
    else toYear = escalation["toYear"] as number;
    if (!isPositive(escalation["annualFactor"])) errors.push("escalation.annualFactor must be a positive number");
    if (!isYear(escalation["sourceYear"])) errors.push("escalation.sourceYear is missing");
    if (typeof escalation["source"] !== "string" || escalation["source"] === "") errors.push("escalation.source is missing");
  }
  const build = data["build"];
  if (!isRecord(build)) {
    errors.push("build is missing");
  } else {
    for (const field of BUILD_FIELDS) {
      if (!isPositive(build[field])) errors.push(`build.${field} must be a positive number`);
    }
    if (isPositive(build["minAngleDegrees"]) && (build["minAngleDegrees"] as number) >= 180) {
      errors.push("build.minAngleDegrees must be under 180");
    }
    const credit = build["upgradeCredit"];
    if (typeof credit !== "number" || !(credit >= 0 && credit <= 1)) errors.push("build.upgradeCredit must be a number from 0 to 1");
    // Positions are whole multiples of the step, so it must divide a metre
    // into a power of two for them to be exact in a float64.
    const step = build["gridStep"];
    if (isPositive(step) && !isPowerOfTwo(1 / step)) errors.push("build.gridStep must be 1 over a power of two");
  }
  const types = data["types"];
  if (!Array.isArray(types) || types.length === 0) return [...errors, "types must be a non-empty list"];
  if (types.length > MAX_TYPES) errors.push(`there are more than ${MAX_TYPES} road types`);
  const ids = new Set<string>();
  types.forEach((type: unknown, i) => {
    const where = `types[${i}]`;
    if (!isRecord(type)) {
      errors.push(`${where} is not an object`);
      return;
    }
    const id = type["id"];
    if (typeof id !== "string" || id === "") errors.push(`${where}.id is missing`);
    else if (ids.has(id)) errors.push(`${where}.id "${id}" appears twice`);
    else ids.add(id);
    if (typeof type["name"] !== "string" || type["name"] === "") errors.push(`${where}.name is missing`);
    for (const field of NUMBER_FIELDS) {
      if (!isPositive(type[field])) errors.push(`${where}.${field} must be a positive number`);
    }
    if (!Number.isInteger(type["lanes"])) errors.push(`${where}.lanes must be a whole number`);
    for (const field of BOOLEAN_FIELDS) {
      if (typeof type[field] !== "boolean") errors.push(`${where}.${field} must be true or false`);
    }
    for (const field of PRICE_FIELDS) checkPrice(type[field], `${where}.${field}`, toYear, errors);
    checkBridge(type["bridge"], `${where}.bridge`, toYear, errors);
  });
  return errors;
}

/**
 * `price` in whole dollars of the escalation's target year. The factor is
 * applied once per year by multiplication, so every engine gets the same
 * number (CLAUDE.md rule 6), and rounded to whole dollars (rule 9).
 */
export function escalate(price: BalancePrice, escalation: RoadBalance["escalation"]): number {
  let amount = price.amount;
  for (let year = price.sourceYear; year < escalation.toYear; year++) amount *= escalation.annualFactor;
  return Math.round(amount);
}

/** Checks a road balance and resolves its prices. Throws listing every problem. */
export function resolveRoadTypes(data: unknown): RoadType[] {
  const errors = checkRoadBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/roads.json: ${errors.join("; ")}`);
  const { escalation, types } = data as RoadBalance;
  return types.map((type, index) => ({
    ...type,
    index,
    buildCostPerMetre: escalate(type.buildCostPerMetre, escalation),
    upkeepPerMetrePerYear: escalate(type.upkeepPerMetrePerYear, escalation),
    demolitionCostPerMetre: escalate(type.demolitionCostPerMetre, escalation),
  }));
}

/** The road balance file as written. */
export const ROAD_BALANCE: RoadBalance = balance;

/** Road types in id order, prices in 2026 dollars. */
export const ROAD_TYPES: readonly RoadType[] = resolveRoadTypes(balance);

/** The index of the road type with this id. Throws if there is none. */
export function roadTypeIndex(id: string): number {
  const index = ROAD_TYPES.findIndex((type) => type.id === id);
  if (index < 0) throw new RangeError(`no road type "${id}"`);
  return index;
}

/** How the sim checks a road before it builds one. Checked with the types above. */
export const ROAD_BUILD: RoadBuildBalance = ROAD_BALANCE.build;
