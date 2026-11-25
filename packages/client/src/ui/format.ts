// Number formatting for the UI. Display only: nothing here feeds back into
// state.

import type { BuildingsInTheWay, GameDate } from "@city-council/sim";

/**
 * Money in short form, such as $3.2B, $480M or -$12K. The sim's, so the
 * prices the tools show and the reasons the sim refuses with read alike
 * (M4-03).
 */
export { formatMoneyShort } from "@city-council/sim";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A game date as the top bar shows it, such as "3 Feb, Year 1". */
export function formatGameDate(date: GameDate): string {
  return `${date.day} ${MONTHS[date.month - 1] ?? "?"}, Year ${date.year}`;
}

/** Speed as the page shows it: "paused", "1x" and so on. */
export function formatSpeed(speed: number): string {
  return speed === 0 ? "paused" : `${speed}x`;
}

/**
 * What a road or a grid would clear (issue M2-15), such as "Clears 3
 * buildings, 12 residents", or null when it clears none. Residents are left
 * out when the buildings hold none, as shops and offices do. The bulldozer's
 * tag says "Takes" for the buildings a road takes with it.
 */
export function formatClears(clears: BuildingsInTheWay | null | undefined, verb = "Clears"): string | null {
  const n = clears?.ids.length ?? 0;
  if (!clears || n === 0) return null;
  const buildings = n === 1 ? "1 building" : `${n} buildings`;
  const r = clears.residents;
  return r === 0 ? `${verb} ${buildings}` : `${verb} ${buildings}, ${r === 1 ? "1 resident" : `${r.toLocaleString("en-US")} residents`}`;
}
