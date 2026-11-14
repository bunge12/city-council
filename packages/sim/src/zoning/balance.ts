// Zoning numbers from `balance/zoning.json`, checked when the module loads
// (PRD, "M2 Zoning and buildings"). The cells themselves are in cells.ts.

import balance from "../../balance/zoning.json" with { type: "json" };

/** One zone as written in the balance file. */
export interface ZoneBalance {
  id: string;
  name: string;
  /** The letter a zone goes by with its density, as in R1 or C3. */
  letter: string;
}

/** One density as written in the balance file. */
export interface DensityBalance {
  /** 1, 2, 3: the number in R1 or C3. */
  level: number;
  name: string;
}

/** The zoning balance file. */
export interface ZoningBalance {
  /** A cell's side, metres. Also the road tool's length step. */
  cellSize: number;
  /** How far cells reach back from a road's edge, in cells. */
  zoneDepthCells: number;
  /** The steepest ground a cell can be zoned on, rise over run at its centre. */
  maxSlope: number;
  zones: ZoneBalance[];
  /** In level order, from 1. */
  densities: DensityBalance[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Every problem with a zoning balance file, or none. A missing field is a problem. */
export function checkZoningBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the zoning balance is not an object"];
  const errors: string[] = [];
  const cellSize = data["cellSize"];
  if (typeof cellSize !== "number" || !Number.isFinite(cellSize) || !(cellSize > 0)) {
    errors.push("cellSize must be a positive number of metres");
  }
  const depth = data["zoneDepthCells"];
  if (!Number.isSafeInteger(depth) || (depth as number) < 1) errors.push("zoneDepthCells must be a whole number of at least 1");
  const maxSlope = data["maxSlope"];
  if (typeof maxSlope !== "number" || !Number.isFinite(maxSlope) || !(maxSlope > 0)) {
    errors.push("maxSlope must be a positive rise over run");
  }

  const zones = data["zones"];
  if (!Array.isArray(zones) || zones.length === 0) {
    errors.push("zones must be a non-empty list");
  } else {
    const ids = new Set<string>();
    const letters = new Set<string>();
    zones.forEach((zone: unknown, i) => {
      const where = `zones[${i}]`;
      if (!isRecord(zone)) {
        errors.push(`${where} is not an object`);
        return;
      }
      const { id, name, letter } = zone;
      if (!isText(id)) errors.push(`${where}.id is missing`);
      else if (ids.has(id)) errors.push(`${where}.id "${id}" appears twice`);
      else ids.add(id);
      if (!isText(name)) errors.push(`${where}.name is missing`);
      if (typeof letter !== "string" || !/^[A-Z]$/.test(letter)) errors.push(`${where}.letter must be one capital letter`);
      else if (letters.has(letter)) errors.push(`${where}.letter "${letter}" appears twice`);
      else letters.add(letter);
    });
  }

  const densities = data["densities"];
  if (!Array.isArray(densities) || densities.length === 0) {
    errors.push("densities must be a non-empty list");
  } else {
    densities.forEach((density: unknown, i) => {
      const where = `densities[${i}]`;
      if (!isRecord(density)) {
        errors.push(`${where} is not an object`);
        return;
      }
      if (density["level"] !== i + 1) errors.push(`${where}.level must be ${i + 1}`);
      if (!isText(density["name"])) errors.push(`${where}.name is missing`);
    });
  }
  return errors;
}

/** Checks a zoning balance and returns it. Throws listing every problem. */
export function resolveZoningBalance(data: unknown): ZoningBalance {
  const errors = checkZoningBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/zoning.json: ${errors.join("; ")}`);
  return data as ZoningBalance;
}

/** The zoning balance, checked. */
export const ZONING_BALANCE: ZoningBalance = resolveZoningBalance(balance);
