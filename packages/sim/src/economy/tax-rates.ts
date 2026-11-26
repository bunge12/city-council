// The four tax rates and what they push back on (M4-07, PRD "M4 Economy"
// and "Satisfaction").
//
// The player sets each rate with `SetTaxRate`, inside its range in
// economy.json. The tax sweep charges it (tax.ts), and it pushes back on the
// zone it taxes in two places:
//
// - Each demand bar has a `tax` part (demand.ts): its zone's pressure, below,
//   times the bar's `tax` weight in demand.json, which is 0 or less. So the
//   part is 0 at the default rate, below zero above it and above zero below
//   it. Mixed pays the residential and commercial rates and has no bar.
// - Each pop's satisfaction target (pops/satisfaction.ts) loses the
//   residential pressure times `taxByWealth` in pops.json for its wealth,
//   so a wealthy pop feels a rise more than a poor one.
//
// The pressure is the rate less its default over the top of the range less
// the default: 0 at the default, 1 at the top, and below 0 under the
// default, down to -default / (max - default) at a rate of 0. One straight
// line, so a step of the slider moves the bar by the same amount anywhere
// on it. Only add, subtract and divide (CLAUDE.md rule 6).

import type { SimState } from "../state";
import { ECONOMY, ECONOMY_SLIDERS, type EconomySlider } from "./balance";

/** Each rate's place in `BudgetState.taxRates`. */
export function taxRateIndex(slider: EconomySlider): number {
  return ECONOMY_SLIDERS.indexOf(slider);
}

/**
 * How hard `slider`'s rate at `rate` pushes back on its zone, as the header
 * says: 0 at the default, 1 at the top of the range, below 0 under the
 * default. 0 for a range with no room above its default.
 */
export function taxPressure(slider: EconomySlider, rate: number): number {
  const range = ECONOMY.taxRates[slider];
  const span = range.max - range.default;
  if (!(span > 0)) return 0;
  return (rate - range.default) / span;
}

/** `taxPressure` of each slider at the rates in `rates`, in `ECONOMY_SLIDERS` order. A rate left out reads its default. */
export function taxPressures(rates: ArrayLike<number> | undefined): Record<EconomySlider, number> {
  const out = {} as Record<EconomySlider, number>;
  for (const [i, slider] of ECONOMY_SLIDERS.entries()) {
    const rate = rates?.[i];
    out[slider] = rate === undefined ? 0 : taxPressure(slider, rate);
  }
  return out;
}

/** A `SetTaxRate` payload: a slider and its new rate, a fraction. */
export interface SetTaxRatePayload {
  zone: EconomySlider;
  rate: number;
}

/**
 * The checked payload of a `SetTaxRate`, or why it is refused: one of the
 * four sliders, and a rate inside its range in `economy.json`. Mixed has no
 * slider of its own: it pays the residential and commercial rates.
 */
export function taxRatePayload(payload: unknown): SetTaxRatePayload | string {
  if (typeof payload !== "object" || payload === null) return "SetTaxRate needs a zone and a rate";
  const { zone, rate } = payload as { zone?: unknown; rate?: unknown };
  if (typeof zone !== "string" || !(ECONOMY_SLIDERS as readonly string[]).includes(zone)) return `SetTaxRate payload.zone must be one of ${ECONOMY_SLIDERS.join(", ")}`;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "SetTaxRate payload.rate must be a number, a fraction such as 0.01 for one percent";
  const range = ECONOMY.taxRates[zone as EconomySlider];
  if (rate < range.min || rate > range.max) return `The ${zone} tax rate runs from ${percent(range.min)} to ${percent(range.max)}`;
  // -0 passes the range check but a JSON log turns it into 0, and the hash reads the bytes.
  return { zone: zone as EconomySlider, rate: rate === 0 ? 0 : rate };
}

/** `rate` as a percentage for a reason: 0.015 as "1.5%". */
function percent(rate: number): string {
  return `${Math.round(rate * 10000) / 100}%`;
}

/** Sets the tax rate of `payload.zone` to `payload.rate`. The sweep charges it from each building's next visit. */
export function setTaxRate(state: SimState, payload: SetTaxRatePayload): void {
  state.budget.taxRates[taxRateIndex(payload.zone)] = payload.rate;
}
