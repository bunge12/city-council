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
// autosave interval, in parts as the saver does, and fails if a part passes
// the tick budget. Every few seconds of game time it sends a road command
// in a fixed cycle: a street through a grid's blocks, a street grid at the
// cap over existing streets, an upgrade, a bulldoze and an undo. It picks
// the segments to upgrade and bulldoze from a SimMirror fed by the host's
// messages, as the page does, and times the step that applies each command
// on its own (issue M1-17). At the end a replay of the full log from the
// seed, the scale city's own commands included, must give the same state
// hash as the live city.

import { writeFileSync } from "node:fs";
import { memoryUsage } from "node:process";
import { performance } from "node:perf_hooks";
import {
  LOG_LIVE_LIMIT,
  PROTOCOL_VERSION,
  SCALE_SEGMENTS,
  SEG_ALIVE,
  SEG_FIXED,
  TICK_MS,
  buildScaleCity,
  deserialize,
  hashState,
  replay,
  type FromSimMessage,
} from "@city-council/sim";
import { expect, test } from "vitest";
import { PUMP_INTERVAL_MS, SimHost, type PendingSave } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import type { ClientTransport, HostTransport } from "../src/protocol/transport";
import { AUTOSAVE_INTERVAL_MS } from "../src/save/config";

const SPEED = 4;
/** One hour of game time. */
const GAME_MS = 60 * 60 * 1000;
const TICKS = GAME_MS / TICK_MS;
/** A NoOp every this many ticks: 9,000 over the run, past the live log limit. */
const NOOP_EVERY = 4;
/** A road command every this many ticks, 900 over the run, offset from the NoOps. */
const ROAD_EVERY = 40;
const ROAD_CYCLE = ["BuildRoad", "BuildRoadGrid", "UpgradeRoad", "BulldozeRoad", "Undo", "BulldozeRoad"] as const;
/** Grid lines of the scale city and of a grid at the cap: 7 lines each way, 96 m apart. */
const LINE = 96;
const SPAN = 6 * LINE;
/** Memory is sampled once a game minute. */
const SAMPLE_EVERY = (60 * 1000) / TICK_MS;
/** Tick budget from M0.md: 20 ms of worker time. */
const BUDGET_MS = 20;
const REPORT = process.env["SOAK_REPORT"] ?? "soak-report.json";

/**
 * A loopback transport: the soak plays the client. Messages to the client
 * are kept for the timings and handed, copied as a worker port would copy
 * them, to a mirror's transport.
 */
function loopback(): {
  transport: HostTransport;
  client: ClientTransport;
  inject(message: unknown): void;
  received: FromSimMessage[];
} {
  let handler: ((message: unknown) => void) | null = null;
  let clientHandler: ((message: FromSimMessage) => void) | null = null;
  const received: FromSimMessage[] = [];
  return {
    transport: {
      send: (message) => {
        received.push(message);
        clientHandler?.(structuredClone(message));
      },
      onMessage: (h) => {
        handler = h;
        return () => (handler = null);
      },
    },
    client: {
      send: (message) => handler?.(message),
      onMessage: (h) => {
        clientHandler = h;
        return () => (clientHandler = null);
      },
    },
    inject: (message) => handler?.(message),
    received,
  };
}

/** The `k`th live segment from `from` on, by id, that a player may change, read from the mirror's copy. */
function pickSegment(mirror: SimMirror, from: number): number | null {
  const roads = mirror.state?.roads;
  if (!roads) return null;
  const limit = roads.segFlags.length;
  for (let k = 0; k < limit; k++) {
    const id = (from + k) % limit;
    const flags = roads.segFlags[id] ?? 0;
    if ((flags & SEG_ALIVE) !== 0 && (flags & SEG_FIXED) === 0) return id;
  }
  return null;
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

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const ms = (value: number): number => Math.round(value * 1000) / 1000;

/** Runs a full GC first when node was started with --expose-gc. */
function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return memoryUsage().heapUsed;
}

test("soak: one hour of game time at 4x", () => {
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
  const { transport, client, inject, received } = loopback();
  const scale = buildScaleCity();
  const SEED = scale.state.seed;
  const host = new SimHost(scale.state, transport, clock);
  const mirror = new SimMirror(client, "soak");
  expect(mirror.state).not.toBeNull();

  let seq = 0;
  const command = (type: string, payload: unknown = {}): void =>
    inject({ v: PROTOCOL_VERSION, type: "command", command: { seq: ++seq, playerId: "soak", type, payload } });

  command("SetSpeed", { speed: SPEED });

  /** The road command for the `n`th road slot, from the cycle, at a grid of the scale city. */
  const roadCommand = (n: number): [type: string, payload: unknown] | null => {
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
        const o = { x: g.x + 72, z: g.z + 72 };
        return [type, { origin: o, along: { x: o.x + SPAN, z: o.z }, across: { x: o.x, z: o.z + SPAN }, depth: 86, width: 86, type: "street" }];
      }
      case "UpgradeRoad":
      case "BulldozeRoad": {
        const seg = pickSegment(mirror, (n * 7919) % SCALE_SEGMENTS);
        if (seg === null) return null;
        return type === "UpgradeRoad" ? [type, { segments: [seg], type: "avenue" }] : [type, { segments: [seg] }];
      }
      default:
        return [type, {}];
    }
  };
  /** Step times of the steps that applied each road command type, and how many each sent and applied. */
  const byCommand: Record<string, { sent: number; applied: number; ms: number[] }> = {};
  for (const type of ROAD_CYCLE) byCommand[type] ??= { sent: 0, applied: 0, ms: [] };
  let roadSlot = 0;
  let lastRoadTick = -1;
  /** The road command waiting for its step: its type and the log length before it. */
  let waitingRoad: { type: string; logBefore: number } | null = null;

  const stepMs = new Float64Array(TICKS);
  let steps = 0;
  const heap: { tick: number; mb: number }[] = [];
  /** Per autosave, the time of each part: the copy, then each step of writing it. */
  const snapshotParts: number[][] = [];
  let snapshotBytes = 0;
  let pagesStored = 0;
  let lastSnapshotAt = 0;
  let lastNoOpTick = -1;
  const heapStart = heapUsed();
  const wallStart = performance.now();

  while (host.tick < TICKS) {
    const tick = host.tick;
    if (tick % NOOP_EVERY === 0 && tick !== lastNoOpTick) {
      command("NoOp", { note: `soak ${tick}` });
      lastNoOpTick = tick;
    }
    if (tick % ROAD_EVERY === ROAD_EVERY / 2 && tick !== lastRoadTick) {
      lastRoadTick = tick;
      const road = roadCommand(roadSlot++);
      if (road) {
        const stats = byCommand[road[0]];
        if (stats) stats.sent++;
        waitingRoad = { type: road[0], logBefore: host.fullLog.length };
        command(road[0], road[1]);
      }
    }
    offset += PUMP_INTERVAL_MS;
    const before = received.length;
    pumpStart = performance.now();
    paced = false;
    host.pump();
    // Each delta reports the timings of the last step it covers. Sum them to
    // get that step's time. At 4x a pump of 10 ms runs zero or one step.
    for (let i = before; i < received.length; i++) {
      const message = received[i];
      if (message?.type !== "delta" || message.steps === 0) continue;
      let total = 0;
      for (const timing of message.timings) total += timing.ms;
      if (steps < stepMs.length) stepMs[steps++] = total;
      // The first step after a road command was sent applies it, or drops
      // it when an earlier command that tick made it invalid.
      if (waitingRoad) {
        const stats = byCommand[waitingRoad.type];
        const applied = host.fullLog.slice(waitingRoad.logBefore).some((e) => e.type === waitingRoad?.type);
        if (stats && applied) {
          stats.applied++;
          stats.ms.push(total);
        }
        waitingRoad = null;
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
    }
    if (host.tick % SAMPLE_EVERY === 0 && heap.at(-1)?.tick !== host.tick) {
      heap.push({ tick: host.tick, mb: mb(memoryUsage().heapUsed) });
    }
  }
  const wallMs = performance.now() - wallStart;
  const fileStart = performance.now();
  const fileBytes = host.snapshotBytes().byteLength;
  const fileMs = performance.now() - fileStart;
  const heapEnd = heapUsed();

  // The live city and a replay of its full log from the seed must agree.
  const live = deserialize(host.snapshotBytes());
  const replayed = replay(SEED, host.fullLog, host.tick);
  expect(hashState(replayed)).toBe(hashState(live.state));
  expect(host.tick).toBe(TICKS);
  expect(host.fullLog.length).toBeGreaterThan(LOG_LIVE_LIMIT);
  // The mirror kept up with every road change.
  expect(hashState(mirror.state?.roads)).toBe(hashState(live.state.roads));

  const sorted = stepMs.slice(0, steps).sort();
  const over = sorted.filter((t) => t > BUDGET_MS).length;
  const commandSteps = Object.fromEntries(
    Object.entries(byCommand).map(([type, c]) => {
      const times = c.ms.slice().sort((x, y) => x - y);
      return [
        type,
        {
          sent: c.sent,
          applied: c.applied,
          meanMs: ms(times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1)),
          p50Ms: ms(times[Math.floor(times.length / 2)] ?? 0),
          maxMs: ms(times.at(-1) ?? 0),
        },
      ];
    }),
  );
  const snapshotTotals = snapshotParts.map((parts) => parts.reduce((a, b) => a + b, 0)).sort((x, y) => x - y);
  /** The slowest run of each part, the copy first. */
  const partMax = (snapshotParts[0] ?? []).map((_, i) => Math.max(...snapshotParts.map((parts) => parts[i] ?? 0)));
  const slowestPart = Math.max(0, ...partMax);
  // A save written in parts from a copy is the save written at once.
  expect(Array.from(finishSave(host.startSave(0)))).toEqual(Array.from(host.saveBytes(0).bytes));
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
      overBudget: over,
    },
    snapshot: {
      count: snapshotParts.length,
      bytes: snapshotBytes,
      // One autosave: the copy and every part of writing it, added up.
      medianMs: ms(snapshotTotals[Math.floor(snapshotTotals.length / 2)] ?? 0),
      maxMs: ms(snapshotTotals.at(-1) ?? 0),
      // The longest the sim waits on a save: the slowest single part.
      partMaxMs: partMax.map(ms),
      slowestPartMs: ms(slowestPart),
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
  // The tick budget is an exit number, so the run fails when a step passes
  // it. Checked after the report is written, so a failure still leaves one.
  expect(over, `steps over the ${BUDGET_MS} ms tick budget`).toBe(0);
  // A part of an autosave runs in the worker between two steps, so it holds
  // up the next one. It gets the same budget as a step (issue #83).
  expect(snapshotParts.length, "autosaves taken").toBeGreaterThan(20);
  expect(slowestPart, `slowest part of an autosave against the ${BUDGET_MS} ms tick budget`).toBeLessThan(BUDGET_MS);
  // Every kind of road command applied often enough to be measured.
  for (const [type, c] of Object.entries(byCommand)) expect(c.applied, `${type} applied`).toBeGreaterThan(20);
});
