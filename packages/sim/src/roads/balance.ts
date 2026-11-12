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
  /** Steepest grade allowed, rise over run. */
  maxSlope: number;
  /** Tightest curve allowed, metres. */
  minCurveRadius: number;
  buildCostPerMetre: BalancePrice;
  upkeepPerMetrePerYear: BalancePrice;
}

export interface RoadBalance {
  escalation: { toYear: number; annualFactor: number; source: string; sourceUrl?: string; sourceYear: number };
  types: RoadTypeBalance[];
}

/** A road type with its prices in whole 2026 dollars. */
export interface RoadType extends Omit<RoadTypeBalance, "buildCostPerMetre" | "upkeepPerMetrePerYear"> {
  /** Index in the balance file. This is what segments store. */
  index: number;
  buildCostPerMetre: number;
  upkeepPerMetrePerYear: number;
}

const NUMBER_FIELDS = ["lanes", "speedKmh", "capacityPerLane", "width", "maxSlope", "minCurveRadius"] as const;
const BOOLEAN_FIELDS = ["oneWay", "zonable"] as const;
const PRICE_FIELDS = ["buildCostPerMetre", "upkeepPerMetrePerYear"] as const;
/** Segments store the type in a Uint8Array. */
const MAX_TYPES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
