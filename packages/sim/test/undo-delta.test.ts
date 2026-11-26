import { describe, expect, it } from "vitest";
import { UNDO_STEPS, applyUndoDelta, createState, diffUndo, step, type Command, type UndoDelta, type UndoRecord } from "../src/index";
import { NO_JOURNALS } from "../src/zoning/zone-undo";
import { submit } from "./seen-ends";

// Issue #155: a delta carries how the undo history changed, not the whole of it.

function record(playerId: string, entry: number): UndoRecord {
  return { playerId, entry, type: "BuildRoad", ops: [], zones: NO_JOURNALS, spent: 0 };
}

/** `delta` as it arrives on the other side of a worker or a socket: no object shared. */
function copied(delta: UndoDelta): UndoDelta {
  return { kept: delta.kept.slice(), added: delta.added.map((r) => ({ ...r, ops: [...r.ops], zones: r.zones.slice() })) };
}

/** What a copy holding `before` ends up with once `after` is sent as a delta. */
function sent(before: readonly UndoRecord[], after: readonly UndoRecord[]): UndoRecord[] | string {
  return applyUndoDelta(before, copied(diffUndo(before, after)));
}

describe("undo deltas", () => {
  const a = record("p1", 0);
  const b = record("p2", 1);
  const c = record("p1", 2);
  const d = record("p2", 3);

  it("sends only a record added at the end", () => {
    const delta = diffUndo([a, b], [a, b, c]);
    expect([...delta.kept]).toEqual([0, 1]);
    expect(delta.added).toEqual([c]);
    expect(sent([a, b], [a, b, c])).toEqual([a, b, c]);
  });

  it("drops a record taken from anywhere and keeps the rest in order", () => {
    // An undo takes a player's newest; going past the limit forgets their oldest.
    expect([...diffUndo([a, b, c], [a, c]).kept]).toEqual([0, 2]);
    expect(diffUndo([a, b, c], [a, c]).added).toEqual([]);
    expect(sent([a, b, c], [b, c, d])).toEqual([b, c, d]);
    expect(sent([a, b, c], [])).toEqual([]);
  });

  it("sends a history that is not the last one changed as new", () => {
    // Records out of their old order are not a keep and an append: they go again.
    const delta = diffUndo([a, b, c], [c, a]);
    expect([...delta.kept]).toEqual([2]);
    expect(delta.added).toEqual([a]);
    expect(sent([a, b, c], [c, a])).toEqual([c, a]);
    expect(sent([], [a, b])).toEqual([a, b]);
  });

  it("refuses a delta that keeps a record the copy does not have", () => {
    expect(applyUndoDelta([a], { kept: Int32Array.of(1), added: [] })).toMatch(/does not have/);
    expect(applyUndoDelta([a, b], { kept: Int32Array.of(1, 0), added: [] })).toMatch(/does not have/);
    expect(applyUndoDelta([a], { kept: [0] as unknown as Int32Array, added: [] })).toMatch(/not a list/);
  });

  it("follows a history through builds, undos and the oldest records forgotten", () => {
    const state = createState(2026);
    let copy: UndoRecord[] = [];
    let last = state.undo;
    let seq = 0;
    const send = (type: string, payload: unknown, playerId: string) => {
      const command: Command = { seq: ++seq, playerId, type, payload };
      expect(submit(state, command)).toEqual({ ok: true });
      step(state);
      if (state.undo === last) return;
      const next = sent(last, state.undo);
      if (typeof next === "string") throw new Error(next);
      expect(applyUndoDelta(copy, copied(diffUndo(last, state.undo)))).toEqual(next);
      copy = next;
      last = state.undo;
    };
    // Short streets, side by side on the flat ground of seed 2026, past the limit for one player.
    for (let i = 0; i < 100; i++) {
      const z = 4420 + (i % 25) * 20;
      const x = 4120 + Math.floor(i / 25) * 120;
      send("BuildRoad", { from: { x, z }, to: { x: x + 80, z }, type: "street" }, i % 4 === 0 ? "p2" : "p1");
      if (i % 10 === 9 && i < 90) send("Undo", {}, "p1");
    }
    expect(state.undo.filter((r) => r.playerId === "p1").length).toBe(UNDO_STEPS);
    expect(copy).toEqual(state.undo);
  });
});
