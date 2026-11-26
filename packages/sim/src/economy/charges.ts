// Development charges (M4-08, PRD "Development charges").
//
// When the grower builds a building, its developer pays the city its zone's
// charge: the zone's rate, whole dollars per square metre, times the
// building's floor space (economy/value.ts), on that zone's charge line.
// Mixed has its own rate, since a mixed building is one project. A
// redevelopment pays only on the floor space it adds over the buildings it
// replaces, and nothing when it adds none. City-owned buildings pay nothing;
// none is built by the grower or by redevelopment.
//
// The rate also slows the grower in its zone (buildings/grower.ts): the
// zone's want, at least one a day while its bar is above zero, is
// multiplied by `chargeShareAt`, from 1 at a charge of 0 to
// `developmentChargeGrowth.shareAtMax` at the top of the range, in a
// straight line. It does not enter the demand bar, so a high charge slows
// construction without telling newcomers the city is less attractive.
//
// Only add, subtract, multiply, divide and floor (CLAUDE.md rule 6).

import { BUILDING_TYPES } from "../buildings/balance";
import type { BuildingState } from "../buildings/buildings";
import { lotJobs } from "../buildings/jobs";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { CHARGE_ZONES, ECONOMY, type ChargeZone } from "./balance";
import { CHARGE_LINES, moveMoney } from "./budget";
import { floorSpaceOf } from "./value";

// The rates are kept in zone order, so a zone number less one is the slider.
for (const [i, zone] of ZONING_BALANCE.zones.entries()) {
  if (CHARGE_ZONES[i] !== zone.id) throw new Error(`zoning.json zone ${i + 1} is "${zone.id}", but the development charges expect "${CHARGE_ZONES[i]}"`);
}
if (ZONING_BALANCE.zones.length !== CHARGE_ZONES.length) throw new Error("zoning.json and the development charges disagree on the zones");

/** The charge slider of zone number `zone`, 1 to 5, or undefined for any other. */
export function chargeZoneOf(zone: number): ChargeZone | undefined {
  return CHARGE_ZONES[zone - 1];
}

/**
 * The share of its daily quota zone number `zone` keeps with its charge at
 * `rate`: 1 at 0, `shareAtMax` at the top of the range, in a straight line.
 */
export function chargeShareAt(zone: number, rate: number): number {
  const slider = chargeZoneOf(zone);
  if (!slider) return 1;
  const max = ECONOMY.developmentCharges[slider].max;
  if (!(max > 0)) return 1;
  const shareAtMax = ECONOMY.developmentChargeGrowth.shareAtMax;
  return 1 - ((1 - shareAtMax) * Math.min(rate, max)) / max;
}

/** `chargeShareAt` for every zone of `chargeRates`, by zone number, index 0 unused. */
export function chargeShares(chargeRates: Float64Array): Float64Array {
  const out = new Float64Array(CHARGE_ZONES.length + 1).fill(1);
  for (let zone = 1; zone <= CHARGE_ZONES.length; zone++) out[zone] = chargeShareAt(zone, chargeRates[zone - 1] ?? 0);
  return out;
}

/** The floor space of building `id` in square metres, from its type, room and jobs. 0 for a free id. */
export function buildingFloorSpace(b: BuildingState, id: number): number {
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  if (!type) return 0;
  return floorSpaceOf(type, b.residents[id] ?? 0, lotJobs(b, id)).total;
}

/** The charge in whole dollars on `space` square metres of floor space in zone number `zone`, at today's rate in `state`. */
export function chargeOn(state: SimState, zone: number, space: number): number {
  const rate = state.budget.chargeRates[zone - 1] ?? 0;
  if (!(space > 0) || !(rate > 0)) return 0;
  return Math.floor(rate * space);
}

/**
 * Charges the developer of new building `id` its zone's development charge
 * on the floor space it adds over `replaced` square metres, the floor space
 * of the buildings it replaced; 0 for a building on free ground. Returns
 * the whole dollars paid.
 */
export function payDevelopmentCharge(state: SimState, id: number, replaced = 0): number {
  const b = state.buildings;
  const zone = b.zone[id] ?? 0;
  const line = CHARGE_LINES[zone - 1];
  if (!line) return 0;
  const charge = chargeOn(state, zone, buildingFloorSpace(b, id) - replaced);
  if (charge > 0) moveMoney(state, line, charge);
  return charge;
}

/** A `SetDevelopmentCharge` payload: a zone and its new rate in whole dollars per square metre. */
export interface SetDevelopmentChargePayload {
  zone: ChargeZone;
  rate: number;
}

/**
 * The checked payload of a `SetDevelopmentCharge`, or why it is refused: a
 * zone of the five, and a rate in whole dollars per square metre inside
 * the zone's range in `economy.json`.
 */
export function chargePayload(payload: unknown): SetDevelopmentChargePayload | string {
  if (typeof payload !== "object" || payload === null) return "SetDevelopmentCharge needs a zone and a rate";
  const { zone, rate } = payload as { zone?: unknown; rate?: unknown };
  if (typeof zone !== "string" || !(CHARGE_ZONES as readonly string[]).includes(zone)) return `SetDevelopmentCharge payload.zone must be one of ${CHARGE_ZONES.join(", ")}`;
  const range = ECONOMY.developmentCharges[zone as ChargeZone];
  if (!Number.isSafeInteger(rate)) return "SetDevelopmentCharge payload.rate must be whole dollars per square metre";
  if ((rate as number) < range.min || (rate as number) > range.max) return `The ${zone} development charge runs from $${range.min} to $${range.max} a square metre`;
  return { zone: zone as ChargeZone, rate: rate as number };
}

/** Sets the development charge of `payload.zone` to `payload.rate`. */
export function setDevelopmentCharge(state: SimState, payload: SetDevelopmentChargePayload): void {
  state.budget.chargeRates[CHARGE_ZONES.indexOf(payload.zone)] = payload.rate;
}
