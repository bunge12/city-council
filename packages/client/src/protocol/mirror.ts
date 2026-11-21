import {
  LOG_LIVE_LIMIT,
  LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  applyBuildingDelta,
  applyStatsDelta,
  applyCellDelta,
  applyRoadDelta,
  applyUndoDelta,
  blockIndexOf,
  buildingInfo,
  buildingOnSlot,
  buildingsInChunk,
  buildingsOnSlots,
  cellAt,
  cellShapesInChunk,
  cellsInChunk,
  gridClears,
  lotMarkAt,
  lotMarksInChunk,
  roadClears,
  roadIndexOf,
  type BuildingInfo,
  type BuildingsInTheWay,
  type GridPlan,
  type RoadPlan,
  type CellInfo,
  type ChunkCellShapes,
  type CommandResult,
  type FromSimMessage,
  type SimState,
  type SystemTiming,
} from "@city-council/sim";
import { adjustHomes, countHomes, homesAfter, homesBefore, type Homes } from "./homes";
import type { ClientTransport } from "./transport";

/** Deeply read-only view of sim state. The client never writes it. */
export type ReadonlyDeep<T> = T extends (infer E)[]
  ? readonly ReadonlyDeep<E>[]
  : T extends ArrayBufferView
    ? T
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

/** What the host reported about its own timing, for the debug panel. */
export interface HostStats {
  /** Per-system time of the host's most recent step. */
  timings: readonly SystemTiming[];
}

/**
 * What a snapshot or delta changed. A snapshot replaces the whole copy, so
 * everything may have changed. A delta names the 500 m chunks, as
 * `cj * CHUNKS_PER_SIDE + ci` ascending, whose roads changed, and the node
 * and segment ids whose rows it carried, ascending; all empty when no road
 * changed. `cellChunks` names the chunks, numbered the same way, holding a
 * zoning cell that came, went, was painted or changed whether it is blocked.
 * It stays empty until something has asked the mirror about cells
 * (`cellsInChunk`, `cellAt`): before that nothing drawn can be out of date.
 * `buildingChunks` names the chunks a building that came or went was or is
 * in, and likewise stays empty until something has asked about buildings
 * (`buildingsInChunk`). It lists only buildings whose rows the delta
 * carried: a building whose road moved under it, as an upgrade moves a
 * road's edge, keeps its row and is not listed. A view that draws
 * buildings must redraw them in every chunk of `roadChunks` and
 * `cellChunks` too, and look up where each of `buildingIds` is and was:
 * a building that came in such a delta changed no cell, so its chunk may
 * be in neither list. `buildingIds` names every building the delta
 * carried a row for, ascending, whether or not anything asked.
 * `steps` is how many sim steps the delta covers: after one or more, every
 * command the host had queued before it has been applied or dropped, or is
 * waiting for the cells to settle (the sim's `waitsForCells`).
 * Listeners run before `sendCommandSettled` resolves for the commands the
 * update settled.
 */
export type MirrorUpdate =
  | { kind: "snapshot" }
  | {
      kind: "delta";
      roadChunks: readonly number[];
      roadNodes: readonly number[];
      roadSegs: readonly number[];
      cellChunks: readonly number[];
      buildingChunks: readonly number[];
      buildingIds: readonly number[];
      steps: number;
    };

type Listener = (update: MirrorUpdate) => void;

/**
 * The client's read-only copy of sim state. It requests a snapshot when
 * created, applies deltas as they arrive and asks for a fresh snapshot if a
 * delta does not line up. Commands go out through `sendCommand`; state only
 * ever changes from what the sim sends back.
 */
export class SimMirror {
  private readonly transport: ClientTransport;
  /** Who this copy sends commands as. */
  readonly playerId: string;
  private current: SimState | null = null;
  private logFrom = 0;
  /** `seq` of the next delta that lines up with the copy. */
  private deltaSeq = 0;
  private nextSeq = 1;
  /** Commands sent and not yet answered, by seq: the host's answer, queued or refused. */
  private readonly answers = new Map<number, (result: CommandResult) => void>();
  /** Commands sent and not yet applied or refused, by seq. */
  private readonly outcomes = new Map<number, (result: CommandResult) => void>();
  /** Seqs of commands the host has queued and not yet applied or dropped. */
  private readonly queued = new Set<number>();
  private readonly listeners = new Set<Listener>();
  private hostStats: HostStats = { timings: [] };
  private awaitingSnapshot = false;
  private homeTally: Homes | null = null;

  constructor(transport: ClientTransport, playerId: string) {
    this.transport = transport;
    this.playerId = playerId;
    transport.onMessage((message) => this.receive(message));
    this.requestSnapshot();
  }

  /** The latest state, or null until the first snapshot arrives. */
  get state(): ReadonlyDeep<SimState> | null {
    return this.current;
  }

  get stats(): HostStats {
    return this.hostStats;
  }

  /**
   * The residential buildings standing in the copy and the residents they
   * hold room for (issue M2-18), or null until the first snapshot. Counted
   * in full from each snapshot, then moved by each building delta. The
   * object is replaced only when a number changes, so a view can compare it.
   */
  get homes(): Homes | null {
    return this.homeTally;
  }

  /**
   * Calls `listener` after every snapshot or delta, with what it changed.
   * Returns an unsubscribe.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The seq the next command this copy sends will carry. No earlier command of this player has it, even from before a reload. */
  get upcomingSeq(): number {
    return this.nextSeq;
  }

  /**
   * Sends a command and resolves with the host's answer: queued, or refused
   * with a reason. Queued is not applied: a command ahead of it in the same
   * tick, perhaps another player's, can still make it invalid, and the step
   * then drops it. `sendCommandSettled` waits for that.
   */
  sendCommand(type: string, payload: unknown = {}): Promise<CommandResult> {
    return this.send(type, payload).answer;
  }

  /**
   * Sends a command and resolves once the sim has settled it: `ok` once it
   * was applied and the delta carrying it is in the copy, or the reason it
   * was not. It can be refused when it arrives, or queued and then dropped
   * at the step (issue 94). Either way the reason comes here.
   */
  sendCommandSettled(type: string, payload: unknown = {}): Promise<CommandResult> {
    return this.send(type, payload).outcome;
  }

  private send(type: string, payload: unknown): { answer: Promise<CommandResult>; outcome: Promise<CommandResult> } {
    const seq = this.nextSeq++;
    const answer = new Promise<CommandResult>((resolve) => this.answers.set(seq, resolve));
    const outcome = new Promise<CommandResult>((resolve) => this.outcomes.set(seq, resolve));
    this.transport.send({
      v: PROTOCOL_VERSION,
      type: "command",
      command: { seq, playerId: this.playerId, type, payload },
    });
    return { answer, outcome };
  }

  /**
   * Every zoning cell whose centre is in 500 m chunk `chunk`, open or
   * blocked, with where its zone and density sit in `state.cells`. Whether
   * a cell is blocked is worked out here, by the sim's own code, from the
   * copy's roads. Empty until the first snapshot.
   */
  cellsInChunk(chunk: number): CellInfo[] {
    return this.current ? cellsInChunk(this.current, chunk) : [];
  }

  /**
   * Every building whose lot's centre is in 500 m chunk `chunk`, by id, with
   * the corners of its lot. Where each lot is follows from the copy's roads,
   * by the sim's own code. Empty until the first snapshot.
   */
  buildingsInChunk(chunk: number): BuildingInfo[] {
    const state = this.current;
    if (!state) return [];
    return buildingsInChunk(state, chunk).flatMap((id) => buildingInfo(state, id) ?? []);
  }

  /** Building `id` with its lot's corners, or null if there is none. */
  building(id: number): BuildingInfo | null {
    return this.current ? buildingInfo(this.current, id) : null;
  }

  /** The chunk building `id`'s lot's centre is in, or -1 if there is none. */
  buildingChunk(id: number): number {
    return this.current ? (buildingInfo(this.current, id)?.chunk ?? -1) : -1;
  }

  /**
   * The building standing on each cell of `slots`, slots in
   * `state.cells.zone` as `cellShapesInChunk` gives them, in the same
   * order, or -1 (`NO_BUILDING`). Worked out by the sim's own code from the
   * copy, for those cells alone. Null until the first snapshot.
   */
  buildingsOnSlots(slots: ArrayLike<number>): Int32Array | null {
    return this.current ? buildingsOnSlots(this.current, slots) : null;
  }

  /**
   * Builds now what the copy's tools and the zoning overlay would otherwise
   * build on their first question, so it lands at load and not on the key
   * press that opens a tool (issue #163). The cell index and the building
   * index are built at load already, by the first frame of buildings. This
   * adds the road spatial index, which picks the road under the pointer, and
   * the block index, which the lot finder behind the overlay's hatching
   * needs: about 20 and 50 ms on the scale town. Both follow the copy's
   * roads from then on.
   */
  prepareTools(): void {
    const state = this.current;
    if (!state) return;
    roadIndexOf(state.roads);
    blockIndexOf(state.roads);
  }

  /**
   * The cells of chunk `chunk` as `cellsInChunk` gives them, laid out flat
   * with their corners for drawing. Null until the first snapshot.
   */
  cellShapesInChunk(chunk: number): ChunkCellShapes | null {
    return this.current ? cellShapesInChunk(this.current, chunk) : null;
  }

  /** The zoning cell whose ground holds the point, in metres, or null. */
  cellAt(x: number, z: number): CellInfo | null {
    return this.current ? cellAt(this.current, x, z) : null;
  }

  /**
   * By the order of `cellShapesInChunk(chunk)`, 1 for each free zoned cell
   * where no building type fits, as the zoning overlay marks it (issue
   * M2-15). Worked out by the sim's own lot finder on the copy. `shapes` is
   * what `cellShapesInChunk(chunk)` just gave, so the chunk's cells are not
   * read twice (issue #164). Null until the first snapshot.
   */
  lotMarksInChunk(chunk: number, shapes?: ChunkCellShapes): Uint8Array | null {
    return this.current ? lotMarksInChunk(this.current, chunk, shapes) : null;
  }

  /** Why no building type fits on the free ground at (x, z), as the overlay marks it, or null where it is not marked. */
  lotMarkAt(x: number, z: number): string | null {
    const state = this.current;
    const cell = state ? cellAt(state, x, z) : null;
    return state && cell ? lotMarkAt(state, cell) : null;
  }

  /** The building standing on the ground at (x, z), with its lot's corners, or null. */
  buildingAt(x: number, z: number): BuildingInfo | null {
    const state = this.current;
    const cell = state ? cellAt(state, x, z) : null;
    if (!state || !cell) return null;
    const id = buildingOnSlot(state, cell.index);
    return id < 0 ? null : buildingInfo(state, id);
  }

  /**
   * The buildings a road the sim has planned would clear, and their
   * residents, for the road tool's preview (issue M2-15). The sim rehearses
   * the road on the copy's network and takes it back, so the copy is as it
   * was. Empty until the first snapshot.
   */
  roadClears(plan: RoadPlan): BuildingsInTheWay {
    return this.current ? roadClears(this.current, plan) : { ids: [], residents: 0 };
  }

  /** As `roadClears`, for a grid the sim has planned. */
  gridClears(plan: GridPlan): BuildingsInTheWay {
    return this.current ? gridClears(this.current, plan) : { ids: [], residents: 0 };
  }

  requestSnapshot(): void {
    this.awaitingSnapshot = true;
    this.transport.send({ v: PROTOCOL_VERSION, type: "requestSnapshot" });
  }

  private receive(message: FromSimMessage): void {
    if (message.v !== PROTOCOL_VERSION) return;
    switch (message.type) {
      case "snapshot":
        this.settleFromSnapshot(message.state);
        this.skipSeqs(message.state);
        this.current = message.state;
        this.homeTally = countHomes(message.state.buildings);
        this.logFrom = message.logFrom;
        this.deltaSeq = message.deltaSeq;
        this.awaitingSnapshot = false;
        this.notify({ kind: "snapshot" });
        return;
      case "delta": {
        const before = this.deltaSeq;
        this.applyDelta(message);
        // A delta the copy could not take still says which commands were dropped, and why.
        if (this.deltaSeq === before) this.settleDropped(message);
        return;
      }
      case "commandResult": {
        if (message.playerId !== this.playerId) return;
        const answer = this.answers.get(message.seq);
        if (!answer) return;
        this.answers.delete(message.seq);
        answer(message.result);
        // Queued is not applied: the outcome comes with the step.
        if (message.result.ok) this.queued.add(message.seq);
        else this.settle(message.seq, message.result);
        return;
      }
    }
  }

  private applyDelta(delta: Extract<FromSimMessage, { type: "delta" }>): void {
    const state = this.current;
    if (state === null) return;
    if (delta.seq !== this.deltaSeq || delta.logFrom !== this.logFrom || delta.tick < state.tick) {
      this.outOfStep();
      return;
    }
    // The undo history is checked before anything changes, and set with the rest below.
    const undo = delta.undo ? applyUndoDelta(state.undo, delta.undo) : null;
    if (typeof undo === "string") {
      this.outOfStep();
      return;
    }
    // Roads first: a delta whose rows do not fit the copy changes nothing.
    let roadChunks: readonly number[] = [];
    let roadNodes: readonly number[] = [];
    let roadSegs: readonly number[] = [];
    if (delta.roads) {
      const applied = applyRoadDelta(state.roads, delta.roads);
      if (typeof applied === "string") {
        this.outOfStep();
        return;
      }
      roadChunks = applied;
      roadNodes = [...delta.roads.nodeIds];
      roadSegs = [...delta.roads.segIds];
    }
    // Then the cells, laid out for the roads as they now are.
    let cellChunks: readonly number[] = [];
    if (delta.roads || delta.cells) {
      const applied = applyCellDelta(state, delta.cells ?? null, roadSegs);
      if (typeof applied === "string") {
        this.outOfStep();
        return;
      }
      cellChunks = applied;
    }
    // Then the buildings, on the cells as they now are.
    let buildingChunks: readonly number[] = [];
    let homes = this.homeTally;
    if (delta.buildings) {
      const before = homesBefore(state.buildings, delta.buildings);
      const applied = applyBuildingDelta(state, delta.buildings);
      if (typeof applied === "string") {
        this.outOfStep();
        return;
      }
      buildingChunks = applied;
      const after = homesAfter(state.buildings, delta.buildings);
      if (homes && (before.count !== after.count || before.capacity !== after.capacity)) homes = adjustHomes(homes, before, after);
    }
    this.deltaSeq++;
    this.homeTally = homes;
    state.tick = delta.tick;
    state.speed = delta.speed;
    // The host's queue as it stands: what a step neither applied nor
    // dropped waits for the cells to settle (the sim's waitsForCells).
    if (delta.pending) state.pending = delta.pending.map((c) => ({ ...c }));
    state.cellReads = delta.cellReads;
    if (undo) state.undo = undo;
    state.rng.set(delta.rng);
    state.growth = { ...delta.growth };
    state.centre = { ...delta.centre };
    const statsProblem = applyStatsDelta(state.stats, delta.stats);
    if (statsProblem !== null) {
      this.outOfStep();
      return;
    }
    for (const entry of delta.log) state.log.push(entry);
    this.logFrom += delta.log.length;
    // Same paging as live state, so the copy stays the same shape.
    while (state.log.length > LOG_LIVE_LIMIT) {
      state.log.splice(0, LOG_PAGE_SIZE);
      state.logOffset += LOG_PAGE_SIZE;
    }
    this.hostStats = { timings: delta.timings };
    // The copy now holds what these commands did, so their senders can look.
    for (const entry of delta.log) if (entry.playerId === this.playerId) this.settle(entry.seq, { ok: true });
    this.settleDropped(delta);
    const buildingIds = delta.buildings ? [...delta.buildings.ids] : [];
    this.notify({ kind: "delta", roadChunks, roadNodes, roadSegs, cellChunks, buildingChunks, buildingIds, steps: delta.steps });
  }

  private settleDropped(delta: Extract<FromSimMessage, { type: "delta" }>): void {
    for (const drop of delta.dropped ?? []) {
      if (drop.playerId === this.playerId) this.settle(drop.seq, { ok: false, reason: drop.reason });
    }
  }

  /**
   * Moves `nextSeq` past every seq of this player's in the snapshot's log
   * and queue. Seqs start at 1 on every page load and the player id stays
   * the same, so without this a command queued before a reload, and kept in
   * the save, could be taken for one sent since.
   */
  private skipSeqs(state: SimState): void {
    for (const command of [...state.log, ...state.pending]) {
      if (command.playerId === this.playerId && command.seq >= this.nextSeq) this.nextSeq = command.seq + 1;
    }
    // A stroke id is the seq of the stroke's first command (M2 review, #147).
    // Its log entry can have left the live log while its undo record stays,
    // and a new stroke must not take its id.
    for (const record of state.undo) {
      if (record.playerId === this.playerId && record.stroke !== undefined && record.stroke >= this.nextSeq) this.nextSeq = record.stroke + 1;
    }
  }

  private settle(seq: number, result: CommandResult): void {
    const resolve = this.outcomes.get(seq);
    if (!resolve) return;
    this.outcomes.delete(seq);
    this.queued.delete(seq);
    resolve(result);
  }

  /**
   * Settles queued commands against a snapshot, when the deltas that would
   * have said what became of them were missed. One in the snapshot's log
   * after the copy's was applied; one still in its queue waits for a later
   * delta. Any other was dropped by a step whose delta went missing, and
   * the reason went with it.
   */
  private settleFromSnapshot(state: SimState): void {
    if (this.queued.size === 0) return;
    const applied = new Set<number>();
    state.log.forEach((entry, i) => {
      // Entries the copy already had may carry this player's seqs from before a reload.
      if (state.logOffset + i >= this.logFrom && entry.playerId === this.playerId) applied.add(entry.seq);
    });
    const pending = new Set(state.pending.filter((c) => c.playerId === this.playerId).map((c) => c.seq));
    for (const seq of [...this.queued]) {
      if (applied.has(seq)) this.settle(seq, { ok: true });
      else if (!pending.has(seq)) this.settle(seq, { ok: false, reason: "This change was not made" });
    }
  }

  /** Out of step with the host. Drop deltas until a snapshot resets us. */
  private outOfStep(): void {
    if (!this.awaitingSnapshot) this.requestSnapshot();
  }

  private notify(update: MirrorUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}
