import {
  LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  TICK_MS,
  drainRoadChanges,
  encodeRoadDelta,
  logLength,
  mergeRoadChanges,
  parseToSimMessage,
  prepareDerived,
  readLog,
  recordRoadChanges,
  captureState,
  serialize,
  serializeDetached,
  serializeDetachedSteps,
  serializeSteps,
  step,
  submit,
  type FromSimMessage,
  type LogEntry,
  type SnapshotSteps,
  type RoadChanges,
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
  private readonly playerId: string | null;
  /** Absolute log index up to which entries have been read out of state. */
  private logCursor: number;
  /**
   * The whole activity log, oldest first: entries a loaded save carried plus
   * every entry read out of live state since. Live state pages out old
   * entries, so this is the host's full record for saves.
   */
  readonly fullLog: LogEntry[];
  /** Entries read since the last delta. */
  private unsent: LogEntry[] = [];
  /** Road ids changed since the last delta. */
  private unsentRoads: RoadChanges | null = null;
  /** `seq` of the next delta. */
  private deltaSeq = 0;
  private sentTick: number;
  private sentSpeed: number;
  /** The undo history the last delta or snapshot reflected. The sim replaces it on every change. */
  private sentUndo: SimState["undo"];
  private sentLogFrom: number;
  private stepsSinceDelta = 0;
  private lastTimings: SystemTiming[] = [];
  /** Real time not yet turned into steps. */
  private owedMs = 0;
  private lastPump: number;

  /**
   * `pagedLog` is the entries that have left live state, as a loaded save
   * gives them; a new city has none.
   *
   * `playerId` is who is on the other end of `transport`. The host knows
   * that from the connection, so it stamps the id on every command and
   * ignores the one the message claims: otherwise a client could send
   * commands in another player's name. Null trusts the message, which is
   * only for tests that play several players over one transport. A host
   * with more than one connection must stamp each connection's own id.
   */
  constructor(
    state: SimState,
    transport: HostTransport,
    now: Clock,
    pagedLog: readonly LogEntry[] = [],
    playerId: string | null = null,
  ) {
    if (pagedLog.length !== state.logOffset) {
      throw new RangeError(`pagedLog has ${pagedLog.length} entries but ${state.logOffset} have left live state`);
    }
    this.state = state;
    prepareDerived(state);
    // From here on every road change is recorded. Earlier ones reach a
    // client in the snapshot it asks for first.
    recordRoadChanges(state.roads);
    this.fullLog = [...pagedLog, ...state.log];
    this.transport = transport;
    this.now = now;
    this.playerId = playerId;
    this.logCursor = logLength(state);
    this.sentTick = state.tick;
    this.sentSpeed = state.speed;
    this.sentUndo = state.undo;
    this.sentLogFrom = this.logCursor;
    this.lastPump = now();
    transport.onMessage((raw) => this.receive(raw));
  }

  /** Current tick, for tests and the worker's own checks. */
  get tick(): number {
    return this.state.tick;
  }

  /** Seed of the hosted city. */
  get seed(): number {
    return this.state.seed;
  }

  /**
   * The city as snapshot bytes with its whole log inside, for a city file.
   * Taken between steps, so it is always a whole tick. The cost grows with
   * the length of the log, so this is for a download, not for every save.
   */
  snapshotBytes(): Uint8Array {
    return serialize(this.state, this.fullLog.slice(0, this.state.logOffset));
  }

  /**
   * The city for a local save: snapshot bytes without the entries that have
   * left live state, and those entries as pages of `LOG_PAGE_SIZE`, from
   * page `pagesStored` on. The caller stores each page once, so a save
   * writes only the live part of the log however long the log is.
   * `pageCount` is how many pages the snapshot counts on in all.
   */
  saveBytes(pagesStored: number): LocalSave {
    // Live state pages entries out a whole page at a time, so this only
    // fails for a city that came from a file someone edited. Keep its log
    // inside the snapshot, as before.
    if (this.state.logOffset % LOG_PAGE_SIZE !== 0) return { bytes: this.snapshotBytes(), pages: [], pageCount: 0 };
    return { bytes: serializeDetached(this.state), ...this.logPages(pagesStored) };
  }

  /**
   * Starts the local save `saveBytes` makes, of the city as it is on this
   * tick, to be written a part at a time. Writing a large city at once
   * holds the next ticks up (issue #83), so a save taken while the city
   * runs is started here, for the cost of copying the typed arrays, and
   * each call of `steps.next()` after that does one part. The caller
   * leaves time for a pump between parts. The sim steps on meanwhile and
   * the save does not see it.
   */
  startSave(pagesStored: number): PendingSave {
    const state = captureState(this.state);
    const { logOffset } = state;
    if (logOffset % LOG_PAGE_SIZE !== 0) {
      return { steps: serializeSteps(state, this.fullLog.slice(0, logOffset)), pages: [], pageCount: 0 };
    }
    return { steps: serializeDetachedSteps(state), ...this.logPages(pagesStored) };
  }

  /** The pages of entries that have left live state, from page `pagesStored` on, and how many there are in all. */
  private logPages(pagesStored: number): { pages: LogPageEntries[]; pageCount: number } {
    const pageCount = this.state.logOffset / LOG_PAGE_SIZE;
    const pages: LogPageEntries[] = [];
    for (let index = pagesStored; index < pageCount; index++) {
      pages.push({ index, entries: this.fullLog.slice(index * LOG_PAGE_SIZE, (index + 1) * LOG_PAGE_SIZE) });
    }
    return { pages, pageCount };
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
        const command =
          this.playerId === null ? message.command : { ...message.command, playerId: this.playerId };
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
    this.unsentRoads = mergeRoadChanges(this.unsentRoads, drainRoadChanges(this.state.roads));
  }

  private flushDelta(): void {
    const changed =
      this.unsent.length > 0 ||
      this.unsentRoads !== null ||
      this.state.tick !== this.sentTick ||
      this.state.speed !== this.sentSpeed ||
      this.state.undo !== this.sentUndo;
    if (!changed) return;
    const undo = this.state.undo !== this.sentUndo ? structuredClone(this.state.undo) : undefined;
    const log = this.unsent;
    // Rows are read now, after every step since the last delta, so an id
    // removed and reused in between goes out once, as what it is now.
    const roads = this.unsentRoads ? encodeRoadDelta(this.state.roads, this.unsentRoads) : undefined;
    const delta: FromSimMessage = {
      v: PROTOCOL_VERSION,
      type: "delta",
      seq: this.deltaSeq,
      tick: this.state.tick,
      speed: this.state.speed,
      logFrom: this.sentLogFrom,
      log,
      ...(roads ? { roads } : {}),
      ...(undo ? { undo } : {}),
      steps: this.stepsSinceDelta,
      timings: this.lastTimings,
    };
    // The rows are fresh arrays, so a worker can move them.
    this.transport.send(delta, roads ? typedArrayBuffers(roads) : []);
    this.deltaSeq++;
    this.unsent = [];
    this.unsentRoads = null;
    this.sentTick = this.state.tick;
    this.sentSpeed = this.state.speed;
    this.sentUndo = this.state.undo;
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
      { v: PROTOCOL_VERSION, type: "snapshot", state, logFrom: this.logCursor, deltaSeq: this.deltaSeq },
      typedArrayBuffers(state),
    );
  }

  private send(message: FromSimMessage): void {
    this.transport.send(message);
  }
}

/** One page of entries that left live state together. */
export interface LogPageEntries {
  index: number;
  entries: LogEntry[];
}

/** What `SimHost.startSave` returns: a `LocalSave` whose bytes are still to be written. */
export interface PendingSave {
  /** Each `next()` writes one part. The last returns the bytes. */
  steps: SnapshotSteps;
  pages: LogPageEntries[];
  pageCount: number;
}

/** What `SimHost.saveBytes` returns. */
export interface LocalSave {
  bytes: Uint8Array;
  /** Pages the caller has not stored yet. */
  pages: LogPageEntries[];
  /** Pages the snapshot counts on being stored, 0 when its log is inside it. */
  pageCount: number;
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
