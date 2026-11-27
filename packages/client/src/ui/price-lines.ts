// The lines of the bulldozer's price tag (M4-16, PRD "The price tag" and
// "Eminent domain"): what a click is charged, part by part, then the total.
// Every figure is one the plan gave (bulldoze-tool.ts): the sim's
// `compensationFor` for the buildings and `planBulldoze` for a road. Nothing
// here adds them up, so the tag cannot disagree with the charge.

import type { Compensation } from "@city-council/sim";
import type { BulldozePreview } from "../tools/bulldoze-tool";

/** One line of the tag: what it is for, and its whole dollars. A refund is paid back, so it shows with a minus. */
export interface PriceLine {
  /** Names the line for tests and styling: `value`, `relocation`, `premium`, `demolition`, `paid`, `road`, `refund` or `total`. */
  id: string;
  label: string;
  amount: number;
  /** Paid back rather than charged: shown with a minus. */
  minus?: boolean;
}

function counted(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString("en-US")} ${many}`;
}

/** Who the relocation payment covers: "2 residents, 4 jobs", leaving out a count of none. */
function covers(c: Compensation): string {
  const parts: string[] = [];
  if (c.residents > 0) parts.push(counted(c.residents, "resident", "residents"));
  if (c.jobs > 0) parts.push(counted(c.jobs, "job", "jobs"));
  return parts.join(", ");
}

/**
 * The compensation's parts as lines: for occupied buildings their value,
 * the relocation payment with the people and jobs it covers, and the
 * premium; for vacant and abandoned ones their demolition; and the ones
 * the city has paid for already, at nothing; and for the city's own
 * landmarks, their demolition and the refund of a share of their price. A
 * part with no buildings is left out.
 */
export function compensationLines(c: Compensation): PriceLine[] {
  const lines: PriceLine[] = [];
  if (c.occupied > 0) {
    lines.push({ id: "value", label: c.occupied === 1 ? "Building value" : `Value of ${counted(c.occupied, "building", "buildings")}`, amount: c.value });
    const who = covers(c);
    lines.push({ id: "relocation", label: who ? `Relocation, ${who}` : "Relocation", amount: c.relocation });
    lines.push({ id: "premium", label: "Premium", amount: c.premium });
  }
  if (c.empty > 0) {
    // Beside occupied ones, say how many stand empty, so the line is not read as the occupied ones' demolition.
    const label = c.occupied > 0 ? `Demolition, ${counted(c.empty, "empty building", "empty buildings")}` : "Demolition";
    lines.push({ id: "demolition", label, amount: c.demolition });
  }
  if (c.paid > 0) lines.push({ id: "paid", label: `${counted(c.paid, "building", "buildings")} paid for already`, amount: 0 });
  // The city's own landmarks (M4-13, M4-17): demolition only, less the refund share of their price, which can leave the total below zero.
  if (c.cityOwned > 0) {
    lines.push({ id: "cityDemolition", label: "City-owned: demolition only", amount: c.cityDemolition });
    lines.push({ id: "cityRefund", label: "Refund", amount: c.refund, minus: true });
  }
  return lines;
}

/**
 * The tag's lines for a preview the sim would accept: a road's demolition
 * less its refund, then the compensation for the buildings it takes; or a
 * building's compensation. The total, the plan's price, ends the list
 * whenever more than one line comes before it. Empty for a refused
 * preview, which shows its reason instead.
 */
export function bulldozeLines(p: BulldozePreview): PriceLine[] {
  if (!p.ok) return [];
  const lines: PriceLine[] = [];
  if (p.kind === "road") {
    lines.push({ id: "road", label: `Road demolition, ${p.length.toFixed(0)} m`, amount: p.demolition });
    lines.push({ id: "refund", label: "Refund", amount: p.refund, minus: true });
  }
  lines.push(...compensationLines(p.compensation));
  if (lines.length > 1) lines.push({ id: "total", label: "Total", amount: p.cost });
  return lines;
}
