// What the land value overlay says about the cell under the pointer (issue
// M3-18): its value, then the parts it is made of, from the sim's own query
// (`landValueAt`). Parts that add nothing are left out.

import { LAND_VALUE_MAX, ROAD_TYPES, type LandValue } from "@city-council/sim";

/** A signed whole number of points, with a true minus sign. */
function signed(n: number): string {
  return n < 0 ? `−${-n}` : `+${n}`;
}

/**
 * The readout's two lines for land worth `v` fronting a road of type
 * `roadType` (its place in `ROAD_TYPES`): "Land value 54 of 100", and
 * "Base 30, Street +10, Water +12, Centre +8, Industry −20". When the
 * parts add up past either end of the scale, the second line says the
 * value is held there.
 */
export function landValueLines(v: LandValue, roadType: number): { title: string; parts: string } {
  const parts = [`Base ${v.base}`];
  if (v.road !== 0) parts.push(`${ROAD_TYPES[roadType]?.name ?? "Road"} ${signed(v.road)}`);
  if (v.water !== 0) parts.push(`Water ${signed(v.water)}`);
  if (v.centre !== 0) parts.push(`Centre ${signed(v.centre)}`);
  if (v.pollution !== 0) parts.push(`Industry ${signed(-v.pollution)}`);
  const sum = v.base + v.road + v.water + v.centre - v.pollution;
  const held = sum !== v.value ? `, held at ${v.value}` : "";
  return { title: `Land value ${v.value} of ${LAND_VALUE_MAX}`, parts: parts.join(", ") + held };
}
