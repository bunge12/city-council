// M4-17: City Hall in the client. Its model at each stage, the stage and
// the tick it last grew as the client derives them, the placement tool run
// on a sim state the way the page runs it on the mirror's copy, the hover
// readout and the bulldozer's lines, and the building layer drawing it.
import { describe, expect, it } from "vitest";
import { Scene } from "three/webgpu";
import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  CREDITED,
  LANDMARKS,
  MILESTONES,
  NONE,
  NO_COMPENSATION,
  ZONING_BALANCE,
  buildingInfo,
  createState,
  creditMilestones,
  findLandmark,
  formatMoneyShort,
  fundCity,
  planPlaceLandmark,
  step,
  submit,
  type BuildingInfo,
  type CommandResult,
  type PlaceLandmarkPayload,
  type SimState,
} from "@city-council/sim";
import { landmarkLook } from "../src/protocol/landmark-stage";
import { createBuildingLayer, type BuildingSource } from "../src/render/building-meshes";
import { SURFACE } from "../src/theme/model";
import { NORTH_AMERICAN } from "../src/theme/north-american";
import { cityHall } from "../src/theme/north-american/generators";
import { landmarkTypeId } from "../src/theme/theme";
import { LandmarkToolController, edgeCells, lotStartAt, previewLandmark, INITIAL_LANDMARK_TOOL, type LandmarkToolHost, type LandmarkToolState } from "../src/tools/landmark-tool";
import { INITIAL_ROAD_TOOL, type RoadToolState } from "../src/tools/road-tool";
import { buildingLines, moneyLine } from "../src/ui/BuildingReadout";
import { landmarkLines } from "../src/ui/LandmarkReadout";
import { compensationLines } from "../src/ui/price-lines";

const HALL = (() => {
  const kind = LANDMARKS.find((l) => l.id === "cityHall");
  if (!kind) throw new Error("no cityHall in economy.json");
  return kind;
})();
const CELL = ZONING_BALANCE.cellSize;
/** The milestones that grow City Hall, by index. */
const GROWS = MILESTONES.flatMap((m, i) => (m.grows.includes("cityHall") ? [i] : []));

/** Highest point of a model's vertices, metres. */
function top(positions: Float32Array): number {
  let y = -Infinity;
  for (let i = 1; i < positions.length; i += 3) y = Math.max(y, positions[i] ?? 0);
  return y;
}

describe("City Hall's model (M4-17)", () => {
  const lot = { w: HALL.width * CELL, d: HALL.depth * CELL };

  it("has a model for each stage in the theme, built at its lot's depth", () => {
    const id = landmarkTypeId("cityHall");
    expect(NORTH_AMERICAN.modelCount(id)).toBe(1 + GROWS.length);
    expect(NORTH_AMERICAN.modelDepth(id)).toBe(HALL.depth);
    expect(NORTH_AMERICAN.palette(id).roof).toHaveLength(1);
  });

  it("rises with each stage and stays on its lot", () => {
    let last = 0;
    for (let stage = 1; stage <= 4; stage++) {
      const m = cityHall(lot, stage);
      const height = top(m.positions);
      expect(height, `stage ${stage}`).toBeGreaterThan(last);
      last = height;
      for (let i = 0; i < m.positions.length; i += 3) {
        expect(Math.abs(m.positions[i] ?? 0)).toBeLessThanOrEqual(lot.w / 2 + 0.01);
        expect(Math.abs(m.positions[i + 2] ?? 0)).toBeLessThanOrEqual(lot.d / 2 + 0.01);
      }
    }
    // Civic at a glance: well above the town's houses at its first stage, and a dome over 40 m by its last.
    expect(top(cityHall(lot, 1).positions)).toBeGreaterThan(12);
    expect(last).toBeGreaterThan(40);
  });

  it("has a roof surface, the dome's, only from stage 2, when something rises on the central block", () => {
    const roofs = (stage: number) => Array.from(cityHall(lot, stage).surfaces).filter((s) => s === SURFACE.roof).length;
    expect(roofs(1)).toBe(0);
    for (const stage of [2, 3, 4]) expect(roofs(stage)).toBeGreaterThan(0);
  });
});

describe("a landmark's stage and when it last grew (M4-17)", () => {
  const type = HALL.index;

  it("is stage 1, going up from when it was placed, before any milestone grows it", () => {
    expect(landmarkLook(new Int32Array([100]), type, 500)).toEqual({ stage: 1, stages: 4, since: 500 });
  });

  it("goes up again from the tick of a milestone reached in play after it was placed", () => {
    const reached = new Int32Array([100, 900]);
    expect(landmarkLook(reached, type, 500)).toEqual({ stage: 2, stages: 4, since: 900 });
  });

  it("goes up from when it was placed when the milestone that grew it came before", () => {
    expect(landmarkLook(new Int32Array([100, 200]), type, 500)).toEqual({ stage: 2, stages: 4, since: 500 });
  });

  it("plays nothing for milestones credited rather than reached", () => {
    const credited = new Int32Array(MILESTONES.length).fill(CREDITED);
    expect(landmarkLook(credited, type, 500)).toEqual({ stage: 4, stages: 4, since: 500 });
  });

  it("follows each milestone that grows it, and only those", () => {
    for (let n = 0; n <= MILESTONES.length; n++) {
      const reached = new Int32Array(n).map((_, i) => 1000 + i * 100);
      const grown = GROWS.filter((i) => i < n);
      const last = grown.at(-1);
      expect(landmarkLook(reached, type, 10)).toEqual({ stage: 1 + grown.length, stages: 4, since: last === undefined ? 10 : 1000 + last * 100 });
    }
  });
});

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const STREET = { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } as const;

let seq = 0;
function run(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, { seq: ++seq, playerId: "p1", type, payload });
  expect(result, `${type} ${JSON.stringify(payload)}`).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
}

/** A street on flat ground with City Hall open, unless `open` is false, and the treasury funded to `funds`. */
function town(open = true, funds = 500_000_000): SimState {
  const state = createState(SEED);
  if (open) creditMilestones(state, 1);
  fundCity(state, funds);
  run(state, "BuildRoad", STREET);
  return state;
}

/** The street of `town`: the newest segment, after the outside connections' stubs. */
function streetOf(state: SimState): number {
  for (let i = state.roads.segFlags.length - 1; i >= 0; i--) if ((state.roads.segFlags[i] ?? 0) !== 0) return i;
  return NONE;
}

type Store = RoadToolState & LandmarkToolState;

function host(state: SimState, sent: PlaceLandmarkPayload[] = []): { host: LandmarkToolHost; store: () => Store } {
  let store: Store = { ...INITIAL_ROAD_TOOL, ...INITIAL_LANDMARK_TOOL };
  let version = 0;
  return {
    store: () => store,
    host: {
      get: () => store,
      set: (patch) => {
        store = { ...store, ...patch };
      },
      city: () => state,
      version: () => version++,
      plan: (payload) => planPlaceLandmark(state, payload),
      send: (payload) => {
        sent.push(payload);
        const result = submit(state, { seq: ++seq, playerId: "p1", type: "PlaceLandmark", payload });
        step(state);
        return Promise.resolve(result as CommandResult);
      },
    },
  };
}

describe("the landmark tool (M4-17)", () => {
  it("puts the lot on the side the pointer is, its middle under the pointer, kept on the segment", () => {
    const state = town();
    const seg = streetOf(state);
    const edge = edgeCells(state, seg);
    const north = edge.filter((c) => c.z < 4600);
    const side = north[0]?.side ?? -1;
    const mid = north[Math.floor(north.length / 2)];
    if (!mid) throw new Error("no cells");
    expect(lotStartAt(state, seg, mid.x, mid.z - 10, HALL.width)).toEqual({ side, place: mid.place - Math.floor((HALL.width - 1) / 2) });
    // At the end of the street the lot stays on it.
    const places = north.length;
    expect(lotStartAt(state, seg, STREET.to.x + 20, mid.z - 10, HALL.width)).toEqual({ side, place: places - HALL.width });
    expect(lotStartAt(state, seg, STREET.from.x - 20, mid.z - 10, HALL.width)).toEqual({ side, place: 0 });
  });

  it("shows the plan's footprint and price, and a click places City Hall and leaves the tool", async () => {
    const state = town();
    const sent: PlaceLandmarkPayload[] = [];
    const { host: h, store } = host(state, sent);
    const tool = new LandmarkToolController(h);
    tool.toggle();
    expect(store().tool).toBe("landmark");
    const hover = { ground: { x: 4296, z: 4600 - 20 }, segment: streetOf(state) };
    const preview = tool.preview(hover, state.budget.treasury);
    expect(preview).toMatchObject({ landmark: "cityHall", name: "City Hall", ok: true, price: HALL.price, refusal: null, reason: null });
    expect(preview?.cells).toHaveLength(HALL.width * HALL.depth);
    const before = state.budget.treasury;
    tool.click(hover, state.budget.treasury);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(state.budget.treasury).toBe(before - HALL.price);
    expect(findLandmark(state.buildings, HALL.index)).toBeGreaterThanOrEqual(0);
    expect(store()).toMatchObject({ tool: null, landmarkPending: [], landmarkNote: null });
    // A second is refused before it is sent, with the sim's reason.
    tool.toggle();
    const again = tool.preview({ ground: { x: 4296, z: 4600 + 20 }, segment: streetOf(state) }, state.budget.treasury);
    expect(again?.ok).toBe(false);
    expect(again?.reason).toMatch(/has a City Hall already/);
    expect(again?.cells.length).toBeGreaterThan(0);
    tool.click({ ground: { x: 4296, z: 4600 + 20 }, segment: streetOf(state) }, state.budget.treasury);
    expect(sent).toHaveLength(1);
    expect(store().landmarkNote).toMatch(/has a City Hall already/);
  });

  it("finds the road from a cell when the pointer is off the road", () => {
    const state = town();
    const { host: h } = host(state);
    const tool = new LandmarkToolController(h);
    tool.toggle();
    expect(tool.payloadAt({ ground: { x: 4296, z: 4600 - 30 }, segment: NONE })).toMatchObject({ landmark: "cityHall", segment: streetOf(state) });
  });

  it("shows the price with the treasury's reason when it cannot pay, and still sends the click", () => {
    const state = town(true, 1_000_000);
    const sent: PlaceLandmarkPayload[] = [];
    const { host: h } = host(state, sent);
    const tool = new LandmarkToolController(h);
    tool.toggle();
    const hover = { ground: { x: 4296, z: 4600 - 20 }, segment: streetOf(state) };
    const preview = tool.preview(hover, state.budget.treasury);
    expect(preview).toMatchObject({ ok: true, price: HALL.price, reason: null });
    if (!preview) throw new Error("no preview");
    expect(preview.refusal).not.toBeNull();
    expect(landmarkLines(preview).reason).toBe(preview.refusal);
    // Sent, so the sim refuses it and the page plays its "rejected" cue.
    tool.click(hover, state.budget.treasury);
    expect(sent).toHaveLength(1);
  });

  it("stays off before the milestone that opens it", () => {
    const state = town(false);
    const { host: h, store } = host(state);
    const tool = new LandmarkToolController(h);
    expect(tool.lock()).toMatch(/locked until the Village milestone/);
    tool.toggle();
    expect(store().tool).toBeNull();
  });

  it("draws a refused lot on its own strip, with no plan of its own", () => {
    const state = town();
    const payload = { landmark: "cityHall", segment: streetOf(state), side: 0, place: 0 };
    const preview = previewLandmark(state, "cityHall", payload, { ok: false, reason: "no" });
    expect(preview).toMatchObject({ ok: false, reason: "no", price: HALL.price });
    expect(preview.cells).toHaveLength(HALL.width * Math.min(HALL.depth, ZONING_BALANCE.zoneDepthCells));
  });
});

describe("City Hall's readouts (M4-17)", () => {
  const state = town();
  run(state, "PlaceLandmark", { landmark: "cityHall", segment: streetOf(state), side: 0, place: 2 });
  const info = buildingInfo(state, findLandmark(state.buildings, HALL.index));
  if (!info) throw new Error("no City Hall");

  it("gives its name, its stage and its upkeep, and no value or tax", () => {
    expect(info.landmark).toBe(true);
    const lines = buildingLines(info, { people: 0 }, { stage: 2, stages: 4 });
    expect(lines).toEqual({ title: "City Hall", detail: `City-owned · stage 2 of 4 · ${HALL.width} × ${HALL.depth} lot`, state: null });
    expect(moneyLine(info, { people: 0, tax: 0 })).toBe(`Upkeep ${formatMoneyShort(HALL.upkeepPerYear)} a year`);
  });

  it("prices clearing it as city-owned: demolition only, less the refund", () => {
    const lines = compensationLines({ ...NO_COMPENSATION, cityDemolition: 900_000, refund: 30_000_000, cityOwned: 1, total: 900_000 - 30_000_000 });
    expect(lines).toEqual([
      { id: "cityDemolition", label: "City-owned: demolition only", amount: 900_000 },
      { id: "cityRefund", label: "Refund", amount: 30_000_000, minus: true },
    ]);
  });
});

describe("the building layer draws City Hall at its stage (M4-17)", () => {
  /** A source with one landmark row on a lot at (4000, 4000), and the stage `look` gives. */
  function source(look: { stage: number; since: number }): { source: BuildingSource; row: BuildingInfo } {
    const w = HALL.width * CELL;
    const d = HALL.depth * CELL;
    const row: BuildingInfo = {
      id: 3,
      firstSeg: 0,
      firstSide: 0,
      firstPlace: 0,
      dir: 0,
      width: HALL.width,
      depth: HALL.depth,
      backSeg: 0,
      backSide: 0,
      backPlace: 0,
      backDir: 0,
      backDepth: 0,
      zone: 0,
      density: 0,
      type: HALL.index,
      residents: 0,
      jobs: 0,
      value: 0,
      variant: 0,
      builtAt: 0,
      corners: [4000, 4000, 4000, 4000 - d, 4000 + w, 4000 - d, 4000 + w, 4000],
      chunk: 0,
      vacant: false,
      abandoned: false,
      landmark: true,
    };
    const chunk = Math.floor(3990 / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor((4000 + w / 2) / CHUNK_SIZE);
    row.chunk = chunk;
    return {
      row,
      source: {
        buildingsInChunk: (c) => (c === chunk ? [row] : []),
        buildingChunk: (id) => (id === row.id ? chunk : -1),
        landmarkLook: () => look,
      },
    };
  }

  function settle(layer: ReturnType<typeof createBuildingLayer>): void {
    const camera = { x: 4000, z: 4000 };
    layer.update(camera, 1000);
    for (let k = 0; k < 1000 && (layer.stats().pending > 0 || layer.stats().waiting > 0); k++) layer.update(camera, 1000);
  }

  it("builds the stage's model in the landmark's colours, and a new one when it grows", () => {
    const look = { stage: 1, since: 0 };
    const { source: s, row } = source(look);
    const layer = createBuildingLayer(new Scene(), s, NORTH_AMERICAN, () => 0);
    layer.reset();
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 1, models: 1 });
    const palette = NORTH_AMERICAN.palette(landmarkTypeId("cityHall"));
    expect(layer.tintOf(row.id)).toEqual({ wall: palette.wall[0], roof: palette.roof[0], trim: palette.trim[0] });
    const low = layer.topOf(row.id)?.y ?? 0;
    // A milestone grows it: the page names it by id, and it is drawn again with the next stage's model.
    look.stage = 2;
    look.since = 50;
    layer.applyIds([row.id]);
    settle(layer);
    expect(layer.stats()).toMatchObject({ buildings: 1, models: 2, lastWrites: 1 });
    expect(layer.topOf(row.id)?.y ?? 0).toBeGreaterThan(low);
    layer.dispose();
  });
});
