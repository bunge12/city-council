// The budget panel's table, columns, graph months and sliders (issue M4-15).
import { describe, expect, it } from "vitest";
import {
  CHARGE_LINES,
  CHARGE_ZONES,
  ECONOMY,
  ECONOMY_SLIDERS,
  HISTORY_LENGTH,
  LEDGER_LINES,
  LINE,
  TAX_LINES,
  TIME_BALANCE,
  createStats,
  createState,
  expensesOf,
  fundCity,
  incomeOf,
  step,
  submit,
  yearDays,
  type LedgerLine,
} from "@city-council/sim";
import { CHARGE_SLIDERS, TAX_SLIDERS, budgetTable, formatCharge, formatRate, moneyMonths, monthColumns, monthLabel, taxRateOfSlider, type BudgetTable } from "../src/ui/budget-table";

/** A ledger with `figures` on their lines and 0 elsewhere. */
function ledger(figures: Partial<Record<LedgerLine, number>>): Float64Array {
  const out = new Float64Array(LEDGER_LINES.length);
  for (const [line, value] of Object.entries(figures)) out[LINE[line as LedgerLine]] = value;
  return out;
}

function rowsOf(table: BudgetTable) {
  return [...table.income, ...table.expenses].flatMap((g) => g.rows);
}

const LAST = ledger({
  taxResidential: 120_000,
  taxCommercial: 40_000,
  taxOffice: 8_000,
  taxIndustrial: 5_500,
  chargeResidential: 60_000,
  chargeMixed: 4_000,
  grants: 1_000_000,
  loansTaken: 2_000_000,
  construction: 900_000,
  demolition: 12_000,
  compensation: 300_000,
  roadUpkeep: 75_000,
  loanRepayments: 9_000,
  interest: 6_000,
});
const NOW = ledger({ taxResidential: 30_000, chargeCommercial: 15_000, roadUpkeep: 20_000, construction: -5_000 });

describe("the budget table", () => {
  const table = budgetTable({ lastMonth: LAST, month: NOW });

  it("holds every ledger line once, with last month's figure and this month's so far", () => {
    const rows = rowsOf(table);
    expect(rows.map((r) => r.line).sort()).toEqual([...LEDGER_LINES].sort());
    for (const row of rows) {
      expect(row.last, row.line).toBe(LAST[LINE[row.line]]);
      expect(row.now, row.line).toBe(NOW[LINE[row.line]]);
    }
  });

  it("puts the taxes and the development charges under headings of their own, one charge line per zone, mixed included", () => {
    expect(table.income.map((g) => g.heading)).toEqual(["Taxes", "Development charges", null]);
    expect(table.income[0]?.rows.map((r) => r.line)).toEqual(TAX_LINES);
    expect(table.income[1]?.rows.map((r) => r.line)).toEqual(CHARGE_LINES);
    expect(table.income[1]?.rows.map((r) => r.label)).toEqual(["Residential", "Commercial", "Office", "Industrial", "Mixed"]);
    expect(table.income[2]?.rows.map((r) => r.line)).toEqual(["grants", "loansTaken"]);
    expect(table.expenses.flatMap((g) => g.rows).every((r) => LINE[r.line] >= LINE.construction)).toBe(true);
  });

  it("totals income and expenses as the sim does, and nets one against the other", () => {
    expect(table.totalIncome).toEqual({ last: 3_237_500, now: 45_000 });
    expect(table.totalExpenses).toEqual({ last: 1_302_000, now: 15_000 });
    expect(table.totalIncome.last).toBe(incomeOf(LAST));
    expect(table.totalExpenses.now).toBe(expensesOf(NOW));
    expect(table.net).toEqual({ last: 3_237_500 - 1_302_000, now: 30_000 });
  });

  it("nets a month to the change in the treasury the sim made over it", () => {
    const state = createState(2026);
    fundCity(state, 50_000_000);
    const opened = state.budget.opening;
    const result = submit(state, { seq: 1, playerId: "test", type: "BuildRoad", payload: { from: { x: 200, z: 3608 }, to: { x: 680, z: 3608 }, type: "street" } });
    expect(result.ok).toBe(true);
    for (let i = 0; i < 20; i++) step(state);
    const net = budgetTable(state.budget).net.now;
    expect(state.budget.month[LINE.construction]).toBeGreaterThan(0);
    expect(net).toBe(state.budget.treasury - opened);
  });
});

describe("the columns", () => {
  const DAY = TIME_BALANCE.ticksPerDay;
  it.each([
    [0, "Dec", "Jan so far"],
    [31 * DAY - 1, "Dec", "Jan so far"],
    [31 * DAY, "Jan", "Feb so far"],
    [yearDays() * DAY + 40 * DAY, "Jan", "Feb so far"],
  ])("at tick %d are %s and %s", (tick, last, now) => {
    expect(monthColumns(tick)).toEqual({ last, now });
  });
});

describe("the graph's months", () => {
  it("reads the last year of closed months from the money history, each labelled with the month it closed", () => {
    const stats = createStats();
    const months = 15;
    stats.money = {
      treasury: Float64Array.from({ length: months }, (_, m) => 1000 * m),
      income: Float64Array.from({ length: months }, (_, m) => 10 * m),
      expenses: Float64Array.from({ length: months }, (_, m) => 5 * m),
      taxIncome: new Float64Array(months),
    };
    stats.next = months;
    // A copy in mid-March of the second year: the newest sample, of 1 March, holds February.
    const tick = (yearDays() + 31 + 28 + 10) * TIME_BALANCE.ticksPerDay;
    const got = moneyMonths(stats, tick);
    expect(got).toHaveLength(12);
    expect(got.at(-1)).toEqual({ month: 13, income: 140, expenses: 70, treasury: 14_000 });
    expect(monthLabel(got.at(-1)?.month ?? 0)).toBe("Feb, Year 2");
    expect(got[0]?.income).toBe(30);
    expect(monthLabel(got[0]?.month ?? 0)).toBe("Mar, Year 1");
  });

  it("leaves out the month before the first, whose sample holds only the starting grant", () => {
    expect(monthLabel(-1)).toBe(`Dec, Year ${TIME_BALANCE.firstYear - 1}`);
    const state = createState(3);
    while (state.tick <= 31 * TIME_BALANCE.ticksPerDay) step(state);
    const got = moneyMonths(state.stats, state.tick);
    expect(got.map((m) => monthLabel(m.month))).toEqual([`Jan, Year ${TIME_BALANCE.firstYear}`]);
    expect(got[0]?.treasury).toBe(state.budget.opening);
    expect(ECONOMY.startingGrant).toBeGreaterThan(0);
  });

  it("is empty with no history", () => {
    expect(moneyMonths(createStats(), 0)).toEqual([]);
    expect(HISTORY_LENGTH).toBeGreaterThan(12);
  });
});

describe("the sliders", () => {
  it("offer the four tax rates and five development charges with their ranges from the balance file", () => {
    expect(TAX_SLIDERS.map((s) => s.zone)).toEqual(ECONOMY_SLIDERS);
    expect(CHARGE_SLIDERS.map((s) => s.zone)).toEqual(CHARGE_ZONES);
    for (const s of TAX_SLIDERS) expect({ min: s.min, max: s.max, default: s.default }).toEqual(ECONOMY.taxRates[s.zone]);
    for (const s of CHARGE_SLIDERS) expect({ min: s.min, max: s.max, default: s.default }).toEqual(ECONOMY.developmentCharges[s.zone]);
    for (const s of [...TAX_SLIDERS, ...CHARGE_SLIDERS]) expect(s.note.length).toBeGreaterThan(20);
  });

  it("send a tax rate on the slider's step, clear of float noise", () => {
    expect(taxRateOfSlider(0.011000000000000001)).toBe(0.011);
    expect(taxRateOfSlider(0.0149999)).toBe(0.015);
    expect(Object.is(taxRateOfSlider(-0), 0)).toBe(true);
    expect(taxRateOfSlider(0.03)).toBe(0.03);
    expect(taxRateOfSlider(0.0165)).toBe(0.0165);
  });

  it("have every default and end of the balance file's ranges on the slider's step (M4 review, #456)", () => {
    // A range input snaps to its step: a default off it could not be set again once the slider moved.
    for (const s of TAX_SLIDERS) for (const v of [s.min, s.max, s.default]) expect(taxRateOfSlider(v), `${s.zone} ${v}`).toBe(v);
    for (const s of CHARGE_SLIDERS) for (const v of [s.min, s.max, s.default]) expect(Number.isInteger(v), `${s.zone} ${v}`).toBe(true);
  });

  it("write rates and charges as the panel shows them", () => {
    expect(formatRate(0.015)).toBe("1.5%");
    expect(formatRate(0)).toBe("0%");
    expect(formatCharge(1500)).toBe("$1,500/m²");
  });
});
