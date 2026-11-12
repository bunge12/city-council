import {
  LOG_LIVE_LIMIT,
  LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  applyRoadDelta,
  type CommandResult,
  type FromSimMessage,
  type SimState,
  type SystemTiming,
} from "@city-council/sim";
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
 * changed. `steps` is how many sim steps the delta covers: after one or
 * more, every command the host had queued before it has been applied or
 * dropped.
 */
export type MirrorUpdate =
  | { kind: "snapshot" }
  | {
      kind: "delta";
      roadChunks: readonly number[];
      roadNodes: readonly number[];
      roadSegs: readonly number[];
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
  private readonly playerId: string;
  private current: SimState | null = null;
  private logFrom = 0;
  /** `seq` of the next delta that lines up with the copy. */
  private deltaSeq = 0;
  private nextSeq = 1;
  private readonly waiting = new Map<number, (result: CommandResult) => void>();
  private readonly listeners = new Set<Listener>();
  private hostStats: HostStats = { timings: [] };
  private awaitingSnapshot = false;

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
   * Calls `listener` after every snapshot or delta, with what it changed.
   * Returns an unsubscribe.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Sends a command and resolves with the sim's answer: accepted into the
   * queue, or refused with a reason.
   */
  sendCommand(type: string, payload: unknown = {}): Promise<CommandResult> {
    const seq = this.nextSeq++;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.transport.send({
        v: PROTOCOL_VERSION,
        type: "command",
        command: { seq, playerId: this.playerId, type, payload },
      });
    });
  }

  requestSnapshot(): void {
    this.awaitingSnapshot = true;
    this.transport.send({ v: PROTOCOL_VERSION, type: "requestSnapshot" });
  }

  private receive(message: FromSimMessage): void {
    if (message.v !== PROTOCOL_VERSION) return;
    switch (message.type) {
      case "snapshot":
        this.current = message.state;
        this.logFrom = message.logFrom;
        this.deltaSeq = message.deltaSeq;
        this.awaitingSnapshot = false;
        this.notify({ kind: "snapshot" });
        return;
      case "delta":
        this.applyDelta(message);
        return;
      case "commandResult": {
        if (message.playerId !== this.playerId) return;
        const resolve = this.waiting.get(message.seq);
        this.waiting.delete(message.seq);
        resolve?.(message.result);
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
    this.deltaSeq++;
    state.tick = delta.tick;
    state.speed = delta.speed;
    // Any step drains the host's queue, so queued commands from the
    // snapshot have now been applied or dropped.
    if (delta.steps > 0) state.pending = [];
    for (const entry of delta.log) state.log.push(entry);
    this.logFrom += delta.log.length;
    // Same paging as live state, so the copy stays the same shape.
    while (state.log.length > LOG_LIVE_LIMIT) {
      state.log.splice(0, LOG_PAGE_SIZE);
      state.logOffset += LOG_PAGE_SIZE;
    }
    this.hostStats = { timings: delta.timings };
    this.notify({ kind: "delta", roadChunks, roadNodes, roadSegs, steps: delta.steps });
  }

  /** Out of step with the host. Drop deltas until a snapshot resets us. */
  private outOfStep(): void {
    if (!this.awaitingSnapshot) this.requestSnapshot();
  }

  private notify(update: MirrorUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}
