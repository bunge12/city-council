import {
  LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  TICK_MS,
  drainBuildingDelta,
  drainCellDelta,
  drainPopDelta,
  drainRoadChanges,
  encodeRoadDelta,
  encodeStatsDelta,
  logLength,
  mergeRoadChanges,
  parseToSimMessage,
  prepareDerived,
  readLog,
  readLogSpent,
  recordBuildingChanges,
  recordCellChanges,
  recordPopChanges,
  recordRoadChanges,
  captureState,
  createCaptureBuffers,
  diffUndo,
  serialize,
  serializeDetached,
  serializeDetachedSteps,
  serializeSteps,
  step,
  submit,
  type DroppedCommand,
  type FromSimMessage,
  type LogEntry,
  type SnapshotBuffer,
  type SnapshotSteps,
  type RoadChanges,
  type SimState,
  type StatTotals,
  type BudgetState,
  sameBudget,
  sameMilestones,
  type SystemTimer,
  type SystemTiming,
  type ToSimMessage,
  type UndoDelta,
  type UndoRecord,
  copyBudget,
  copyDemand,
} from "@city-council/sim";
import type { HostTransport } from "./transport";

/** How the history went from `sent` to `now`, with the new records copied out of state. */
function undoDelta(sent: readonly UndoRecord[], now: readonly UndoRecord[]): UndoDelta {
  const { kept, added } = diffUndo(sent, now);
  return { kept, added: structuredClone(added) };
}

/**
 * Most steps one `pump` runs. After a stall, such as a background tab or a
 * debugger pause, the host catches up by at most this many steps and drops
 * the rest of the missed time, so the city does not lurch forward on return.
 */
export const MAX_CATCH_UP_STEPS = 8;

/**
 * Most deltas out at once, sent and not yet taken by the client. Two, not
 * one, so a client that never got a delta still gets the next, sees the gap
 * in the numbers and asks for a snapshot.
 */
export const MAX_DELTAS_OUT = 2;

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
  /** The money each of `unsent` moved, one per entry (M4-03). */
  private unsentSpent: number[] = [];
  /** Commands the steps since the last delta dropped. */
  private unsentDropped: DroppedCommand[] = [];
  /** Road ids changed since the last delta. */
  private unsentRoads: RoadChanges | null = null;
  /** `seq` of the next delta. */
  private deltaSeq = 0;
  /**
   * `seq` of the first delta the client has not said it took. While
   * `MAX_DELTAS_OUT` are out, the next waits and the steps in between go in
   * it together.
   */
  private ackedSeq = 0;
  private sentTick: number;
  private sentSpeed: number;
  /** The undo history the last delta or snapshot reflected. The sim replaces it on every change. */
  private sentUndo: SimState["undo"];
  /** Which commands the queue held when the last delta went out, as `queueKey` writes them. */
  private sentQueue: string;
  private sentLogFrom: number;
  /** The statistics' write position as the last delta or snapshot left it, so the next delta sends the samples taken since. */
  private sentStatsNext: number;
  /** The running totals as the last delta or snapshot left them, so the next delta sends only those that changed. */
  private sentStatTotals: StatTotals;
  /** The treasury, ledger and tax rates as the last delta or snapshot left them, so the next delta sends them only when they changed. */
  private sentBudget: BudgetState;
  /** The milestones reached as the last delta or snapshot left them, a copy (M4-12). */
  private sentMilestones: Int32Array;
  private stepsSinceDelta = 0;
  /**
   * What an autosave copies the city into and writes it out to, kept from
   * one save to the next (issue #158). A save taken while another still
   * holds them, before its `release`, uses fresh buffers as before.
   */
  private readonly captureBuffers = createCaptureBuffers();
  private readonly saveBuffer: SnapshotBuffer = { buffer: null };
  private saveBuffersHeld = false;
  private lastTimings: SystemTiming[] = [];
  /** Real time not yet turned into steps. */
  private owedMs = 0;
  private lastPump: number;
  /** While true, `pump` steps nothing and only `advance` moves the sim (see `hold`). */
  private held = false;

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
    // From here on every road and cell change is recorded. Earlier ones
    // reach a client in the snapshot it asks for first.
    recordRoadChanges(state.roads);
    recordCellChanges(state);
    recordBuildingChanges(state);
    recordPopChanges(state);
    this.fullLog = [...pagedLog, ...state.log];
    this.transport = transport;
    this.now = now;
    this.playerId = playerId;
    this.logCursor = logLength(state);
    this.sentTick = state.tick;
    this.sentSpeed = state.speed;
    this.sentUndo = state.undo;
    this.sentQueue = queueKey(state.pending);
    this.sentStatsNext = state.stats.next;
    this.sentStatTotals = { ...state.stats.totals };
    this.sentBudget = copyBudget(state.budget);
    this.sentMilestones = state.milestones.slice();
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
    // A large city's capture and bytes are tens of megabytes, and fresh ones
    // every autosave make the collections that hold a tick up. So the save
    // writes into buffers kept from the last one, unless that one has not
    // been released yet.
    const keep = !this.saveBuffersHeld;
    let released = false;
    const release = keep
      ? () => {
          if (released) return;
          released = true;
          this.saveBuffersHeld = false;
        }
      : () => undefined;
    if (keep) this.saveBuffersHeld = true;
    const state = captureState(this.state, keep ? this.captureBuffers : undefined);
    const { logOffset } = state;
    if (logOffset % LOG_PAGE_SIZE !== 0) {
      return { steps: serializeSteps(state, this.fullLog.slice(0, logOffset)), pages: [], pageCount: 0, release };
    }
    return { steps: serializeDetachedSteps(state, keep ? this.saveBuffer : undefined), ...this.logPages(pagesStored), release };
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
      case "deltaAck":
        // Only a delta that is out: one already counted, or never sent,
        // changes nothing. Taking one takes those before it, so a delta that
        // never arrived is not waited for.
        if (message.seq < this.ackedSeq || message.seq >= this.deltaSeq) return;
        this.ackedSeq = message.seq + 1;
        // What was stepped while it was out goes now, not at the next pump.
        this.flushDelta();
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
    if (this.held) {
      this.owedMs = 0;
      this.flushDelta();
      return;
    }
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

  /**
   * Stops the clock stepping the sim: from here on only `advance` does,
   * paused or not, and queued commands wait for it. For tests, which then
   * say how many steps to run instead of waiting on real time, so what they
   * see does not depend on how fast the machine draws (issue #224). The sim
   * is the same either way; only who decides when to step changes.
   */
  hold(): void {
    this.held = true;
  }

  /** Gives stepping back to the clock, starting from now: held time is not caught up. */
  release(): void {
    this.held = false;
    this.owedMs = 0;
    this.lastPump = this.now();
  }

  /** True while `hold` has stopped the clock. */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * Runs `steps` steps now, whatever the speed, then sends one delta. At any
   * speed but paused each step is one tick; paused steps apply commands and
   * leave the tick where it is, as `step` does.
   */
  advance(steps: number): void {
    for (let i = 0; i < steps; i++) this.stepOnce();
    // Whatever is out: the caller is told the steps are done right after
    // this, and their delta must already be on its way (see `serveClock`).
    this.flushDelta(true);
  }

  private stepOnce(): void {
    const timings: SystemTiming[] = [];
    const starts = new Map<string, number>();
    const timer: SystemTimer = {
      start: (system) => void starts.set(system, this.now()),
      end: (system) => timings.push({ system, ms: this.now() - (starts.get(system) ?? 0) }),
    };
    for (const dropped of step(this.state, timer)) this.unsentDropped.push(dropped);
    this.lastTimings = timings;
    this.stepsSinceDelta++;
    // Read after every step so no entry pages out of live state unread.
    const entries = readLog(this.state, this.logCursor);
    for (const spent of readLogSpent(this.state, this.logCursor)) this.unsentSpent.push(spent);
    this.logCursor += entries.length;
    for (const entry of entries) {
      this.fullLog.push(entry);
      this.unsent.push(entry);
    }
    this.unsentRoads = mergeRoadChanges(this.unsentRoads, drainRoadChanges(this.state.roads));
  }

  /**
   * Sends what changed since the last delta, unless the client has yet to
   * take `MAX_DELTAS_OUT` of those before it. A worker steps whether or not the page keeps up, and a
   * page that draws a frame in a second took each delta later than the one
   * before: the queue grew without end and every click waited behind it
   * (issues #335, #345). Held back, the changes stay where they are read
   * from and go in one delta once the client says it took one.
   * `force` is for a snapshot, which must follow everything stepped so far,
   * and for `advance`, whose caller waits for the delta of its steps.
   */
  private flushDelta(force = false): void {
    if (!force && this.deltaSeq - this.ackedSeq >= MAX_DELTAS_OUT) return;
    // Cells are read now, like road rows below, so a cell painted and then
    // moved by a road in between goes out once, as what it is now.
    const cells = drainCellDelta(this.state);
    // Building rows too: one added and removed in between goes out once.
    const buildings = drainBuildingDelta(this.state);
    // And each building's people and jobs filled, read now. Pop rows never
    // go in a delta (M3-05): a client's copy has them as of its snapshot.
    const people = drainPopDelta(this.state);
    const stats = encodeStatsDelta(this.state.stats, this.sentStatsNext, this.sentStatTotals);
    const budget = sameBudget(this.state.budget, this.sentBudget) ? undefined : copyBudget(this.state.budget);
    const milestones = sameMilestones(this.state.milestones, this.sentMilestones) ? undefined : this.state.milestones.slice();
    const changed =
      budget !== undefined ||
      milestones !== undefined ||
      this.unsent.length > 0 ||
      this.unsentDropped.length > 0 ||
      this.unsentRoads !== null ||
      cells !== null ||
      buildings !== null ||
      people !== null ||
      Object.keys(stats.totals).length > 0 ||
      stats.samples.length > 0 ||
      this.state.tick !== this.sentTick ||
      this.state.speed !== this.sentSpeed ||
      this.state.undo !== this.sentUndo;
    if (!changed) return;
    // The queue only when it changed: a stroke waiting for the cells can sit
    // there for many deltas, and copying it into each made garbage the
    // collector then paid for inside a step.
    const queue = queueKey(this.state.pending);
    // Only how the history changed: the whole of it, after fifty strokes
    // at the cap, was megabytes a delta (issue #155). The new records are
    // copied so the message holds none of the state's own objects.
    const undo = this.state.undo !== this.sentUndo ? undoDelta(this.sentUndo, this.state.undo) : undefined;
    const log = this.unsent;
    const dropped = this.unsentDropped;
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
      logSpent: this.unsentSpent,
      ...(roads ? { roads } : {}),
      ...(cells ? { cells } : {}),
      ...(buildings ? { buildings } : {}),
      ...(people ? { people } : {}),
      ...(undo ? { undo } : {}),
      ...(dropped.length > 0 ? { dropped } : {}),
      rng: this.state.rng.slice(),
      cellReads: this.state.cellReads,
      centre: { ...this.state.centre },
      stats,
      travelReadyAt: this.state.travelReadyAt,
      demand: copyDemand(this.state.demand),
      redevelopedToday: this.state.redevelopedToday,
      ...(budget ? { budget } : {}),
      ...(milestones ? { milestones } : {}),
      ...(queue !== this.sentQueue ? { pending: this.state.pending.map((c) => ({ ...c })) } : {}),
      steps: this.stepsSinceDelta,
      timings: this.lastTimings,
    };
    this.deltaSeq++;
    this.unsent = [];
    this.unsentSpent = [];
    this.unsentDropped = [];
    this.unsentRoads = null;
    this.sentTick = this.state.tick;
    this.sentSpeed = this.state.speed;
    this.sentUndo = this.state.undo;
    this.sentQueue = queue;
    this.sentStatsNext = this.state.stats.next;
    this.sentStatTotals = { ...this.state.stats.totals };
    if (budget) this.sentBudget = copyBudget(budget);
    if (milestones) this.sentMilestones = milestones.slice();
    this.sentLogFrom += log.length;
    this.stepsSinceDelta = 0;
    // Sent last, once the host has noted what it sent: over a transport
    // that delivers at once, the client can ask for a snapshot from inside
    // this call, and the snapshot must follow this delta, not repeat it.
    // The rows and the undo delta are fresh arrays, so a worker can move them.
    this.transport.send(delta, typedArrayBuffers({ roads, cells, buildings, people, undo, stats, budget, milestones }));
  }

  private sendSnapshot(): void {
    // Anything stepped but unsent goes out first, so deltas and the snapshot
    // agree on where the log stands, whether or not the last delta was taken.
    this.flushDelta(true);
    // The worker keeps stepping its own state, so the snapshot is a copy.
    // The copy's buffers are then moved to the client rather than copied a
    // second time by postMessage.
    const state = structuredClone(this.state);
    this.transport.send(
      { v: PROTOCOL_VERSION, type: "snapshot", state, logFrom: this.logCursor, deltaSeq: this.deltaSeq },
      typedArrayBuffers(state),
    );
    // The client's copy is whole from here, so the next delta need not wait
    // for the ones before the snapshot.
    this.ackedSeq = this.deltaSeq;
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
  /**
   * Hands the save's buffers back to the host once its bytes are stored
   * and nothing reads them any more. Until then the next save allocates
   * buffers of its own. The bytes must not be read after this.
   */
  release(): void;
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

/** The commands in a queue, by sender and seq, to tell whether it changed since a delta. */
function queueKey(pending: readonly { playerId: string; seq: number }[]): string {
  let key = "";
  for (const c of pending) key += `${c.playerId.length}:${c.playerId}${c.seq},`;
  return key;
}
