// The economy's numbers from `balance/economy.json`, checked when the module
// loads (M4-01, PRD "M4 Economy"). Every price is resolved to whole 2026
// dollars here: construction by the highway index in roads.json, the rest
// by the general price index in this file. The issues after M4-01 read it.

import balance from "../../balance/economy.json" with { type: "json" };
import { isRecord, isShare, unknownKeys } from "../balance-fields";
import { BUILDINGS_BALANCE, JOB_KINDS, type JobKind } from "../buildings/balance";
import { ROAD_BALANCE } from "../roads/balance";
import { ZONING_BALANCE } from "../zoning/balance";

/** The four tax sliders and price keys (M4.md). Mixed pays the residential and commercial tax rates. */
export const ECONOMY_SLIDERS = ["residential", "commercial", "office", "industrial"] as const;
export type EconomySlider = (typeof ECONOMY_SLIDERS)[number];

/**
 * The five development charge sliders, in zone order (zoning.json). Mixed
 * has its own, since a mixed building is one project (M4-08).
 */
export const CHARGE_ZONES = ["residential", "commercial", "office", "industrial", "mixed"] as const;
export type ChargeZone = (typeof CHARGE_ZONES)[number];

/** The job kinds whose output, not sales, is taxed (M4-06). */
export const BUSINESS_OUTPUTS = ["office", "industrial"] as const;
export type BusinessOutput = (typeof BUSINESS_OUTPUTS)[number];

/** Which index raises a price to 2026. */
export type PriceIndex = "construction" | "general";

/** A price as written: whole dollars in its source year. */
export interface EconomyPrice {
  amount: number;
  sourceYear: number;
  index: PriceIndex;
  source: string;
  sourceUrl?: string;
  placeholder?: boolean;
  note?: string;
}

/** A price with the range a slider may set it to, all whole dollars of the source year. */
export interface EconomyPriceRange extends EconomyPrice {
  min: number;
  max: number;
}

/** A rate a slider sets: a default and its range, as fractions. */
export interface EconomyRate {
  default: number;
  min: number;
  max: number;
  source: string;
  sourceUrl?: string;
  placeholder?: boolean;
  note?: string;
}

/** A share with where it came from. */
export interface EconomyShare {
  share: number;
  source: string;
  sourceUrl?: string;
  sourceYear?: number;
  placeholder?: boolean;
  note?: string;
}

/** One loan the city may take. */
export interface LoanOffer {
  termMonths: number;
  annualRate: number;
}

/** The economy balance file as written. */
export interface EconomyBalanceFile {
  generalEscalation: { toYear: number; annualFactor: number; source: string; sourceUrl?: string; sourceYear: number };
  startingGrant: EconomyPrice;
  overdraft: EconomyPrice;
  taxRates: Record<EconomySlider, EconomyRate>;
  developmentCharges: Record<ChargeZone, EconomyPriceRange>;
  developmentChargeGrowth: { shareAtMax: number; source: string; sourceUrl?: string; placeholder?: boolean; note?: string };
  business: { salesPerJob: EconomyPrice; outputPerJob: Record<BusinessOutput, EconomyPrice>; source: string; placeholder?: boolean };
  value: {
    perSquareMetre: Record<EconomySlider, EconomyPrice>;
    landValueReference: number;
    landValueWeight: number;
    source: string;
    placeholder?: boolean;
  };
  floorSpace: { perResident: number; perJob: Record<JobKind, number>; source: string; sourceUrl?: string; sourceYear?: number; placeholder?: boolean };
  eminentDomain: {
    relocationPerResident: EconomyPrice;
    relocationPerJob: EconomyPrice;
    premium: EconomyShare;
    demolitionPerSquareMetre: EconomyPrice;
    refundShare: EconomyShare;
  };
  expropriationRecords: { max: number; source: string; placeholder?: boolean };
  loans: { maxOpen: number; offers: LoanOffer[]; source: string; placeholder?: boolean };
  creditLimit: { perResident: EconomyPrice; lastYearTaxMultiple: number; source: string; placeholder?: boolean };
  landmarks: LandmarkFile[];
}

/** One landmark as economy.json writes it (M4-13). */
export interface LandmarkFile {
  id: string;
  name: string;
  /** The unlock that opens it, one progression's registry knows. Checked there, since progression reads this file. */
  unlock: string;
  /** Its lot: columns along the road and cells back from it. */
  width: number;
  depth: number;
  price: EconomyPrice;
  floorSpace: { squareMetres: number; source: string; sourceUrl?: string; placeholder?: boolean; note?: string };
  upkeepShare: EconomyShare;
}

/** One landmark with its price in whole 2026 dollars (M4-13). */
export interface Landmark {
  /** Its place in `ECONOMY.landmarks`, which a landmark's building row stores as its type. */
  index: number;
  id: string;
  name: string;
  unlock: string;
  width: number;
  depth: number;
  /** Whole 2026 dollars, charged on the construction line when it is placed. */
  price: number;
  /** Square metres, what its demolition is priced on. */
  floorSpace: number;
  /** Whole dollars a year to keep, on the building upkeep line: its price times its upkeep share, rounded. */
  upkeepPerYear: number;
}

/** A development charge in 2026 dollars per square metre of floor space added. */
export interface DevelopmentCharge {
  default: number;
  min: number;
  max: number;
}

/** The economy with every price in whole 2026 dollars. */
export interface Economy {
  startingGrant: number;
  overdraft: number;
  taxRates: Record<EconomySlider, { default: number; min: number; max: number }>;
  developmentCharges: Record<ChargeZone, DevelopmentCharge>;
  /** The share of a zone's daily quota left with its charge at the top of its range (M4-08). */
  developmentChargeGrowth: { shareAtMax: number };
  /** Whole 2026 dollars a year for each job filled: a shop job's sales, and an office or factory job's output (M4-06). */
  business: { salesPerJob: number; outputPerJob: Record<BusinessOutput, number> };
  value: { perSquareMetre: Record<EconomySlider, number>; landValueReference: number; landValueWeight: number };
  floorSpace: { perResident: number; perJob: Record<JobKind, number> };
  eminentDomain: {
    relocationPerResident: number;
    relocationPerJob: number;
    premium: number;
    demolitionPerSquareMetre: number;
    refundShare: number;
  };
  /** The most expropriation records state keeps (economy/compensation.ts, M4-09). */
  expropriationsMax: number;
  loans: { maxOpen: number; offers: readonly LoanOffer[] };
  creditLimit: { perResident: number; lastYearTaxMultiple: number };
  /** The landmarks, by their type (M4-13). */
  landmarks: readonly Landmark[];
}

const WORDS = ["source", "sourceUrl", "note", "placeholder"] as const;
const PRICE_KEYS = ["amount", "sourceYear", "index", ...WORDS];
const RANGE_KEYS = [...PRICE_KEYS, "min", "max"];
const RATE_KEYS = ["default", "min", "max", ...WORDS];
const SHARE_KEYS = ["share", "sourceYear", ...WORDS];

function isYear(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1900 && (value as number) <= 2100;
}

function isWhole(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Problems with where a figure came from: a source, and `placeholder` true or false if given. */
function sourceProblems(record: Record<string, unknown>, where: string): string[] {
  const errors: string[] = [];
  if (typeof record["source"] !== "string" || record["source"].trim() === "") errors.push(`${where}.source is missing`);
  if (record["placeholder"] !== undefined && typeof record["placeholder"] !== "boolean") errors.push(`${where}.placeholder must be true or false`);
  return errors;
}

function yearProblems(record: Record<string, unknown>, where: string, toYear: number, required: boolean): string[] {
  if (!("sourceYear" in record)) return required ? [`${where}.sourceYear is missing`] : [];
  if (!isYear(record["sourceYear"])) return [`${where}.sourceYear must be a year`];
  if ((record["sourceYear"] as number) > toYear) return [`${where}.sourceYear is after ${toYear}`];
  return [];
}

/** Problems with `value` as a price: whole dollars, a source year no later than `toYear`, an index and a source. Progression's grants are checked with it too (M4-12). */
export function priceProblems(value: unknown, where: string, toYear: number, keys: readonly string[] = PRICE_KEYS): string[] {
  if (!isRecord(value)) return [`${where} is missing`];
  const errors: string[] = [];
  if (!isWhole(value["amount"])) errors.push(`${where}.amount must be a whole number of dollars`);
  errors.push(...yearProblems(value, where, toYear, true));
  if (value["index"] !== "construction" && value["index"] !== "general") errors.push(`${where}.index must be "construction" or "general"`);
  errors.push(...sourceProblems(value, where), ...unknownKeys(value, keys, where));
  return errors;
}

function rangeProblems(value: unknown, where: string, toYear: number): string[] {
  const errors = priceProblems(value, where, toYear, RANGE_KEYS);
  if (!isRecord(value)) return errors;
  const { amount, min, max } = value;
  if (!isWhole(min)) errors.push(`${where}.min must be a whole number of dollars`);
  if (!isWhole(max)) errors.push(`${where}.max must be a whole number of dollars`);
  if (isWhole(amount) && isWhole(min) && isWhole(max) && !(min <= amount && amount <= max)) {
    errors.push(`${where}.amount ${amount} is outside its range ${min} to ${max}`);
  }
  return errors;
}

function rateProblems(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where} is missing`];
  const errors: string[] = [];
  for (const key of ["default", "min", "max"]) {
    if (!(key in value)) errors.push(`${where}.${key} is missing`);
    else if (!isShare(value[key])) errors.push(`${where}.${key} must be a rate from 0 to 1`);
  }
  const { default: d, min, max } = value;
  if (isShare(d) && isShare(min) && isShare(max) && !(min <= d && d <= max)) errors.push(`${where}.default ${d} is outside its range ${min} to ${max}`);
  errors.push(...sourceProblems(value, where), ...unknownKeys(value, RATE_KEYS, where));
  return errors;
}

function shareRecordProblems(value: unknown, where: string, toYear: number): string[] {
  if (!isRecord(value)) return [`${where} is missing`];
  const errors: string[] = [];
  if (!("share" in value)) errors.push(`${where}.share is missing`);
  else if (!isShare(value["share"])) errors.push(`${where}.share must be a share from 0 to 1`);
  errors.push(...yearProblems(value, where, toYear, false), ...sourceProblems(value, where), ...unknownKeys(value, SHARE_KEYS, where));
  return errors;
}

/** Problems with `value` as one entry per slider of `sliders`, the four tax sliders by default, each checked by `check`. */
function perSlider(value: unknown, where: string, check: (entry: unknown, at: string) => string[], sliders: readonly string[] = ECONOMY_SLIDERS): string[] {
  if (!isRecord(value)) return [`${where} is missing`];
  const errors: string[] = [];
  for (const slider of sliders) errors.push(...check(value[slider], `${where}.${slider}`));
  errors.push(...unknownKeys(value, sliders, where));
  return errors;
}

function blockProblems(data: Record<string, unknown>, key: string, check: (block: Record<string, unknown>) => string[]): string[] {
  const block = data[key];
  return isRecord(block) ? check(block) : [`${key} is missing`];
}

const LANDMARK_KEYS = ["id", "name", "unlock", "width", "depth", "price", "floorSpace", "upkeepShare"];

/**
 * Problems with the landmark list (M4-13): each with a distinct id and
 * unlock, a name, a lot of whole cells no wider than a lot may be
 * (buildings.json) and no deeper than a zoning strip, a price, a floor
 * space and an upkeep share.
 */
function landmarkProblems(value: unknown, toYear: number): string[] {
  if (!Array.isArray(value)) return ["landmarks must be a list"];
  const errors: string[] = [];
  const ids = new Set<unknown>();
  const unlocks = new Set<unknown>();
  value.forEach((entry: unknown, i) => {
    const at = `landmarks[${i}]`;
    if (!isRecord(entry)) return void errors.push(`${at} is not an object`);
    if (typeof entry["id"] !== "string" || entry["id"] === "" || ids.has(entry["id"])) errors.push(`${at}.id must be a name no other landmark has`);
    ids.add(entry["id"]);
    if (typeof entry["name"] !== "string" || entry["name"].trim() === "") errors.push(`${at}.name is missing`);
    if (typeof entry["unlock"] !== "string" || unlocks.has(entry["unlock"])) errors.push(`${at}.unlock must be an unlock no other landmark has`);
    unlocks.add(entry["unlock"]);
    const width = entry["width"];
    const depth = entry["depth"];
    if (!Number.isSafeInteger(width) || (width as number) < 1 || (width as number) > BUILDINGS_BALANCE.maxLotWidth) errors.push(`${at}.width must be a whole number of cells from 1 to ${BUILDINGS_BALANCE.maxLotWidth}`);
    if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > ZONING_BALANCE.zoneDepthCells) errors.push(`${at}.depth must be a whole number of cells from 1 to ${ZONING_BALANCE.zoneDepthCells}`);
    errors.push(...priceProblems(entry["price"], `${at}.price`, toYear));
    const space = entry["floorSpace"];
    if (!isRecord(space)) errors.push(`${at}.floorSpace is missing`);
    else {
      if (!isPositive(space["squareMetres"])) errors.push(`${at}.floorSpace.squareMetres must be a positive number`);
      errors.push(...sourceProblems(space, `${at}.floorSpace`), ...unknownKeys(space, ["squareMetres", ...WORDS], `${at}.floorSpace`));
    }
    errors.push(...shareRecordProblems(entry["upkeepShare"], `${at}.upkeepShare`, toYear));
    errors.push(...unknownKeys(entry, LANDMARK_KEYS, at));
  });
  return errors;
}

/**
 * Every problem with an economy balance file, or none. A missing field, a
 * price with no source or source year, and a default outside its range are
 * each a problem, named by where they are.
 */
export function checkEconomyBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the economy balance is not an object"];
  const errors: string[] = [];
  let toYear = 2026;
  errors.push(
    ...blockProblems(data, "generalEscalation", (e) => {
      const out: string[] = [];
      if (!isYear(e["toYear"])) out.push("generalEscalation.toYear is missing");
      else toYear = e["toYear"] as number;
      if (!isPositive(e["annualFactor"])) out.push("generalEscalation.annualFactor must be a positive number");
      if (!isYear(e["sourceYear"])) out.push("generalEscalation.sourceYear is missing");
      out.push(...sourceProblems(e, "generalEscalation"), ...unknownKeys(e, ["toYear", "annualFactor", ...WORDS, "sourceYear"], "generalEscalation"));
      return out;
    }),
  );
  if (toYear !== ROAD_BALANCE.escalation.toYear) errors.push(`generalEscalation.toYear must be roads.json's escalation.toYear, ${ROAD_BALANCE.escalation.toYear}`);
  errors.push(...priceProblems(data["startingGrant"], "startingGrant", toYear));
  errors.push(...priceProblems(data["overdraft"], "overdraft", toYear));
  errors.push(...perSlider(data["taxRates"], "taxRates", rateProblems));
  errors.push(...perSlider(data["developmentCharges"], "developmentCharges", (v, at) => rangeProblems(v, at, toYear), CHARGE_ZONES));
  errors.push(
    ...blockProblems(data, "developmentChargeGrowth", (g) => {
      const out: string[] = [];
      if (!isShare(g["shareAtMax"])) out.push("developmentChargeGrowth.shareAtMax must be a share from 0 to 1");
      out.push(...sourceProblems(g, "developmentChargeGrowth"), ...unknownKeys(g, ["shareAtMax", ...WORDS], "developmentChargeGrowth"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "business", (b) => {
      const out = priceProblems(b["salesPerJob"], "business.salesPerJob", toYear);
      const perJob = b["outputPerJob"];
      if (!isRecord(perJob)) out.push("business.outputPerJob is missing");
      else {
        for (const kind of BUSINESS_OUTPUTS) out.push(...priceProblems(perJob[kind], `business.outputPerJob.${kind}`, toYear));
        out.push(...unknownKeys(perJob, BUSINESS_OUTPUTS, "business.outputPerJob"));
      }
      out.push(...sourceProblems(b, "business"), ...unknownKeys(b, ["salesPerJob", "outputPerJob", ...WORDS], "business"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "value", (v) => {
      const out = perSlider(v["perSquareMetre"], "value.perSquareMetre", (p, at) => priceProblems(p, at, toYear));
      const ref = v["landValueReference"];
      if (!(typeof ref === "number" && Number.isFinite(ref) && ref > 0 && ref <= 100)) out.push("value.landValueReference must be a number above 0 and at most 100");
      if (!isShare(v["landValueWeight"])) out.push("value.landValueWeight must be a share from 0 to 1");
      out.push(...sourceProblems(v, "value"), ...unknownKeys(v, ["perSquareMetre", "landValueReference", "landValueWeight", ...WORDS], "value"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "floorSpace", (f) => {
      const out: string[] = [];
      if (!isPositive(f["perResident"])) out.push("floorSpace.perResident must be a positive number of square metres");
      const perJob = f["perJob"];
      if (!isRecord(perJob)) out.push("floorSpace.perJob is missing");
      else {
        for (const kind of JOB_KINDS) if (!isPositive(perJob[kind])) out.push(`floorSpace.perJob.${kind} must be a positive number of square metres`);
        out.push(...unknownKeys(perJob, JOB_KINDS, "floorSpace.perJob"));
      }
      out.push(...yearProblems(f, "floorSpace", toYear, false), ...sourceProblems(f, "floorSpace"));
      out.push(...unknownKeys(f, ["perResident", "perJob", "sourceYear", ...WORDS], "floorSpace"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "eminentDomain", (d) => [
      ...priceProblems(d["relocationPerResident"], "eminentDomain.relocationPerResident", toYear),
      ...priceProblems(d["relocationPerJob"], "eminentDomain.relocationPerJob", toYear),
      ...shareRecordProblems(d["premium"], "eminentDomain.premium", toYear),
      ...priceProblems(d["demolitionPerSquareMetre"], "eminentDomain.demolitionPerSquareMetre", toYear),
      ...shareRecordProblems(d["refundShare"], "eminentDomain.refundShare", toYear),
      ...unknownKeys(d, ["relocationPerResident", "relocationPerJob", "premium", "demolitionPerSquareMetre", "refundShare"], "eminentDomain"),
    ]),
  );
  errors.push(
    ...blockProblems(data, "expropriationRecords", (r) => {
      const out: string[] = [];
      if (!Number.isSafeInteger(r["max"]) || (r["max"] as number) < 1) out.push("expropriationRecords.max must be a whole number of at least 1");
      out.push(...sourceProblems(r, "expropriationRecords"), ...unknownKeys(r, ["max", ...WORDS], "expropriationRecords"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "loans", (l) => {
      const out: string[] = [];
      if (!Number.isSafeInteger(l["maxOpen"]) || (l["maxOpen"] as number) < 1) out.push("loans.maxOpen must be a whole number of at least 1");
      const offers = l["offers"];
      if (!Array.isArray(offers) || offers.length === 0) out.push("loans.offers must be a non-empty list");
      else {
        offers.forEach((offer: unknown, i) => {
          const at = `loans.offers[${i}]`;
          if (!isRecord(offer)) return void out.push(`${at} is not an object`);
          if (!Number.isSafeInteger(offer["termMonths"]) || (offer["termMonths"] as number) < 1) out.push(`${at}.termMonths must be a whole number of at least 1`);
          if (!isShare(offer["annualRate"])) out.push(`${at}.annualRate must be a rate from 0 to 1`);
          out.push(...unknownKeys(offer, ["termMonths", "annualRate"], at));
        });
      }
      out.push(...sourceProblems(l, "loans"), ...unknownKeys(l, ["maxOpen", "offers", ...WORDS], "loans"));
      return out;
    }),
  );
  errors.push(
    ...blockProblems(data, "creditLimit", (c) => {
      const out = priceProblems(c["perResident"], "creditLimit.perResident", toYear);
      const m = c["lastYearTaxMultiple"];
      if (!(typeof m === "number" && Number.isFinite(m) && m >= 0)) out.push("creditLimit.lastYearTaxMultiple must be a number of at least 0");
      out.push(...sourceProblems(c, "creditLimit"), ...unknownKeys(c, ["perResident", "lastYearTaxMultiple", ...WORDS], "creditLimit"));
      return out;
    }),
  );
  errors.push(...landmarkProblems(data["landmarks"], toYear));
  errors.push(...unknownKeys(data, ["generalEscalation", "startingGrant", "overdraft", "taxRates", "developmentCharges", "developmentChargeGrowth", "business", "value", "floorSpace", "eminentDomain", "expropriationRecords", "loans", "creditLimit", "landmarks"], "the file"));
  return errors;
}

/**
 * `amount` of `sourceYear` in whole dollars of `toYear`, raised by `factor`
 * once a year by multiplication, as roads.json's prices are (rule 6), and
 * rounded half up to whole dollars (rule 9).
 */
function raise(amount: number, sourceYear: number, toYear: number, factor: number): number {
  let out = amount;
  for (let year = sourceYear; year < toYear; year++) out *= factor;
  return Math.floor(out + 0.5);
}

/** Checks an economy balance and resolves every price to whole 2026 dollars. Throws listing every problem. */
export function resolveEconomy(data: unknown): Economy {
  const errors = checkEconomyBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/economy.json: ${errors.join("; ")}`);
  const file = data as EconomyBalanceFile;
  const general = file.generalEscalation;
  const construction = ROAD_BALANCE.escalation;
  const factorOf = (index: PriceIndex): number => (index === "construction" ? construction.annualFactor : general.annualFactor);
  const at = (p: EconomyPrice, amount = p.amount): number => raise(amount, p.sourceYear, general.toYear, factorOf(p.index));
  const sliders = <T, U>(record: Record<EconomySlider, T>, f: (v: T) => U): Record<EconomySlider, U> =>
    Object.fromEntries(ECONOMY_SLIDERS.map((s) => [s, f(record[s])])) as Record<EconomySlider, U>;
  return {
    startingGrant: at(file.startingGrant),
    overdraft: at(file.overdraft),
    taxRates: sliders(file.taxRates, (r) => ({ default: r.default, min: r.min, max: r.max })),
    developmentCharges: Object.fromEntries(
      CHARGE_ZONES.map((zone) => {
        const c = file.developmentCharges[zone];
        return [zone, { default: at(c), min: at(c, c.min), max: at(c, c.max) }];
      }),
    ) as Record<ChargeZone, DevelopmentCharge>,
    developmentChargeGrowth: { shareAtMax: file.developmentChargeGrowth.shareAtMax },
    business: {
      salesPerJob: at(file.business.salesPerJob),
      outputPerJob: { office: at(file.business.outputPerJob.office), industrial: at(file.business.outputPerJob.industrial) },
    },
    value: {
      perSquareMetre: sliders(file.value.perSquareMetre, (p) => at(p)),
      landValueReference: file.value.landValueReference,
      landValueWeight: file.value.landValueWeight,
    },
    floorSpace: { perResident: file.floorSpace.perResident, perJob: { ...file.floorSpace.perJob } },
    eminentDomain: {
      relocationPerResident: at(file.eminentDomain.relocationPerResident),
      relocationPerJob: at(file.eminentDomain.relocationPerJob),
      premium: file.eminentDomain.premium.share,
      demolitionPerSquareMetre: at(file.eminentDomain.demolitionPerSquareMetre),
      refundShare: file.eminentDomain.refundShare.share,
    },
    expropriationsMax: file.expropriationRecords.max,
    loans: { maxOpen: file.loans.maxOpen, offers: file.loans.offers.map((o) => ({ ...o })) },
    creditLimit: { perResident: at(file.creditLimit.perResident), lastYearTaxMultiple: file.creditLimit.lastYearTaxMultiple },
    landmarks: file.landmarks.map((l, index) => {
      const price = at(l.price);
      return {
        index,
        id: l.id,
        name: l.name,
        unlock: l.unlock,
        width: l.width,
        depth: l.depth,
        price,
        floorSpace: l.floorSpace.squareMetres,
        upkeepPerYear: Math.round(price * l.upkeepShare.share),
      };
    }),
  };
}

/** `price` in whole dollars of the year economy.json raises prices to, by its index: what a grant in progression.json is worth (M4-12). */
export function priceNow(price: EconomyPrice): number {
  const general = ECONOMY_BALANCE_FILE.generalEscalation;
  const factor = price.index === "construction" ? ROAD_BALANCE.escalation.annualFactor : general.annualFactor;
  return raise(price.amount, price.sourceYear, general.toYear, factor);
}

/** The year economy.json raises prices to. */
export const PRICE_YEAR: number = (balance as EconomyBalanceFile).generalEscalation.toYear;

/** The economy balance file as written. */
export const ECONOMY_BALANCE_FILE = balance as EconomyBalanceFile;

/** `value` and everything in it frozen, so a slider cannot write a balance number by mistake. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The economy, checked, with every price in whole 2026 dollars. Frozen: the
 * rates a player sets live in state (M4-02, M4-07), and these are only the
 * defaults and ranges.
 */
export const ECONOMY: Economy = deepFreeze(resolveEconomy(balance));
