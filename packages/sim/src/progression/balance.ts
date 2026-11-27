// The population milestones from `balance/progression.json`, checked when
// the module loads (M4-12, PRD "Progression"), and the registry of unlocks
// they open.

import balance from "../../balance/progression.json" with { type: "json" };
import { isRecord, unknownKeys } from "../balance-fields";
import { PRICE_YEAR, priceNow, priceProblems, type EconomyPrice } from "../economy/balance";

/**
 * Every unlock the sim knows: a thing a player cannot use until a milestone
 * opens it. M4 registers the two higher densities and City Hall (M4-12);
 * each later module adds its own ids here and names the milestone that
 * opens each in progression.json. The order is not the shape of a save:
 * state keeps the milestones reached, and what is open is derived from them.
 */
export const UNLOCKS = ["density2", "density3", "cityHall"] as const;
export type Unlock = (typeof UNLOCKS)[number];

/** The unlock that lets the zone tool paint each density above 1, by level. */
export const DENSITY_UNLOCKS: Readonly<Record<number, Unlock>> = Object.freeze({ 2: "density2", 3: "density3" });

/** One milestone as progression.json writes it. */
export interface MilestoneFile {
  population: number;
  name: string;
  grant: EconomyPrice;
  unlocks: string[];
}

/** One milestone, its grant in whole dollars of today. */
export interface Milestone {
  /** The population that reaches it: a whole number of residents, above the milestone before's. */
  population: number;
  /** Its name, for the toast and the reason a locked tool gives. */
  name: string;
  /** Whole dollars paid once, on the grants line, when it is reached. */
  grant: number;
  /** What it opens. */
  unlocks: readonly Unlock[];
}

const MILESTONE_KEYS = ["population", "name", "grant", "unlocks"];

/**
 * Every problem with a progression balance file, or none: milestones in
 * rising order of population, each with a name, a grant priced as
 * economy.json prices things, and unlocks the registry knows, every unlock
 * opened by exactly one milestone.
 */
export function checkProgressionBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the progression balance is not an object"];
  const errors: string[] = [...unknownKeys(data, ["milestones"], "the file")];
  const list = data["milestones"];
  if (!Array.isArray(list) || list.length === 0) return [...errors, "milestones must be a non-empty list"];
  const opened = new Map<string, number>();
  const names = new Set<string>();
  let last = 0;
  list.forEach((entry: unknown, i) => {
    const at = `milestones[${i}]`;
    if (!isRecord(entry)) return void errors.push(`${at} is not an object`);
    const { population, name, unlocks } = entry;
    if (!Number.isSafeInteger(population) || (population as number) <= last) errors.push(`${at}.population must be a whole number of residents above ${last}`);
    else last = population as number;
    if (typeof name !== "string" || name.trim() === "") errors.push(`${at}.name is missing`);
    else if (names.has(name)) errors.push(`${at}.name "${name}" is used twice`);
    else names.add(name);
    errors.push(...priceProblems(entry["grant"], `${at}.grant`, PRICE_YEAR));
    if (!Array.isArray(unlocks)) errors.push(`${at}.unlocks must be a list`);
    else {
      for (const id of unlocks) {
        if (!(UNLOCKS as readonly unknown[]).includes(id)) errors.push(`${at}.unlocks names ${JSON.stringify(id)}, which is not one of ${UNLOCKS.join(", ")}`);
        else if (opened.has(id as string)) errors.push(`${at}.unlocks names ${id}, which milestones[${opened.get(id as string)}] opens already`);
        else opened.set(id as string, i);
      }
    }
    errors.push(...unknownKeys(entry, MILESTONE_KEYS, at));
  });
  for (const id of UNLOCKS) if (!opened.has(id)) errors.push(`no milestone opens ${id}`);
  return errors;
}

/** Checks a progression balance and resolves every grant to whole dollars of today. Throws listing every problem. */
export function resolveProgression(data: unknown): readonly Milestone[] {
  const errors = checkProgressionBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/progression.json: ${errors.join("; ")}`);
  return (data as { milestones: MilestoneFile[] }).milestones.map((m) =>
    Object.freeze({ population: m.population, name: m.name, grant: priceNow(m.grant), unlocks: Object.freeze([...m.unlocks] as Unlock[]) }),
  );
}

/** The milestones, in rising order of population, frozen. */
export const MILESTONES: readonly Milestone[] = Object.freeze(resolveProgression(balance));

/** Where in `MILESTONES` each unlock is opened. */
const OPENED_BY: Readonly<Record<Unlock, number>> = Object.freeze(
  Object.fromEntries(UNLOCKS.map((id) => [id, MILESTONES.findIndex((m) => m.unlocks.includes(id))])) as Record<Unlock, number>,
);

/** The place in `MILESTONES` of the milestone that opens `unlock`. */
export function unlockMilestone(unlock: Unlock): number {
  return OPENED_BY[unlock];
}
