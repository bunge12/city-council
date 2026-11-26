import { budgetColour } from "../render/cell-geometry";
import { BUDGET_SCALE } from "../render/config";
import { formatMoneyShort } from "./format";
import { useBudgetHover, useUi } from "./store";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/** The legend's ticks: the scale's places, with the net income a year at each. */
const TICKS: readonly { at: number; label: string }[] = [
  { at: -1, label: `-${formatMoneyShort(BUDGET_SCALE.full)}` },
  { at: 0, label: "$0" },
  { at: 1, label: `+${formatMoneyShort(BUDGET_SCALE.full)}` },
];

/**
 * The budget overlay's legend (issue M4-18): its diverging scale as a bar,
 * a loss on the left in red, break-even in grey in the middle and a gain on
 * the right in blue, with the net income a year under it. The colours come
 * from `BUDGET_SCALE`, as the overlay's do. Shown while the overlay is.
 */
export function BudgetLegend() {
  const on = useUi((s) => s.overlay === "budget");
  if (!on) return null;
  const stops = BUDGET_SCALE.stops;
  const gradient = `linear-gradient(to right, ${stops.map((s) => `${hex(s.colour)} ${((s.at + 1) / 2) * 100}%`).join(", ")})`;
  return (
    <section className="panel zone-legend land-value-legend budget-legend" id="budget-legend" aria-label="Budget legend">
      <h2>Net income a year</h2>
      <div
        className="scale"
        role="img"
        aria-label={`From ${hex(budgetColour(-1))}, a loss of ${formatMoneyShort(BUDGET_SCALE.full)} or more, through ${hex(budgetColour(0))}, break-even, to ${hex(budgetColour(1))}, a gain of ${formatMoneyShort(BUDGET_SCALE.full)} or more`}
        style={{ background: gradient }}
      />
      <div className="ticks">
        {TICKS.map((t) => (
          <span key={t.at} style={{ left: `${((t.at + 1) / 2) * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      <p className="hint">
        Each block's tax less its share of the upkeep of the roads round it. Within {formatMoneyShort(BUDGET_SCALE.neutral)} of break-even is grey. Roads and buildings outside any
        block count by 500 m square. Point at a block to see its figures.
      </p>
    </section>
  );
}

/**
 * Next to the cursor over a block, or open ground, while the budget overlay
 * is on and no tool is: its tax, its road upkeep and the net, a year. The
 * area and each figure are on data attributes too, for tests.
 */
export function BudgetReadout() {
  const hover = useBudgetHover((s) => s.hover);
  if (!hover) return null;
  const { tax, upkeep, net } = hover.budget;
  const block = hover.area >= 0;
  return (
    <div
      className="road-readout land-value-readout budget-readout"
      id="budget-readout"
      role="status"
      data-area={String(hover.area)}
      data-kind={block ? "block" : "chunk"}
      data-tax={String(tax)}
      data-upkeep={String(upkeep)}
      data-net={String(net)}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">{block ? "This block, a year" : "Open ground in this 500 m square, a year"}</div>
      <div className="detail">
        Tax {formatMoneyShort(tax)} · road upkeep {formatMoneyShort(upkeep)} · net{" "}
        <strong>
          {net > 0 ? "+" : ""}
          {formatMoneyShort(net)}
        </strong>
      </div>
    </div>
  );
}
