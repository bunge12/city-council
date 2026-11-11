import {
  PROTOCOL_VERSION,
  TICK_MS,
  logLength,
  parseToSimMessage,
  readLog,
  step,
  submit,
  type FromSimMessage,
  type LogEntry,
  type SimState,
  type SystemTimer,
  type SystemTiming,
  type ToSimMessage,
} from "@city-council/sim";
import type { HostTransport } from "./transport";

/**
 * Most steps one `pump` runs. After a stall, such as a background tab or a
 * debugger pause, the host catches up by at most this many steps and drops
 * the rest of the missed time, so the city does not lurch forward on return.
 */
export const MAX_CATCH_UP_STEPS = 8;

/** How often the worker calls `pump`, in real milliseconds. */
export const PUMP_INTERVAL_MS = 10;

/**
 * Real milliseconds between steps. At 1x one step per TICK_MS; faster speeds
 * divide that. While paused the host keeps stepping at the 1x rate so queued
 * commands, including the one that unpauses, still apply (see `step`).
 */
export function stepIntervalMs(speed: number): number {
  return TICK_MS / Math.max(speed, 1);
}

/** A clock in real milliseconds. Host code only; the sim never sees it. */
export type Clock = () => number;

/**
 * Hosts one city: answers messages, steps the sim from real time and sends
 * deltas. It runs inside the Web Worker today and is written against a
 * transport and a clock, so a server can host it the same way.
 */
export class SimHost {
  private readonly state: SimState;
  private readonly transport: HostTransport;
  private readonly now: Clock;
  /** Absolute log index up to which entries have been read out of state. */
  private logCursor: number;
  /**
   * Every entry read out of live state, in order. Live state pages out old
   * entries, so this is the host's full record for saves (issue 08).
   */
  readonly fullLog: LogEntry[] = [];
  /** Entries read since the last delta. */
  private unsent: LogEntry[] = [];
  private sentTick: number;
  private sentSpeed: number;
  private sentLogFrom: number;
  private stepsSinceDelta = 0;
  private lastTimings: SystemTiming[] = [];
  /** Real time not yet turned into steps. */
  private owedMs = 0;
  private lastPump: number;

  constructor(state: SimState, transport: HostTransport, now: Clock) {
    this.state = state;
    this.transport = transport;
    this.now = now;
    this.logCursor = logLength(state);
    this.sentTick = state.tick;
    this.sentSpeed = state.speed;
    this.sentLogFrom = this.logCursor;
    this.lastPump = now();
    transport.onMessage((raw) => this.receive(raw));
  }

  /** Current tick, for tests and the worker's own checks. */
  get tick(): number {
    return this.state.tick;
  }

  private receive(raw: unknown): void {
    const message = parseToSimMessage(raw);
    if (typeof message === "string") {
      // Nothing to answer with a seq; drop it. A socket host would log it.
      return;
    }
    this.handle(message);
  }

  private handle(message: ToSimMessage): void {
    switch (message.type) {
      case "command": {
        const { command } = message;
        this.send({
          v: PROTOCOL_VERSION,
          type: "commandResult",
          seq: command.seq,
          playerId: command.playerId,
          result: submit(this.state, command),
        });
        return;
      }
      case "requestSnapshot":
        this.sendSnapshot();
        return;
    }
  }

  /**
   * Steps the sim for the real time passed since the last pump, then sends
   * one delta if anything changed. Called on a timer by the worker, and
   * directly by tests with a fake clock.
   */
  pump(): void {
    const now = this.now();
    this.owedMs += now - this.lastPump;
    this.lastPump = now;
    let steps = 0;
    while (this.owedMs >= stepIntervalMs(this.state.speed)) {
      if (steps === MAX_CATCH_UP_STEPS) {
        this.owedMs = 0;
        break;
      }
      // Speed can change inside a step, so read the interval before it.
      this.owedMs -= stepIntervalMs(this.state.speed);
      this.stepOnce();
      steps++;
    }
    this.flushDelta();
  }

  private stepOnce(): void {
    const timings: SystemTiming[] = [];
    const starts = new Map<string, number>();
    const timer: SystemTimer = {
      start: (system) => void starts.set(system, this.now()),
      end: (system) => timings.push({ system, ms: this.now() - (starts.get(system) ?? 0) }),
    };
    step(this.state, timer);
    this.lastTimings = timings;
    this.stepsSinceDelta++;
    // Read after every step so no entry pages out of live state unread.
    const entries = readLog(this.state, this.logCursor);
    this.logCursor += entries.length;
    for (const entry of entries) {
      this.fullLog.push(entry);
      this.unsent.push(entry);
    }
  }

  private flushDelta(): void {
    const changed =
      this.unsent.length > 0 ||
      this.state.tick !== this.sentTick ||
      this.state.speed !== this.sentSpeed;
    if (!changed) return;
    const log = this.unsent;
    this.send({
      v: PROTOCOL_VERSION,
      type: "delta",
      tick: this.state.tick,
      speed: this.state.speed,
      logFrom: this.sentLogFrom,
      log,
      steps: this.stepsSinceDelta,
      timings: this.lastTimings,
    });
    this.unsent = [];
    this.sentTick = this.state.tick;
    this.sentSpeed = this.state.speed;
    this.sentLogFrom += log.length;
    this.stepsSinceDelta = 0;
  }

  private sendSnapshot(): void {
    // Anything stepped but unsent goes out first, so deltas and the snapshot
    // agree on where the log stands.
    this.flushDelta();
    // The worker keeps stepping its own state, so the snapshot is a copy.
    // The copy's buffers are then moved to the client rather than copied a
    // second time by postMessage.
    const state = structuredClone(this.state);
    this.transport.send(
      { v: PROTOCOL_VERSION, type: "snapshot", state, logFrom: this.logCursor },
      typedArrayBuffers(state),
    );
  }

  private send(message: FromSimMessage): void {
    this.transport.send(message);
  }
}

/** The distinct buffers behind every typed array in `value`. */
export function typedArrayBuffers(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
  } else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) typedArrayBuffers(child, found);
  }
  return [...found];
}
