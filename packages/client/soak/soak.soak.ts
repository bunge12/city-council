// Soak run: hosts one city headless at 4x for one hour of game time and
// reports step time and memory. Run it with `pnpm soak`.
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
// autosave interval. At the end a replay of the full log from the seed must
// give the same state hash as the live city.

import { writeFileSync } from "node:fs";
import { memoryUsage } from "node:process";
import { performance } from "node:perf_hooks";
import {
  LOG_LIVE_LIMIT,
  PROTOCOL_VERSION,
  TICK_MS,
  createState,
  deserialize,
  hashState,
  replay,
  type FromSimMessage,
} from "@city-council/sim";
import { expect, test } from "vitest";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import type { HostTransport } from "../src/protocol/transport";
import { AUTOSAVE_INTERVAL_MS } from "../src/save/config";

const SEED = 1;
const SPEED = 4;
/** One hour of game time. */
const GAME_MS = 60 * 60 * 1000;
const TICKS = GAME_MS / TICK_MS;
/** A NoOp every this many ticks: 9,000 over the run, past the live log limit. */
const NOOP_EVERY = 4;
/** Memory is sampled once a game minute. */
const SAMPLE_EVERY = (60 * 1000) / TICK_MS;
/** Tick budget from M0.md: 20 ms of worker time. */
const BUDGET_MS = 20;
const REPORT = process.env["SOAK_REPORT"] ?? "soak-report.json";

/** A loopback transport: the soak plays the client. */
function loopback(): { transport: HostTransport; inject(message: unknown): void; received: FromSimMessage[] } {
  let handler: ((message: unknown) => void) | null = null;
  const received: FromSimMessage[] = [];
  return {
    transport: {
      send: (message) => void received.push(message),
      onMessage: (h) => {
        handler = h;
        return () => (handler = null);
      },
    },
    inject: (message) => handler?.(message),
    received,
  };
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
  const { transport, inject, received } = loopback();
  const host = new SimHost(createState(SEED), transport, clock);

  let seq = 0;
  const command = (type: string, payload: unknown = {}): void =>
    inject({ v: PROTOCOL_VERSION, type: "command", command: { seq: ++seq, playerId: "soak", type, payload } });

  command("SetSpeed", { speed: SPEED });

  const stepMs = new Float64Array(TICKS);
  let steps = 0;
  const heap: { tick: number; mb: number }[] = [];
  const snapshotMs: number[] = [];
  let snapshotBytes = 0;
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
    }
    received.length = 0;
    if (offset - lastSnapshotAt >= AUTOSAVE_INTERVAL_MS) {
      lastSnapshotAt = offset;
      const t0 = performance.now();
      snapshotBytes = host.snapshotBytes().byteLength;
      snapshotMs.push(performance.now() - t0);
    }
    if (host.tick % SAMPLE_EVERY === 0 && heap.at(-1)?.tick !== host.tick) {
      heap.push({ tick: host.tick, mb: mb(memoryUsage().heapUsed) });
    }
  }
  const wallMs = performance.now() - wallStart;
  const heapEnd = heapUsed();

  // The live city and a replay of its full log from the seed must agree.
  const live = deserialize(host.snapshotBytes());
  const replayed = replay(SEED, host.fullLog, host.tick);
  expect(hashState(replayed)).toBe(hashState(live.state));
  expect(host.tick).toBe(TICKS);
  expect(host.fullLog.length).toBeGreaterThan(LOG_LIVE_LIMIT);

  const sorted = stepMs.slice(0, steps).sort();
  const over = sorted.filter((t) => t > BUDGET_MS).length;
  const report = {
    seed: SEED,
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
      count: snapshotMs.length,
      bytes: snapshotBytes,
      maxMs: ms(Math.max(0, ...snapshotMs)),
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
});
