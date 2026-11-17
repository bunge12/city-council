// The soak's page (issue M2-17): a SimMirror in a worker thread of its own,
// fed the host's messages as the page is fed the sim worker's. In the
// browser the sim and the page have a heap each, so a collection of the
// page's copy never lands in a step. With the mirror in the soak's own
// thread it did: one heap held both copies of the grown town, and a full
// collection of it landed in the step that allocated past the limit.
//
// The soak bundles this file and starts it with `new Worker`. It answers
// the soak's questions about what the page sees, in the order they come,
// after every message sent before them.

import { parentPort } from "node:worker_threads";
import { SEG_ALIVE, SEG_FIXED, buildingCount, hashState, seeBuilding, segmentEnds, segmentTypeId, type BuildingSeen, type BuildingState } from "@city-council/sim";
import { countHomes } from "../src/protocol/homes";
import { SimMirror } from "../src/protocol/mirror";
import type { ClientTransport } from "../src/protocol/transport";

/** What the soak sends: a message from the host, or a question with an id to answer. */
export type ToMirror =
  | { kind: "message"; message: unknown }
  | { kind: "ask"; id: number; question: MirrorQuestion };

export type MirrorQuestion =
  | { q: "ready" }
  | { q: "segment"; from: number }
  | { q: "buildings"; seed: number; count: number }
  | { q: "homes" }
  | { q: "hashes" };

/** What the worker sends back: a message for the host, or an answer. */
export type FromMirror = { kind: "send"; message: unknown } | { kind: "answer"; id: number; answer: unknown };

const port = parentPort;
if (!port) throw new Error("mirror-worker runs as a worker thread");

let handler: ((message: never) => void) | null = null;
const transport: ClientTransport = {
  send: (message) => port.postMessage({ kind: "send", message } satisfies FromMirror),
  onMessage: (h) => {
    handler = h as (message: never) => void;
    return () => (handler = null);
  },
};
const mirror = new SimMirror(transport, "soak");

/** The first live segment from `from` on, by id, that a player may change, as the page shows it. */
function segment(from: number): { seg: number; ends: number[][]; types: string[] } | null {
  const roads = mirror.state?.roads;
  if (!roads) return null;
  const limit = roads.segFlags.length;
  for (let k = 0; k < limit; k++) {
    const id = (from + k) % limit;
    const flags = roads.segFlags[id] ?? 0;
    if ((flags & SEG_ALIVE) !== 0 && (flags & SEG_FIXED) === 0) return { seg: id, ends: [segmentEnds(roads, id)], types: [segmentTypeId(roads, id)] };
  }
  return null;
}

/** Up to `count` buildings standing, from an id the seed picks, as the player saw them. */
function buildings(seed: number, count: number): BuildingSeen[] {
  const b = mirror.state?.buildings;
  if (!b) return [];
  const limit = b.flags.length;
  const from = seed % Math.max(1, limit);
  const seen: BuildingSeen[] = [];
  for (let k = 0; k < limit && seen.length < count; k++) {
    const id = (from + k) % limit;
    const one = seeBuilding(b as BuildingState, id);
    if (one) seen.push(one);
  }
  return seen;
}

function answer(question: MirrorQuestion): unknown {
  const state = mirror.state;
  switch (question.q) {
    case "ready":
      return state !== null;
    case "segment":
      return segment(question.from);
    case "buildings":
      return buildings(question.seed, question.count);
    case "homes":
      // The top bar's figure, kept from the deltas, beside a count from scratch.
      return state ? { homes: mirror.homes?.count ?? -1, counted: countHomes(state.buildings).count, buildings: buildingCount(state.buildings) } : null;
    case "hashes":
      return state
        ? { roads: hashState(state.roads), cells: hashState(state.cells), buildings: hashState(state.buildings), homes: mirror.homes?.count ?? null }
        : null;
  }
}

port.on("message", (data: ToMirror) => {
  if (data.kind === "message") handler?.(data.message as never);
  else port.postMessage({ kind: "answer", id: data.id, answer: answer(data.question) } satisfies FromMirror);
});
