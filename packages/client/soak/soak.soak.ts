// Soak run: hosts the M1 scale city, 30,000 road segments, headless at 4x
// for one hour of game time while roads are built, upgraded, bulldozed and
// undone, and reports step time and memory. Run it with `pnpm soak`.
//
// It drives the real SimHost, the same class the Web Worker runs, with no
// worker and no page. The host reads its clock once at the start of each
// pump to pace itself, and that first read returns a virtual time that moves
// exactly one pump interval per pump. So the host steps on the same ticks it
// would live, every run steps identically, and the run takes about a second
// instead of fifteen minutes. Later reads in the pump, which time the
// systems, add the real time since the pump began, so step timings are real.
//
// Along the way it sends a NoOp every few ticks, which pushes the activity
// log past its live limit so paging runs, and takes a snapshot on the
// autosave interval, in parts as the saver does. Every few seconds of game time it sends a road command
// in a fixed cycle: a street through a grid's blocks, a street grid at the
// cap over existing streets, an upgrade, a bulldoze and an undo. It picks
// the segments to upgrade and bulldoze from a SimMirror fed by the host's
// messages, as the page does, and times the step that applies each command
// on its own (issue M1-17).
//
// Since M2-17 it also zones, rezones and clears buildings on a cycle of its
// own: a ZoneCells at the cap over a grid and the ground round it, a
// rezone of half of that ground to another zone, and a BulldozeBuilding of
// buildings the mirror shows standing. The grower builds on the zoning as
// the hour goes on, so the idle steps carry its work, and its own time per
// step is reported. The SimMirror runs in a worker thread of its own
// (mirror-worker.ts), as the page does in the browser: with it in the
// soak's thread, one heap held both copies of the grown town, and a full
// collection of it landed in whichever step allocated past the limit.
//
// The tick budget is checked per source of work: each road command type,
// the steps that walk a slice of zoning cells, the idle steps (log paging
// among them) and each autosave's slowest part. Each source may pass the
// budget only a couple of times in a run. A shared CI runner pauses a step
// now and then, for a garbage collection or another tenant, and such a
// pause lands on a step of any source at random. A source that is slow
// every time it runs passes the budget every time, and so fails the run,
// however rarely it runs. The worst cases, a grid at the cap and each part
// of an autosave, are also held to the budget by \`pnpm bench\`, which
// averages many runs.
//
// A garbage collection pauses whichever step is running, and the grower's
// is the step that runs most, so the report counts the collections on the
// sim's thread and names the ones that ran during each step over the budget
// and each grower step over 5 ms (issue 166).
//
// At the end a replay of the full log from the
// seed, the scale city's own commands included, must give the same state
// hash as the live city.
//
// The hour runs once, and two tests judge it (issue #231). "the replay and
// the page agree with the live city" holds the hashes: a failure there means
// the sim or the page went wrong, and running it again will not help. "every
// source inside the tick budget" holds the step times: a failure there can
// be the runner. Its message carries `[budget]`, so `pnpm soak`, through
// scripts/budget-retry.mjs, runs the soak once more and fails only when the
// second hour misses as well.

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { memoryUsage } from "node:process";
import { PerformanceObserver, constants, performance } from "node:perf_hooks";
import {
  CELLS_SYSTEM,
  GROWER_SYSTEM,
  LOG_LIVE_LIMIT,
  PROTOCOL_VERSION,
  SCALE_SEGMENTS,
  SEG_ALIVE,
  TICK_MS,
  ZONING_BALANCE,
  budgetFigure,
  buildScaleCity,
  buildingCount,
  cellsSettled,
  deserialize,
  hashState,
  judgeBudget,
  replay,
  step,
  type FromSimMessage,
} from "@city-council/sim";
import { beforeAll, describe, expect, test } from "vitest";
import { holdDemandBars } from "../src/protocol/held-demand";
import { PUMP_INTERVAL_MS, SimHost, type PendingSave } from "../src/protocol/host";
import { build } from "vite";
import { countHomes } from "../src/protocol/homes";
import type { HostTransport } from "../src/protocol/transport";
import type { FromMirror, MirrorQuestion, ToMirror } from "./mirror-worker";
import { AUTOSAVE_INTERVAL_MS } from "../src/save/config";
import { recordBudgetRow } from "../test/budget";

const SPEED = 4;
/** One hour of game time. */
const GAME_MS = 60 * 60 * 1000;
const TICKS = GAME_MS / TICK_MS;
/** A NoOp every this many ticks: 9,000 over the run, past the live log limit. */
const NOOP_EVERY = 4;
/** A road command every this many ticks, 900 over the run, offset from the NoOps. */
const ROAD_EVERY = 40;
const ROAD_CYCLE = ["BuildRoad", "BuildRoadGrid", "UpgradeRoad", "BulldozeRoad", "Undo", "BulldozeRoad"] as const;
/** A zoning command every this many ticks, on ticks of their own between the road commands and the NoOps. */
const ZONE_EVERY = 40;
const ZONE_OFFSET = 30;
const ZONE_CYCLE = ["ZoneCells", "ZoneCells", "BulldozeBuilding"] as const;
const ZONES = ZONING_BALANCE.zones.map((z) => z.id);
/** Buildings one BulldozeBuilding of the soak names. */
const CLEAR_COUNT = 50;
/** The player the zoning cycle sends as, apart from the road cycle's, so the road cycle's Undo takes back a road change. */
const ZONING_PLAYER = "soak-zoning";
/** Grid lines of the scale city and of a grid at the cap: 7 lines each way, 96 m apart. */
const LINE = 96;
const SPAN = 6 * LINE;
/** Memory is sampled once a game minute. */
const SAMPLE_EVERY = (60 * 1000) / TICK_MS;
/**
 * Tick budget from M0.md: 20 ms of worker time. It and how many steps of
 * each source may pass it are in the sim's balance/budgets.json, as the
 * `soak.*` figures (issue #232), which share this one step time
 * (budgets.test.ts holds them to that).
 *
 * A source may pass it a couple of times in a run: random pauses of the
 * runner. Runs on CI and on a slower machine met up to two in a source, and
 * most met none. Each autosave allocates a snapshot of about 13 MB, so a
 * collection of the old generation tends to land in one of its parts rather
 * than in a step: runs met up to two such parts in 28 saves, and autosaves
 * are allowed three. The bench holds the mean of each part to the budget.
 */
const BUDGET_MS = budgetFigure("soak.command-steps").overMs ?? 0;
/** A step whose cells system took longer than this walked a slice; an idle one takes microseconds. */
const SETTLE_MIN_MS = 0.25;
/** A grower step slower than this is listed in the report with the collections that paused it (issue 166). Not checked. */
const GROWER_SLOW_MS = 5;
const REPORT = process.env["SOAK_REPORT"] ?? "soak-report.json";

/**
 * The mirror-worker bundled for Node, so a worker thread can run it:
 * mirror-worker.ts imports the sim and the client from their TypeScript
 * sources, which Node cannot load on its own.
 */
async function bundleMirrorWorker(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "soak-mirror-"));
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      ssr: fileURLToPath(new URL("./mirror-worker.ts", import.meta.url)),
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "mirror-worker.mjs" } },
    },
    ssr: { noExternal: true },
  });
  return join(outDir, "mirror-worker.mjs");
}

/**
 * The host's transport to a page in a worker thread of its own, as in the
 * browser, where the sim and the page do not share a heap (mirror-worker.ts).
 * Messages to the page are kept for the timings and posted to it, copied
 * as a worker port copies them. `ask` puts a question to the page and
 * resolves once the page has taken in every message sent before it.
 */
function pageInWorker(file: string): {
  transport: HostTransport;
  inject(message: unknown): void;
  ask<T>(question: MirrorQuestion): Promise<T>;
  received: FromSimMessage[];
  stop(): Promise<number>;
} {
  const worker = new Worker(file);
  let handler: ((message: unknown) => void) | null = null;
  const received: FromSimMessage[] = [];
  const waiting = new Map<number, (answer: unknown) => void>();
  let asked = 0;
  worker.on("message", (data: FromMirror) => {
    if (data.kind === "send") handler?.(data.message);
    else {
      waiting.get(data.id)?.(data.answer);
      waiting.delete(data.id);
    }
  });
  const post = (data: ToMirror) => worker.postMessage(data);
  return {
    transport: {
      send: (message) => {
        received.push(message);
        post({ kind: "message", message });
      },
      onMessage: (h) => {
        handler = h;
        return () => (handler = null);
      },
    },
    inject: (message) => handler?.(message),
    ask: <T>(question: MirrorQuestion) =>
      new Promise<T>((resolve) => {
        const id = ++asked;
        waiting.set(id, resolve as (answer: unknown) => void);
        post({ kind: "ask", id, question });
      }),
    received,
    stop: () => worker.terminate(),
  };
}

function finishSave(save: PendingSave): Uint8Array {
  for (;;) {
    const part = save.steps.next();
    if (part.done) return part.value;
  }
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/**
 * Puts the budget checks in the GitHub job summary, when there is one, so a
 * failed run says which source went over without opening the log.
 */
function writeSummary(checks: readonly BudgetCheck[], over: number, steps: number): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (!file) return;
  const rows = checks.map(
    (c) => `| ${c.pass ? "pass" : "**over**"} | ${c.name} | ${c.overBudget} of ${c.steps} | ${c.allowed} | ${ms(c.medianMs)} | ${ms(c.maxMs)} |`,
  );
  const lines = [
    `### Soak: the ${BUDGET_MS} ms tick budget${process.env["BUDGET_ATTEMPT"] ? `, attempt ${process.env["BUDGET_ATTEMPT"]}` : ""}`,
    "",
    "| | Source | Over the budget | Allowed | Median ms | Max ms |",
    "|---|---|---:|---:|---:|---:|",
    ...rows,
    "",
    `${over} of ${steps} steps passed the budget in all. A source that passes it once or twice met a pause on the runner; one that passes it more often is slow every time it runs.`,
    "",
  ];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

/** One source of work held to the tick budget. */
interface BudgetCheck {
  /** The figure in budgets.json. */
  figure: string;
  name: string;
  steps: number;
  overBudget: number;
  allowed: number;
  medianMs: number;
  maxMs: number;
  pass: boolean;
  /** Whether a miss fails the soak, or only shows in the table. */
  mode: "blocks" | "reports";
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const ms = (value: number): number => Math.round(value * 1000) / 1000;

/** What the hour leaves for the two tests to judge. */
interface SoakRun {
  /** The live city, the replay of its log, and the page's copy, each hashed. */
  hashes: {
    replay: string;
    live: string;
    tick: number;
    endTick: number;
    logEntries: number;
    page: { roads: string; cells: string; buildings: string; homes: number | null } | null;
    roads: string;
    cells: string;
    buildings: string;
    /** A save written in parts gave the same bytes as one written at once. */
    savePartsMatch: boolean;
    homesMismatches: number;
    homes: number;
  };
  budgets: {
    checks: BudgetCheck[];
    autosaves: number;
    settleSteps: number;
    applied: Record<string, number>;
    mostBuildings: number;
  };
}

/** Runs a full GC first when node was started with --expose-gc. */
function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return memoryUsage().heapUsed;
}

async function soakHour(): Promise<SoakRun> {
  const page = pageInWorker(await bundleMirrorWorker());
  let offset = 0;
  let pumpStart = 0;
  let paced = false;
  const clock = (): number => {
    if (!paced) {
      paced = true;
      return offset;
    }
    return offset + (performance.now() - pumpStart);
  };
  const { transport, inject, ask, received } = page;
  // Every demand bar held at 100 (M3-07): the scale city has no residents,
  // so with its own bars only houses would grow, at the pull from outside,
  // and the soak would measure an idle grower. Held, every zone grows at
  // its full rate, the busiest demand can ask for. The replay at the end
  // runs in this thread, so it is held the same way.
  holdDemandBars(100);
  const scale = buildScaleCity();
  // The generator lays its grids faster than any player, and leaves a walk
  // of about 4,200 ticks of zoning cells behind. The hour starts once that
  // has settled, as a player's city would be: strokes sent into a walk that
  // long wait for it (M2 review, #147), and the backlog would measure the
  // generator, not play. No command is sent meanwhile, so a replay of the
  // log from the seed steps through the same ticks.
  while (!cellsSettled(scale.state)) step(scale.state);
  const startTick = scale.state.tick;
  const SEED = scale.state.seed;
  const host = new SimHost(scale.state, transport, clock);
  // The page asks for a snapshot as it starts; wait until it has one.
  let ready = false;
  for (let k = 0; k < 1000 && !ready; k++) {
    ready = await ask<boolean>({ q: "ready" });
    if (!ready) await new Promise((r) => setTimeout(r, 10));
  }
  if (!ready) throw new Error("the page never had its snapshot");

  let seq = 0;
  const command = (type: string, payload: unknown = {}, playerId = "soak"): void =>
    inject({ v: PROTOCOL_VERSION, type: "command", command: { seq: ++seq, playerId, type, payload } });

  command("SetSpeed", { speed: SPEED });

  /** The road command for the `n`th road slot, from the cycle, at a grid of the scale city. */
  const roadCommand = async (n: number): Promise<[type: string, payload: unknown] | null> => {
    const type = ROAD_CYCLE[n % ROAD_CYCLE.length] ?? "Undo";
    /** How many times round the cycle. */
    const round = Math.floor(n / ROAD_CYCLE.length);
    const g = scale.grids[(round * 7) % scale.grids.length] ?? { x: 0, z: 0 };
    switch (type) {
      case "BuildRoad": {
        // A quarter of the way into a row of blocks, clear of the scale
        // city's avenues along the middles, across three of its streets.
        const z = g.z + LINE * (round % 6) + 24;
        return [type, { from: { x: g.x - 24, z }, to: { x: g.x + 3 * LINE + 24, z }, type: "street" }];
      }
      case "BuildRoadGrid": {
        // Near the cap over the city's streets (issue 88): 5 by 6 lines, each
        // of the 49 sections splitting one street, 343 of the 360 allowed.
        const o = { x: g.x + 72, z: g.z + 72 };
        return [type, { origin: o, along: { x: o.x + 4 * LINE, z: o.z }, across: { x: o.x, z: o.z + 5 * LINE }, depth: 86, width: 86, type: "street" }];
      }
      case "UpgradeRoad":
      case "BulldozeRoad": {
        // As the page shows the segment now: the sim refuses an edit of one that changed since (issue 94).
        const picked = await ask<{ seg: number; ends: number[][]; types: string[] } | null>({ q: "segment", from: (n * 7919) % SCALE_SEGMENTS });
        if (!picked) return null;
        const seen = { ends: picked.ends, types: picked.types };
        return type === "UpgradeRoad" ? [type, { segments: [picked.seg], ...seen, type: "avenue" }] : [type, { segments: [picked.seg], ...seen }];
      }
      default:
        return [type, {}];
    }
  };
  /** The zoning command for the `n`th zoning slot: paint a grid and the ground round it, rezone half of it, or clear buildings. */
  const zoneCommand = async (n: number): Promise<[type: string, payload: unknown] | null> => {
    const type = ZONE_CYCLE[n % ZONE_CYCLE.length] ?? "ZoneCells";
    const round = Math.floor(n / ZONE_CYCLE.length);
    const g = scale.grids[(round * 13) % scale.grids.length] ?? { x: 0, z: 0 };
    const side = ZONING_BALANCE.maxRectSide;
    const perRow = Math.ceil(Math.sqrt(ZONING_BALANCE.maxRectsPerCommand));
    /** Rectangles of the largest size, side by side in a square centred on the grid: as many as one command takes, or half. */
    const square = (count: number) =>
      Array.from({ length: count }, (_, k) => {
        const x = g.x + SPAN / 2 - (perRow / 2) * side + (k % perRow) * side;
        const z = g.z + SPAN / 2 - (perRow / 2) * side + Math.floor(k / perRow) * side + side / 2;
        return { from: { x, z }, to: { x: x + side, z }, width: side };
      });
    if (type === "BulldozeBuilding") {
      const buildings = await ask<{ id: number; segment: number; side: number; place: number }[]>({ q: "buildings", seed: n * 104_729, count: CLEAR_COUNT });
      return buildings.length > 0 ? [type, { buildings }] : null;
    }
    if (n % ZONE_CYCLE.length === 0) {
      return [type, { zone: ZONES[round % ZONES.length], density: 1 + (round % 3), rects: square(ZONING_BALANCE.maxRectsPerCommand) }];
    }
    // The rezone: half the same ground, to the next zone at another density.
    return [type, { zone: ZONES[(round + 1) % ZONES.length], density: 1 + ((round + 1) % 3), rects: square(ZONING_BALANCE.maxRectsPerCommand / 2) }];
  };
  /** Step times of the steps that applied each road and zoning command type, and how many each sent and applied. */
  const byCommand: Record<string, { sent: number; applied: number; ms: number[] }> = {};
  for (const type of [...ROAD_CYCLE, ...ZONE_CYCLE]) byCommand[type] ??= { sent: 0, applied: 0, ms: [] };
  let roadSlot = 0;
  let lastRoadTick = -1;
  let zoneSlot = 0;
  let lastZoneTick = -1;
  /** The command waiting for its step: its type and the log length before it. */
  let waitingRoad: { type: string; logBefore: number } | null = null;
  /** Every step over the budget: its tick, what it applied, and each system's time, to say where the time went. */
  const slowSteps: { tick: number; command: string | null; ms: Record<string, number>; gc?: string[] }[] = [];
  /**
   * Every garbage collection on this thread, which hosts the sim, and the
   * pump each slow step ran in, so the report says which slow steps a
   * collection paused (issue 166). The page's collections run in its own
   * worker and pause no step.
   */
  const collections: { start: number; ms: number; kind: string }[] = [];
  const GC_KINDS: Record<number, string> = {
    [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
    [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
    [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weak callbacks",
  };
  const takeCollections = (list: { getEntries(): readonly { startTime: number; duration: number; detail?: unknown }[] }) => {
    for (const e of list.getEntries()) {
      const kind = (e.detail as { kind?: number } | undefined)?.kind ?? 0;
      collections.push({ start: e.startTime, ms: e.duration, kind: GC_KINDS[kind] ?? "other" });
    }
  };
  const gcObserver = new PerformanceObserver(takeCollections);
  gcObserver.observe({ entryTypes: ["gc"] });
  const slowPumps: { tick: number; growerMs: number; start: number; end: number; step?: (typeof slowSteps)[number] }[] = [];
  /** The grower's time in each step it ran in. */
  const growerMs: number[] = [];
  /**
   * Sampled with the heap: buildings standing, and the top bar's homes
   * counter (M2-18), which the mirror keeps from the deltas, beside the
   * homes counted afresh from the mirror's rows.
   */
  const buildingsOverTime: { tick: number; buildings: number; homes: number }[] = [];
  let homesMismatches = 0;

  const stepMs = new Float64Array(TICKS);
  let steps = 0;
  /** Steps that applied no road command, by whether they walked a slice of zoning cells. */
  const settleMs: number[] = [];
  const idleMs: number[] = [];
  const heap: { tick: number; mb: number }[] = [];
  /** Per autosave, the time of each part: the copy, then each step of writing it. */
  const snapshotParts: number[][] = [];
  let snapshotBytes = 0;
  let pagesStored = 0;
  let lastSnapshotAt = 0;
  let lastNoOpTick = -1;
  const heapStart = heapUsed();
  const wallStart = performance.now();

  while (host.tick < startTick + TICKS) {
    const tick = host.tick;
    if (tick % NOOP_EVERY === 0 && tick !== lastNoOpTick) {
      command("NoOp", { note: `soak ${tick}` });
      lastNoOpTick = tick;
    }
    if (tick % ROAD_EVERY === ROAD_EVERY / 2 && tick !== lastRoadTick) {
      lastRoadTick = tick;
      const road = await roadCommand(roadSlot++);
      if (road) {
        const stats = byCommand[road[0]];
        if (stats) stats.sent++;
        waitingRoad = { type: road[0], logBefore: host.fullLog.length };
        command(road[0], road[1]);
      }
    }
    if (tick % ZONE_EVERY === ZONE_OFFSET && tick !== lastZoneTick) {
      lastZoneTick = tick;
      const zoning = await zoneCommand(zoneSlot++);
      if (zoning) {
        const stats = byCommand[zoning[0]];
        if (stats) stats.sent++;
        waitingRoad = { type: zoning[0], logBefore: host.fullLog.length };
        // As a player of its own: Undo takes back its sender's newest change, and a
        // ZoneCells leaves one, so on the road cycle's player the Undo would take back zoning.
        command(zoning[0], zoning[1], ZONING_PLAYER);
      }
    }
    offset += PUMP_INTERVAL_MS;
    const before = received.length;
    pumpStart = performance.now();
    paced = false;
    host.pump();
    const pumpEnd = performance.now();
    // Each delta reports the timings of the last step it covers. Sum them to
    // get that step's time. At 4x a pump of 10 ms runs zero or one step.
    for (let i = before; i < received.length; i++) {
      const message = received[i];
      if (message?.type !== "delta" || message.steps === 0) continue;
      let total = 0;
      let grower = 0;
      for (const timing of message.timings) {
        total += timing.ms;
        if (timing.system === GROWER_SYSTEM) {
          growerMs.push(timing.ms);
          grower += timing.ms;
        }
      }
      if (steps < stepMs.length) stepMs[steps++] = total;
      // The first step after a road command was sent applies it, or drops
      // it when an earlier command that tick made it invalid.
      let applied = false;
      const waitingType = waitingRoad?.type;
      if (waitingRoad) {
        const stats = byCommand[waitingRoad.type];
        applied = host.fullLog.slice(waitingRoad.logBefore).some((e) => e.type === waitingRoad?.type);
        if (stats && applied) {
          stats.applied++;
          stats.ms.push(total);
        }
        waitingRoad = null;
      }
      if (total > BUDGET_MS) {
        const bySystem: Record<string, number> = {};
        for (const timing of message.timings) bySystem[timing.system] = ms((bySystem[timing.system] ?? 0) + timing.ms);
        slowSteps.push({ tick: host.tick, command: applied ? (waitingType ?? null) : null, ms: bySystem });
      }
      if (total > BUDGET_MS || grower > GROWER_SLOW_MS) {
        const slow = total > BUDGET_MS ? slowSteps.at(-1) : undefined;
        slowPumps.push({ tick: host.tick, growerMs: grower, start: pumpStart, end: pumpEnd, ...(slow ? { step: slow } : {}) });
      }
      if (!applied) {
        const settling = message.timings.some((t) => t.system === CELLS_SYSTEM && t.ms > SETTLE_MIN_MS);
        (settling ? settleMs : idleMs).push(total);
      }
    }
    received.length = 0;
    if (offset - lastSnapshotAt >= AUTOSAVE_INTERVAL_MS) {
      lastSnapshotAt = offset;
      // What an autosave does: the live part of the log only, from a copy
      // taken now, written a part at a time. The saver leaves a pump
      // between parts, so each part holds the sim up on its own; here they
      // run back to back and are timed one by one. Pages are counted as
      // stored, as they are after the first save that has them.
      let t0 = performance.now();
      const save = host.startSave(pagesStored);
      const parts = [performance.now() - t0];
      for (;;) {
        t0 = performance.now();
        const part = save.steps.next();
        parts.push(performance.now() - t0);
        if (!part.done) continue;
        snapshotBytes = part.value.byteLength;
        break;
      }
      snapshotParts.push(parts);
      pagesStored = save.pageCount;
      // Stored, as the saver does once IndexedDB has the bytes: the next save may write into the same buffers (issue #158).
      save.release();
    }
    if (host.tick % SAMPLE_EVERY === 0 && heap.at(-1)?.tick !== host.tick) {
      heap.push({ tick: host.tick, mb: mb(memoryUsage().heapUsed) });
      const sample = await ask<{ homes: number; counted: number; buildings: number } | null>({ q: "homes" });
      if (sample) {
        if (sample.homes !== sample.counted) homesMismatches++;
        buildingsOverTime.push({ tick: host.tick, buildings: sample.buildings, homes: sample.homes });
      }
    }
  }
  const wallMs = performance.now() - wallStart;
  takeCollections({ getEntries: () => gcObserver.takeRecords() });
  gcObserver.disconnect();
  /** The collections that ran during a pump, as "major 7.1 ms": the step's, or the delta's sent after it in the same pump. */
  const pausedBy = (p: { start: number; end: number }): string[] =>
    collections.filter((c) => c.start < p.end && c.start + c.ms > p.start).map((c) => `${c.kind} ${ms(c.ms)} ms`);
  for (const p of slowPumps) if (p.step) p.step.gc = pausedBy(p);
  const fileStart = performance.now();
  const fileBytes = host.snapshotBytes().byteLength;
  const fileMs = performance.now() - fileStart;
  const heapEnd = heapUsed();

  // The live city and a replay of its full log from the seed must agree.
  const live = deserialize(host.snapshotBytes());
  const replayed = replay(SEED, host.fullLog, host.tick);
  const pageHashes = await ask<{ roads: string; cells: string; buildings: string; homes: number | null } | null>({ q: "hashes" });
  await page.stop();

  const sorted = stepMs.slice(0, steps).sort();
  const over = sorted.filter((t) => t > BUDGET_MS).length;
  const ascending = (times: readonly number[]) => Float64Array.from(times).sort();
  const overOf = (times: ArrayLike<number>) => Array.from(times).filter((t) => t > BUDGET_MS).length;
  const commandSteps = Object.fromEntries(
    Object.entries(byCommand).map(([type, c]) => {
      const times = ascending(c.ms);
      return [
        type,
        {
          sent: c.sent,
          applied: c.applied,
          meanMs: ms(times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1)),
          p50Ms: ms(quantile(times, 0.5)),
          maxMs: ms(times.at(-1) ?? 0),
          overBudget: overOf(times),
        },
      ];
    }),
  );
  const settleSorted = ascending(settleMs);
  const idleSorted = ascending(idleMs);
  const snapshotTotals = snapshotParts.map((parts) => parts.reduce((a, b) => a + b, 0)).sort((x, y) => x - y);
  /** The slowest run of each part, the copy first. */
  const partMax = (snapshotParts[0] ?? []).map((_, i) => Math.max(...snapshotParts.map((parts) => parts[i] ?? 0)));
  const slowestPart = Math.max(0, ...partMax);
  /** Each autosave's slowest part, in order of size. */
  const saveSlowest = ascending(snapshotParts.map((parts) => Math.max(0, ...parts)));
  /** Each source: how many of its steps passed its figure's time, against how many may. Its row goes to the CI table. */
  const check = (figure: string, name: string, times: Float64Array): BudgetCheck => {
    const limit = budgetFigure(figure).overMs ?? 0;
    const overBudget = Array.from(times).filter((t) => t > limit).length;
    const row = judgeBudget(figure, name, overBudget);
    recordBudgetRow(row);
    return { figure, name, steps: times.length, overBudget, allowed: row.budget, medianMs: quantile(times, 0.5), maxMs: times.at(-1) ?? 0, pass: row.pass, mode: row.mode };
  };
  const checks: BudgetCheck[] = [
    ...Object.entries(byCommand).map(([type, c]) => check("soak.command-steps", `${type} steps`, ascending(c.ms))),
    check("soak.settle-steps", "zoning cell settle steps", settleSorted),
    check("soak.idle-steps", "idle steps", idleSorted),
    check("soak.autosave-parts", "autosaves' slowest parts", saveSlowest),
  ];
  // A save written in parts from a copy is the save written at once.
  // A save written in parts into the kept buffers is the save written at once.
  const lastSave = host.startSave(0);
  const savePartsMatch = Buffer.from(finishSave(lastSave)).equals(Buffer.from(host.saveBytes(0).bytes));
  lastSave.release();
  const report = {
    seed: SEED,
    startSegments: scale.counts.segments,
    endSegments: (() => {
      let n = 0;
      for (const f of live.state.roads.segFlags) if ((f & SEG_ALIVE) !== 0) n++;
      return n;
    })(),
    roadCommands: commandSteps,
    speed: SPEED,
    gameMinutes: GAME_MS / 60_000,
    ticks: host.tick,
    stepsTimed: steps,
    realMinutesAtSpeed: GAME_MS / SPEED / 60_000,
    wallSeconds: Math.round(wallMs / 100) / 10,
    logEntries: host.fullLog.length,
    stepMs: {
      mean: ms(sorted.reduce((a, b) => a + b, 0) / Math.max(steps, 1)),
      p50: ms(quantile(sorted, 0.5)),
      p99: ms(quantile(sorted, 0.99)),
      max: ms(sorted[sorted.length - 1] ?? 0),
      budget: BUDGET_MS,
      // Every step over the budget, whatever the cause. Not checked: see checks.
      overBudget: over,
    },
    grower: (() => {
      const times = ascending(growerMs);
      const most = buildingsOverTime.reduce((a, b) => Math.max(a, b.buildings), 0);
      return {
        steps: times.length,
        p50Ms: ms(quantile(times, 0.5)),
        p99Ms: ms(quantile(times, 0.99)),
        maxMs: ms(times.at(-1) ?? 0),
        buildingsAtEnd: buildingCount(live.state.buildings),
        mostBuildings: most,
        homesAtEnd: pageHashes?.homes ?? null,
        mostHomes: buildingsOverTime.reduce((a, b) => Math.max(a, b.homes), 0),
        homesMismatches,
        // Each grower step over GROWER_SLOW_MS and the collections that ran in its pump.
        slowSteps: slowPumps.filter((p) => p.growerMs > GROWER_SLOW_MS).map((p) => ({ tick: p.tick, ms: ms(p.growerMs), gc: pausedBy(p) })),
        // One sample every ten game minutes, for the shape of the growth.
        buildingsOverTime: buildingsOverTime.filter((_, i) => i % 10 === 0),
      };
    })(),
    settleSteps: { count: settleSorted.length, p50: ms(quantile(settleSorted, 0.5)), p95: ms(quantile(settleSorted, 0.95)), max: ms(settleSorted.at(-1) ?? 0), overBudget: overOf(settleSorted) },
    idleSteps: { count: idleSorted.length, p99: ms(quantile(idleSorted, 0.99)), max: ms(idleSorted.at(-1) ?? 0), overBudget: overOf(idleSorted) },
    slowSteps,
    // Collections on the thread that hosts the sim. A major one pauses whichever step is running.
    gc: (() => {
      const majors = collections.filter((c) => c.kind === "major").map((c) => c.ms).sort((x, y) => x - y);
      return { minor: collections.filter((c) => c.kind === "minor").length, major: majors.length, other: collections.length - majors.length - collections.filter((c) => c.kind === "minor").length, majorMedianMs: ms(quantile(Float64Array.from(majors), 0.5)), majorMaxMs: ms(majors.at(-1) ?? 0) };
    })(),
    checks: checks.map((c) => ({ ...c, medianMs: ms(c.medianMs), maxMs: ms(c.maxMs) })),
    snapshot: {
      count: snapshotParts.length,
      bytes: snapshotBytes,
      // One autosave: the copy and every part of writing it, added up.
      medianMs: ms(snapshotTotals[Math.floor(snapshotTotals.length / 2)] ?? 0),
      maxMs: ms(snapshotTotals.at(-1) ?? 0),
      // The longest the sim waits on a save: the slowest single part.
      partMaxMs: partMax.map(ms),
      slowestPartMs: ms(slowestPart),
      medianSlowestPartMs: ms(quantile(saveSlowest, 0.5)),
      budget: BUDGET_MS,
      // A city file still carries the whole log. Written on download only.
      cityFileBytes: fileBytes,
      cityFileMs: ms(fileMs),
    },
    heapMb: {
      start: mb(heapStart),
      end: mb(heapEnd),
      peakSampled: Math.max(...heap.map((h) => h.mb)),
      gcBeforeReading: typeof (globalThis as { gc?: unknown }).gc === "function",
    },
    stateHash: hashState(live.state),
  };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`soak report (also in ${REPORT}):\n${JSON.stringify(report, null, 2)}`);
  writeSummary(checks, over, steps);
  return {
    hashes: {
      replay: hashState(replayed),
      // A command still waiting for the cells to settle (M2 review, #147) is
      // in the live queue and not yet in the log, so the queue is left out.
      live: hashState({ ...live.state, pending: [] }),
      tick: host.tick,
      endTick: startTick + TICKS,
      logEntries: host.fullLog.length,
      page: pageHashes,
      roads: hashState(live.state.roads),
      cells: hashState(live.state.cells),
      buildings: hashState(live.state.buildings),
      savePartsMatch,
      homesMismatches,
      homes: countHomes(live.state.buildings).count,
    },
    budgets: {
      checks,
      autosaves: snapshotParts.length,
      settleSteps: settleSorted.length,
      applied: Object.fromEntries(Object.entries(byCommand).map(([type, c]) => [type, c.applied])),
      mostBuildings: report.grower.mostBuildings,
    },
  };
}

describe("soak: one hour of game time at 4x", () => {
  let run: SoakRun;
  beforeAll(async () => {
    run = await soakHour();
  }, 600_000);

  test("the replay and the page agree with the live city", () => {
    const h = run.hashes;
    expect(h.replay, "the replay of the full log from the seed").toBe(h.live);
    expect(h.tick).toBe(h.endTick);
    expect(h.logEntries).toBeGreaterThan(LOG_LIVE_LIMIT);
    // The page kept up with every road, cell and building change.
    expect(h.page?.roads, "the page's roads").toBe(h.roads);
    expect(h.page?.cells, "the page's cells").toBe(h.cells);
    expect(h.page?.buildings, "the page's buildings").toBe(h.buildings);
    // A save written in parts into the kept buffers is the save written at once.
    expect(h.savePartsMatch, "a save in parts, against one at once").toBe(true);
    // The top bar's homes counter, kept from the deltas, never strayed from a count from scratch, and ends on the live city's.
    expect(h.homesMismatches, "samples where the homes counter strayed").toBe(0);
    expect(h.page?.homes, "the page's homes").toBe(h.homes);
  });

  test(`every source inside the ${BUDGET_MS} ms tick budget`, () => {
    const b = run.budgets;
    // Enough of each source ran for its count over the budget to mean
    // something. These are the same every run, so they carry no `[budget]`
    // mark and a miss is not run again.
    expect(b.autosaves, "autosaves taken").toBeGreaterThan(20);
    expect(b.settleSteps, "steps that walked a slice of zoning cells").toBeGreaterThan(20);
    for (const [type, applied] of Object.entries(b.applied)) expect(applied, `${type} applied`).toBeGreaterThan(20);
    // The grower built a town on the zoning, and the clearing took some of it away again.
    // Since M3-07 its pace follows demand: with every bar at 100 the zones add
    // about 50 buildings a game day together, against up to 1,000 at the M2
    // pace, and the hour's 360 game days grew about 2,800 (10,000 before).
    expect(b.mostBuildings, "buildings grown").toBeGreaterThan(2_000);
    // The tick budget is an exit number. A part of an autosave runs in the
    // worker between two steps, so it holds up the next one and gets the
    // same budget as a step (issue #83).
    const failed = b.checks.filter((c) => !c.pass && c.mode === "blocks");
    expect(
      failed.map((c) => `${c.name}: ${c.overBudget} of ${c.steps} over, ${c.allowed} allowed, max ${ms(c.maxMs)} ms`),
      `[budget] sources that passed the ${BUDGET_MS} ms tick budget more often than a runner's pauses explain`,
    ).toEqual([]);
  });
});
