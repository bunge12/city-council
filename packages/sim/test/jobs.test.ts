import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  ZONING_BALANCE,
  buildingInfo,
  buildingJobs,
  cellAt,
  checkBuildingsBalance,
  createState,
  findLot,
  jobsByEducation,
  jobsByKind,
  jobsForLot,
  step,
  submit,
  type BuildingType,
  type Command,
  type SimState,
} from "../src/index";
import buildingsJson from "../balance/buildings.json" with { type: "json" };
import { addBuilding, removeBuilding } from "../src/buildings/buildings";

// M3-01: jobs per building, from the PRD's "Jobs per building" table.

const CELL = ZONING_BALANCE.cellSize;

const type = (id: string): BuildingType => {
  const t = BUILDING_TYPES.find((x) => x.id === id);
  if (!t) throw new Error(`no type ${id}`);
  return t;
};

const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(buildingsJson)) as Record<string, unknown>;

describe("jobs per building", () => {
  it("gives the PRD's worked examples", () => {
    expect(jobsForLot(type("corner-store"), 1, 1)).toBe(1);
    expect(jobsForLot(type("strip-mall"), 6, 3)).toBe(36);
    expect(jobsForLot(type("office-tower"), 4, 6)).toBe(840);
    expect(jobsForLot(type("small-factory"), 4, 4)).toBe(5);
    expect(jobsForLot(type("regional-mall"), 12, 12)).toBe(216);
  });

  it("follows the PRD's rates for every zone and density, and the through-lot types' own", () => {
    const rates: Record<string, number[]> = {
      residential: [0, 0, 0],
      commercial: [1, 2, 4],
      office: [3, 9, 35],
      industrial: [0.3, 0.5, 0.8],
      mixed: [0.8, 1.5, 6],
    };
    const through: Record<string, number> = { "big-box-centre": 0.6, "regional-mall": 1.5, "distribution-centre": 0.3, "heavy-plant": 0.5 };
    for (const t of BUILDING_TYPES) {
      expect(t.jobsPerCell, t.id).toBe(t.throughLot ? through[t.id] : rates[t.zone]?.[t.density - 1]);
    }
  });

  it("gives at least one job to a type that offers any, and none to homes", () => {
    // 0.3 a cell on a 1 x 2 lot is 0.6, which rounds to 1; on 1 x 1 it would round to 0.
    expect(jobsForLot({ jobsPerCell: 0.3 }, 1, 1)).toBe(1);
    expect(jobsForLot(type("workshop"), 1, 2)).toBe(1);
    expect(jobsForLot(type("high-tower"), 6, 6)).toBe(0);
    // Halves round up.
    expect(jobsForLot({ jobsPerCell: 0.5 }, 1, 5)).toBe(3);
    for (const t of BUILDING_TYPES) {
      const least = jobsForLot(t, t.width[0], t.depth[0]);
      if (t.zone === "residential") expect(least, t.id).toBe(0);
      else expect(least, t.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("reads a building's row and type only, and gives a free id none", () => {
    const office = type("office-tower");
    const rows = { flags: Uint8Array.of(1, 0), type: Uint16Array.of(office.index, office.index), width: Uint8Array.of(4, 4), depth: Uint8Array.of(6, 6) };
    expect(buildingJobs(rows, 0)).toBe(840);
    expect(buildingJobs(rows, 1)).toBe(0);
    expect(buildingJobs(rows, 9)).toBe(0);
  });

  it("splits a building's jobs between kinds and education levels in whole jobs that add up", () => {
    for (const t of BUILDING_TYPES) {
      for (let w = t.width[0]; w <= t.width[1]; w++) {
        for (let d = t.depth[0]; d <= t.depth[1]; d++) {
          const jobs = jobsForLot(t, w, d);
          const kinds = jobsByKind(t, jobs);
          const levels = jobsByEducation(kinds);
          const all = [...Object.values(kinds), ...Object.values(levels)];
          expect(all.every((n) => Number.isSafeInteger(n) && n >= 0), t.id).toBe(true);
          expect(kinds.commercial + kinds.office + kinds.industrial, t.id).toBe(jobs);
          expect(levels.low + levels.medium + levels.high, t.id).toBe(jobs);
        }
      }
    }
  });

  it("gives each zone the education levels the PRD says its jobs take", () => {
    // Shops and factories: low and medium. Offices: medium and high.
    for (const id of ["shopping-centre", "large-factory"]) {
      const t = type(id);
      const levels = jobsByEducation(jobsByKind(t, jobsForLot(t, 6, 6)));
      expect(levels.high, id).toBe(0);
      expect(levels.low, id).toBeGreaterThan(0);
      expect(levels.medium, id).toBeGreaterThan(0);
    }
    const tower = jobsByEducation(jobsByKind(type("office-tower"), 840));
    expect(tower).toEqual({ low: 0, medium: 420, high: 420 });
    // Mixed: shop jobs, and office jobs too at density 3.
    expect(jobsByKind(type("main-street-block"), 16)).toEqual({ commercial: 16, office: 0, industrial: 0 });
    expect(jobsByKind(type("mixed-mid-rise"), 30)).toEqual({ commercial: 30, office: 0, industrial: 0 });
    const podium = jobsByKind(type("podium-tower"), jobsForLot(type("podium-tower"), 4, 5));
    expect(podium).toEqual({ commercial: 60, office: 60, industrial: 0 });
    expect(jobsByKind(type("single-family-home"), 0)).toEqual({ commercial: 0, office: 0, industrial: 0 });
  });

  it("shows in buildingInfo for a building in state, so the readout can give it", () => {
    let seq = 0;
    const send = (state: SimState, t: string, payload: unknown): void => {
      const c: Command = { seq: ++seq, playerId: "p1", type: t, payload };
      expect(submit(state, c)).toEqual({ ok: true });
      step(state);
    };
    // Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000) (build-road.test.ts).
    const state = createState(2026);
    send(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
    const z = 4595 - CELL / 2;
    send(state, "ZoneCells", { zone: "office", density: 1, rects: [{ from: { x: 4202, z: z - CELL }, to: { x: 4246, z: z - CELL }, width: 3 * CELL }] });
    const cell = cellAt(state, 4200 + CELL / 2, z);
    if (!cell) throw new Error("no cell");
    const found = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth });
    if (!found.ok) throw new Error(found.reason);
    const id = addBuilding(state, { ...found.lot, residents: 0, variant: 0 });
    const info = buildingInfo(state, id);
    const t = BUILDING_TYPES[found.lot.type];
    if (!info || !t) throw new Error("no building");
    expect(t.zone).toBe("office");
    expect(info.jobs).toBe(jobsForLot(t, found.lot.width, found.lot.depth));
    expect(info.jobs).toBe(3 * found.lot.width * found.lot.depth);
    removeBuilding(state, id);
    expect(buildingJobs(state.buildings, id)).toBe(0);
  });
});

describe("the job balance", () => {
  it("is well formed in the balance file", () => {
    expect(checkBuildingsBalance(buildingsJson)).toEqual([]);
  });

  it("refuses jobs per cell below 0 or not a number, and jobs on a zone with no mix", () => {
    const bad = (patch: Record<string, unknown>, i = 6) => {
      const data = copy();
      const types = data["types"] as Record<string, unknown>[];
      types[i] = { ...types[i], ...patch };
      return checkBuildingsBalance(data);
    };
    expect(bad({ jobsPerCell: -1 })).toEqual([expect.stringMatching(/types\[6\]\.jobsPerCell must be a number of at least 0/)]);
    expect(bad({ jobsPerCell: "4" })).toEqual([expect.stringMatching(/types\[6\]\.jobsPerCell/)]);
    // A home with jobs: residential's mix is empty.
    expect(bad({ jobsPerCell: 1 }, 0)).toEqual([expect.stringMatching(/types\[0\]\.jobsPerCell is above 0 but jobMix\.residential\[0\] gives its jobs no kind/)]);
    // A shop with no jobs where commercial offers them is a slip.
    expect(bad({ jobsPerCell: 0 })).toEqual([expect.stringMatching(/types\[6\]\.jobsPerCell is 0 but jobMix\.commercial\[0\] gives jobs there/)]);
  });

  it("refuses a job kind or a zone's mix that is missing, out of range or does not add to 1", () => {
    const withKinds = (kinds: unknown) => checkBuildingsBalance({ ...copy(), jobKinds: kinds });
    expect(checkBuildingsBalance(Object.fromEntries(Object.entries(copy()).filter(([k]) => k !== "jobKinds")))).toEqual(["jobKinds must be an object"]);
    expect(withKinds({ commercial: { low: 0.6, medium: 0.4, high: 0 }, office: { low: 0, medium: 0.5, high: 0.5 } })).toEqual(["jobKinds.industrial is missing"]);
    expect(withKinds({ ...BUILDINGS_KINDS, office: { low: 0, medium: 0.5 } })).toEqual(["jobKinds.office.high is missing"]);
    expect(withKinds({ ...BUILDINGS_KINDS, office: { low: -0.1, medium: 0.6, high: 0.5 } })).toEqual(["jobKinds.office.low must be a share from 0 to 1"]);
    expect(withKinds({ ...BUILDINGS_KINDS, office: { low: 0, medium: 0.5, high: 0.4 } })).toEqual([expect.stringMatching(/jobKinds\.office must add to 1/)]);
    expect(withKinds({ ...BUILDINGS_KINDS, farm: { low: 1, medium: 0, high: 0 } })).toEqual(['jobKinds has an unknown kind "farm"']);

    const withMix = (patch: Record<string, unknown>) => checkBuildingsBalance({ ...copy(), jobMix: { ...MIX, ...patch } });
    const noOffice = Object.fromEntries(Object.entries(MIX).filter(([zone]) => zone !== "office"));
    const missing = checkBuildingsBalance({ ...copy(), jobMix: noOffice });
    expect(missing[0]).toBe("jobMix.office is missing");
    expect(missing.slice(1).every((e) => /jobMix\.office\[\d\] gives its jobs no kind/.test(e))).toBe(true);
    expect(withMix({ mixed: [{ commercial: 1 }, { commercial: 1 }] })[0]).toBe("jobMix.mixed must list 3 densities");
    expect(withMix({ mixed: [{ commercial: 1 }, { commercial: 1 }, { commercial: 0.5, office: 0.4 }] })[0]).toBe("jobMix.mixed[2] must add to 1, not 0.9");
    expect(withMix({ mixed: [{ commercial: 1 }, { commercial: 1 }, { commercial: 0.5, office: 1.5 }] })).toContain("jobMix.mixed[2].office must be a share from 0 to 1");
    expect(withMix({ mixed: [{ commercial: 1 }, { shops: 1 }, { commercial: 1 }] })).toContain('jobMix.mixed[1] has an unknown field "shops"');
    expect(withMix({ farm: [{}, {}, {}] })).toEqual(['jobMix has an unknown zone "farm"']);
  });
});

const BUILDINGS_KINDS = (buildingsJson as unknown as { jobKinds: Record<string, unknown> }).jobKinds;
const MIX = (buildingsJson as unknown as { jobMix: Record<string, unknown> }).jobMix;
