import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { ECONOMY, LEDGER_LINES, formatMoneyShort } from "../packages/sim/src/index";
import { formatRate } from "../packages/client/src/ui/budget-table";
import { openCity } from "./helpers";
import { budgetCity } from "./money-fixtures";

// Issue M4-15: the budget panel on a town a few months in, a few days past
// its last close (money-fixtures.ts). The page holds the worker's clock
// (`?heldclock`), so the sim steps only when the spec says and no figure
// moves while one is read: the result is the same on a slow runner and a
// fast one.

interface Budget {
  treasury: number;
  opening: number;
  month: ArrayLike<number>;
  lastMonth: ArrayLike<number>;
  taxRates: ArrayLike<number>;
  loans: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { budget: Budget } | null };
    advance(steps: number): Promise<number>;
  };
};

test.use({ viewport: { width: 1280, height: 900 } });

/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["BUDGET_EVIDENCE_DIR"];

async function attach(page: Page, testInfo: TestInfo, name: string, what?: Locator): Promise<void> {
  const file = `${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const shot = what ? await what.screenshot() : await page.screenshot();
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, shot);
  }
}

/** The mirror's budget, as plain arrays. */
function budget(page: Page) {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.budget;
    if (!b) throw new Error("no city");
    return { treasury: b.treasury, opening: b.opening, month: Array.from(b.month), lastMonth: Array.from(b.lastMonth), taxRates: Array.from(b.taxRates), loans: Array.from(b.loans) };
  });
}

/** Steps the held clock once, so a command the page just sent applies. */
const stepOnce = (page: Page) => page.evaluate(() => window.cityCouncil.advance(1));

test("the budget panel shows the sim's ledger, moves a tax rate, and takes and repays a loan", async ({ page }, testInfo) => {
  const city = budgetCity();
  await openCity(page, city.bytes, { query: "webgl&heldclock", name: "Budget" });
  const panel = page.locator("#budget-panel");
  await expect(panel).toBeHidden();

  // The treasury in the time card opens it, and M closes and opens it again.
  await page.locator("#treasury").click();
  await expect(panel).toBeVisible();
  await expect(page.locator("#treasury")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#game-date").click();
  await page.keyboard.press("KeyM");
  await expect(panel).toBeHidden();
  await page.keyboard.press("KeyM");
  await expect(panel).toBeVisible();

  // Every line, last month and this month so far, is the sim's.
  const b = await budget(page);
  for (const [i, line] of LEDGER_LINES.entries()) {
    const row = page.locator(`#budget-ledger tr[data-line="${line}"]`);
    await expect(row, line).toHaveAttribute("data-last", String(b.lastMonth[i]));
    await expect(row, line).toHaveAttribute("data-now", String(b.month[i]));
    await expect(row.locator("td").first(), line).toHaveText(formatMoneyShort(b.lastMonth[i] ?? 0));
    await expect(row.locator("td").nth(1), line).toHaveText(formatMoneyShort(b.month[i] ?? 0));
  }
  // The town's last month had tax, a development charge and road upkeep on it.
  const lastOf = async (line: string) => Number(await page.locator(`#budget-ledger tr[data-line="${line}"]`).getAttribute("data-last"));
  for (const line of ["taxResidential", "taxCommercial", "roadUpkeep"]) expect(await lastOf(line), line).toBeGreaterThan(0);
  let charges = 0;
  for (const line of LEDGER_LINES.filter((l) => l.startsWith("charge"))) charges += await lastOf(line);
  expect(charges).toBeGreaterThan(0);
  // Income less expenses is the month's change in the treasury: last month's from its opening to this month's, and this month's so far to today's.
  const net = page.locator("#budget-net");
  const netLast = Number(await net.getAttribute("data-last"));
  const netNow = Number(await net.getAttribute("data-now"));
  expect(netLast).toBe(b.opening - city.lastMonthOpening);
  expect(netNow).toBe(b.treasury - b.opening);
  expect(Number(await page.locator("#budget-income").getAttribute("data-last")) - Number(await page.locator("#budget-expenses").getAttribute("data-last"))).toBe(netLast);
  // The graph has a line for each closed month in the history.
  await expect(page.locator("#budget-flow-graph")).toHaveAttribute("data-months", /^([1-9]|1[0-2])$/);
  await expect(page.locator("#budget-month")).toContainText("income");
  await attach(page, testInfo, "budget-panel-income", panel);

  // The residential tax slider sends SetTaxRate, and the sim's rate follows.
  const residential = page.locator("#tax-residential");
  await expect(residential).toHaveAttribute("min", String(ECONOMY.taxRates.residential.min));
  await expect(residential).toHaveAttribute("max", String(ECONOMY.taxRates.residential.max));
  expect(b.taxRates[0]).toBe(ECONOMY.taxRates.residential.default);
  await residential.fill("0.02");
  await stepOnce(page);
  await expect.poll(async () => (await budget(page)).taxRates[0]).toBe(0.02);
  await expect(residential).toHaveAttribute("data-value", "0.02");
  await expect(panel.locator('label[for="tax-residential"] output')).toHaveText("2%");
  // The keyboard moves a slider a step at a time, and each step is one command.
  const commercial = page.locator("#tax-commercial");
  await commercial.focus();
  await commercial.press("ArrowRight");
  await expect(panel.locator('label[for="tax-commercial"] output')).toHaveText(formatRate(ECONOMY.taxRates.commercial.default + 0.001));
  await stepOnce(page);
  await expect.poll(async () => (await budget(page)).taxRates[1]).toBe(Math.round((ECONOMY.taxRates.commercial.default + 0.001) * 1000) / 1000);
  await expect(commercial).toHaveAttribute("data-value", String((await budget(page)).taxRates[1]));

  // A loan within the credit limit: the treasury rises by the principal and the loan is listed.
  const credit = page.locator("#budget-credit");
  await expect(credit).toHaveAttribute("data-left", String(city.creditLeft));
  const principal = Math.floor(city.creditLeft / 2 / 1000) * 1000;
  expect(principal).toBeGreaterThan(0);
  await page.locator("#loan-amount").fill(String(principal));
  await page.locator("#loan-term").selectOption(String(ECONOMY.loans.offers[0]?.termMonths));
  const before = (await budget(page)).treasury;
  await page.locator("#take-loan").click();
  await stepOnce(page);
  const loanRow = page.locator("#budget-loans tr[data-loan]");
  await expect(loanRow).toHaveCount(1);
  await expect(loanRow).toHaveAttribute("data-balance", String(principal));
  expect((await budget(page)).treasury).toBe(before + principal);
  await expect(credit).toHaveAttribute("data-owed", String(principal));
  await expect(page.locator('#budget-ledger tr[data-line="loansTaken"]')).toHaveAttribute("data-now", String(principal));
  await page.locator("#budget-loans").scrollIntoViewIfNeeded();
  await attach(page, testInfo, "budget-panel-loan", page.locator('section[aria-label="Loans"]'));
  await page.locator("#budget-flow-graph").scrollIntoViewIfNeeded();
  await page.locator("#budget-flow-graph").hover();
  await attach(page, testInfo, "budget-panel-graph", page.locator('section[aria-label="The last year"]'));

  // Repaying it takes its balance out and closes it.
  const id = await loanRow.getAttribute("data-loan");
  await page.locator(`#repay-loan-${id}`).click();
  await stepOnce(page);
  await expect(page.locator("#budget-loans")).toHaveCount(0);
  expect((await budget(page)).loans).toEqual([]);
  expect((await budget(page)).treasury).toBe(before);
  await expect(page.locator('#budget-ledger tr[data-line="loanRepayments"]')).toHaveAttribute("data-now", String(principal + (b.month[LEDGER_LINES.indexOf("loanRepayments")] ?? 0)));

  // Escape closes it.
  await page.locator("#game-date").click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("the statistics panel graphs the treasury, income and expenses", async ({ page }, testInfo) => {
  const city = budgetCity();
  await openCity(page, city.bytes, { query: "webgl&heldclock", name: "Budget stats" });
  await page.locator("#stats-toggle").click();
  const money = page.locator('#stats-panel section[aria-label="Money"]');
  for (const [id, value] of [
    ["treasury", city.state.budget.treasury],
    ["income", null],
    ["expenses", null],
  ] as const) {
    const pick = money.locator(`#stat-${id}`);
    await expect(pick).toHaveCount(1);
    if (value !== null) await expect(pick).toHaveText(formatMoneyShort(value));
  }
  await money.locator("#stat-treasury").click();
  await expect(page.locator("#stats-graph")).toHaveAttribute("data-series", "treasury");
  await expect(page.locator("#stats-series-title")).toHaveText("Treasury");
  await page.locator("#stats-range-1").click();
  await attach(page, testInfo, "statistics-treasury", page.locator("#stats-panel .stats-sticky"));
});
