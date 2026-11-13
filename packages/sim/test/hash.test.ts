import { describe, expect, it } from "vitest";
import { Fnv64 } from "../src/hash";
import { createBareState, fnv1a64, hashState, step, submit, type SimState } from "../src/index";

declare function structuredClone<T>(value: T): T;
declare class TextEncoder {
  encode(s: string): Uint8Array;
}

// Reference FNV-1a 64 on BigInt, to check the split 32-bit version.
function referenceFnv(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}

function busyState(): SimState {
  const state = createBareState(77);
  submit(state, { seq: 1, playerId: "p1", type: "SetSpeed", payload: { speed: 2 } });
  step(state);
  submit(state, { seq: 2, playerId: "p2", type: "NoOp", payload: { note: "hi" } });
  step(state);
  submit(state, { seq: 3, playerId: "p1", type: "NoOp", payload: {} });
  return state;
}

describe("fnv1a64", () => {
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
  ])("matches the published test vector for %j", (text, hash) => {
    expect(fnv1a64(new TextEncoder().encode(text))).toBe(hash);
  });

  it("matches a BigInt reference on every byte value and longer input", () => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 167 + (i >> 3)) & 0xff;
    for (const n of [1, 2, 255, 256, 4096]) {
      expect(fnv1a64(bytes.subarray(0, n))).toBe(referenceFnv(bytes.subarray(0, n)));
    }
  });
});

describe("Fnv64", () => {
  it("gives the same hash for bytes fed together, one at a time, or part each way", () => {
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 211 + (i >> 5)) & 0xff;
    const single = new Fnv64();
    for (const b of bytes) single.byte(b);
    const whole = new Fnv64();
    whole.bytes(bytes);
    const mixed = new Fnv64();
    mixed.bytes(bytes.subarray(0, 1234));
    mixed.byte(bytes[1234] ?? 0);
    mixed.bytes(bytes.subarray(1235));
    expect(whole.hex()).toBe(single.hex());
    expect(mixed.hex()).toBe(single.hex());
    expect(whole.hex()).toBe(referenceFnv(bytes));
  });
});

describe("hashState", () => {
  it("returns 16 hex digits and is stable for equal states", () => {
    const hash = hashState(busyState());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashState(busyState())).toBe(hash);
    expect(hashState(structuredClone(busyState()))).toBe(hash);
  });

  it("ignores the order object keys were written in", () => {
    expect(hashState({ a: 1, b: [2, "x"] })).toBe(hashState({ b: [2, "x"], a: 1 }));
  });

  it("changes when any byte of the generator state changes", () => {
    const base = busyState();
    const baseHash = hashState(base);
    const bytes = new Uint8Array(base.rng.buffer, base.rng.byteOffset, base.rng.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const copy = structuredClone(base);
        const view = new Uint8Array(copy.rng.buffer, copy.rng.byteOffset, copy.rng.byteLength);
        view[i] = (view[i] ?? 0) ^ bit;
        expect(hashState(copy), `byte ${i} bit ${bit}`).not.toBe(baseHash);
      }
    }
  });

  it("changes when any scalar, queued command or log entry changes", () => {
    const base = busyState();
    const baseHash = hashState(base);
    const edits: [string, (s: SimState) => void][] = [
      ["tick", (s) => (s.tick += 1)],
      ["seed", (s) => (s.seed ^= 1)],
      ["speed", (s) => (s.speed = 4)],
      ["version", (s) => (s.version += 1)],
      ["logOffset", (s) => (s.logOffset += 1)],
      ["pending dropped", (s) => s.pending.pop()],
      ["pending seq", (s) => s.pending[0] && (s.pending[0].seq += 1)],
      ["log tick", (s) => s.log[1] && (s.log[1].tick += 1)],
      ["log player", (s) => s.log[1] && (s.log[1].playerId = "p3")],
      ["log type", (s) => s.log[1] && (s.log[1].type = "NoOq")],
      ["log payload", (s) => s.log[1] && (s.log[1].payload = { note: "hj" })],
      ["log entry dropped", (s) => s.log.shift()],
      ["log order", (s) => s.log.reverse()],
    ];
    for (const [name, edit] of edits) {
      const copy = structuredClone(base);
      edit(copy);
      expect(hashState(copy), name).not.toBe(baseHash);
    }
  });

  it("tells apart values that print the same", () => {
    expect(hashState([1, "1"])).not.toBe(hashState(["1", 1]));
    expect(hashState({ a: null })).not.toBe(hashState({ a: undefined }));
    expect(hashState(new Uint8Array([1, 0, 0, 0]))).not.toBe(hashState(new Uint32Array([1])));
    expect(hashState(["ab", "c"])).not.toBe(hashState(["a", "bc"]));
  });

  it("hashes only the viewed bytes of a typed array", () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]);
    expect(hashState(buffer.subarray(1, 4))).toBe(hashState(new Uint8Array([1, 2, 3])));
  });

  it("refuses data state must not hold", () => {
    expect(() => hashState({ f: () => 1 })).toThrow(/state\.f is a function/);
    expect(() => hashState({ m: new Map() })).toThrow(/not plain data/);
    expect(() => hashState({ n: 1n })).toThrow(TypeError);
  });
});
