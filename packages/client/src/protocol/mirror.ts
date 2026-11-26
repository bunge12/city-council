import {
  LOG_LIVE_LIMIT,
  LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  applyBuildingDelta,
  applyPopDelta,
  applyStatsDelta,
  countOccupancy,
  popDeltaProblem,
  statsDeltaProblem,
  STAT_TOTALS,
  applyCellDelta,
  applyRoadDelta,
  applyUndoDelta,
  blockIndexOf,
  buildingGround,
  buildingChunk,
  buildingInfo,
  buildingOnSlot,
  buildingsInChunk,
  buildingsOnSlots,
  cellAt,
  cellShapesInChunk,
  cellsInChunk,
  applyExpropriationDelta,
  gridEffects,
  NO_COMPENSATION,
  landValueAt,
  landValuesOfShapes,
  lotMarkAt,
  lotMarksInChunk,
  prepareWaterMap,
  terrainOf,
  roadEffects,
  roadIndexOf,
  type BuildingGround,
  type BuildingInfo,
  type BuildingsInTheWay,
  type RoadEffects,
  type GridPlan,
  type RoadPlan,
  type CellInfo,
  type ChunkCellShapes,
  type LandValue,
  type CommandResult,
  type FromSimMessage,
  type Occupancy,
  type SimState,
  type SystemTiming,
  checkBudget,
  checkDemand,
  copyBudget,
  copyDemand,
  holdsHomes,
  reachableRoomWith,
  whyNoNewcomers,
  type ReachableRoom,
} from "@city-council/sim";
import { countRoom, roomAfter, roomBefore } from "./room";
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
 * `peopleIds` names every building whose people or jobs filled the delta
 * changed, ascending (M3-05), and `statTotals` the city totals it changed,
 * in the sim's `STAT_TOTALS` order. `statSamples` is how many monthly
 * history samples it added.
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
      peopleIds: readonly number[];
      statTotals: readonly string[];
      statSamples: number;
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
  private roomTally: number | null = null;
  /** Every building's people and jobs filled, counted from the last snapshot's pops and moved by each delta. */
  private occupancy: Occupancy = { people: new Int32Array(0), filled: new Int32Array(0) };

  constructor(transport: ClientTransport, playerId: string) {
    this.transport = transport;
    this.playerId = playerId;
    transport.onMessage((message) => this.receive(message));
    this.requestSnapshot();
  }

  /**
   * The latest state, or null until the first snapshot arrives.
   *
   * Its `pops` are as of the last snapshot: deltas carry each building's
   * people and jobs filled, not pop rows (M3-05). Do not read them, or ask
   * the sim's pop queries about this copy; use `buildingPeople`,
   * `jobsFilled` and `state.stats` instead.
   */
  get state(): ReadonlyDeep<SimState> | null {
    return this.current;
  }

  get stats(): HostStats {
    return this.hostStats;
  }

  /**
   * The people the copy's buildings hold room for (issue M3-15), or null
   * until the first snapshot. Counted in full from each snapshot, then moved
   * by each building delta.
   */
  get room(): number | null {
    return this.roomTally;
  }

  /** The people living in building `id`, as the sim's `buildingPeople` has them. 0 for an id that is not a building. */
  buildingPeople(id: number): number {
    return this.occupancy.people[id] ?? 0;
  }

  /** Building `id`'s jobs filled, as the sim's `jobsFilled` has them. 0 for an id that is not a building. */
  jobsFilled(id: number): number {
    return this.occupancy.filled[id] ?? 0;
  }

  /** `buildingPeople` and `jobsFilled` as the sim's planners take them, so a preview prices clearing a building as the command will (M4-09). */
  readonly peopleIn = (id: number): number => this.buildingPeople(id);
  readonly filledIn = (id: number): number => this.jobsFilled(id);

  /**
   * Why no newcomer would move into home `id` today, as the sim's
   * `whyNoNewcomers` says (M3-08): `abandoned` while it is abandoned (M3-24),
   * `noRoute` when its road reaches no outside
   * connection, `noDemand` when the residential bar is at or below zero, or
   * null. Null before the first snapshot. Read with `buildingPeople` to say
   * why a home stands empty.
   */
  whyNoNewcomers(id: number): "abandoned" | "noRoute" | "noDemand" | null {
    return this.current ? whyNoNewcomers(this.current, id) : null;
  }

  /**
   * The homes newcomers can reach, as the sim's `reachableRoom` counts them,
   * when they hold new homes back (#330): `unfilledHomesMax` or more of
   * them still filling, so the grower adds no home and redevelopment waits.
   * Null while they do not, and before the first snapshot. Worked out from
   * the copy's buildings and roads and each building's people, with one
   * pass over the buildings, so ask it while the tooltip is open and not on
   * every update.
   */
  homesWaiting(): ReachableRoom | null {
    if (!this.current) return null;
    const room = reachableRoomWith(this.current, this.occupancy.people);
    return holdsHomes(room) ? room : null;
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

  /**
   * How building `id`'s ground is zoned against what it was built under
   * (M3-14): as built, zoned up so it may redevelop, or for something else
   * so it stands as a permitted existing use. Null if there is no such
   * building.
   */
  buildingGround(id: number): BuildingGround | null {
    return this.current ? buildingGround(this.current, id) : null;
  }

  /** The chunk building `id`'s lot's centre is in, or -1 if there is none. */
  buildingChunk(id: number): number {
    // Not through buildingInfo, which also works out the building's value (M4-01).
    return this.current ? buildingChunk(this.current, id) : -1;
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
    // And the distance to water the land value overlay reads (issue M3-18).
    prepareWaterMap(terrainOf(state.seed));
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

  /**
   * By the order of `shapes`, as `cellShapesInChunk` just gave them, each
   * cell's land value, worked out by the sim's own code from the copy
   * (issue M3-18). Land value is derived, not state, so nothing of it
   * travels in a delta. Null until the first snapshot.
   */
  landValuesOfShapes(shapes: ChunkCellShapes): Uint8Array | null {
    return this.current ? landValuesOfShapes(this.current, shapes) : null;
  }

  /** The land value of the zoning cell at (x, z), its parts, and the type of road it fronts, or null where there is no cell. */
  landValueAt(x: number, z: number): { value: LandValue; roadType: number } | null {
    const state = this.current;
    const cell = state ? cellAt(state, x, z) : null;
    const value = state && cell ? landValueAt(state, cell) : null;
    return state && cell && value ? { value, roadType: state.roads.segType[cell.segment] ?? 0 } : null;
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
   * The buildings a road the sim has planned would clear, and the people
   * living in them as the copy counts them, for the road tool's preview
   * (issue M2-15, M3-12). The sim rehearses
   * the road on the copy's network and takes it back, so the copy is as it
   * was. Empty until the first snapshot.
   */
  roadClears(plan: RoadPlan): BuildingsInTheWay {
    return this.effectsOf(plan, (state) => roadEffects(state, plan, this.peopleIn, this.filledIn)).clears;
  }

  /** As `roadClears`, for a grid the sim has planned. */
  gridClears(plan: GridPlan): BuildingsInTheWay {
    return this.effectsOf(plan, (state) => gridEffects(state, plan, this.peopleIn, this.filledIn)).clears;
  }

  /**
   * The buildings a road or grid the sim has planned would clear and the
   * cells it would open on its own segments, for the road tools' previews
   * (issue #323): the sim's `roadEffects` and `gridEffects`, rehearsed on
   * the copy and taken back. Kept for each plan, so the preview's two
   * questions about one plan cost one rehearsal.
   */
  private effectsOf(plan: RoadPlan | GridPlan, find: (state: SimState) => RoadEffects): RoadEffects {
    let effects = this.effects.get(plan);
    if (!effects) {
      effects = this.current ? find(this.current) : { clears: { ids: [], residents: 0, compensation: { ...NO_COMPENSATION } }, cells: new Float64Array(0) };
      this.effects.set(plan, effects);
    }
    return effects;
  }

  private readonly effects = new WeakMap<object, RoadEffects>();

  /** The cells a road the sim has planned would open, as corners, eight numbers a cell. Empty until the first snapshot. */
  roadCells(plan: RoadPlan): Float64Array {
    return this.effectsOf(plan, (state) => roadEffects(state, plan, this.peopleIn, this.filledIn)).cells;
  }

  /** As `roadCells`, for a grid the sim has planned. */
  gridCells(plan: GridPlan): Float64Array {
    return this.effectsOf(plan, (state) => gridEffects(state, plan, this.peopleIn, this.filledIn)).cells;
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
        this.roomTally = countRoom(message.state.buildings);
        this.occupancy = countOccupancy(message.state);
        this.logFrom = message.logFrom;
        this.deltaSeq = message.deltaSeq;
        this.awaitingSnapshot = false;
        this.notify({ kind: "snapshot" });
        return;
      case "delta": {
        const before = this.deltaSeq;
        try {
          this.applyDelta(message);
          // A delta the copy could not take still says which commands were dropped, and why.
          if (this.deltaSeq === before) this.settleDropped(message);
        } finally {
          // Taken, applied or not: the host sends the next only now (issue
          // #345), after everything listening has run. Also when one of
          // them threw, or the host would wait for good on a page that
          // went on after the error.
          this.transport.send({ v: PROTOCOL_VERSION, type: "deltaAck", seq: message.seq });
        }
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
    const spentFits = Array.isArray(delta.logSpent) && delta.logSpent.length === delta.log.length;
    if (delta.seq !== this.deltaSeq || delta.logFrom !== this.logFrom || delta.tick < state.tick || !spentFits) {
      this.outOfStep();
      return;
    }
    // The undo history is checked before anything changes, and set with the rest below.
    const undo = delta.undo ? applyUndoDelta(state.undo, delta.undo) : null;
    if (typeof undo === "string") {
      this.outOfStep();
      return;
    }
    // So are the statistics, whose samples must be whole rows of totals,
    // and the people, so neither can fail once the rest has changed.
    if (statsDeltaProblem(delta.stats) || (delta.people && popDeltaProblem(delta.people))) {
      this.outOfStep();
      return;
    }
    // And the demand bars, which must have the shape this build keeps.
    if (checkDemand(delta.demand) !== null) {
      this.outOfStep();
      return;
    }
    // And the treasury and ledger, when they came, which must add up.
    if (delta.budget && checkBudget(delta.budget) !== null) {
      this.outOfStep();
      return;
    }
    // And the expropriations, which must apply to the list the copy has.
    const expropriations = delta.expropriations ? applyExpropriationDelta(state.expropriations, delta.expropriations, delta.tick) : null;
    if (typeof expropriations === "string") {
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
    let room = this.roomTally;
    if (delta.buildings) {
      const before = roomBefore(state.buildings, delta.buildings);
      const applied = applyBuildingDelta(state, delta.buildings);
      if (typeof applied === "string") {
        this.outOfStep();
        return;
      }
      buildingChunks = applied;
      if (room !== null) room += roomAfter(state.buildings, delta.buildings) - before;
    }
    if (delta.people) {
      const occupancy = applyPopDelta(this.occupancy, delta.people, state.buildings.flags.length);
      // Checked above, so this is a reason only if the check and the apply disagree.
      if (typeof occupancy === "string") {
        this.outOfStep();
        return;
      }
      this.occupancy = occupancy;
    }
    this.deltaSeq++;
    this.roomTally = room;
    state.tick = delta.tick;
    state.speed = delta.speed;
    // The host's queue as it stands: what a step neither applied nor
    // dropped waits for the cells to settle (the sim's waitsForCells).
    if (delta.pending) state.pending = delta.pending.map((c) => ({ ...c }));
    state.cellReads = delta.cellReads;
    state.travelReadyAt = delta.travelReadyAt;
    // The last whole travel-time table is the sim's, for job matching
    // (#313), and no delta carries it: let go of the one a snapshot brought.
    state.travelLast = null;
    state.demand = copyDemand(delta.demand);
    state.redevelopedToday = delta.redevelopedToday;
    if (delta.budget) state.budget = copyBudget(delta.budget);
    if (expropriations) state.expropriations = expropriations;
    if (undo) state.undo = undo;
    state.rng.set(delta.rng);
    state.centre = { ...delta.centre };
    const statTotals = applyStatsDelta(state.stats, delta.stats);
    for (const entry of delta.log) state.log.push(entry);
    for (const spent of delta.logSpent) state.logSpent.push(spent);
    this.logFrom += delta.log.length;
    // Same paging as live state, so the copy stays the same shape.
    while (state.log.length > LOG_LIVE_LIMIT) {
      state.log.splice(0, LOG_PAGE_SIZE);
      state.logSpent.splice(0, LOG_PAGE_SIZE);
      state.logOffset += LOG_PAGE_SIZE;
    }
    this.hostStats = { timings: delta.timings };
    // The copy now holds what these commands did, so their senders can look.
    for (const entry of delta.log) if (entry.playerId === this.playerId) this.settle(entry.seq, { ok: true });
    this.settleDropped(delta);
    const buildingIds = delta.buildings ? [...delta.buildings.ids] : [];
    const peopleIds = delta.people ? [...delta.people.ids] : [];
    this.notify({
      kind: "delta",
      roadChunks,
      roadNodes,
      roadSegs,
      cellChunks,
      buildingChunks,
      buildingIds,
      peopleIds,
      statTotals: typeof statTotals === "string" ? [] : statTotals,
      statSamples: delta.stats.samples.length / STAT_TOTALS.length,
      steps: delta.steps,
    });
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
