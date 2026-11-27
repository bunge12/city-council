import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  BUILDING_TYPES,
  ECONOMY,
  MILESTONES,
  POPS_BALANCE,
  buildingTaxPerYear,
  cellAt,
  createState,
  formatMoneyShort,
  fundCity,
  generateTerrain,
  heightAt,
  planBulldozeBuildings,
  seeBuilding,
  serialize,
  syncCells,
  unlockMilestone,
  type SimState,
} from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { addPop } from "../packages/sim/src/pops/pops";
import { lotProblem } from "../packages/sim/src/buildings/where";
import { finishConstruction } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M4-16: every tool says what a click costs before it, and the zone
// tool says what is still locked. The bulldozer's tag gives an occupied
// house's compensation part by part and a vacant one's demolition only,
// and each total is what the click is charged. The bulldozing spends the
// city down to its overdraft, so the road tool then shows a street's price
// in the warning colour with the sim's reason, and a click is refused with
// the "rejected" sound. Before the first milestone the zone tool shows
// medium density greyed, with the population that unlocks it. The hover
// readout gives a house's value and its yearly tax.
//
// The city is built in Node with the sim: a street with a house on every
// two cells of its north side, people in all but one, a second street
// behind them, and no milestone reached. It is saved paused and the page
// holds the worker's clock (`?heldclock`), so the sim steps only when the
// spec says and no figure moves between the tag and the charge: the
// outcome is the same on a slow runner and a fast one.

type Vec3 = readonly [number, number, number];
interface CueRecord {
  cue: string;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    advance(steps: number): Promise<number>;
    sound: { cues(): CueRecord[]; clear(): void };
    mirror: { state: { tick: number; budget: { treasury: number }; buildings: { flags: Uint8Array }; log: { type: string }[]; logSpent: number[] } | null };
    view: Promise<{ buildingTop(id: number): { x: number; y: number; z: number } | null }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void }; project(x: number, y: number, z: number): { x: number; y: number } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function getComputedStyle(element: unknown): { color: string; opacity: string };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const terrain = generateTerrain(SEED);
const CELL = 8;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["PRICES_EVIDENCE_DIR"];
/** What the city has left over its overdraft once both houses are paid for: less than any street. */
const LEFT_OVER = 5_000;
/** The warning colour, `--bad-ink`, as the treasury below zero shows it (M4-14). */
const WARNING = "rgb(122, 23, 18)";

const cellCentre = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

interface PricesCity {
  bytes: Uint8Array;
  /** A house with two people in it, and one nobody lives in. */
  occupied: number;
  vacant: number;
  /** What clearing each costs, from the sim's plan in Node. */
  occupiedPrice: number;
  vacantPrice: number;
  /** What the occupied house pays a year in tax. */
  occupiedTax: number;
}

/** The houses' street, its houses with people in all but one, funded so that clearing both leaves `LEFT_OVER` over the overdraft. */
function pricesCity(): PricesCity {
  const state: SimState = createState(SEED);
  buildRoads(state, [
    [[4200, 4600], [4392, 4600], "street"],
    [[4200, 4480], [4392, 4480], "street"],
  ]);
  syncCells(state);
  for (let p = 0; p < 24; p++) {
    for (let k = 0; k < 6; k++) {
      const [x, z] = cellCentre(p, k);
      const cell = cellAt(state, x, z);
      if (!cell) continue;
      state.cells.zone[cell.index] = 1;
      state.cells.density[cell.index] = 1;
    }
  }
  const type = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  const houses: number[] = [];
  for (let p = 0; p + 1 < 24; p += 2) {
    const [x, z] = cellCentre(p, 0);
    const cell = cellAt(state, x, z);
    if (!cell) continue;
    const shape = { first: { seg: cell.segment, side: cell.side, place: cell.place, dir: 0 }, width: 2, depth: 4, back: null };
    if (lotProblem(state, shape, 1, 1) !== null) continue;
    const lot = { firstSeg: cell.segment, firstSide: cell.side, firstPlace: cell.place, dir: 0, width: 2, depth: 4, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 };
    houses.push(addBuilding(state, { ...lot, type, residents: 3, variant: p * 7 }));
  }
  const [vacant, ...lived] = houses;
  const occupied = lived[3];
  if (vacant === undefined || occupied === undefined) throw new Error("too few houses");
  // Newcomers in their grace, so nobody leaves while the spec runs (#361). The first house stays empty.
  for (const home of lived) addPop(state, { home, size: 2, education: 1, wealth: 1, children: 0, satisfaction: 100, graceDays: POPS_BALANCE.newcomer.graceDays });
  finishConstruction(state);
  state.speed = 0;
  const priceOf = (id: number): number => {
    const seen = seeBuilding(state.buildings, id);
    const plan = planBulldozeBuildings(state, { buildings: [seen] });
    if (!plan.ok) throw new Error(plan.reason);
    return plan.compensation.total;
  };
  const occupiedPrice = priceOf(occupied);
  const vacantPrice = priceOf(vacant);
  fundCity(state, occupiedPrice + vacantPrice + LEFT_OVER - ECONOMY.overdraft);
  if (state.milestones.length !== 0) throw new Error("the city has a milestone already");
  return { bytes: serialize(state), occupied, vacant, occupiedPrice, vacantPrice, occupiedTax: buildingTaxPerYear(state, occupied) };
}

/** Looks at (x, z) from `height` up, from the south. */
async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function moveTo(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

/** Moves the pointer onto the roof of building `id` as drawn. */
async function moveToTop(page: Page, id: number): Promise<void> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  const p = await screenAt(page, top.x, top.z, top.y - 1);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

const cues = (page: Page) => page.evaluate(() => window.cityCouncil.sound.cues().map((c) => c.cue));
const isLive = (page: Page, id: number) => page.evaluate((id) => ((window.cityCouncil.mirror.state?.buildings.flags[id] ?? 0) & 1) !== 0, id);
const logLength = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);

/** A click where the pointer is, then one step of the held clock, so the sim applies what the click sent. */
async function clickAndStep(page: Page): Promise<void> {
  await page.mouse.down();
  await page.mouse.up();
  await frames(page, 2);
  await page.evaluate(() => window.cityCouncil.advance(1));
  await frames(page, 2);
}

let shotNo = 0;
/** A screenshot for the pull request: the page, or `what` with `around` CSS pixels of the page round it. */
async function attach(page: Page, testInfo: TestInfo, name: string, what?: Locator, around = 0): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const box = what ? await what.boundingBox() : null;
  const clip = box ? { x: Math.max(0, box.x - around), y: Math.max(0, box.y - around), width: box.width + 2 * around, height: box.height + 2 * around } : undefined;
  const png = await page.screenshot(clip ? { clip } : {});
  writeFileSync(path, png);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, png);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The tag's lines as it shows them: each line's id and amount. */
async function tagLines(tag: Locator): Promise<{ line: string; amount: number }[]> {
  return tag.locator("#bulldoze-lines tr").evaluateAll((rows) =>
    rows.map((r) => ({ line: (r as unknown as { dataset: Record<string, string> }).dataset["line"] ?? "", amount: Number((r as unknown as { dataset: Record<string, string> }).dataset["amount"]) })),
  );
}

test("prices before the click: the bulldozer's tag is the charge, a broke city's street is refused, and density 2 shows its milestone", async ({ page }, testInfo) => {
  const city = pricesCity();
  await openCity(page, city.bytes, { query: "webgl&heldclock", name: "Prices" });
  await look(page, 4296, 4570, 220);
  // A click starts audio, as the player's first one does.
  await page.locator("#game-date").click();
  const tag = page.locator("#bulldoze-tag");

  await test.step("the hover readout gives a house's value and its yearly tax", async () => {
    await moveToTop(page, city.occupied);
    const readout = page.locator("#building-readout");
    await expect(readout).toHaveAttribute("data-building", String(city.occupied));
    await expect(readout).toHaveAttribute("data-tax", String(city.occupiedTax));
    const value = Number(await readout.getAttribute("data-value"));
    expect(value).toBeGreaterThan(0);
    expect(city.occupiedTax).toBeGreaterThan(0);
    await expect(page.locator("#building-money")).toHaveText(`Value ${formatMoneyShort(value)} · Tax ${formatMoneyShort(city.occupiedTax)} a year`);
    await attach(page, testInfo, "the hover readout with a house's value and tax", readout, 40);
  });

  await test.step("an occupied house's tag gives its value, relocation and premium, then the total, which the click is charged", async () => {
    await page.keyboard.press("KeyB");
    await moveToTop(page, city.occupied);
    await expect(tag).toHaveAttribute("data-ids", String(city.occupied));
    await expect(tag).toHaveAttribute("data-ok", "true");
    await expect(tag).toHaveAttribute("data-refusal", "");
    const lines = await tagLines(tag);
    expect(lines.map((l) => l.line)).toEqual(["value", "relocation", "premium", "total"]);
    await expect(tag.locator("tr.line-relocation th")).toHaveText("Relocation, 2 residents");
    const total = lines.at(-1)?.amount ?? NaN;
    expect(total).toBe(city.occupiedPrice);
    expect(Number(await tag.getAttribute("data-cost"))).toBe(total);
    await expect(page.locator("#bulldoze-cost")).toHaveText(formatMoneyShort(total));
    await attach(page, testInfo, "an occupied house's tag", tag, 60);
    const log = await logLength(page);
    await clickAndStep(page);
    expect(await isLive(page, city.occupied)).toBe(false);
    expect(await logLength(page)).toBe(log + 1);
    // What the click was charged, as the log keeps it beside its entry (M4-03): the tag's total, to the dollar.
    expect(await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))).toBe(total);
  });

  await test.step("a vacant house's tag gives its demolition only, which the click is charged", async () => {
    await moveToTop(page, city.vacant);
    await expect(tag).toHaveAttribute("data-ids", String(city.vacant));
    const lines = await tagLines(tag);
    expect(lines).toEqual([{ line: "demolition", amount: city.vacantPrice }]);
    await expect(tag.locator("tr.line-demolition th")).toHaveText("Demolition");
    await expect(page.locator("#bulldoze-cost")).toHaveText(formatMoneyShort(city.vacantPrice));
    expect(city.vacantPrice).toBeLessThan(city.occupiedPrice / 10);
    await attach(page, testInfo, "a vacant house's tag", tag, 60);
    await clickAndStep(page);
    expect(await isLive(page, city.vacant)).toBe(false);
    expect(await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))).toBe(city.vacantPrice);
  });

  await test.step("a road's tag gives its demolition less its refund, the houses it takes, then the total", async () => {
    await page.keyboard.down("Shift");
    await moveTo(page, 4380, 4600);
    await expect(tag).toHaveAttribute("data-kind", "road");
    const lines = await tagLines(tag);
    expect(lines.map((l) => l.line)).toEqual(["road", "refund", "value", "relocation", "premium", "total"]);
    expect(lines.at(-1)?.amount).toBe(Number(await tag.getAttribute("data-cost")));
    // The city has spent its money on the houses, so the tag keeps the price and says why a click is refused.
    await expect(tag).toHaveAttribute("data-refusal", /^Costs \$[\d.]+M, \$[\d.]+K available$/);
    await expect(page.locator("#bulldoze-reason")).toHaveText(/^Costs /);
    await attach(page, testInfo, "a road's tag, refused for money", tag, 60);
    await page.keyboard.up("Shift");
    await page.keyboard.press("KeyB");
  });

  await test.step("past the overdraft the road tool shows a street's price in the warning colour with the reason, and a click is refused with the rejected sound", async () => {
    const treasury = await page.evaluate(() => window.cityCouncil.mirror.state?.budget.treasury ?? NaN);
    // Within a few dollars of what the fixture left: the held steps ran a slice of the tax sweep.
    expect(Math.abs(treasury + ECONOMY.overdraft - LEFT_OVER)).toBeLessThan(LEFT_OVER);
    await look(page, 4500, 4760, 260);
    await page.keyboard.press("KeyR");
    await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
    const a = await screenAt(page, 4440, 4760);
    const b = await screenAt(page, 4640, 4760);
    await page.mouse.click(a.x, a.y);
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await frames(page, 3);
    const readout = page.locator("#road-readout");
    await expect(readout).toHaveAttribute("data-ok", "true");
    await expect(readout).toHaveClass(/refused/);
    const price = Number(await readout.getAttribute("data-price"));
    expect(price).toBeGreaterThan(LEFT_OVER * 2);
    const refusal = await readout.getAttribute("data-refusal");
    expect(refusal).toMatch(/^Costs \$[\d.]+[KM], \$[\d.]+K available$/);
    await expect(page.locator("#road-cost")).toHaveText(formatMoneyShort(price));
    await expect(page.locator("#road-reason")).toHaveText(refusal ?? "");
    expect(await page.locator("#road-cost").evaluate((el) => getComputedStyle(el).color)).toBe(WARNING);
    await attach(page, testInfo, "the road tool refused for money", readout, 60);
    await page.evaluate(() => window.cityCouncil.sound.clear());
    const log = await logLength(page);
    await page.mouse.click(b.x, b.y);
    await frames(page, 2);
    await page.evaluate(() => window.cityCouncil.advance(1));
    await expect(page.locator("#road-note")).toHaveText(/^Costs /);
    expect(await logLength(page)).toBe(log);
    await expect.poll(() => cues(page)).toEqual(["reject"]);
    await attach(page, testInfo, "the refused street's note");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  await test.step("before the first milestone the zone tool shows medium density greyed, with the population that unlocks it", async () => {
    await page.locator("#zone-tool").click();
    const medium = page.locator("#zone-density-2");
    const first = MILESTONES[unlockMilestone("density2")];
    if (!first) throw new Error("no milestone unlocks density 2");
    await expect(medium).toHaveAttribute("data-locked", "true");
    await expect(medium).toHaveAttribute("aria-disabled", "true");
    await expect(medium.locator(".unlocks-at")).toHaveText(`Unlocks at ${first.population.toLocaleString("en-US")} residents`);
    await expect(medium).toHaveAttribute("title", `Medium density is locked until the ${first.name} milestone, at ${first.population.toLocaleString("en-US")} residents`);
    expect(Number(await medium.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
    await expect(page.locator("#zone-density-1")).not.toHaveAttribute("data-locked", "true");
    await expect(page.locator("#zone-density-1 .unlocks-at")).toHaveCount(0);
    // A click on it picks nothing. Forced: Playwright waits on `aria-disabled`, which the button keeps for its tooltip.
    await medium.click({ force: true });
    await expect(medium).toHaveAttribute("aria-pressed", "false");
    await attach(page, testInfo, "the zone tool with medium density locked", page.locator("#zone-menu"), 20);
  });
});
